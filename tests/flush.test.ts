import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Same pattern as consolidator.test.ts: only the subprocess is faked — the real lock,
// archive, outcome validation, ledger folds, and the whole flush pipeline run for real
// against a temp dir.
vi.mock("../src/spawn/launch.js", async (importOriginal) => {
	const actual = await importOriginal<Record<string, unknown>>();
	return { ...actual, spawnWorker: vi.fn() };
});

import { DEFAULTS } from "../src/config.js";
import { registerConsolidateCommand } from "../src/commands/consolidate.js";
import { dispatchConsolidator, waitForProjectLock } from "../src/hooks/consolidator-trigger.js";
import { flushObserverTail } from "../src/hooks/observer-trigger.js";
import { foldLedger, type Entry } from "../src/ledger/index.js";
import { acquireProjectLock, inspectProjectLock, releaseProjectLock } from "../src/memory/lock.js";
import { Runtime } from "../src/runtime.js";
import { spawnWorker } from "../src/spawn/launch.js";
import { writeConsolidatorResult, writeObserverResult, type ConsolidatorOutcome } from "../src/spawn/runs.js";
import { observation, observationsRecordedEntry, rawMessage, type TestObservation } from "./fixtures/session.js";

const spawnMock = vi.mocked(spawnWorker);

/** Observation lines inside the consolidator kickoff prompt: "<timestamp>  <content>". */
function parseBatchTimestamps(argv: string[]): string[] {
	const prompt = argv[argv.indexOf("-p") + 1] ?? "";
	const section = prompt.split("OBSERVATIONS TO CONSOLIDATE")[1] ?? "";
	return [...section.matchAll(/^(\S+) {2}/gm)].map((match) => match[1] ?? "");
}

const DEFAULT_OBSERVATIONS = (): TestObservation[] => [
	observation("2026-05-02T10:00:01"),
	observation("2026-05-02T10:00:02"),
	observation("2026-05-02T10:00:03"),
];

/** The raw observation the fake observer emits for the uncovered tail. */
const TAIL_OBSERVATION_ID = "2026-05-02T10:05:00";

type NotifyCall = { message: string; level: string };

type Harness = {
	cwd: string;
	branch: Entry[];
	runtime: Runtime;
	pi: any;
	ctx: any;
	notifications: NotifyCall[];
	handler: (args: string) => Promise<void>;
};

const tempDirs: string[] = [];

/**
 * A branch whose committed observation watermark is `coversUpToId`. When it is "raw-1"
 * (default) a second raw entry stays uncovered — the tail a flush must observe.
 */
function makeHarness(
	args: {
		observations?: TestObservation[];
		coversUpToId?: string;
		config?: Partial<typeof DEFAULTS>;
	} = {},
): Harness {
	const cwd = mkdtempSync(join(tmpdir(), "om-flush-"));
	tempDirs.push(cwd);
	const observations = args.observations ?? DEFAULT_OBSERVATIONS();
	const coversUpToId = args.coversUpToId ?? "raw-1";
	const branch: Entry[] = [rawMessage("raw-1", "first part of the conversation")];
	if (coversUpToId === "raw-2") {
		// Fully covered: the watermark sits at the tip, so a flush has no tail to observe.
		branch.push(rawMessage("raw-2", "second part of the conversation"));
		branch.push(observationsRecordedEntry("om-1", { observations, coversUpToId: "raw-2" }));
	} else {
		// raw-2 stays uncovered: the tail a flush must observe.
		branch.push(observationsRecordedEntry("om-1", { observations, coversUpToId: "raw-1" }));
		branch.push(rawMessage("raw-2", "second part of the conversation"));
	}
	const sessionManager = {
		getBranch: () => branch,
		getEntries: () => branch,
		getSessionId: () => "sess-1",
	};
	const runtime = new Runtime();
	runtime.enabled = true;
	runtime.config = { ...DEFAULTS, ...args.config };
	runtime.configLoaded = true;
	runtime.activatePaths({ cwd, sessionManager });

	let appended = 0;
	const pi: any = {
		registerCommand: (_name: string, def: any) => {
			registeredCommand = def;
		},
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
	let registeredCommand: any;
	registerConsolidateCommand(pi, runtime);
	const notifications: NotifyCall[] = [];
	const ctx = {
		cwd,
		hasUI: true,
		ui: { notify: (message: string, level: string = "info") => notifications.push({ message, level }) },
		sessionManager,
		getContextUsage: () => ({ tokens: null }),
		signal: undefined,
	};
	return {
		cwd,
		branch,
		runtime,
		pi,
		ctx,
		notifications,
		handler: (commandArgs: string) => registeredCommand.handler(commandArgs, ctx),
	};
}

const allPromoted = (timestamps: string[]): ConsolidatorOutcome[] =>
	timestamps.map((timestamp) => ({ timestamp, disposition: "promoted" as const }));

/** Fake worker behavior for both roles: observer emits one tail observation, consolidator reports outcomes. */
function defaultFakeWorker(opts: {
	/** Dispositions for the consolidator by submitted timestamp; defaults to all promoted. */
	outcomes?: (timestamps: string[]) => ConsolidatorOutcome[];
} = {}): void {
	spawnMock.mockImplementation(async (o) => {
		if (o.env.OM_WORKER === "observer") {
			writeObserverResult(o.env.OM_RESULT_PATH ?? "", {
				observations: [{ timestamp: "2026-05-02 10:05", content: "the tail of the conversation was discussed" }],
			});
			return { code: 0, signal: null, stderr: "" };
		}
		const timestamps = parseBatchTimestamps(o.argv);
		writeConsolidatorResult(o.env.OM_RESULT_PATH ?? "", {
			batchId: o.env.OM_BATCH_ID ?? "",
			outcomes: (opts.outcomes ?? allPromoted)(timestamps),
		});
		return { code: 0, signal: null, stderr: "" };
	});
}

const consolidatorCalls = () => spawnMock.mock.calls.filter((c) => c[0]!.env.OM_WORKER === "consolidator");
const observerCalls = () => spawnMock.mock.calls.filter((c) => c[0]!.env.OM_WORKER === "observer");
const promptOf = (call: any[]): string => call[0].argv[call[0].argv.indexOf("-p") + 1] as string;

beforeEach(() => {
	spawnMock.mockReset();
	delete process.env.PI_OM_FLUSH_LOCK_WAIT_MS;
	delete process.env.PI_OM_FLUSH_LOCK_RETRY_MS;
});

afterEach(() => {
	while (tempDirs.length > 0) {
		rmSync(tempDirs.pop() ?? "", { recursive: true, force: true });
	}
});

describe("flushObserverTail (§8 tail observation)", () => {
	it("fires below chunkTokens and covers exactly the uncovered remainder", async () => {
		const h = makeHarness({ config: { chunkTokens: 1_000_000 } });
		h.ctx.hasUI = false;
		defaultFakeWorker();

		await flushObserverTail(h.pi, h.runtime, h.ctx);

		expect(observerCalls()).toHaveLength(1);
		const prompt = promptOf(observerCalls()[0]!);
		expect(prompt).toContain("second part of the conversation");
		expect(prompt).not.toContain("first part of the conversation");

		// Committed: one recorded entry covering exactly up to the tip.
		const recorded = h.branch.find((e) => e.id === "appended-1");
		expect(recorded?.customType).toBe("om.observations.recorded");
		expect((recorded?.data as { coversUpToId: string }).coversUpToId).toBe("raw-2");
		expect((recorded?.data as { observations: unknown[] }).observations).toHaveLength(1);
		expect(h.runtime.dispatchedCoversUpToId).toBe("raw-2");
		expect(h.runtime.observersInFlight.size).toBe(0);
		expect(h.runtime.observerTasks.size).toBe(0);
	});

	it("awaits in-flight observers before cutting the tail", async () => {
		const h = makeHarness({ config: { chunkTokens: 1_000_000 } });
		h.ctx.hasUI = false;
		defaultFakeWorker();

		const events: string[] = [];
		let releaseObserver!: () => void;
		const pending = new Promise<void>((resolve) => {
			releaseObserver = resolve;
		}).then(() => {
			events.push("in-flight-observer-done");
		});
		h.runtime.trackObserverTask(pending);
		setTimeout(releaseObserver, 30);

		await flushObserverTail(h.pi, h.runtime, h.ctx);
		expect(events).toEqual(["in-flight-observer-done"]);
		expect(observerCalls()).toHaveLength(1);
	});

	it("is a no-op when nothing is uncovered", async () => {
		const h = makeHarness({ coversUpToId: "raw-2", config: { chunkTokens: 10 } });
		h.ctx.hasUI = false;
		defaultFakeWorker();

		await flushObserverTail(h.pi, h.runtime, h.ctx);

		expect(spawnMock).not.toHaveBeenCalled();
		expect(h.runtime.dispatchedCoversUpToId).toBeUndefined();
	});
});

describe("/om:consolidate --flush (full pipeline)", () => {
	it("observes the tail, then consolidates ALL active observations, even below the overflow target", async () => {
		const h = makeHarness({
			// Pool (30 tok) is far below both the threshold and the target, and the tail is far
			// below chunkTokens: only a full-pool flush can publish any of it.
			config: { chunkTokens: 1_000_000, poolTargetTokens: 10_000, consolidateAtPoolTokens: 15_000 },
		});
		defaultFakeWorker();

		await h.handler("--flush");

		// Tail observer ran, then ONE consolidator over everything active (3 original + 1 tail).
		expect(observerCalls()).toHaveLength(1);
		const cons = consolidatorCalls();
		expect(cons).toHaveLength(1);
		const submitted = parseBatchTimestamps(cons[0]![0].argv);
		expect([...submitted].sort()).toEqual([
			"2026-05-02T10:00:01",
			"2026-05-02T10:00:02",
			"2026-05-02T10:00:03",
			TAIL_OBSERVATION_ID,
		]);

		// The whole pool drained; the archive exists for the batch; the lock was released.
		expect(foldLedger(h.branch).activeObservations).toHaveLength(0);
		expect(readdirSync(h.runtime.archiveDir)).toHaveLength(1);
		expect(inspectProjectLock(h.runtime.projectDir)).toBeUndefined();
		expect(h.runtime.consolidatorInFlight).toBe(false);
	});

	it("reports promoted/retained/discarded counts plus the archive path, and that it is safe to leave", async () => {
		// Fully covered branch → no tail observer; the report is about the consolidator only.
		const h = makeHarness({ coversUpToId: "raw-2" });
		defaultFakeWorker({
			outcomes: (timestamps) =>
				timestamps.map((timestamp, i) => ({
					timestamp,
					disposition: (["promoted", "retained", "discarded"] as const)[i % 3]!,
				})),
		});

		await h.handler("--flush");

		expect(observerCalls()).toHaveLength(0);
		const report = h.notifications.map((n) => n.message).find((m) => m.includes("flush complete"));
		expect(report).toBeDefined();
		expect(report).toContain("promoted 1");
		expect(report).toContain("retained locally 1");
		expect(report).toContain("discarded 1");
		expect(report).toMatch(/archive: \.memory[/\\]sessions[/\\]sess-1[/\\]archive[/\\][0-9a-f]{16}\.json/);
		expect(report).toContain("Safe to leave");
		expect(foldLedger(h.branch).activeObservations).toHaveLength(0);
	});

	it("lock busy → the flush waits (bounded retry) and runs once the lock is released mid-wait", async () => {
		process.env.PI_OM_FLUSH_LOCK_RETRY_MS = "40";
		process.env.PI_OM_FLUSH_LOCK_WAIT_MS = "5000";
		const h = makeHarness({ coversUpToId: "raw-2" });
		defaultFakeWorker();

		const foreign = acquireProjectLock(h.runtime.projectDir, { pid: process.pid, sessionId: "other" });
		if (foreign === "busy") throw new Error("precondition failed: lock should have been free");
		// Released mid-wait: the flush's bounded retry must pick it up.
		setTimeout(() => releaseProjectLock(foreign), 100);

		await h.handler("--flush");

		expect(consolidatorCalls()).toHaveLength(1);
		expect(foldLedger(h.branch).activeObservations).toHaveLength(0);
		expect(h.notifications.some((n) => n.message.includes("flush busy"))).toBe(false);
		expect(inspectProjectLock(h.runtime.projectDir)).toBeUndefined();
	});

	it("lock busy past the timeout → busy report with the holder, and no consolidator ever spawns", async () => {
		process.env.PI_OM_FLUSH_LOCK_RETRY_MS = "30";
		process.env.PI_OM_FLUSH_LOCK_WAIT_MS = "150";
		const h = makeHarness({ coversUpToId: "raw-2" });
		defaultFakeWorker();

		const foreign = acquireProjectLock(h.runtime.projectDir, { pid: process.pid, sessionId: "other" });
		if (foreign === "busy") throw new Error("precondition failed: lock should have been free");
		try {
			await h.handler("--flush");

			expect(consolidatorCalls()).toHaveLength(0);
			const busy = h.notifications.find((n) => n.message.includes("flush busy"));
			expect(busy).toBeDefined();
			expect(busy?.message).toContain("held by pid");
			expect(busy?.message).toContain("session other");
			expect(busy?.message).toContain("Run /om:consolidate --flush again later");
			// Nothing drained; the batch stays active and retryable; the foreign lock is untouched.
			expect(foldLedger(h.branch).activeObservations).toHaveLength(3);
			expect(h.runtime.consolidatorInFlight).toBe(false);
			expect(inspectProjectLock(h.runtime.projectDir)?.sessionId).toBe("other");
		} finally {
			releaseProjectLock(foreign);
		}
	});

	it("is a no-op with a message when om is off", async () => {
		const h = makeHarness();
		h.runtime.enabled = false;
		defaultFakeWorker();

		await h.handler("--flush");

		expect(spawnMock).not.toHaveBeenCalled();
		expect(h.notifications[0]?.message).toContain("om is off");
	});

	it("refuses when passive mode is on (passive = no workers, including flush)", async () => {
		const h = makeHarness();
		h.runtime.config.passive = true;
		defaultFakeWorker();

		await h.handler("--flush");

		expect(spawnMock).not.toHaveBeenCalled();
		const refusal = h.notifications.find((n) => n.message.includes("passive"));
		expect(refusal).toBeDefined();
		expect(refusal?.level).toBe("warning");
	});
});

describe("/om:consolidate without --flush (explicit overflow-only)", () => {
	it("still forces overflow-only consolidation below the pool threshold (no threshold hack)", async () => {
		// Pool 30 tok: below consolidateAtPoolTokens (15 000) but above poolTargetTokens (10)
		// → the two oldest are promoted even though the background trigger would never fire.
		const h = makeHarness({ coversUpToId: "raw-2", config: { poolTargetTokens: 10, consolidateAtPoolTokens: 15_000 } });
		defaultFakeWorker();

		await h.handler("");

		await vi.waitFor(() => expect(h.runtime.consolidatorInFlight).toBe(false));
		expect(consolidatorCalls()).toHaveLength(1);
		const submitted = parseBatchTimestamps(consolidatorCalls()[0]![0].argv);
		expect(submitted).toEqual(["2026-05-02T10:00:01", "2026-05-02T10:00:02"]);
		// The newest observation stays in the local buffer.
		expect(foldLedger(h.branch).activeObservations.map((o) => o.timestamp)).toEqual(["2026-05-02T10:00:03"]);
	});

	it("reports nothing to consolidate when the pool fits the target", async () => {
		const h = makeHarness({ coversUpToId: "raw-2", config: { poolTargetTokens: 10_000 } });
		await h.handler("");
		expect(spawnMock).not.toHaveBeenCalled();
		expect(h.notifications.at(-1)?.message).toContain("nothing to consolidate");
	});
});

describe("waitForProjectLock (flush lock waiter)", () => {
	it("gives up on an aborted signal without acquiring", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "om-flush-lock-"));
		tempDirs.push(cwd);
		const foreign = acquireProjectLock(cwd, { pid: process.pid, sessionId: "other" });
		if (foreign === "busy") throw new Error("precondition failed: lock should have been free");
		const controller = new AbortController();
		controller.abort();
		try {
			const lock = await waitForProjectLock(cwd, { pid: process.pid, sessionId: "sess" }, { signal: controller.signal });
			expect(lock).toBe("busy");
		} finally {
			releaseProjectLock(foreign);
		}
	});

	it("returns a handle when the lock is free on the first try (no delay)", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "om-flush-lock-"));
		tempDirs.push(cwd);
		const lock = await waitForProjectLock(cwd, { pid: process.pid, sessionId: "sess" });
		if (lock === "busy") throw new Error("precondition failed: lock should have been free");
		expect(inspectProjectLock(cwd)?.sessionId).toBe("sess");
		releaseProjectLock(lock);
	});
});

describe("dispatchConsolidator with an injected lock waiter", () => {
	it("uses the injected waiter: a busy lock that clears mid-wait lets the run proceed", async () => {
		const h = makeHarness({ coversUpToId: "raw-2" });
		defaultFakeWorker();
		const foreign = acquireProjectLock(h.runtime.projectDir, { pid: process.pid, sessionId: "other" });
		if (foreign === "busy") throw new Error("precondition failed: lock should have been free");
		setTimeout(() => releaseProjectLock(foreign), 30);

		const result = await dispatchConsolidator(h.pi, h.runtime, h.ctx, DEFAULT_OBSERVATIONS(), {
			acquireLock: (projectDir, owner) =>
				waitForProjectLock(projectDir, owner, { retryDelayMs: 10, timeoutMs: 2_000 }),
		});

		expect(result.outcome).toBe("completed");
		expect(consolidatorCalls()).toHaveLength(1);
		expect(foldLedger(h.branch).activeObservations).toHaveLength(0);
	});
});