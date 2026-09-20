import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AGENT_EXTENSION_PATH, buildWorkerArgv, buildWorkerEnv, modelArg } from "../src/spawn/launch.js";
import {
	consolidatorResultPath,
	readConsolidatorResult,
	readObserverResult,
	runCostPath,
	runResultPath,
	runsDir,
	writeConsolidatorResult,
	writeObserverResult,
} from "../src/spawn/runs.js";
import { registerObserverTool } from "../agent/observer/tool.js";

describe("launch argv + env", () => {
	const model = { provider: "anthropic" as const, id: "claude-sonnet-4-6", thinking: "low" as const };

	it("builds the headless yt-edit-style flag set", () => {
		const argv = buildWorkerArgv({ model, sessionName: "om-observer-x", kickoffPrompt: "go" });
		expect(argv).toContain("--no-extensions");
		expect(argv).toContain("--no-builtin-tools");
		expect(argv).toContain("--no-skills");
		expect(argv).toContain("--no-prompt-templates");
		expect(argv).toContain("--no-context-files");
		expect(argv[argv.indexOf("--model") + 1]).toBe("anthropic/claude-sonnet-4-6");
		expect(argv[argv.indexOf("--thinking") + 1]).toBe("low");
		expect(argv[argv.indexOf("-e") + 1]).toBe(AGENT_EXTENSION_PATH);
		expect(argv[argv.indexOf("-n") + 1]).toBe("om-observer-x");
		expect(argv[argv.indexOf("-p") + 1]).toBe("go");
		expect(AGENT_EXTENSION_PATH.endsWith("/agent/index.ts")).toBe(true);
	});

	it("omits --thinking when no level is configured", () => {
		const argv = buildWorkerArgv({ model: { provider: "x", id: "y" }, sessionName: "n", kickoffPrompt: "p" });
		expect(argv).not.toContain("--thinking");
	});

	it("formats the model arg as provider/id", () => {
		expect(modelArg(model)).toBe("anthropic/claude-sonnet-4-6");
	});

	it("splits the worker IPC env by role: observer gets runtime-dir IPC only", () => {
		const runtimeDir = "/proj/.memory/runtime/sess-1";
		const env = buildWorkerEnv("observer", { runtimeDir, runId: "r1" });
		expect(env.OM_WORKER).toBe("observer");
		expect(env.OM_RUN_ID).toBe("r1");
		// Chunk travels as the `pi -p` prompt (recorded user message), not via env/file.
		expect(env.OM_CHUNK_PATH).toBeUndefined();
		expect(env.OM_RESULT_PATH).toBe(runResultPath(runtimeDir, "r1"));
		expect(env.OM_COST_PATH).toBe(runCostPath(runtimeDir, "r1"));
		// The observer has no file tools — no sandbox root is handed out.
		expect(env.OM_MEMORY_DIR).toBeUndefined();
	});

	it("gives the consolidator the shared bank as OM_MEMORY_DIR, IPC under the runtime dir", () => {
		const runtimeDir = "/proj/.memory/runtime/sess-1";
		const projectDir = "/proj/.memory/project";
		const env = buildWorkerEnv("consolidator", { runtimeDir, projectDir, runId: "c1" });
		expect(env.OM_WORKER).toBe("consolidator");
		expect(env.OM_MEMORY_DIR).toBe(projectDir);
		// The consolidator's result file is the outcome contract, still under the runtime dir.
		expect(env.OM_RESULT_PATH).toBe(consolidatorResultPath(runtimeDir, "c1"));
		expect(env.OM_COST_PATH).toBe(runCostPath(runtimeDir, "c1"));
	});

	it("refuses a consolidator without the shared-bank sandbox root", () => {
		expect(() => buildWorkerEnv("consolidator", { runtimeDir: "/proj/.memory/runtime/sess-1", runId: "c1" })).toThrow();
	});

	it("resolves run paths under the session runtime dir's runs/ (outside the durable bank)", () => {
		expect(runsDir("/proj/.memory/runtime/sess-1")).toBe("/proj/.memory/runtime/sess-1/runs");
		expect(runResultPath("/proj/.memory/runtime/sess-1", "r")).toBe(
			"/proj/.memory/runtime/sess-1/runs/r.result.json",
		);
		expect(consolidatorResultPath("/proj/.memory/runtime/sess-1", "c")).toBe(
			"/proj/.memory/runtime/sess-1/runs/c.consolidation.json",
		);
	});
});

describe("consolidator result IPC round-trip", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "om-cons-ipc-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("writes and reads back a validated outcome report", () => {
		const path = join(dir, "c1.consolidation.json");
		writeConsolidatorResult(path, {
			batchId: "batch-1",
			outcomes: [
				{ timestamp: "2026-06-25T14:30:00", disposition: "promoted" },
				{ timestamp: "2026-06-25T14:31:00", disposition: "retained" },
				{ timestamp: "2026-06-25T14:32:00", disposition: "discarded" },
			],
		});
		const result = readConsolidatorResult(path);
		expect(result.batchId).toBe("batch-1");
		expect(result.outcomes).toEqual([
			{ timestamp: "2026-06-25T14:30:00", disposition: "promoted" },
			{ timestamp: "2026-06-25T14:31:00", disposition: "retained" },
			{ timestamp: "2026-06-25T14:32:00", disposition: "discarded" },
		]);
	});

	it("throws on a missing batchId", () => {
		const path = join(dir, "bad1.consolidation.json");
		writeFileSync(path, JSON.stringify({ outcomes: [] }));
		expect(() => readConsolidatorResult(path)).toThrow("batchId");
	});

	it("throws on a missing outcomes array", () => {
		const path = join(dir, "bad2.consolidation.json");
		writeFileSync(path, JSON.stringify({ batchId: "b" }));
		expect(() => readConsolidatorResult(path)).toThrow("outcomes");
	});

	it("throws on a malformed outcome entry (no silent filtering)", () => {
		const path = join(dir, "bad3.consolidation.json");
		writeFileSync(
			path,
			JSON.stringify({ batchId: "b", outcomes: [{ timestamp: "t", disposition: "nope" }] }),
		);
		expect(() => readConsolidatorResult(path)).toThrow("malformed outcome");
	});
});

describe("observer result IPC round-trip", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "om-runs-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("writes and reads back valid observations, dropping malformed ones", () => {
		const path = join(dir, "r.result.json");
		writeObserverResult(path, {
			observations: [
				{ timestamp: "2026-06-25 14:30", content: "ok" },
				{ timestamp: "2026-06-25 14:31", content: "  " }, // dropped: blank content
			],
		});
		const result = readObserverResult(path);
		expect(result.observations).toEqual([{ timestamp: "2026-06-25 14:30", content: "ok" }]);
	});

	it("throws on a result file missing the observations array", () => {
		const path = join(dir, "bad.result.json");
		writeFileSync(path, JSON.stringify({ nope: true }));
		expect(() => readObserverResult(path)).toThrow();
	});
});

describe("registerObserverTool", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "om-tool-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("writes an empty result file on registration and accumulates across calls", async () => {
		const path = join(dir, "r.result.json");
		let tool: any;
		const fakePi = { registerTool: (def: any) => (tool = def) } as any;

		registerObserverTool(fakePi, path);
		expect(readObserverResult(path).observations).toEqual([]);

		await tool.execute("id1", { observations: [{ timestamp: "2026-06-25 14:30", content: "first" }] });
		await tool.execute("id2", {
			observations: [
				{ timestamp: "2026-06-25 14:30", content: "first" }, // duplicate
				{ timestamp: "2026-06-25 14:31", content: "second" },
			],
		});

		expect(readObserverResult(path).observations).toEqual([
			{ timestamp: "2026-06-25 14:30", content: "first" },
			{ timestamp: "2026-06-25 14:31", content: "second" },
		]);
	});
});
