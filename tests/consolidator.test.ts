import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The dispatch tests drive the orchestrator end-to-end with a faked `pi` and a faked
// subprocess: only spawnWorker is replaced — the real lock, archive, outcome validation,
// ledger appends, and INDEX regeneration all run for real against a temp dir.
vi.mock("../src/spawn/launch.js", async (importOriginal) => {
	const actual = await importOriginal<Record<string, unknown>>();
	return { ...actual, spawnWorker: vi.fn() };
});

import { registerConsolidatorTools } from "../agent/consolidator/tools.js";
import { DEFAULTS } from "../src/config.js";
import {
	deriveBatchId,
	dispatchConsolidator,
	evaluateConsolidatorTrigger,
	validateConsolidatorOutcomes,
} from "../src/hooks/consolidator-trigger.js";
import {
	OM_OBSERVATIONS_ARCHIVED,
	OM_OBSERVATIONS_DROPPED,
	foldLedger,
	type Entry,
} from "../src/ledger/index.js";
import { acquireProjectLock, inspectProjectLock, releaseProjectLock } from "../src/memory/lock.js";
import { indexPath } from "../src/memory/paths.js";
import { Runtime } from "../src/runtime.js";
import { buildWorkerEnv, spawnWorker } from "../src/spawn/launch.js";
import { writeConsolidatorResult, type ConsolidatorOutcome } from "../src/spawn/runs.js";
import {
	observation,
	observationsRecordedEntry,
	rawMessage,
	type TestObservation,
} from "./fixtures/session.js";

const spawnMock = vi.mocked(spawnWorker);

/** Observation lines inside the kickoff prompt: "<timestamp>  <content>". */
function parseBatchTimestamps(argv: string[]): string[] {
	const prompt = argv[argv.indexOf("-p") + 1] ?? "";
	const section = prompt.split("OBSERVATIONS TO CONSOLIDATE")[1] ?? "";
	return [...section.matchAll(/^(\S+) {2}/gm)].map((match) => match[1] ?? "");
}

const allPromoted = (timestamps: string[]): ConsolidatorOutcome[] =>
	timestamps.map((timestamp) => ({ timestamp, disposition: "promoted" as const }));

type FakeWorkerBehavior = {
	exitCode?: number;
	/** Outcome list for the submitted timestamps; defaults to all promoted. */
	outcomes?: (timestamps: string[]) => ConsolidatorOutcome[];
	/** Override the batchId written into the result file (wrong-batchId case). */
	batchIdOverride?: string;
	/** Skip writing the result file entirely (missing-file case). */
	skipResult?: boolean;
	/** Runs synchronously when the fake worker starts — mid-run commits, session flips, captures. */
	onRun?: (opts: { argv: string[]; env: NodeJS.ProcessEnv }) => void;
};

/** Queue one fake consolidator subprocess run (consumed before the default implementation). */
function queueFakeWorker(behavior: FakeWorkerBehavior = {}): void {
	spawnMock.mockImplementationOnce(async (opts) => {
		behavior.onRun?.(opts);
		if (!behavior.skipResult) {
			const timestamps = parseBatchTimestamps(opts.argv);
			const outcomes = (behavior.outcomes ?? allPromoted)(timestamps);
			writeConsolidatorResult(opts.env.OM_RESULT_PATH ?? "", {
				batchId: behavior.batchIdOverride ?? opts.env.OM_BATCH_ID ?? "",
				outcomes,
			});
		}
		return { code: behavior.exitCode ?? 0, signal: null, stderr: "" };
	});
}

function defaultObservations(): TestObservation[] {
	return [
		observation("2026-05-02T10:00:01"),
		observation("2026-05-02T10:00:02"),
		observation("2026-05-02T10:00:03"),
	];
}

type Harness = {
	cwd: string;
	branch: Entry[];
	runtime: Runtime;
	// A minimal stand-in for ExtensionAPI: only appendEntry is exercised on this path.
	pi: any;
	ctx: {
		cwd: string;
		hasUI: boolean;
		sessionManager: {
			getBranch: () => Entry[];
			getEntries: () => Entry[];
			getSessionId: () => string;
		};
		getContextUsage: () => { tokens: number | null };
	};
	observations: TestObservation[];
	setSessionId: (id: string) => void;
};

const tempDirs: string[] = [];

function makeHarness(
	args: { observations?: TestObservation[]; sessionId?: string; cwd?: string } = {},
): Harness {
	const cwd = args.cwd ?? mkdtempSync(join(tmpdir(), "om-cons-dispatch-"));
	tempDirs.push(cwd);
	const observations = args.observations ?? defaultObservations();
	const branch: Entry[] = [
		rawMessage("raw-1", "hello world conversation text"),
		observationsRecordedEntry("om-1", { observations, coversUpToId: "raw-1" }),
	];
	let sessionId = args.sessionId ?? "sess-1";
	const sessionManager = {
		getBranch: () => branch,
		getEntries: () => branch,
		getSessionId: () => sessionId,
	};
	const runtime = new Runtime();
	runtime.enabled = true;
	runtime.config = { ...DEFAULTS, poolTargetTokens: 10, consolidateAtPoolTokens: 100 };
	runtime.configLoaded = true;
	runtime.activatePaths({ cwd, sessionManager });
	let appended = 0;
	const pi = {
		appendEntry: (customType: string, data: unknown) => {
			appended += 1;
			branch.push({
				type: "custom",
				id: `appended-${appended}`,
				parentId: null,
				timestamp: "2026-05-02T10:00:00.000Z",
				customType,
				data,
			} as Entry);
		},
	};
	return {
		cwd,
		branch,
		runtime,
		pi,
		ctx: { cwd, hasUI: false, sessionManager, getContextUsage: () => ({ tokens: null }) },
		observations,
		setSessionId: (id: string) => {
			sessionId = id;
		},
	};
}

function droppedEntry(branch: Entry[]): (Entry & { data: { observationTimestamps: string[] } }) | undefined {
	const found = branch.find((entry) => entry.customType === OM_OBSERVATIONS_DROPPED);
	return found as (Entry & { data: { observationTimestamps: string[] } }) | undefined;
}

function archivedEntries(branch: Entry[]): Entry[] {
	return branch.filter((entry) => entry.customType === OM_OBSERVATIONS_ARCHIVED);
}

beforeEach(() => {
	spawnMock.mockReset();
	// Default fake worker: exit 0 with a complete, honest outcome report.
	spawnMock.mockImplementation(async (opts) => {
		const timestamps = parseBatchTimestamps(opts.argv);
		writeConsolidatorResult(opts.env.OM_RESULT_PATH ?? "", {
			batchId: opts.env.OM_BATCH_ID ?? "",
			outcomes: allPromoted(timestamps),
		});
		return { code: 0, signal: null, stderr: "" };
	});
});

afterEach(() => {
	while (tempDirs.length > 0) {
		rmSync(tempDirs.pop() ?? "", { recursive: true, force: true });
	}
});

describe("buildWorkerEnv(consolidator)", () => {
	it("sets role, run id, batch id, and the shared-bank sandbox root", () => {
		const env = buildWorkerEnv("consolidator", {
			runtimeDir: "/proj/.memory/runtime/sess-1",
			projectDir: "/proj/.memory/project",
			runId: "c1",
			batchId: "batch-abc",
		});
		expect(env.OM_WORKER).toBe("consolidator");
		expect(env.OM_RUN_ID).toBe("c1");
		expect(env.OM_MEMORY_DIR).toBe("/proj/.memory/project");
		expect(env.OM_BATCH_ID).toBe("batch-abc");
	});

	it("refuses a consolidator without a batch id", () => {
		expect(() =>
			buildWorkerEnv("consolidator", {
				runtimeDir: "/proj/.memory/runtime/sess-1",
				projectDir: "/proj/.memory/project",
				runId: "c1",
			}),
		).toThrow(/batchId/);
	});
});

describe("dispatchConsolidator (§7d ordering)", () => {
	it("archives the batch first, then on valid outcomes tombstones it and regenerates INDEX under the lock", async () => {
		const h = makeHarness();
		queueFakeWorker();
		await dispatchConsolidator(h.pi, h.runtime, h.ctx, h.observations);

		const timestamps = h.observations.map((o) => o.timestamp);
		const batchId = deriveBatchId("sess-1", timestamps);
		const archivePath = join(h.runtime.archiveDir, `${batchId}.json`);

		// Step 1: the batch was archived verbatim under its deterministic id.
		expect(existsSync(archivePath)).toBe(true);
		const archived = JSON.parse(readFileSync(archivePath, "utf-8")) as {
			batchId: string;
			observations: TestObservation[];
		};
		expect(archived.batchId).toBe(batchId);
		expect(archived.observations.map((o) => o.timestamp)).toEqual(timestamps);

		// The archive map landed in the ledger (path relative to cwd).
		const archiveEntries = archivedEntries(h.branch);
		expect(archiveEntries).toHaveLength(1);
		expect(archiveEntries[0]!.data).toEqual({
			batchId,
			path: join(".memory", "sessions", "sess-1", "archive", `${batchId}.json`),
			timestamps,
		});
		expect(foldLedger(h.branch).archivedBatches).toHaveLength(1);

		// Step 4: the worker got the batch id in env and prompt; nothing dated anywhere.
		expect(spawnMock).toHaveBeenCalledTimes(1);
		const call = spawnMock.mock.calls[0]!;
		expect(call[0].env.OM_BATCH_ID).toBe(batchId);
		const prompt = call[0].argv[call[0].argv.indexOf("-p") + 1] as string;
		expect(prompt).toContain(`"${batchId}"`);
		expect(prompt).toContain("report_consolidation_outcomes");
		expect(prompt).not.toContain("Current local time:");

		// Steps 5–6: valid outcomes → the whole batch drained, INDEX regenerated.
		const dropped = droppedEntry(h.branch);
		expect(dropped?.data.observationTimestamps.sort()).toEqual([...timestamps].sort());
		expect(foldLedger(h.branch).activeObservations).toHaveLength(0);
		expect(readFileSync(indexPath(h.runtime.projectDir), "utf-8")).toContain("# Project Memory Index");

		// Step 7: lock released, in-process guard reset.
		expect(inspectProjectLock(h.runtime.projectDir)).toBeUndefined();
		expect(h.runtime.consolidatorInFlight).toBe(false);
	});

	it("archives before drain: the archive file survives a failed worker and the batch stays active", async () => {
		const h = makeHarness();
		queueFakeWorker({ exitCode: 1 });
		await dispatchConsolidator(h.pi, h.runtime, h.ctx, h.observations);

		const batchId = deriveBatchId("sess-1", h.observations.map((o) => o.timestamp));
		const archivePath = join(h.runtime.archiveDir, `${batchId}.json`);
		expect(existsSync(archivePath)).toBe(true);
		expect(JSON.parse(readFileSync(archivePath, "utf-8")).observations).toHaveLength(3);

		// No tombstone: the batch is retryable.
		expect(droppedEntry(h.branch)).toBeUndefined();
		expect(foldLedger(h.branch).activeObservations).toHaveLength(3);
		expect(inspectProjectLock(h.runtime.projectDir)).toBeUndefined();
		expect(h.runtime.lastWorkerError).toContain("code 1");
	});

	it("deterministic batchId: a retry of the same batch reuses the same archive name (idempotent, merges in the fold)", async () => {
		const h = makeHarness();
		queueFakeWorker();
		await dispatchConsolidator(h.pi, h.runtime, h.ctx, h.observations);
		const afterFirst = readdirSync(h.runtime.archiveDir);
		expect(afterFirst).toHaveLength(1);

		// Same observations again (a retry after a failed first attempt, say).
		queueFakeWorker();
		await dispatchConsolidator(h.pi, h.runtime, h.ctx, h.observations);

		const afterSecond = readdirSync(h.runtime.archiveDir);
		expect(afterSecond).toEqual(afterFirst); // same name → overwritten in place, not duplicated
		// Ledger side: replayed archive entries merge by batchId in the fold…
		expect(archivedEntries(h.branch)).toHaveLength(2);
		expect(foldLedger(h.branch).archivedBatches).toHaveLength(1);
		// …and the second tombstone is a no-op (nothing still active).
		expect(h.branch.filter((entry) => entry.customType === OM_OBSERVATIONS_DROPPED)).toHaveLength(1);
	});

	it("secret-screens observations out of the archive and the submitted batch, but still drains them", async () => {
		const secret = observation("2026-05-02T10:00:02", {
			content: "rotated the deploy password=hunter2secretvalue yesterday",
		});
		const observations = [observation("2026-05-02T10:00:01"), secret, observation("2026-05-02T10:00:03")];
		const h = makeHarness({ observations });
		let seenPrompt = "";
		queueFakeWorker({
			onRun: (opts) => {
				seenPrompt = opts.argv[opts.argv.indexOf("-p") + 1] ?? "";
			},
		});
		await dispatchConsolidator(h.pi, h.runtime, h.ctx, observations);

		const safe = [observations[0]!, observations[2]!];
		const batchId = deriveBatchId("sess-1", safe.map((o) => o.timestamp));
		const archivePath = join(h.runtime.archiveDir, `${batchId}.json`);
		const archived = JSON.parse(readFileSync(archivePath, "utf-8")) as { observations: TestObservation[] };
		expect(archived.observations.map((o) => o.timestamp)).toEqual(
			safe.map((o) => o.timestamp),
		);

		// The worker was never shown the secret.
		expect(seenPrompt).not.toContain("hunter2secretvalue");
		// The screened observation is accounted as immediately discarded and drains anyway.
		const dropped = droppedEntry(h.branch);
		expect(dropped?.data.observationTimestamps.sort()).toEqual(
			[...observations.map((o) => o.timestamp)].sort(),
		);
		expect(foldLedger(h.branch).activeObservations).toHaveLength(0);
	});

	it.each([
		[
			"missing result file",
			{ skipResult: true },
		],
		[
			"wrong batchId",
			{ batchIdOverride: "deadbeefdeadbeef" },
		],
		[
			"missing timestamp",
			{ outcomes: (timestamps: string[]) => allPromoted(timestamps.slice(1)) },
		],
		[
			"extra unknown timestamp",
			{
				outcomes: (timestamps: string[]) => [
					...allPromoted(timestamps),
					{ timestamp: "2099-01-01T00:00:00", disposition: "promoted" as const },
				],
			},
		],
		[
			"duplicate timestamp",
			{
				outcomes: (timestamps: string[]) => [
					...allPromoted(timestamps),
					{ timestamp: timestamps[0] ?? "", disposition: "retained" as const },
				],
			},
		],
	])("invalid outcomes (%s) → no tombstone, batch stays active, lock released", async (_name, behavior) => {
		const h = makeHarness();
		queueFakeWorker(behavior);
		await dispatchConsolidator(h.pi, h.runtime, h.ctx, h.observations);

		expect(droppedEntry(h.branch)).toBeUndefined();
		expect(foldLedger(h.branch).activeObservations).toHaveLength(3);
		expect(inspectProjectLock(h.runtime.projectDir)).toBeUndefined();
		expect(h.runtime.lastWorkerError).toContain("outcome validation failed");
	});

	it("tombstones only timestamps still active on the branch — an observation committed mid-run survives", async () => {
		const h = makeHarness();
		const midRun = observation("2026-05-02T11:30:00");
		queueFakeWorker({
			onRun: () => {
				// An observer commits during the consolidator run: NOT part of the handed batch.
				h.branch.push(
					observationsRecordedEntry("om-mid-run", { observations: [midRun], coversUpToId: "raw-1" }),
				);
			},
		});
		await dispatchConsolidator(h.pi, h.runtime, h.ctx, h.observations);

		const dropped = droppedEntry(h.branch);
		expect(dropped?.data.observationTimestamps).toEqual(h.observations.map((o) => o.timestamp));
		const active = foldLedger(h.branch).activeObservations;
		expect(active.map((o) => o.timestamp)).toEqual([midRun.timestamp]);
		expect(readFileSync(indexPath(h.runtime.projectDir), "utf-8")).toContain("# Project Memory Index");
	});

	it("session-id mismatch at commit time → no tombstone ledger entry (bank writes still land)", async () => {
		const h = makeHarness();
		queueFakeWorker({
			onRun: () => {
				h.setSessionId("sess-replacement"); // session replacement mid-run
			},
		});
		await dispatchConsolidator(h.pi, h.runtime, h.ctx, h.observations);

		expect(droppedEntry(h.branch)).toBeUndefined();
		expect(foldLedger(h.branch).activeObservations).toHaveLength(3);
		// Project-scoped bank writes belong to the run regardless of session identity.
		expect(existsSync(indexPath(h.runtime.projectDir))).toBe(true);
		expect(inspectProjectLock(h.runtime.projectDir)).toBeUndefined();
		expect(h.runtime.consolidatorInFlight).toBe(false);
	});

	it("regenerates INDEX.md BEFORE the tombstone — the acknowledgement lands only after successful index generation", async () => {
		const h = makeHarness();
		let indexAtTombstone: string | undefined;
		const baseAppendEntry = h.pi.appendEntry;
		h.pi.appendEntry = (customType: string, data: unknown) => {
			if (customType === OM_OBSERVATIONS_DROPPED) {
				indexAtTombstone = existsSync(indexPath(h.runtime.projectDir))
					? readFileSync(indexPath(h.runtime.projectDir), "utf-8")
					: undefined;
			}
			baseAppendEntry(customType, data);
		};
		queueFakeWorker({
			onRun: ({ env }) => {
				// The worker's bank write — INDEX regeneration must pick it up before the tombstone.
				writeFileSync(
					join(env.OM_MEMORY_DIR ?? "", "fresh-topic.md"),
					"---\nid: fresh-topic\ntitle: Fresh Topic\nsummary: written by the fake worker\n---\n\nbody\n",
				);
			},
		});

		const result = await dispatchConsolidator(h.pi, h.runtime, h.ctx, h.observations);

		expect(result.outcome).toBe("completed");
		// At the moment the tombstone (acknowledgement) was committed, INDEX.md already existed
		// and included the worker's fresh topic. A crash between the two leaves the batch active
		// and retryable; the reverse order would acknowledge with a stale or missing index.
		expect(indexAtTombstone).toContain("fresh-topic.md");
	});

	it("index regeneration failure → no tombstone: the batch stays active and retryable", async () => {
		const h = makeHarness();
		// Make the INDEX write fail: an INDEX.md DIRECTORY makes the temp+rename throw.
		mkdirSync(join(h.runtime.projectDir, "INDEX.md"), { recursive: true });
		queueFakeWorker();

		const result = await dispatchConsolidator(h.pi, h.runtime, h.ctx, h.observations);

		expect(result.outcome).toBe("failed");
		expect(droppedEntry(h.branch)).toBeUndefined();
		expect(foldLedger(h.branch).activeObservations).toHaveLength(3);
		expect(inspectProjectLock(h.runtime.projectDir)).toBeUndefined();
	});

	it("abortAllWorkers aborts the worker but does NOT release the lock — the dispatch's finally releases it after the exit", async () => {
		const h = makeHarness();
		let workerStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			workerStarted = resolve;
		});
		spawnMock.mockImplementationOnce(async (opts) => {
			workerStarted();
			return await new Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }>((resolve) => {
				opts.signal?.addEventListener("abort", () => resolve({ code: null, signal: "SIGTERM", stderr: "" }));
			});
		});

		const run = dispatchConsolidator(h.pi, h.runtime, h.ctx, h.observations);
		h.runtime.consolidatorInFlight = true; // the caller's guard, as in evaluateConsolidatorTrigger
		await started; // the lock is held and the (fake) worker is "running"

		h.runtime.abortAllWorkers();
		// Synchronously after the abort (the worker's close event has not been processed yet):
		// the lock must STILL be held and the in-flight flag still set — freeing the lock now
		// would let another consolidator start while the dying worker may still write.
		expect(inspectProjectLock(h.runtime.projectDir)?.sessionId).toBe("sess-1");
		expect(h.runtime.consolidatorInFlight).toBe(true);

		const result = await run; // the abort resolves the worker → the dispatch's finally releases
		expect(result.outcome).toBe("failed");
		expect(inspectProjectLock(h.runtime.projectDir)).toBeUndefined();
		expect(h.runtime.consolidatorInFlight).toBe(false);
	});

	it("busy lock → background dispatch defers without spawning; the foreign lock is left alone", async () => {
		const h = makeHarness();
		const foreign = acquireProjectLock(h.runtime.projectDir, { pid: process.pid, sessionId: "other" });
		if (foreign === "busy") throw new Error("precondition failed: lock should have been free");

		queueFakeWorker(); // must never be consumed
		await dispatchConsolidator(h.pi, h.runtime, h.ctx, h.observations);

		expect(spawnMock).not.toHaveBeenCalled();
		expect(droppedEntry(h.branch)).toBeUndefined();
		expect(foldLedger(h.branch).activeObservations).toHaveLength(3);
		expect(h.runtime.consolidatorInFlight).toBe(false); // reset → a later trigger re-fires
		// The dispatch must NOT release a lock it does not hold.
		const info = inspectProjectLock(h.runtime.projectDir);
		expect(info?.sessionId).toBe("other");

		releaseProjectLock(foreign);
		expect(inspectProjectLock(h.runtime.projectDir)).toBeUndefined();
	});

	it("two runtimes sharing one projectDir: the second dispatch defers while the first holds the lock", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "om-cons-two-"));
		tempDirs.push(cwd);
		const h1 = makeHarness({ cwd, sessionId: "sess-1" });
		const h2 = makeHarness({ cwd, sessionId: "sess-2" }); // same projectDir, different session

		let releaseGate!: () => void;
		const gate = new Promise<void>((resolve) => {
			releaseGate = resolve;
		});
		spawnMock.mockImplementationOnce(async (opts) => {
			const timestamps = parseBatchTimestamps(opts.argv);
			writeConsolidatorResult(opts.env.OM_RESULT_PATH ?? "", {
				batchId: opts.env.OM_BATCH_ID ?? "",
				outcomes: allPromoted(timestamps),
			});
			await gate; // first consolidator still running
			return { code: 0, signal: null, stderr: "" };
		});

		const first = dispatchConsolidator(h1.pi, h1.runtime, h1.ctx, h1.observations);
		// The dispatch body runs synchronously through the lock acquire, so it is held now.
		expect(inspectProjectLock(h1.runtime.projectDir)?.sessionId).toBe("sess-1");

		await dispatchConsolidator(h2.pi, h2.runtime, h2.ctx, h2.observations);
		expect(spawnMock).toHaveBeenCalledTimes(1); // second runtime never spawned
		expect(droppedEntry(h2.branch)).toBeUndefined();
		expect(foldLedger(h2.branch).activeObservations).toHaveLength(3);
		expect(h2.runtime.consolidatorInFlight).toBe(false);

		releaseGate();
		await first;
		expect(inspectProjectLock(h1.runtime.projectDir)).toBeUndefined();
		expect(droppedEntry(h1.branch)).toBeDefined();
	});
});

describe("evaluateConsolidatorTrigger (threshold clock)", () => {
	it("fires the dispatch when the active pool crosses the threshold, draining only the overflow", async () => {
		const h = makeHarness();
		h.runtime.config.consolidateAtPoolTokens = 20; // pool is 30 tokens
		h.runtime.config.poolTargetTokens = 10; // keeps the newest 10, promotes 2
		queueFakeWorker();
		evaluateConsolidatorTrigger(h.pi, h.runtime, h.ctx);

		await vi.waitFor(() => expect(h.runtime.consolidatorInFlight).toBe(false));
		expect(spawnMock).toHaveBeenCalledTimes(1);
		const active = foldLedger(h.branch).activeObservations;
		expect(active.map((o) => o.timestamp)).toEqual(["2026-05-02T10:00:03"]);
		expect(existsSync(join(h.runtime.archiveDir, `${deriveBatchId("sess-1", [
			"2026-05-02T10:00:01",
			"2026-05-02T10:00:02",
		])}.json`))).toBe(true);
	});

	it("is a no-op below the threshold", () => {
		const h = makeHarness();
		h.runtime.config.consolidateAtPoolTokens = 10_000;
		evaluateConsolidatorTrigger(h.pi, h.runtime, h.ctx);
		expect(spawnMock).not.toHaveBeenCalled();
		expect(h.runtime.consolidatorInFlight).toBe(false);
	});
});

describe("deriveBatchId", () => {
	it("is deterministic and order-insensitive over timestamps", () => {
		expect(deriveBatchId("sess-1", ["b", "a"])).toBe(deriveBatchId("sess-1", ["a", "b"]));
	});

	it("differs per session and is a short hex id", () => {
		const id = deriveBatchId("sess-1", ["a", "b"]);
		expect(id).toMatch(/^[0-9a-f]{16}$/);
		expect(id).not.toBe(deriveBatchId("sess-2", ["a", "b"]));
	});
});

describe("validateConsolidatorOutcomes", () => {
	const submitted = ["2026-05-02T10:00:01", "2026-05-02T10:00:02"];

	it("accepts an exact accounting and returns per-disposition counts", () => {
		const { counts } = validateConsolidatorOutcomes(
			{
				batchId: "b1",
				outcomes: [
					{ timestamp: submitted[0]!, disposition: "promoted" },
					{ timestamp: submitted[1]!, disposition: "retained" },
				],
			},
			"b1",
			submitted,
		);
		expect(counts).toEqual({ promoted: 1, retained: 1, discarded: 0 });
	});

	it("rejects a batchId mismatch", () => {
		expect(() =>
			validateConsolidatorOutcomes({ batchId: "other", outcomes: allPromoted(submitted) }, "b1", submitted),
		).toThrow(/batchId/);
	});
});

describe("registerConsolidatorTools (scoped to the bank root)", () => {
	let cwd: string;
	let bankRoot: string;
	let tools: Map<string, any>;

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "om-cons-tools-"));
		tempDirs.push(cwd);
		bankRoot = join(cwd, ".memory");
		tools = new Map();
		const fakePi = { registerTool: (def: any) => tools.set(def.name, def) } as any;
		registerConsolidatorTools(fakePi, bankRoot);
	});

	it("registers the scoped tool belt (no terminal report tool)", () => {
		expect([...tools.keys()].sort()).toEqual(["edit", "grep", "ls", "read", "write"].sort());
	});

	it("write then read a topic file", async () => {
		const res = await tools.get("write").execute("1", { path: "auth.md", content: "---\nid: auth\n---\nbody" });
		expect(res.content[0].text).toContain("Wrote auth.md");
		expect(readFileSync(join(bankRoot, "auth.md"), "utf-8")).toContain("body");
		const read = await tools.get("read").execute("2", { path: "auth.md" });
		expect(read.content[0].text).toContain("body");
	});

	it("refuses to write or edit INDEX.md", async () => {
		const w = await tools.get("write").execute("1", { path: "INDEX.md", content: "x" });
		expect(w.content[0].text).toContain("generated automatically");
		expect(existsSync(join(bankRoot, "INDEX.md"))).toBe(false);
	});

	it("rejects paths that escape the bank root", async () => {
		const r = await tools.get("write").execute("1", { path: "../escape.md", content: "x" });
		expect(r.content[0].text).toContain("escapes");
		expect(existsSync(join(cwd, "escape.md"))).toBe(false);
	});

	it("edit replaces an exact unique substring and rejects ambiguous matches", async () => {
		await tools.get("write").execute("1", { path: "t.md", content: "alpha beta alpha" });
		const ambiguous = await tools.get("edit").execute("2", { path: "t.md", oldText: "alpha", newText: "X" });
		expect(ambiguous.content[0].text).toContain("ambiguous");
		const ok = await tools.get("edit").execute("3", { path: "t.md", oldText: "beta", newText: "BETA" });
		expect(ok.content[0].text).toContain("Edited");
		expect(readFileSync(join(bankRoot, "t.md"), "utf-8")).toBe("alpha BETA alpha");
	});

	it("ls and grep operate within the bank root", async () => {
		await tools.get("write").execute("1", { path: "auth.md", content: "uses JWT tokens" });
		await tools.get("write").execute("2", { path: "deploy.md", content: "uses fly.io" });
		const ls = await tools.get("ls").execute("3", {});
		expect(ls.content[0].text.split("\n").sort()).toEqual(["auth.md", "deploy.md"]);
		const grep = await tools.get("grep").execute("4", { pattern: "JWT" });
		expect(grep.content[0].text).toContain("auth.md:1");
	});
});
