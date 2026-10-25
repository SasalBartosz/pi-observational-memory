/**
 * Background consolidation: archive, lock, run the worker, validate, publish INDEX, then drain.
 * Only explicit acknowledgements (plus screened secrets) drain; omissions remain active.
 * The lock stays held until the worker exits and publication finishes. Ledger commits must
 * stay in the originating session, even though bank writes are shared across sessions.
 */
import { createHash } from "node:crypto";
import { join, relative } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	OM_OBSERVATIONS_ARCHIVED,
	OM_OBSERVATIONS_DROPPED,
	foldLedger,
	lastSourceEntryId,
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
import {
	consolidatorBatchPath,
	consolidatorResultPath,
	readConsolidatorResult,
	writeConsolidatorBatch,
	type ConsolidatorRunResult,
} from "../spawn/runs.js";
import { recordWorkerCost } from "./observer-trigger.js";
import { nextRunId } from "../ids.js";
import type { TriggerCtx } from "./trigger-ctx.js";

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
	const retryDelayMs = Math.max(1, options.retryDelayMs ?? FLUSH_LOCK_RETRY_DELAY_MS);
	if (options.signal?.aborted) return "busy";

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

/** Stable across retries of the same selection, making archive writes idempotent. */
export function deriveBatchId(sessionId: string, timestamps: Iterable<string>): string {
	const sorted = [...timestamps].sort();
	return createHash("sha256").update([sessionId, ...sorted].join("\n")).digest("hex").slice(0, 16);
}

/** Unknown/duplicate ids invalidate a report; omissions are returned without a disposition. */
export function validateConsolidatorOutcomes(
	result: ConsolidatorRunResult,
	batchId: string,
	submittedTimestamps: readonly string[],
): {
	counts: { promoted: number; retained: number; discarded: number };
	acknowledgedTimestamps: string[];
	missingTimestamps: string[];
} {
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
	return {
		counts,
		acknowledgedTimestamps: submittedTimestamps.filter((timestamp) => seen.has(timestamp)),
		missingTimestamps: submittedTimestamps.filter((timestamp) => !seen.has(timestamp)),
	};
}

/** Called under the project lock so the worker sees the current bank. */
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
	const obsLines = batch.map((observation, index) => `${index + 1}  ${observation.content}`).join("\n");
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
		"===== OBSERVATIONS TO CONSOLIDATE (each line is `<index>  <content>`; indices are 1-based) =====\n" +
		`${obsLines}\n` +
		"===== END OBSERVATIONS =====\n\n" +
		"Fold every observation above into topic files (create/merge/rewrite as needed). Then update " +
		`.memory/project/OVERVIEW.md per your instructions — keep it under ~${overviewTargetTokens} tokens ` +
		`(~${overviewWords} words), undated current-state orientation: no advice or next steps.\n\n` +
		"Finally, call report_consolidation_outcomes with your batch id and an { index, disposition } " +
		`entry for each of the ${batch.length} numbered observations. Use integer labels, not timestamps. ` +
		"If the tool reports missing indices or errors, supply missing or corrected entries until it " +
		"confirms completion; calls merge. Never invent outcomes for unprocessed observations."
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
	// Compaction waits only for observers, not background consolidation.
	void dispatchConsolidator(pi, runtime, ctx, promote);
}

export type ConsolidatorDispatchResult = {
	outcome: "completed" | "partial" | "deferred" | "lock-busy" | "all-screened" | "failed";
	/** Archive path recorded in the om.observations.archived entry (relative to cwd), once archived. */
	archivePath?: string;
	/** Worker-validated dispositions for acknowledged observations ("completed"/"partial"). */
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
	/** Flush injects a cancellable waiter; background consolidation tries once. */
	acquireLock?: (projectDir: string, owner: ProjectLockOwner, signal: AbortSignal) => LockHandle | "busy" | Promise<LockHandle | "busy">;
};

/** Re-fold before committing: observers may have added observations while the worker ran. */
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
	const runId = nextRunId("cons");
	const controller = new AbortController();
	runtime.consolidatorController = controller;
	runtime.status.workerStart("consolidator", runId);
	const dispatchSessionId = runtime.sessionId;
	let archiveRelPath: string | undefined;
	const lockOwner: ProjectLockOwner = { pid: process.pid, sessionId: dispatchSessionId, runId };

	try {
		// Secrets must reach neither the archive nor the worker.
		const { safe, screened } = screenSecrets(promote);
		if (safe.length === 0) {
			// No bank writes, so no project lock is needed.
			const drained = tombstoneStillActive(pi, ctx, screened.map((o) => o.timestamp));
			debugLog("consolidator.batch-all-screened", { runId, drained });
			runtime.status.workerDone(runId, drained);
			return { outcome: "all-screened", drained, screened: screened.length };
		}

		const batchId = deriveBatchId(dispatchSessionId, safe.map((o) => o.timestamp));
		const archivePath = join(runtime.archiveDir, `${batchId}.json`);
		atomicWrite(archivePath, `${JSON.stringify({ batchId, observations: safe }, null, "\t")}\n`);
		archiveRelPath = relative(ctx.cwd, archivePath) || archivePath;
		// Use this exact order in both the prompt and the index manifest.
		const batch = sortObservations(safe);
		const submittedTimestamps = batch.map((o) => o.timestamp);
		pi.appendEntry(OM_OBSERVATIONS_ARCHIVED, { batchId, path: archiveRelPath, timestamps: submittedTimestamps });
		debugLog("consolidator.archive", {
			runId,
			batchId,
			path: archiveRelPath,
			submitted: safe.length,
			screened: screened.length,
		});

		const lock = await (opts.acquireLock
			? opts.acquireLock(runtime.projectDir, lockOwner, controller.signal)
			: acquireProjectLock(runtime.projectDir, lockOwner));
		if (lock !== "busy") runtime.consolidatorLock = lock;
		controller.signal.throwIfAborted();
		if (lock === "busy") {
			const lockMessage = inspectProjectLock(runtime.projectDir)?.message ?? "held by another process";
			debugLog("consolidator.lock.busy", { runId, batchId, flush: opts.acquireLock !== undefined, lockMessage });
			if (!opts.acquireLock && ctx.hasUI) {
				ctx.ui?.notify("om: consolidation deferred — the project memory lock is held by another process", "info");
			}
			runtime.status.workerDone(runId, 0);
			return { outcome: opts.acquireLock ? "lock-busy" : "deferred", archivePath: archiveRelPath, lockMessage };
		}

		const prompt = buildConsolidatorPrompt(
			runtime.projectDir,
			ctx.cwd,
			batch,
			batchId,
			runtime.config.overviewTargetTokens,
		);

		const batchPath = consolidatorBatchPath(runtime.runtimeDir, runId);
		writeConsolidatorBatch(batchPath, { batchId, timestamps: submittedTimestamps });
		const argv = buildWorkerArgv({
			model: runtime.config.models.consolidator,
			sessionName: `om-consolidator-${runId}`,
			kickoffPrompt: prompt,
		});
		const env = buildWorkerEnv("consolidator", {
			runtimeDir: runtime.runtimeDir,
			projectDir: runtime.projectDir,
			runId,
			batchPath,
		});
		const exit = await spawnWorker({ argv, cwd: runtime.runtimeDir, env, signal: controller.signal });
		// Capture cost before the exit-code check so a partial run's spend is still recorded.
		recordWorkerCost(pi, runtime, ctx, "consolidator", runId);
		// Crashes and cancellations are not acknowledgements, even if a report exists.
		controller.signal.throwIfAborted();
		if (exit.code !== 0) {
			throw new Error(`consolidator exited with code ${exit.code}${exit.stderr ? `: ${exit.stderr.trim().slice(0, 200)}` : ""}`);
		}

		// Revalidate persisted ids; the worker's exit code alone is not success.
		let validation: ReturnType<typeof validateConsolidatorOutcomes>;
		try {
			const result = readConsolidatorResult(consolidatorResultPath(runtime.runtimeDir, runId));
			validation = validateConsolidatorOutcomes(result, batchId, submittedTimestamps);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			debugLog("consolidator.outcomes.invalid", { runId, batchId, message });
			throw new Error(`consolidator outcome validation failed: ${message}`);
		}

		const { counts, acknowledgedTimestamps, missingTimestamps } = validation;
		if (missingTimestamps.length > 0) {
			debugLog("consolidator.outcomes.partial", {
				runId, batchId, acknowledged: acknowledgedTimestamps.length, missing: missingTimestamps,
			});
		}

		// Publish INDEX before acknowledging anything; a failure must leave the batch retryable.
		atomicWrite(indexPath(runtime.projectDir), renderIndexFile(listTopics(runtime.projectDir, ctx.cwd)));
		debugLog("consolidator.index", { runId, batchId });

		let drained = 0;
		let tombstoneSkipped = false;
		if (ctx.sessionManager.getSessionId() !== dispatchSessionId) {
			// Bank writes are shared, but acknowledgements belong only to the originating session.
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
			drained = tombstoneStillActive(pi, ctx, [...acknowledgedTimestamps, ...screened.map((o) => o.timestamp)]);
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

		runtime.status.workerDone(runId, drained);
		runtime.refreshFooterGauges(ctx.sessionManager.getBranch(), ctx.getContextUsage?.());
		if (ctx.hasUI && ctx.ui) {
			runtime.queueToast(
				`om: consolidator promoted ${counts.promoted}, retained in archive ${counts.retained}, discarded ${counts.discarded + screened.length}` +
					(missingTimestamps.length > 0 ? `; ${missingTimestamps.length} unreported observation(s) remain active` : ""),
				missingTimestamps.length > 0 ? "warning" : "info",
				ctx.ui.notify.bind(ctx.ui),
			);
		}
		return {
			outcome: missingTimestamps.length > 0 ? "partial" : "completed",
			archivePath: archiveRelPath, counts, screened: screened.length, drained, tombstoneSkipped,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		runtime.lastWorkerError = message;
		runtime.status.workerError(runId);
		if (ctx.hasUI) ctx.ui?.notify(`om: consolidator failed: ${message}`, "error");
		return { outcome: "failed", archivePath: archiveRelPath, error: message };
	} finally {
		// Abort requests do not release the lock: the worker must exit before another writer starts.
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
