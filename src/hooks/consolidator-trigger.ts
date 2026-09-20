/**
 * Consolidator clock + dispatch. When the active observation pool crosses `consolidateAtPoolTokens`,
 * promote the oldest observations (above `poolTargetTokens`) into durable `.memory/project/`
 * topic files via a subprocess consolidator, then drain exactly the batch it submitted — and
 * only after the worker's outcome report VALIDATES.
 *
 * Runs in the BACKGROUND, mirroring the observer trigger (turn_end / agent_start), strictly
 * one at a time in-process (`consolidatorInFlight`, design risk 4) and one at a time
 * cross-process (the project lock, plan §4). Compaction does not wait for it (R5).
 *
 * Dispatch ordering (plan §7d), strict:
 *   1. Archive first: the submitted batch is written verbatim to the session-local archive
 *      under a deterministic batch id BEFORE anything is drained (idempotent by name, so a
 *      retry/replay of the same batch merges instead of duplicating). Secret-looking
 *      observations are screened out of both the archive and the submitted batch and are
 *      accounted as immediately discarded — they drain with the batch after validation.
 *   2. Acquire the project lock BEFORE reading the shared bank or building the prompt.
 *      Busy: the background dispatch defers silently (info-level notice at most, no retry —
 *      a later threshold trigger re-fires; the batch stays active and retryable).
 *   3. Build the prompt from FRESH bank state (post-lock): current index + current OVERVIEW
 *      + the batch lines + the batch id + the outcome-file contract. Nothing dated anywhere.
 *   4. Spawn the worker with the split env including OM_BATCH_ID.
 *   5. On exit: record cost, then VALIDATE the outcome file — it must exist and parse, its
 *      batchId must match, and its outcomes must account for every submitted timestamp
 *      exactly once (no missing, no extras, no duplicates). Worker exit code 0 alone is NOT
 *      success. On missing/invalid outcomes the whole batch stays active (retryable — no
 *      tombstone), the lock is released, and the failure is reported.
 *   6. Tombstone last: only after validation, only submitted timestamps still active on the
 *      originating branch (an observation an observer committed mid-run is not in the handed
 *      batch and must survive; forked branches keep their copies). Secret-screened timestamps
 *      join the tombstone set — they were never submitted but must drain too. Then INDEX.md
 *      is regenerated under the same lock; tombstone → index stay one critical section.
 *   7. Release the lock in `finally`, after the worker process has exited.
 *   8. Session identity: the dispatching session id is captured up front and re-checked before
 *      ANY ledger commit — a session replacement between dispatch and commit must never land
 *      this run's tombstone in the NEW session's ledger (the archive entry at step 1 is fine:
 *      it is written pre-spawn, into the session that dispatched). The bank writes are
 *      project-scoped and stand regardless.
 */
import { createHash } from "node:crypto";
import { join, relative } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	OM_OBSERVATIONS_ARCHIVED,
	OM_OBSERVATIONS_DROPPED,
	foldLedger,
	lastSourceEntryId,
	observationToLine,
	poolTokens,
	selectPromotionOverflow,
	sortObservations,
	type Entry,
	type Observation,
} from "../ledger/index.js";
import { debugLog } from "../debug-log.js";
import { renderIndexFile } from "../memory/index-render.js";
import { acquireProjectLock, inspectProjectLock, type LockHandle, type ProjectLockOwner } from "../memory/lock.js";
import { atomicWrite, indexPath, listTopics, readOverview } from "../memory/paths.js";
import { screenSecrets } from "../memory/secrets.js";
import type { Runtime } from "../runtime.js";
import { buildWorkerArgv, buildWorkerEnv, spawnWorker } from "../spawn/launch.js";
import { consolidatorResultPath, readConsolidatorResult, type ConsolidatorRunResult } from "../spawn/runs.js";
import { recordWorkerCost } from "./observer-trigger.js";

type TriggerCtx = {
	cwd: string;
	hasUI: boolean;
	ui?: { notify: (message: string, level?: "info" | "warning" | "error") => void };
	sessionManager: {
		getBranch: () => Entry[];
		getEntries: () => Entry[];
		getSessionId: () => string;
	};
	getContextUsage?: () => { tokens: number | null } | undefined;
};

let runCounter = 0;

function nextRunId(): string {
	runCounter += 1;
	const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
	return `cons-${stamp}-${process.pid}-${runCounter}`;
}

// ── Flush lock wait (plan §4/§8) ────────────────────────────────────────────────────────
// The background path defers on a busy lock (a later threshold trigger re-fires). An explicit
// /om:consolidate --flush cannot defer — the user is waiting — so it retries acquisition with
// a short delay under a total-time bound. The retry lives HERE (caller side), never in the
// lock module, and never spawns a worker while waiting.

/** Total budget an explicit flush waits for a foreign lock holder before reporting "busy". */
export const FLUSH_LOCK_WAIT_TIMEOUT_MS = 60_000;
/** Delay between lock acquisition attempts during a flush wait. */
export const FLUSH_LOCK_RETRY_DELAY_MS = 1_500;

export type FlushLockWaitOptions = {
	/** Total wait budget; defaults to FLUSH_LOCK_WAIT_TIMEOUT_MS. */
	timeoutMs?: number;
	/** Delay between acquisition attempts; defaults to FLUSH_LOCK_RETRY_DELAY_MS. */
	retryDelayMs?: number;
	/** When aborted, the wait gives up (returns "busy") instead of acquiring — never spawns. */
	signal?: AbortSignal;
};

function sleepCancellable(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(done, ms);
		function done(): void {
			clearTimeout(timer);
			signal?.removeEventListener("abort", done);
			resolve();
		}
		if (signal) {
			if (signal.aborted) {
				done();
				return;
			}
			signal.addEventListener("abort", done, { once: true });
		}
	});
}

/**
 * Bounded, cancellable project-lock acquisition for the explicit flush path: try immediately,
 * then retry every `retryDelayMs` until `timeoutMs` elapses or the lock comes free. Returns
 * "busy" on timeout/abort — the caller reports and exits WITHOUT spawning.
 */
export async function waitForProjectLock(
	projectDir: string,
	owner: ProjectLockOwner,
	options: FlushLockWaitOptions = {},
): Promise<LockHandle | "busy"> {
	const timeoutMs = options.timeoutMs ?? FLUSH_LOCK_WAIT_TIMEOUT_MS;
	const retryDelayMs = options.retryDelayMs ?? FLUSH_LOCK_RETRY_DELAY_MS;

	let lock = acquireProjectLock(projectDir, owner);
	if (lock !== "busy") return lock;

	const deadline = Date.now() + timeoutMs;
	while (Date.now() + retryDelayMs <= deadline) {
		if (options.signal?.aborted) return "busy";
		await sleepCancellable(retryDelayMs, options.signal);
		if (options.signal?.aborted) return "busy";
		lock = acquireProjectLock(projectDir, owner);
		if (lock !== "busy") {
			debugLog("consolidator.lock.wait-acquired", {
				pid: owner.pid,
				sessionId: owner.sessionId,
				elapsedMs: timeoutMs - Math.max(0, deadline - Date.now()),
			});
			return lock;
		}
		debugLog("consolidator.lock.wait-retry", { pid: owner.pid, sessionId: owner.sessionId });
	}
	return "busy";
}

/**
 * Deterministic batch id: a short sha256 of the source session id + the batch's observation
 * timestamps (sorted). Retries/replays of the same batch derive the same id, so the archive
 * write is idempotent by name and a replayed batch merges instead of duplicating (the
 * consolidator prompt's rewrite-in-place semantics handle the bank side the same way).
 */
export function deriveBatchId(sessionId: string, timestamps: Iterable<string>): string {
	const sorted = [...timestamps].sort();
	return createHash("sha256").update([sessionId, ...sorted].join("\n")).digest("hex").slice(0, 16);
}

/**
 * Validate the consolidator's outcome report against the submitted batch: the batchId must
 * match, and every submitted timestamp must be accounted for exactly once — no missing, no
 * extras, no duplicates. Throws on any violation; returns the per-disposition counts.
 */
export function validateConsolidatorOutcomes(
	result: ConsolidatorRunResult,
	batchId: string,
	submittedTimestamps: readonly string[],
): { counts: { promoted: number; retained: number; discarded: number } } {
	if (result.batchId !== batchId) {
		throw new Error(`outcome batchId "${result.batchId}" does not match the submitted batch "${batchId}"`);
	}
	const submitted = new Set(submittedTimestamps);
	const seen = new Set<string>();
	const counts = { promoted: 0, retained: 0, discarded: 0 };
	for (const outcome of result.outcomes) {
		if (!submitted.has(outcome.timestamp)) {
			throw new Error(`outcome reported for unknown timestamp ${outcome.timestamp}`);
		}
		if (seen.has(outcome.timestamp)) {
			throw new Error(`duplicate outcome for timestamp ${outcome.timestamp}`);
		}
		seen.add(outcome.timestamp);
		counts[outcome.disposition] += 1;
	}
	const missing = submittedTimestamps.filter((timestamp) => !seen.has(timestamp));
	if (missing.length > 0) {
		const shown = missing.slice(0, 3).join(", ");
		throw new Error(`missing outcomes for ${missing.length} submitted timestamp(s): ${shown}${missing.length > 3 ? ", …" : ""}`);
	}
	return { counts };
}

/**
 * Build the consolidator's `-p` prompt from FRESH bank state (post-lock): current index +
 * current overview + the batch lines + the batch id. The overview is included verbatim so
 * the consolidator rewrites it in place (wholesale, undated — never a dated running
 * history). Nothing in the prompt or the bank carries dates; front matter is exactly
 * id/title/summary. The outcome-file contract is spelled out so the worker knows its run is
 * judged by report_consolidation_outcomes, not by its closing words.
 */
function buildConsolidatorPrompt(
	projectDir: string,
	cwd: string,
	batch: Observation[],
	batchId: string,
	overviewTargetTokens: number,
): string {
	const indexText = renderIndexFile(listTopics(projectDir, cwd));
	const overviewText = readOverview(projectDir);
	const overviewWords = Math.round((overviewTargetTokens * 3) / 4);
	const obsLines = sortObservations(batch).map(observationToLine).join("\n");
	return (
		"You are folding the observations below into the durable topic files under your sandbox " +
		"(.memory/project/). Front matter is exactly id/title/summary — no dates or timestamps " +
		"anywhere in the bank.\n\n" +
		`Your batch id is "${batchId}" — you must pass exactly this id to report_consolidation_outcomes.\n\n` +
		"===== CURRENT MEMORY INDEX (generated; do not edit INDEX.md) =====\n" +
		`${indexText}\n` +
		"===== END MEMORY INDEX =====\n\n" +
		"===== CURRENT OVERVIEW (.memory/project/OVERVIEW.md — undated current-state orientation) =====\n" +
		`${overviewText ?? "(empty — no overview yet; start one)"}\n` +
		"===== END OVERVIEW =====\n\n" +
		"===== OBSERVATIONS TO CONSOLIDATE (each line is `<timestamp-id>  <content>`) =====\n" +
		`${obsLines}\n` +
		"===== END OBSERVATIONS =====\n\n" +
		"Fold every observation above into topic files (create/merge/rewrite as needed). Then update " +
		`.memory/project/OVERVIEW.md per your instructions — keep it under ~${overviewTargetTokens} tokens ` +
		`(~${overviewWords} words), undated current-state orientation: no advice or next steps.\n\n` +
		"Finally, you MUST call report_consolidation_outcomes with your batch id " +
		`"${batchId}" and one outcome entry for EVERY observation timestamp listed above — each ` +
		"exactly once, as promoted, retained, or discarded. An incomplete or duplicated report invalidates " +
		"the whole run: the orchestrator keeps the entire batch active and retries, wasting this work. " +
		"Finish with a one-sentence confirmation."
	);
}

export function evaluateConsolidatorTrigger(pi: ExtensionAPI, runtime: Runtime, ctx: TriggerCtx): void {
	if (!runtime.enabled || runtime.config.passive) return;
	if (runtime.consolidatorInFlight) return;

	const branch = ctx.sessionManager.getBranch();
	const active = foldLedger(branch).activeObservations;
	if (poolTokens(active) < runtime.config.consolidateAtPoolTokens) return;

	const { promote } = selectPromotionOverflow(active, runtime.config.poolTargetTokens);
	if (promote.length === 0) return;

	runtime.consolidatorInFlight = true;
	if (ctx.hasUI) {
		ctx.ui?.notify(`om: consolidator started (${promote.length} obs, ~${poolTokens(promote).toLocaleString()} tok)`, "info");
	}
	// Deliberately NOT tracked in observerTasks: compaction waits only for in-flight observers,
	// never the consolidator (design R5). The consolidatorInFlight flag enforces one-at-a-time
	// in-process; the project lock (§4) enforces it cross-process. A busy lock makes the
	// dispatch defer — consolidatorInFlight is reset in its finally either way, so a later
	// trigger re-fires on the next tick once the other holder has released.
	void dispatchConsolidator(pi, runtime, ctx, promote);
}

/**
 * What a dispatch did — the synchronous report an explicit flush needs (background callers
 * ignore it). "completed" = the worker ran and its outcomes validated; "deferred" = the
 * default single-try lock acquisition found the lock busy (background semantics); "lock-busy"
 * = an injected lock waiter (flush) exhausted its bounded wait; "all-screened" = every
 * observation looked secret, so the batch drained locally without a worker; "failed" = worker
 * error or invalid outcomes (the batch stays active and retryable).
 */
export type ConsolidatorDispatchResult = {
	outcome: "completed" | "deferred" | "lock-busy" | "all-screened" | "failed";
	/** Archive path recorded in the om.observations.archived entry (relative to cwd), once archived. */
	archivePath?: string;
	/** Worker-validated dispositions for the submitted batch ("completed" only). */
	counts?: { promoted: number; retained: number; discarded: number };
	/** Secret-screened observations: never submitted; drained as discarded. */
	screened?: number;
	/** Observations actually tombstoned on the dispatching branch. */
	drained?: number;
	/** The session was replaced mid-run: bank writes landed, the ledger tombstone was skipped. */
	tombstoneSkipped?: boolean;
	/** Error message ("failed" only). */
	error?: string;
	/** inspectProjectLock() status for the holder, e.g. "held by pid X (session Y)" ("deferred"/"lock-busy"). */
	lockMessage?: string;
};

export type DispatchConsolidatorOptions = {
	/**
	 * Lock acquisition strategy, injected so the flush path can wait without changing the
	 * background behavior. Default: one non-blocking try — busy means silent defer (a later
	 * threshold trigger re-fires). The flush path injects `waitForProjectLock` (bounded,
	 * cancellable retry; busy means the explicit command reports and exits).
	 */
	acquireLock?: (projectDir: string, owner: ProjectLockOwner) => LockHandle | "busy" | Promise<LockHandle | "busy">;
};

/**
 * Tombstone the given timestamps, intersected with what is still active on the branch, and
 * return how many actually drained. Never tombstones something already dropped, and never
 * something an observer committed during the run (those are not in the handed batch).
 */
function tombstoneStillActive(pi: ExtensionAPI, ctx: TriggerCtx, timestamps: readonly string[]): number {
	const branch = ctx.sessionManager.getBranch();
	const stillActive = new Set(foldLedger(branch).activeObservations.map((o) => o.timestamp));
	const toDrop = timestamps.filter((timestamp) => stillActive.has(timestamp));
	if (toDrop.length === 0) return 0;
	const coversUpToId = lastSourceEntryId(branch);
	if (!coversUpToId) return 0;
	pi.appendEntry(OM_OBSERVATIONS_DROPPED, { observationTimestamps: toDrop, coversUpToId });
	return toDrop.length;
}

export async function dispatchConsolidator(
	pi: ExtensionAPI,
	runtime: Runtime,
	ctx: TriggerCtx,
	promote: Observation[],
	opts: DispatchConsolidatorOptions = {},
): Promise<ConsolidatorDispatchResult> {
	const runId = nextRunId();
	const controller = new AbortController();
	runtime.consolidatorController = controller;
	runtime.status.workerStart("consolidator", runId);
	// Identity of the session that dispatched this run; re-checked before any ledger commit
	// (§7d step 8). The archive entry below is written pre-spawn into the dispatching
	// session's ledger — exactly the session it belongs to — so it needs no guard; only the
	// post-spawn tombstone must not land in a replacement session's ledger.
	const dispatchSessionId = runtime.sessionId;
	// Kept outside the try so a failure result can still tell the caller where the batch was
	// archived (archive-before-drain means the file survives a failed run — it is the retry).
	let archiveRelPath: string | undefined;
	// The lock owner handed to the (possibly injected) acquisition strategy.
	const lockOwner: ProjectLockOwner = { pid: process.pid, sessionId: dispatchSessionId, runId };

	try {
		// ── Step 1: archive first, before anything is drained. ─────────────────────────
		// Secret-looking observations are pulled out of BOTH the archive and the submitted
		// batch (best-effort screen — credentials never go to a subprocess) and are accounted
		// as immediately discarded: they drain with the batch after validation.
		const { safe, screened } = screenSecrets(promote);
		if (safe.length === 0) {
			// Whole batch screened: nothing to archive or submit. Drain directly as discarded —
			// no worker, no bank writes, so no lock is needed either.
			const drained = tombstoneStillActive(pi, ctx, screened.map((o) => o.timestamp));
			debugLog("consolidator.batch-all-screened", { runId, drained });
			runtime.status.workerDone(runId, drained);
			return { outcome: "all-screened", drained, screened: screened.length };
		}

		const batchId = deriveBatchId(dispatchSessionId, safe.map((o) => o.timestamp));
		const archivePath = join(runtime.archiveDir, `${batchId}.json`);
		atomicWrite(archivePath, `${JSON.stringify({ batchId, observations: safe }, null, "\t")}\n`);
		archiveRelPath = relative(ctx.cwd, archivePath) || archivePath;
		const submittedTimestamps = safe.map((o) => o.timestamp);
		pi.appendEntry(OM_OBSERVATIONS_ARCHIVED, { batchId, path: archiveRelPath, timestamps: submittedTimestamps });
		debugLog("consolidator.archive", {
			runId,
			batchId,
			path: archiveRelPath,
			submitted: safe.length,
			screened: screened.length,
		});

		// ── Step 2: project lock before reading the bank or building the prompt. ────────
		// Default (background): one non-blocking try — busy defers silently (no retry loop, no
		// spawn; the batch stays active and retryable, a later threshold trigger re-fires, and
		// the archive write above is idempotent by name). The flush path injects a bounded,
		// cancellable waiter instead; for it, busy means the wait timed out — surfaced as
		// "lock-busy" so the explicit command can report the holder and exit without spawning.
		const lock = await (opts.acquireLock
			? opts.acquireLock(runtime.projectDir, lockOwner)
			: acquireProjectLock(runtime.projectDir, lockOwner));
		if (lock === "busy") {
			const lockMessage = inspectProjectLock(runtime.projectDir)?.message ?? "held by another process";
			debugLog("consolidator.lock.busy", { runId, batchId, flush: opts.acquireLock !== undefined, lockMessage });
			if (!opts.acquireLock) {
				// Background dispatch defers (info-level notice at most).
				if (ctx.hasUI) {
					ctx.ui?.notify("om: consolidation deferred — the project memory lock is held by another process", "info");
				}
				runtime.status.workerDone(runId, 0);
				return { outcome: "deferred", archivePath: archiveRelPath, lockMessage };
			}
			runtime.status.workerDone(runId, 0);
			return { outcome: "lock-busy", archivePath: archiveRelPath, lockMessage };
		}
		runtime.consolidatorLock = lock;

		// ── Step 3: build the prompt from FRESH bank state (post-lock). ────────────────
		const prompt = buildConsolidatorPrompt(
			runtime.projectDir,
			ctx.cwd,
			safe,
			batchId,
			runtime.config.overviewTargetTokens,
		);

		// ── Step 4: spawn with the split env including the batch id. ──────────────────
		const argv = buildWorkerArgv({
			model: runtime.config.models.consolidator,
			sessionName: `om-consolidator-${runId}`,
			kickoffPrompt: prompt,
		});
		const env = buildWorkerEnv("consolidator", {
			runtimeDir: runtime.runtimeDir,
			projectDir: runtime.projectDir,
			runId,
			batchId,
		});
		const exit = await spawnWorker({ argv, cwd: runtime.runtimeDir, env, signal: controller.signal });
		// Capture cost before the exit-code check so a partial run's spend is still recorded.
		recordWorkerCost(pi, runtime, ctx, "consolidator", runId);
		if (exit.code !== 0) {
			throw new Error(`consolidator exited with code ${exit.code}${exit.stderr ? `: ${exit.stderr.trim().slice(0, 200)}` : ""}`);
		}

		// ── Step 5: validate the outcome contract. ─────────────────────────────────────
		// Exit code 0 alone is NOT success: the file must exist, parse, match the batch id,
		// and account for every submitted timestamp exactly once. Any violation leaves the
		// whole batch active (retryable — no tombstone).
		let counts: { promoted: number; retained: number; discarded: number };
		try {
			const result = readConsolidatorResult(consolidatorResultPath(runtime.runtimeDir, runId));
			counts = validateConsolidatorOutcomes(result, batchId, submittedTimestamps).counts;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			debugLog("consolidator.outcomes.invalid", { runId, batchId, message });
			throw new Error(`consolidator outcome validation failed: ${message}`);
		}

		// ── Steps 6 + 8: tombstone last — and only into the dispatching session's ledger.
		let drained = 0;
		let tombstoneSkipped = false;
		if (ctx.sessionManager.getSessionId() !== dispatchSessionId) {
			// The session was replaced while the worker ran (resume into a new session,
			// session_start with a different id). Appending the tombstone now would drain the
			// batch in a ledger the observations do not belong to. Bank writes are
			// project-scoped and stand; only the ledger writes are discarded. The batch
			// stays active on THIS branch, which is the correct, conservative outcome.
			debugLog("consolidator.session-mismatch", {
				runId,
				batchId,
				dispatchSessionId,
				currentSessionId: ctx.sessionManager.getSessionId(),
			});
			if (ctx.hasUI) {
				ctx.ui?.notify("om: consolidator finished after a session switch — tombstone skipped", "info");
			}
			tombstoneSkipped = true;
		} else {
			// Submitted + secret-screened (never submitted, but they must drain too).
			drained = tombstoneStillActive(pi, ctx, [...safe, ...screened].map((o) => o.timestamp));
			debugLog("consolidator.tombstone", {
				runId,
				batchId,
				drained,
				promoted: counts.promoted,
				retained: counts.retained,
				discarded: counts.discarded,
				screened: screened.length,
			});
		}

		// INDEX regeneration is a project-scoped bank write — it belongs to the run even when
		// the session identity changed. Tombstone → index stay one critical section under the
		// lock; a crash between the two is covered by the batch-id replay (idempotent merge).
		atomicWrite(indexPath(runtime.projectDir), renderIndexFile(listTopics(runtime.projectDir, ctx.cwd)));

		runtime.status.workerDone(runId, drained);
		runtime.refreshFooterGauges(ctx.sessionManager.getBranch(), ctx.getContextUsage?.()?.tokens ?? null);
		if (ctx.hasUI && ctx.ui) {
			runtime.queueToast(
				`om: consolidator promoted ${counts.promoted}, retained ${counts.retained}, discarded ${counts.discarded + screened.length}`,
				"info",
				ctx.ui.notify.bind(ctx.ui),
			);
		}
		return { outcome: "completed", archivePath: archiveRelPath, counts, screened: screened.length, drained, tombstoneSkipped };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		runtime.lastWorkerError = message;
		runtime.status.workerError(runId);
		if (ctx.hasUI) ctx.ui?.notify(`om: consolidator failed: ${message}`, "error");
		return { outcome: "failed", archivePath: archiveRelPath, error: message };
	} finally {
		// Step 7: release the lock after the worker has exited. Idempotent: abortAllWorkers()
		// may already have released (and cleared the field) on /om off or session replacement;
		// releaseProjectLock itself is owner-checked and never throws.
		runtime.releaseConsolidatorLock();
		runtime.consolidatorController = undefined;
		runtime.consolidatorInFlight = false;
	}
}

export function registerConsolidatorTrigger(pi: ExtensionAPI, runtime: Runtime): void {
	const handler = (_event: unknown, ctx: TriggerCtx) => evaluateConsolidatorTrigger(pi, runtime, ctx);
	pi.on("turn_end", handler as never);
	pi.on("agent_start", handler as never);
}
