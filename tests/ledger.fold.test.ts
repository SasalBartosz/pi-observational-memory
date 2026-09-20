import { describe, expect, it } from "vitest";

import { foldLedger } from "../src/ledger/index.js";
import {
	branchSummary,
	observation,
	observationsArchivedEntry,
	observationsDroppedEntry,
	observationsRecordedEntry,
	textCustomMessage,
	unknownCustomEntry,
} from "./fixtures/session.js";

describe("foldLedger (minimal schema, timestamp-keyed)", () => {
	it("folds observations from branch root through the target entry", () => {
		const obs1 = observation("2026-05-02T10:00:01");
		const obs2 = observation("2026-05-02T10:05:00");
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			observationsRecordedEntry("om-1", { observations: [obs1], coversUpToId: "raw-1" }),
			textCustomMessage("raw-2", "bbbb"),
			observationsRecordedEntry("om-2", { observations: [obs2], coversUpToId: "raw-2" }),
		];

		const folded = foldLedger(entries, { upToEntryId: "om-1" });

		expect(folded.observations.map((o) => o.timestamp)).toEqual(["2026-05-02T10:00:01"]);
		expect(folded.activeObservations.map((o) => o.timestamp)).toEqual(["2026-05-02T10:00:01"]);
		expect(folded.observationsByTimestamp.get("2026-05-02T10:05:00")).toBeUndefined();
	});

	it("applies drops as tombstones while preserving observation history", () => {
		const obs1 = observation("2026-05-02T10:00:01");
		const obs2 = observation("2026-05-02T10:00:02");
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			observationsRecordedEntry("om-1", { observations: [obs1, obs2], coversUpToId: "raw-1" }),
			observationsDroppedEntry("om-drop-1", { observationTimestamps: ["2026-05-02T10:00:01"], coversUpToId: "raw-1" }),
		];

		const folded = foldLedger(entries);

		expect(folded.observations.map((o) => o.timestamp)).toEqual(["2026-05-02T10:00:01", "2026-05-02T10:00:02"]);
		expect(folded.activeObservations.map((o) => o.timestamp)).toEqual(["2026-05-02T10:00:02"]);
		expect(folded.droppedObservationTimestamps.has("2026-05-02T10:00:01")).toBe(true);
		expect(folded.observationsByTimestamp.get("2026-05-02T10:00:01")).toEqual(obs1);
	});

	it("keeps the first valid observation when duplicate timestamp-ids appear", () => {
		const first = observation("2026-05-02T10:00:01", { content: "first" });
		const dup = observation("2026-05-02T10:00:01", { content: "duplicate" });
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			observationsRecordedEntry("om-1", { observations: [first], coversUpToId: "raw-1" }),
			observationsRecordedEntry("om-2", { observations: [dup], coversUpToId: "raw-1" }),
		];

		const folded = foldLedger(entries);

		expect(folded.observationsByTimestamp.get("2026-05-02T10:00:01")?.content).toBe("first");
		expect(folded.observations).toHaveLength(1);
	});

	it("retains tombstones for unknown drop timestamps without throwing", () => {
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			observationsDroppedEntry("om-drop-1", { observationTimestamps: ["2099-01-01T00:00:00"], coversUpToId: "raw-1" }),
		];

		const folded = foldLedger(entries);

		expect(folded.droppedObservationTimestamps.has("2099-01-01T00:00:00")).toBe(true);
		expect(folded.activeObservations).toEqual([]);
	});

	it("collects archived batch pointers without affecting active observations, deduped by batchId", () => {
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			observationsRecordedEntry("om-1", {
				observations: [observation("2026-05-02T10:00:01")],
				coversUpToId: "raw-1",
			}),
			observationsArchivedEntry("om-arch-1", {
				batchId: "b1",
				path: ".memory/sessions/s1/archive/b1.json",
				timestamps: ["2026-05-02T10:00:01"],
			}),
			// Replay of the same batch (same deterministic batchId): merges, not duplicates.
			observationsArchivedEntry("om-arch-2", {
				batchId: "b1",
				path: ".memory/sessions/s1/archive/b1.json",
				timestamps: ["2026-05-02T10:00:01"],
			}),
			observationsArchivedEntry("om-arch-3", {
				batchId: "b2",
				path: ".memory/sessions/s1/archive/b2.json",
				timestamps: ["2026-05-02T10:00:01"],
			}),
		];

		const folded = foldLedger(entries);

		expect(folded.archivedBatches.map((b) => b.batchId)).toEqual(["b1", "b2"]);
		// Archived entries are pure metadata: the observation stays active.
		expect(folded.activeObservations.map((o) => o.timestamp)).toEqual(["2026-05-02T10:00:01"]);
	});

	it("ignores invalid archived data", () => {
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			unknownCustomEntry("om-arch-invalid", "om.observations.archived", { batchId: "x", path: "" }),
		];

		const folded = foldLedger(entries);

		expect(folded.archivedBatches).toEqual([]);
	});

	it("ignores unknown custom entries and invalid data", () => {
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			unknownCustomEntry("other", "other.memory", { any: true }),
			observationsRecordedEntry("invalid", { observations: [], coversUpToId: "raw-1" }),
		];

		const folded = foldLedger(entries);

		expect(folded.observations).toEqual([]);
		expect(folded.activeObservations).toEqual([]);
	});

	it("folds only the branch path supplied by the caller", () => {
		const mainObs = observation("2026-05-02T10:00:01");
		const forkObs = observation("2026-05-02T11:00:01");
		const mainBranch = [
			branchSummary("root", "root summary"),
			textCustomMessage("raw-main", "main"),
			observationsRecordedEntry("main-ledger", { observations: [mainObs], coversUpToId: "raw-main" }),
		];
		const forkBranch = [
			branchSummary("root", "root summary"),
			textCustomMessage("raw-fork", "fork"),
			observationsRecordedEntry("fork-ledger", { observations: [forkObs], coversUpToId: "raw-fork" }),
		];

		expect(foldLedger(mainBranch).observations.map((o) => o.timestamp)).toEqual(["2026-05-02T10:00:01"]);
		expect(foldLedger(forkBranch).observations.map((o) => o.timestamp)).toEqual(["2026-05-02T11:00:01"]);
	});
});
