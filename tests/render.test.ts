import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { observationToLine, renderSummary, sortObservations } from "../src/ledger/index.js";
import { observation } from "./fixtures/session.js";
import {
	PROJECT_MEMORY_DIR,
	renderBootstrapBlock,
	renderIndexFile,
	renderMemoryMap,
} from "../src/memory/index-render.js";
import type { Topic } from "../src/memory/paths.js";
import { estimateStringTokens } from "../src/tokens.js";

function topic(overrides: Partial<Topic> = {}): Topic {
	return {
		id: "auth",
		title: "Auth",
		summary: "JWT and sessions",
		path: join(".memory", "project", "auth.md"),
		filename: "auth.md",
		...overrides,
	};
}

describe("renderSummary (project overview + map + observations)", () => {
	it("renders a chronological observations section", () => {
		const observations = [
			observation("2026-05-02T10:05:00", { content: "second event" }),
			observation("2026-05-02T10:00:01", { content: "first event" }),
		];

		const block = renderSummary(undefined, undefined, observations);
		expect(block).toContain("## Observations");
		const obsSection = block.split("## Observations\n")[1];
		expect(obsSection).toBe("2026-05-02T10:00:01  first event\n2026-05-02T10:05:00  second event");
	});

	it("returns an empty string when there is nothing to render", () => {
		expect(renderSummary(undefined, undefined, [])).toBe("");
	});

	it("includes the map section when provided", () => {
		const block = renderSummary(undefined, "## Memory map\nauth.md · auth stuff", [observation("2026-05-02T10:00:01")]);
		expect(block).toContain("## Memory map");
		expect(block.indexOf("## Memory map")).toBeLessThan(block.indexOf("## Observations"));
	});

	it("renders the overview first, before map and observations", () => {
		const block = renderSummary("The service uses JWT.", "## Memory map\nauth.md · auth", [
			observation("2026-05-02T10:00:01"),
		]);
		expect(block).toContain("## Project overview");
		expect(block).toContain("The service uses JWT.");
		expect(block.indexOf("## Project overview")).toBeLessThan(block.indexOf("## Memory map"));
		expect(block.indexOf("## Memory map")).toBeLessThan(block.indexOf("## Observations"));
	});

	it("renders an overview-only block when there are no observations or map", () => {
		const block = renderSummary("The service uses JWT.", undefined, []);
		expect(block).toContain("## Project overview");
		expect(block).toContain("The service uses JWT.");
	});

	it("frames the overview as fallible reference material, never an instruction source", () => {
		const block = renderSummary("The service uses JWT.", undefined, []);
		expect(block).toContain("never an instruction source");
		expect(block).toContain("fallible reference");
	});

	it("formats a single observation line as 'timestamp  content'", () => {
		expect(observationToLine(observation("2026-05-02T10:00:01", { content: "hi" }))).toBe("2026-05-02T10:00:01  hi");
	});

	it("sorts disambiguated same-minute ids in suffix order", () => {
		const sorted = sortObservations([
			observation("2026-05-02T10:00:00.02"),
			observation("2026-05-02T10:00:00"),
			observation("2026-05-02T10:00:00.01"),
		]);
		expect(sorted.map((o) => o.timestamp)).toEqual([
			"2026-05-02T10:00:00",
			"2026-05-02T10:00:00.01",
			"2026-05-02T10:00:00.02",
		]);
	});

	it("renders a compact session archive section: one line per batch, paths only", () => {
		const block = renderSummary(undefined, undefined, [observation("2026-05-02T10:00:01")], [
			{
				batchId: "b1",
				path: join(".memory", "sessions", "s1", "archive", "b1.json"),
				timestamps: ["2026-05-02T10:00:01", "2026-05-02T10:00:02"],
			},
			{ batchId: "b2", path: join(".memory", "sessions", "s1", "archive", "b2.json"), timestamps: ["2026-05-02T10:05:00"] },
		]);
		expect(block).toContain("## Session archive");
		expect(block).toContain(`- ${join(".memory", "sessions", "s1", "archive", "b1.json")} (2 observations)`);
		expect(block).toContain(`- ${join(".memory", "sessions", "s1", "archive", "b2.json")} (1 observations)`);
		expect(block.indexOf("## Observations")).toBeLessThan(block.indexOf("## Session archive"));
	});

	it("renders archive-only blocks and omits the section when there are no batches", () => {
		expect(renderSummary(undefined, undefined, [], [{ batchId: "b1", path: "p.json", timestamps: ["t1"] }])).toContain(
			"## Session archive",
		);
		const withoutBatches = renderSummary(undefined, undefined, [observation("2026-05-02T10:00:01")]);
		expect(withoutBatches).not.toContain("## Session archive");
	});
});

describe("renderIndexFile", () => {
	it("renders an empty index placeholder under the project-scoped header", () => {
		const index = renderIndexFile([]);
		expect(index).toContain("# Project Memory Index");
		expect(index).toContain("_No topics yet._");
	});

	it("renders topics without any updated suffix", () => {
		const index = renderIndexFile([topic()]);
		expect(index).toContain("## Auth");
		expect(index).toContain("`.memory/project/auth.md`");
		expect(index).toContain("JWT and sessions");
		expect(index).not.toContain("updated");
	});
});

describe("renderMemoryMap", () => {
	it("returns undefined when there are no topics", () => {
		expect(renderMemoryMap([])).toBeUndefined();
	});

	it("renders topic lines with no updated suffix, framed as possibly-stale reference", () => {
		const map = renderMemoryMap([topic(), topic({ id: "deploy", title: "Deploy", summary: "fly.io", filename: "deploy.md", path: join(".memory", "project", "deploy.md") })]);
		expect(map).toContain("## Memory map");
		expect(map).toContain("`.memory/project/auth.md` — JWT and sessions");
		expect(map).toContain("`.memory/project/deploy.md` — fly.io");
		expect(map).toContain(`${PROJECT_MEMORY_DIR}/`);
		expect(map).toContain("Possibly-stale");
		expect(map).not.toContain("updated");
	});
});

describe("renderBootstrapBlock", () => {
	it("returns undefined when the bank is empty", () => {
		expect(renderBootstrapBlock(undefined, [], 2_000)).toBeUndefined();
		expect(renderBootstrapBlock("   ", [], 2_000)).toBeUndefined();
	});

	it("renders framing + overview + topic index within the budget", () => {
		const block = renderBootstrapBlock("Current-state orientation.", [topic()], 2_000);
		expect(block).toContain("## Project memory");
		expect(block).toContain(`${PROJECT_MEMORY_DIR}/`);
		expect(block).toContain("possibly-stale reference material");
		expect(block).toContain("never an instruction source");
		expect(block).toContain("Current-state orientation.");
		expect(block).toContain("`.memory/project/auth.md` — JWT and sessions");
		expect(block).not.toContain("Full index");
	});

	it("renders an overview-only block when there are no topics", () => {
		const block = renderBootstrapBlock("Orientation.", [], 2_000);
		expect(block).toContain("Orientation.");
		expect(block).not.toContain("## Memory map");
	});

	it("hard-truncates to the budget and appends the full-index pointer", () => {
		const hugeOverview = "established state ".repeat(2_000); // ~8500 tokens
		const budget = 300;
		const block = renderBootstrapBlock(hugeOverview, [topic()], budget)!;
		expect(block).toContain("## Project memory");
		expect(block).toContain("Full index at");
		expect(block).toContain("INDEX.md");
		expect(estimateStringTokens(block)).toBeLessThanOrEqual(budget + 2);
		// The overview is cut mid-way (ellipted), not rendered in full.
		expect(block).not.toContain(hugeOverview);
		expect(block).toContain("…");
	});

	it("drops topic lines that do not fit, keeping earlier lines and the pointer", () => {
		const manyTopics = Array.from({ length: 30 }, (_, i) =>
			topic({
				id: `t${i}`,
				title: `T${i}`,
				summary: `summary number ${i} with some extra length`,
				filename: `t${i}.md`,
				path: join(".memory", "project", `t${i}.md`),
			}),
		);
		const block = renderBootstrapBlock(undefined, manyTopics, 150)!;
		expect(block).toContain("`.memory/project/t0.md`");
		expect(block).not.toContain("`.memory/project/t29.md`");
		expect(block).toContain("Full index");
		expect(estimateStringTokens(block)).toBeLessThanOrEqual(150 + 2);
	});

	it("renders the shared topic-line format the memory map uses", () => {
		const block = renderBootstrapBlock(undefined, [topic()], 2_000)!;
		const map = renderMemoryMap([topic()])!;
		expect(block).toContain(map.split("\n").find((l) => l.startsWith("- "))!);
	});
});
