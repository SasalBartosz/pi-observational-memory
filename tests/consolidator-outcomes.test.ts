import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";

import { registerConsolidatorOutcomeTool } from "../agent/consolidator/outcomes.js";
import omWorker from "../agent/index.js";
import type { ToolText } from "../agent/tool-text.js";
import * as runFiles from "../src/spawn/runs.js";
import { readConsolidatorResult, writeConsolidatorBatch, type ConsolidatorBatch } from "../src/spawn/runs.js";

type CapturedTool = {
	name: string;
	description: string;
	executionMode?: string;
	parameters: unknown;
	execute: (id: string, params: unknown) => Promise<ToolText>;
};

function captureTool(): { pi: any; tool: () => CapturedTool } {
	const tools = new Map<string, CapturedTool>();
	return {
		pi: { registerTool: (def: CapturedTool) => tools.set(def.name, def) },
		tool: () => {
			const tool = tools.get("report_consolidation_outcomes");
			if (!tool) throw new Error("outcome tool was not registered");
			return tool;
		},
	};
}

const tempDirs: string[] = [];
function tempResultPath(): string {
	const dir = mkdtempSync(join(tmpdir(), "om-cons-outcomes-"));
	tempDirs.push(dir);
	return join(dir, "run.consolidation.json");
}

// These suffixes caused timestamp transcription failures in real batches.
const batch: ConsolidatorBatch = {
	batchId: "batch-abc",
	timestamps: [
		"2026-10-25T01:37:00",
		"2026-10-25T01:37:00.01",
		"2026-10-25T01:37:00.02",
		"2026-10-25T01:37:00.10",
		"2026-10-25T01:37:01",
	],
};

function setup(submitted = batch): { path: string; tool: CapturedTool } {
	const { pi, tool } = captureTool();
	const path = tempResultPath();
	registerConsolidatorOutcomeTool(pi, path, submitted);
	return { path, tool: tool() };
}

const report = (outcomes: unknown) => ({ batchId: batch.batchId, outcomes });

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("registerConsolidatorOutcomeTool", () => {
	it("does not seed acknowledgements and executes sequentially", () => {
		const { path, tool } = setup();
		expect(existsSync(path)).toBe(false);
		expect(tool.executionMode).toBe("sequential");
	});

	it("maps numeric labels to exact canonical timestamps", async () => {
		const { path, tool } = setup();
		const dispositions = ["promoted", "retained", "discarded", "promoted", "retained"] as const;
		const result = await tool.execute("report", report(dispositions.map((disposition, i) => ({ index: i + 1, disposition }))));

		expect(result.details).toMatchObject({ total: 5, promoted: 2, retained: 2, discarded: 1 });
		expect(readConsolidatorResult(path)).toEqual({
			batchId: batch.batchId,
			outcomes: batch.timestamps.map((timestamp, i) => ({ timestamp, disposition: dispositions[i] })),
		});
	});

	it("persists valid partial progress before throwing an actionable tool error", async () => {
		const { path, tool } = setup();
		await expect(tool.execute("partial", report([
			{ index: 1, disposition: "promoted" }, { index: 3, disposition: "discarded" },
		]))).rejects.toThrow(/Missing indices: 2, 4, 5/);
		expect(readConsolidatorResult(path).outcomes).toEqual([
			{ timestamp: batch.timestamps[0], disposition: "promoted" },
			{ timestamp: batch.timestamps[2], disposition: "discarded" },
		]);
	});

	it("completes the accumulated report with just the missing entries", async () => {
		const { path, tool } = setup();
		await expect(tool.execute("first", report([{ index: 1, disposition: "promoted" }]))).rejects.toThrow(/Missing indices/);
		const second = await tool.execute("repair", report([2, 3, 4, 5].map((index) => ({ index, disposition: "retained" }))));
		expect(second.details).toMatchObject({ total: 5, promoted: 1, retained: 4 });
		expect(readConsolidatorResult(path).outcomes.map((outcome) => outcome.timestamp)).toEqual(batch.timestamps);
	});

	it("corrects an earlier entry without dropping the others", async () => {
		const { path, tool } = setup();
		await tool.execute("first", report(batch.timestamps.map((_, i) => ({ index: i + 1, disposition: "retained" }))));
		const corrected = await tool.execute("correct", report([{ index: 4, disposition: "promoted" }]));
		expect(corrected.details).toMatchObject({ total: 5, promoted: 1, retained: 4 });
		expect(readConsolidatorResult(path).outcomes).toEqual(batch.timestamps.map((timestamp, i) => ({
			timestamp, disposition: i === 3 ? "promoted" : "retained",
		})));
	});

	it("never defaults an empty report to a disposition", async () => {
		const { path, tool } = setup();
		await expect(tool.execute("empty", report([]))).rejects.toThrow(/Missing indices: 1, 2, 3, 4, 5/);
		expect(readConsolidatorResult(path)).toEqual({ batchId: batch.batchId, outcomes: [] });
	});

	it("rejects a wrong batch id without creating a result", async () => {
		const { path, tool } = setup();
		await expect(tool.execute("wrong", { batchId: "wrong-id", outcomes: [{ index: 1, disposition: "promoted" }] }))
			.rejects.toThrow(/batchId mismatch/);
		expect(existsSync(path)).toBe(false);
	});

	// pi validates arguments against the tool schema before execute() ever runs.
	it.each([
		["index zero", [{ index: 0, disposition: "promoted" }]],
		["missing index", [{ disposition: "promoted" }]],
		["null entry", [null]],
		["unknown disposition", [{ index: 2, disposition: "maybe" }]],
		["malformed outcomes", null],
	])("the schema rejects %s before execution", (_name, outcomes) => {
		const { tool } = setup();
		expect(() => validateToolArguments(tool as any, {
			type: "toolCall", id: "invalid", name: tool.name, arguments: report(outcomes),
		} as any)).toThrow(/Validation failed/);
	});

	it.each([
		["index past the end", [{ index: batch.timestamps.length + 1, disposition: "promoted" }]],
		["duplicate index", [{ index: 2, disposition: "promoted" }, { index: 2, disposition: "retained" }]],
	])("invalid %s leaves memory and disk unchanged", async (_name, outcomes) => {
		const { path, tool } = setup();
		await expect(tool.execute("seed", report([{ index: 1, disposition: "retained" }]))).rejects.toThrow(/Missing indices/);
		const before = readFileSync(path, "utf-8");
		await expect(tool.execute("invalid", report(outcomes))).rejects.toThrow();
		expect(readFileSync(path, "utf-8")).toBe(before);
		// Persist the in-memory state again to prove the rejected call changed neither copy.
		await expect(tool.execute("check", report([]))).rejects.toThrow(/Missing indices/);
		expect(readFileSync(path, "utf-8")).toBe(before);
	});

	it("rejects a whole call without remembering even its valid entries", async () => {
		const { path, tool } = setup();
		await expect(tool.execute("invalid", report([
			{ index: 1, disposition: "promoted" }, { index: 999, disposition: "promoted" },
		]))).rejects.toThrow(/invalid observation index/);
		expect(existsSync(path)).toBe(false);
		await expect(tool.execute("repair", report([2, 3, 4, 5].map((index) => ({ index, disposition: "retained" })))))
			.rejects.toThrow(/Missing indices: 1\./);
		expect(readConsolidatorResult(path).outcomes).toHaveLength(4);
	});

	it("does not remember new entries when persistence fails", async () => {
		const { path, tool } = setup();
		await expect(tool.execute("seed", report([{ index: 1, disposition: "retained" }]))).rejects.toThrow(/Missing indices/);
		const before = readFileSync(path, "utf-8");
		vi.spyOn(runFiles, "writeConsolidatorResult").mockImplementationOnce(() => { throw new Error("disk full"); });
		await expect(tool.execute("failed-write", report([{ index: 2, disposition: "promoted" }]))).rejects.toThrow("disk full");
		expect(readFileSync(path, "utf-8")).toBe(before);
		await expect(tool.execute("repair", report([3, 4, 5].map((index) => ({ index, disposition: "retained" })))))
			.rejects.toThrow(/Missing indices: 2\./);
		expect(readConsolidatorResult(path).outcomes.map((outcome) => outcome.timestamp)).toEqual([
			batch.timestamps[0], ...batch.timestamps.slice(2),
		]);
	});

	it("repairs one omission in a 214-observation batch without re-emitting the other 213", async () => {
		const largeBatch = {
			batchId: "large-batch",
			timestamps: Array.from({ length: 214 }, (_, index) =>
				`2026-10-25T01:37:00${index === 0 ? "" : `.${String(index).padStart(2, "0")}`}`),
		};
		const { path, tool } = setup(largeBatch);
		await expect(tool.execute("partial", {
			batchId: largeBatch.batchId,
			outcomes: largeBatch.timestamps.map((_, i) => ({ index: i + 1, disposition: "promoted" }))
				.filter((outcome) => outcome.index !== 4),
		})).rejects.toThrow(/Missing indices: 4\./);
		expect(readConsolidatorResult(path).outcomes).toHaveLength(213);
		const complete = await tool.execute("repair", {
			batchId: largeBatch.batchId, outcomes: [{ index: 4, disposition: "retained" }],
		});
		expect(complete.details).toMatchObject({ total: 214, promoted: 213, retained: 1 });
		expect(readConsolidatorResult(path).outcomes.map((outcome) => outcome.timestamp)).toEqual(largeBatch.timestamps);
	});

	it("describes numeric labels, merging, and archive-only retention", () => {
		const { tool } = setup();
		expect(tool.description).toContain("1-based numeric label");
		expect(tool.description).toContain("Calls merge");
		expect(tool.description).toContain("session archive, not the active pool");
	});
});

describe("consolidator worker startup", () => {
	function startupEnv(): { path: string; pi: any; tool: () => CapturedTool } {
		const path = tempResultPath();
		const batchPath = `${path}.batch.json`;
		writeConsolidatorBatch(batchPath, batch);
		vi.stubEnv("OM_WORKER", "consolidator");
		vi.stubEnv("OM_MEMORY_DIR", join(dirname(path), "bank"));
		vi.stubEnv("OM_RESULT_PATH", path);
		vi.stubEnv("OM_BATCH_PATH", batchPath);
		const { pi, tool } = captureTool();
		pi.on = vi.fn();
		return { path, pi, tool };
	}

	it("loads the manifest and wires up reporting without seeding defaults", async () => {
		const { path, pi, tool } = startupEnv();
		omWorker(pi);
		expect(existsSync(path)).toBe(false);
		await expect(tool().execute("report", report([{ index: 4, disposition: "promoted" }]))).rejects.toThrow(/Missing indices/);
		expect(readConsolidatorResult(path).outcomes).toEqual([{ timestamp: batch.timestamps[3], disposition: "promoted" }]);
	});

	it("requires an authoritative manifest path", () => {
		const { pi } = startupEnv();
		vi.stubEnv("OM_BATCH_PATH", undefined);
		expect(() => omWorker(pi)).toThrow(/OM_BATCH_PATH not set/);
	});
});
