import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/spawn/launch.js", async (importOriginal) => {
	const actual = await importOriginal<Record<string, unknown>>();
	return { ...actual, spawnWorker: vi.fn() };
});

import { registerReviewerTools } from "../agent/reviewer/tools.js";
import { DEFAULTS } from "../src/config.js";
import { runMemoryReview, validateReviewerResult } from "../src/commands/review.js";
import { inspectProjectLock } from "../src/memory/lock.js";
import { Runtime } from "../src/runtime.js";
import { spawnWorker } from "../src/spawn/launch.js";
import { writeReviewerResult } from "../src/spawn/runs.js";

const spawnMock = vi.mocked(spawnWorker);
const tempDirs: string[] = [];

function topic(id: string, title: string, summary: string, body: string): string {
	return `---\nid: ${id}\ntitle: ${title}\nsummary: ${summary}\n---\n\n${body}\n`;
}

function makeHarness() {
	const cwd = mkdtempSync(join(tmpdir(), "om-review-"));
	tempDirs.push(cwd);
	const projectDir = join(cwd, ".memory", "project");
	mkdirSync(projectDir, { recursive: true });
	writeFileSync(join(projectDir, "OVERVIEW.md"), "Old overview.\n", "utf-8");
	writeFileSync(join(projectDir, "stale.md"), topic("stale", "Stale", "Old duplicated notes", "Legacy details."), "utf-8");
	mkdirSync(join(cwd, "src"), { recursive: true });
	writeFileSync(join(cwd, "src", "main.ts"), "export const currentRuntime = true;\n", "utf-8");

	const branch: any[] = [];
	const runtime = new Runtime();
	runtime.enabled = true;
	runtime.config = { ...DEFAULTS, models: { ...DEFAULTS.models } };
	runtime.configLoaded = true;
	const sessionManager = {
		getSessionId: () => "sess-1",
		getBranch: () => branch,
		getEntries: () => branch,
	};
	runtime.activatePaths({ cwd, sessionManager });
	const pi = {
		appendEntry: (customType: string, data: unknown) => branch.push({ type: "custom", customType, data }),
	};
	const ctx = {
		cwd,
		hasUI: false,
		sessionManager,
		getContextUsage: () => ({ tokens: null }),
	};
	return { cwd, projectDir, runtime, pi: pi as any, ctx };
}

beforeEach(() => {
	spawnMock.mockReset();
});

afterEach(() => {
	while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("manual reviewer orchestration", () => {
	it("accepts a detailed review summary without an arbitrary length cap", () => {
		const h = makeHarness();
		const summary = "Detailed maintenance outcome. ".repeat(1_000);

		expect(() =>
			validateReviewerResult(
				{
					reviewId: "review-long-summary",
					files: [
						{ path: "OVERVIEW.md", disposition: "kept" },
						{ path: "stale.md", disposition: "kept" },
					],
					createdFiles: [],
					summary,
				},
				"review-long-summary",
				["OVERVIEW.md", "stale.md"],
				h.projectDir,
			),
		).not.toThrow();
	});

	it("reviews under the project lock, validates the report, and regenerates INDEX", async () => {
		const h = makeHarness();
		spawnMock.mockImplementationOnce(async (opts) => {
			const memory = opts.env.OM_MEMORY_DIR!;
			writeFileSync(join(memory, "OVERVIEW.md"), "Current project orientation.\n", "utf-8");
			rmSync(join(memory, "stale.md"));
			writeFileSync(
				join(memory, "runtime.md"),
				topic("runtime", "Runtime", "Current runtime structure", "The source exposes currentRuntime."),
				"utf-8",
			);
			writeReviewerResult(opts.env.OM_RESULT_PATH!, {
				reviewId: opts.env.OM_REVIEW_ID!,
				files: [
					{ path: "OVERVIEW.md", disposition: "updated" },
					{ path: "stale.md", disposition: "merged" },
				],
				createdFiles: ["runtime.md"],
				summary: "Removed stale duplication and captured the current runtime.",
			});
			return { code: 0, signal: null, stderr: "" };
		});

		const result = await runMemoryReview(h.pi, h.runtime, h.ctx);

		expect(result.outcome).toBe("completed");
		expect(result.counts).toEqual({ kept: 0, updated: 1, merged: 1, deleted: 0, created: 1 });
		expect(existsSync(join(h.projectDir, "stale.md"))).toBe(false);
		expect(readFileSync(join(h.projectDir, "INDEX.md"), "utf-8")).toContain("runtime.md");
		expect(inspectProjectLock(h.projectDir)).toBeUndefined();

		const call = spawnMock.mock.calls[0]![0];
		expect(call.env.OM_WORKER).toBe("reviewer");
		expect(call.env.OM_PROJECT_DIR).toBe(h.cwd);
		expect(call.argv[call.argv.indexOf("--model") + 1]).toBe("openrouter/z-ai/glm-5.3-flash");
		const prompt = call.argv[call.argv.indexOf("-p") + 1]!;
		expect(prompt).toContain("OVERVIEW.md");
		expect(prompt).toContain("stale.md");
	});

	it("reports failure without rolling back edits when the terminal report is incomplete", async () => {
		const h = makeHarness();
		spawnMock.mockImplementationOnce(async (opts) => {
			const memory = opts.env.OM_MEMORY_DIR!;
			writeFileSync(join(memory, "OVERVIEW.md"), "Partially changed.\n", "utf-8");
			rmSync(join(memory, "stale.md"));
			writeFileSync(join(memory, "new.md"), topic("new", "New", "A partial new file", "partial"), "utf-8");
			writeReviewerResult(opts.env.OM_RESULT_PATH!, {
				reviewId: opts.env.OM_REVIEW_ID!,
				files: [{ path: "OVERVIEW.md", disposition: "updated" }], // stale.md omitted → invalid
				createdFiles: ["new.md"],
				summary: "Incomplete report.",
			});
			return { code: 0, signal: null, stderr: "" };
		});

		const result = await runMemoryReview(h.pi, h.runtime, h.ctx);

		expect(result.outcome).toBe("failed");
		expect(result.error).toContain("initial files");
		expect(readFileSync(join(h.projectDir, "OVERVIEW.md"), "utf-8")).toBe("Partially changed.\n");
		expect(existsSync(join(h.projectDir, "stale.md"))).toBe(false);
		expect(existsSync(join(h.projectDir, "new.md"))).toBe(true);
		expect(existsSync(join(h.projectDir, "INDEX.md"))).toBe(false);
		expect(inspectProjectLock(h.projectDir)).toBeUndefined();
	});
});

describe("reviewer tool sandbox", () => {
	it("can mutate only memory and inspect only safe project files", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "om-review-tools-"));
		tempDirs.push(cwd);
		const memory = join(cwd, ".memory", "project");
		mkdirSync(memory, { recursive: true });
		mkdirSync(join(cwd, "src"), { recursive: true });
		writeFileSync(join(cwd, "src", "app.ts"), "export const app = true;\n", "utf-8");
		writeFileSync(join(cwd, ".env"), "API_KEY=do-not-read\n", "utf-8");
		writeFileSync(join(memory, "old.md"), topic("old", "Old", "Old memory", "body"), "utf-8");

		const tools = new Map<string, any>();
		registerReviewerTools({ registerTool: (def: any) => tools.set(def.name, def) } as any, memory, cwd);
		expect([...tools.keys()].sort()).toEqual([
			"memory_delete",
			"memory_edit",
			"memory_list",
			"memory_read",
			"memory_write",
			"project_grep",
			"project_list",
			"project_read",
		]);

		const source = await tools.get("project_read").execute("1", { path: "src/app.ts" });
		expect(source.content[0].text).toContain("app = true");
		const secret = await tools.get("project_read").execute("2", { path: ".env" });
		expect(secret.content[0].text).toContain("excluded for safety");
		const escape = await tools.get("project_read").execute("3", { path: "../outside" });
		expect(escape.content[0].text).toContain("outside the project");

		await tools.get("memory_delete").execute("4", { path: "old.md" });
		expect(existsSync(join(memory, "old.md"))).toBe(false);
		const invalid = await tools.get("memory_write").execute("5", { path: "Bad Name.md", content: "x" });
		expect(invalid.content[0].text).toContain("lowercase-kebab-case");
	});
});
