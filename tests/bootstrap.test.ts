import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { computeBootstrapFingerprint, OM_BOOTSTRAP, registerBootstrapHook } from "../src/hooks/bootstrap.js";
import { renderBootstrapBlock } from "../src/memory/index-render.js";
import { listTopics, readOverview } from "../src/memory/paths.js";
import { DEFAULTS } from "../src/config.js";
import { estimateStringTokens } from "../src/tokens.js";
import { Runtime } from "../src/runtime.js";

/**
 * Drive the bootstrap hook directly against a real temp-dir bank. The Runtime is real (with the
 * gate forced on and config pinned), and paths read/write the actual `.memory/project/` files.
 */
function setup(cwd: string): { runtime: Runtime; fire: (ctx: unknown) => Promise<any> } {
	const runtime = new Runtime();
	runtime.enabled = true;
	runtime.config = { ...DEFAULTS };
	runtime.configLoaded = true; // pin the config: never read the developer's real settings
	runtime.activatePaths({ cwd, sessionManager: { getSessionId: () => "sess-1" } });

	const handlers: Array<(event: unknown, ctx: unknown) => Promise<any>> = [];
	const pi = {
		on: (_event: string, handler: (event: unknown, ctx: unknown) => Promise<any>) => {
			handlers.push(handler);
		},
	};
	registerBootstrapHook(pi as never, runtime);
	expect(handlers.length).toBe(1);
	return { runtime, fire: (ctx: unknown) => handlers[0]!({ type: "before_agent_start" }, ctx) };
}

/** Write a bank: OVERVIEW body + one topic file per [filename, title, summary]. */
function writeBank(
	cwd: string,
	bank: { overview?: string; topics?: Array<[string, string, string]> },
): void {
	const projectDir = join(cwd, ".memory", "project");
	mkdirSync(projectDir, { recursive: true });
	if (bank.overview !== undefined) writeFileSync(join(projectDir, "OVERVIEW.md"), bank.overview, "utf-8");
	for (const [filename, title, summary] of bank.topics ?? []) {
		writeFileSync(
			join(projectDir, filename),
			`---\nid: ${filename.replace(/\.md$/, "")}\ntitle: ${title}\nsummary: ${summary}\n---\n\nTopic body.\n`,
			"utf-8",
		);
	}
}

function expectInjection(result: any): string {
	expect(result).toBeDefined();
	expect(result.message).toBeDefined();
	expect(result.message.customType).toBe(OM_BOOTSTRAP);
	expect(result.message.display).toBe(false);
	expect(typeof result.message.content).toBe("string");
	return result.message.content;
}

let tempDirs: string[] = [];
beforeEach(() => {
	tempDirs = [];
});
afterEach(() => {
	for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function tempCwd(marker: string): string {
	const cwd = mkdtempSync(join(tmpdir(), marker));
	tempDirs.push(cwd);
	return cwd;
}

describe("bootstrap injection (before_agent_start)", () => {
	it("injects the orientation block on the first agent turn when the bank has content", async () => {
		const cwd = tempCwd("om-bootstrap-first-");
		writeBank(cwd, { overview: "The service is a fork.", topics: [["auth.md", "Auth", "OIDC login flow"]] });
		const { fire } = setup(cwd);

		const content = expectInjection(await fire({ cwd }));
		expect(content).toContain("## Project memory");
		expect(content).toContain(".memory/project/");
		expect(content).toContain("The service is a fork.");
		expect(content).toContain(".memory/project/auth.md");
		expect(content).toContain("OIDC login flow");
		// The read-or-grep instruction must be part of the injected block.
		expect(content).toContain("Read or grep these files");
	});

	it("does not re-inject the same bank content on later turns", async () => {
		const cwd = tempCwd("om-bootstrap-dedupe-");
		writeBank(cwd, { overview: "Stable overview." });
		const { fire } = setup(cwd);

		expectInjection(await fire({ cwd }));
		for (let i = 0; i < 3; i++) {
			expect(await fire({ cwd })).toBeUndefined();
		}
	});

	it("re-injects once after the bank content changes", async () => {
		const cwd = tempCwd("om-bootstrap-change-");
		writeBank(cwd, { overview: "Old state." });
		const { fire } = setup(cwd);

		const first = expectInjection(await fire({ cwd }));
		expect(first).toContain("Old state.");

		// The consolidator (this or another session) wrote a new topic: content changed →
		// exactly one re-injection, then silence again.
		writeBank(cwd, { topics: [["auth.md", "Auth", "OIDC login flow"]] });
		const second = expectInjection(await fire({ cwd }));
		expect(second).toContain("OIDC login flow");
		expect(await fire({ cwd })).toBeUndefined();
	});

	it("injects nothing for an empty bank, and stays silent on later turns", async () => {
		const cwd = tempCwd("om-bootstrap-empty-");
		writeBank(cwd, {}); // bank dir exists, no OVERVIEW, no topics
		const { fire, runtime } = setup(cwd);

		expect(await fire({ cwd })).toBeUndefined();
		expect(await fire({ cwd })).toBeUndefined();
		// The empty state is fingerprinted, so content appearing later injects once.
		writeBank(cwd, { overview: "Now there is content." });
		const content = expectInjection(await fire({ cwd }));
		expect(content).toContain("Now there is content.");
		expect(runtime.lastBootstrapFingerprint).toBe(
			computeBootstrapFingerprint("Now there is content.", listTopics(join(cwd, ".memory", "project"), cwd)),
		);
	});

	it("skips injection and warns (no throw) when the bank is unreadable", async () => {
		const cwd = tempCwd("om-bootstrap-unreadable-");
		// `.memory/project` exists but is a FILE: existsSync passes, readdir throws ENOTDIR.
		mkdirSync(join(cwd, ".memory"), { recursive: true });
		writeFileSync(join(cwd, ".memory", "project"), "not a directory", "utf-8");
		const { fire, runtime } = setup(cwd);

		const notifications: Array<[string, string]> = [];
		const ctx = { cwd, hasUI: true, ui: { notify: (m: string, l: string) => notifications.push([m, l]) } };

		expect(await fire(ctx)).toBeUndefined(); // no throw
		expect(notifications.length).toBe(1);
		expect(notifications[0]![0]).toContain("project memory unreadable");
		expect(notifications[0]![1]).toBe("warning");
		expect(runtime.lastBootstrapError).toBeDefined();

		// Same failure again: no repeat toast, still no injection, still no throw.
		notifications.length = 0;
		expect(await fire(ctx)).toBeUndefined();
		expect(notifications.length).toBe(0);
	});

	it("respects the bootstrapTokens budget cap and passes the config value through", async () => {
		const cwd = tempCwd("om-bootstrap-budget-");
		writeBank(cwd, {
			overview: "Word ".repeat(500).trim(),
			topics: [["auth.md", "Auth", "OIDC login flow"]],
		});
		const { runtime, fire } = setup(cwd);
		const budget = 100; // just above the fixed header + pointer cost, so the body is cut
		runtime.config = { ...DEFAULTS, bootstrapTokens: budget };

		const content = expectInjection(await fire({ cwd }));
		// The ≈4-chars/token heuristic plus join separators can round a few tokens past the
		// cap; the contract is "hard-capped", i.e. bounded by the budget, not the untrimmed
		// bank (hundreds of tokens here).
		expect(estimateStringTokens(content)).toBeLessThanOrEqual(budget + 5);
		// Truncation kicked in: the full-index pointer replaced the cut tail.
		expect(content).toContain("Full index at");
		// The uncut block would be far larger — the config value really flowed through.
		const full = readOverview(join(cwd, ".memory", "project"))!;
		expect(estimateStringTokens(full)).toBeGreaterThan(300);
	});

	it("injects nothing while the gate is off", async () => {
		const cwd = tempCwd("om-bootstrap-off-");
		writeBank(cwd, { overview: "There is content." });
		const runtime = new Runtime();
		runtime.enabled = false;
		runtime.config = { ...DEFAULTS };
		runtime.configLoaded = true;
		runtime.activatePaths({ cwd, sessionManager: { getSessionId: () => "sess-1" } });

		const handlers: Array<(event: unknown, ctx: unknown) => Promise<any>> = [];
		registerBootstrapHook({ on: (_e: string, h: (e: unknown, c: unknown) => Promise<any>) => handlers.push(h) } as never, runtime);
		expect(await handlers[0]!({ type: "before_agent_start" }, { cwd })).toBeUndefined();
	});

	it("re-injects once after activatePaths resets the per-session fingerprint (resume/reload/fork)", async () => {
		const cwd = tempCwd("om-bootstrap-reset-");
		writeBank(cwd, { overview: "Same content." });
		const { runtime, fire } = setup(cwd);

		expectInjection(await fire({ cwd }));
		expect(await fire({ cwd })).toBeUndefined();
		expect(runtime.lastBootstrapFingerprint).toBeDefined();

		// A new session_start (fresh/resume/fork) re-activates: fingerprint reset → one injection.
		runtime.activatePaths({ cwd, sessionManager: { getSessionId: () => "sess-2" } });
		expect(runtime.lastBootstrapFingerprint).toBeUndefined();
		const content = expectInjection(await fire({ cwd }));
		expect(content).toContain("Same content.");
		expect(await fire({ cwd })).toBeUndefined();
	});
});

describe("computeBootstrapFingerprint", () => {
	it("is stable for identical bank content and differs for any routing-field edit", () => {
		const cwd = tempCwd("om-bootstrap-fp-");
		writeBank(cwd, {
			overview: "Overview.",
			topics: [["auth.md", "Auth", "OIDC login flow"]],
		});
		const projectDir = join(cwd, ".memory", "project");

		const read = () => [readOverview(projectDir), listTopics(projectDir, cwd)] as const;
		const [overview, topics] = read();
		expect(computeBootstrapFingerprint(overview, topics)).toBe(computeBootstrapFingerprint(overview, topics));
		expect(computeBootstrapFingerprint(undefined, [])).toBe(computeBootstrapFingerprint(undefined, []));
		expect(computeBootstrapFingerprint("A", [])).not.toBe(computeBootstrapFingerprint("B", []));

		// An edit to a summary only (overview untouched) must change the fingerprint.
		writeFileSync(
			join(projectDir, "auth.md"),
			"---\nid: auth\ntitle: Auth\nsummary: SAML login flow\n---\n\nTopic body.\n",
			"utf-8",
		);
		const [overview2, topics2] = read();
		expect(overview2).toBe(overview);
		expect(computeBootstrapFingerprint(overview2, topics2)).not.toBe(computeBootstrapFingerprint(overview, topics));
	});
});

describe("renderBootstrapBlock coverage for the bootstrap contract", () => {
	it("carries the memory dir path, stale-material framing, and the read/grep instruction", () => {
		const block = renderBootstrapBlock("Overview body.", [{ id: "auth", title: "Auth", summary: "S", path: ".memory/project/auth.md", filename: "auth.md" }], DEFAULTS.bootstrapTokens)!;
		expect(block).toContain(".memory/project/");
		expect(block).toContain("possibly-stale reference material");
		expect(block).toContain("Read or grep these files");
	});
});
