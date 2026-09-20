import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { registerCompactionHook } from "../src/hooks/compaction-hook.js";
import { DEFAULTS } from "../src/config.js";
import { type Entry } from "../src/ledger/index.js";
import { Runtime } from "../src/runtime.js";
import {
	observation,
	observationsArchivedEntry,
	observationsRecordedEntry,
	textCustomMessage,
	type TestEntry,
} from "./fixtures/session.js";

/**
 * Drive the session_before_compact handler directly against a real branch. The archive wiring
 * (plan §7e) is the target: the projection's `archivedBatches` must reach `renderSummary`'s
 * fourth parameter so the "## Session archive" section appears in the live compaction block.
 */
function setup(cwd: string): { runtime: Runtime; fire: (event: unknown, ctx: unknown) => Promise<any> } {
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
	registerCompactionHook(pi as never, runtime);
	expect(handlers.length).toBe(1);
	return {
		runtime,
		fire: (event: unknown, ctx: unknown) => handlers[0]!(event, ctx),
	};
}

function ctxFor(cwd: string, branch: TestEntry[]): unknown {
	return {
		cwd,
		hasUI: false,
		sessionManager: { getBranch: () => branch },
	};
}

function compactEvent(branch: TestEntry[]): unknown {
	return {
		preparation: { firstKeptEntryId: "raw-2", tokensBefore: 1000 },
		branchEntries: branch,
	};
}

let tempDirs: string[] = [];
beforeEach(() => {
	tempDirs = [];
});
afterEach(() => {
	for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe("compaction hook session-archive wiring (plan §7e)", () => {
	it("renders the Session archive section for batches archived before the cutoff", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "om-compaction-archive-"));
		tempDirs.push(cwd);
		const { runtime, fire } = setup(cwd);

		const branch: TestEntry[] = [
			textCustomMessage("raw-1", "aaaa"),
			observationsRecordedEntry("om-1", {
				observations: [observation("2026-05-02T10:00:01")],
				coversUpToId: "raw-1",
			}),
			observationsArchivedEntry("om-arch-1", {
				batchId: "b1",
				path: "p1.json",
				timestamps: ["2026-05-02T10:00:01"],
			}),
			textCustomMessage("raw-2", "bbbb"), // cutoff — everything before is folded
		];

		const result = await fire(compactEvent(branch), ctxFor(cwd, branch));
		expect(result).toBeDefined();
		expect(result.compaction.firstKeptEntryId).toBe("raw-2");
		expect(result.compaction.summary).toContain("## Session archive");
		expect(result.compaction.summary).toContain("- p1.json (1 observations)");
		// The observation folded from the prefix is still rendered alongside it.
		expect(result.compaction.summary).toContain("2026-05-02T10:00:01");
		expect(runtime.compactHookInFlight).toBe(false);
	});

	it("omits the Session archive section when nothing was archived", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "om-compaction-noarchive-"));
		tempDirs.push(cwd);
		const { fire } = setup(cwd);

		const branch: TestEntry[] = [
			textCustomMessage("raw-1", "aaaa"),
			observationsRecordedEntry("om-1", {
				observations: [observation("2026-05-02T10:00:01")],
				coversUpToId: "raw-1",
			}),
			textCustomMessage("raw-2", "bbbb"),
		];

		const result = await fire(compactEvent(branch), ctxFor(cwd, branch));
		expect(result.compaction.summary).not.toContain("## Session archive");
	});
});
