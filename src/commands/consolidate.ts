import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { foldLedger, poolTokens, selectPromotionOverflow, type Entry } from "../ledger/index.js";
import type { Runtime } from "../runtime.js";
import { debugLog } from "../debug-log.js";
import {
	FLUSH_LOCK_RETRY_DELAY_MS,
	FLUSH_LOCK_WAIT_TIMEOUT_MS,
	dispatchConsolidator,
	waitForProjectLock,
	type ConsolidatorDispatchResult,
} from "../hooks/consolidator-trigger.js";
import { flushObserverTail } from "../hooks/observer-trigger.js";

/** Flush retries only the original selection, and only while observations actually drain. */
export const MAX_FLUSH_CONSOLIDATION_ATTEMPTS = 3;

function flushLockWaitEnvOverride(name: string, fallback: number): number {
	const raw = process.env[name];
	const parsed = typeof raw === "string" ? Number(raw) : NaN;
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/** Wait for a background consolidator before selecting the flush's full batch. */
async function waitForConsolidatorIdle(runtime: Runtime, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (runtime.consolidatorInFlight) {
		if (Date.now() >= deadline) return false;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	return true;
}

export function registerConsolidateCommand(pi: ExtensionAPI, runtime: Runtime): void {
	pi.registerCommand("om:consolidate", {
		description:
			"Force an observational-memory consolidation now; --flush also observes the uncovered tail and consolidates the whole pool (run it before ending a short session)",
		handler: async (args: string, ctx: any) => {
			const flush = args.trim() === "--flush";
			const notify = (message: string, level: "info" | "warning" | "error"): void => {
				if (ctx.hasUI) ctx.ui.notify(message, level);
			};

			if (!runtime.enabled) {
				notify("om is off (use /om on to enable)", "info");
				return;
			}
			runtime.ensureConfig(ctx.cwd);
			if (runtime.config.passive) {
				notify("om: passive mode is on — workers are disabled, including forced consolidation (unset PI_OM_PASSIVE)", "warning");
				return;
			}

			if (flush) {
				await runFlush(pi, runtime, ctx, notify);
				return;
			}

			if (runtime.consolidatorInFlight) {
				notify("om: consolidation already in progress", "warning");
				return;
			}
			const branch = ctx.sessionManager.getBranch() as Entry[];
			const active = foldLedger(branch).activeObservations;
			const { promote } = selectPromotionOverflow(active, runtime.config.poolTargetTokens);
			if (promote.length === 0) {
				notify(
					`om: nothing to consolidate (pool ${poolTokens(active).toLocaleString()} tok <= target ${runtime.config.poolTargetTokens.toLocaleString()} tok)`,
					"info",
				);
				return;
			}
			notify(`om: consolidator started (${promote.length} obs, ~${poolTokens(promote).toLocaleString()} tok)`, "info");
			runtime.consolidatorInFlight = true;
			void dispatchConsolidator(pi, runtime, ctx, promote).catch(() => {
				runtime.consolidatorInFlight = false;
			});
		},
	});
}

async function runFlush(
	pi: ExtensionAPI,
	runtime: Runtime,
	ctx: any,
	notify: (message: string, level: "info" | "warning" | "error") => void,
): Promise<void> {
	const sessionId = ctx.sessionManager.getSessionId();
	notify("om: flush — observing the remaining conversation…", "info");
	await flushObserverTail(pi, runtime, ctx);

	if (!(await waitForConsolidatorIdle(runtime, FLUSH_LOCK_WAIT_TIMEOUT_MS))) {
		notify(
			"om: flush deferred — a consolidation started earlier is still running; run /om:consolidate --flush again when it finishes",
			"warning",
		);
		return;
	}

	// An empty pool falls through: the loop's session/abort checks run first, then it completes.
	const active = foldLedger(ctx.sessionManager.getBranch() as Entry[]).activeObservations;
	if (active.length > 0) notify(`om: flushing — consolidating ${active.length} observation(s)…`, "info");
	debugLog("flush.consolidate", { observations: active.length, poolTokens: poolTokens(active) });

	// The ledger, not the worker's claimed coverage, determines what needs another attempt.
	const selected = new Set(active.map((observation) => observation.timestamp));
	const counts = { promoted: 0, retained: 0, discarded: 0 };
	let drainedTotal = 0;
	let archivePath: string | undefined;
	let lastError: string | undefined;
	let attempts = 0;
	let stopReason: ConsolidatorDispatchResult["outcome"] | "session-replaced" | "aborted" = "completed";

	while (attempts < MAX_FLUSH_CONSOLIDATION_ATTEMPTS) {
		if (ctx.sessionManager.getSessionId() !== sessionId) {
			stopReason = "session-replaced";
			break;
		}
		if (!runtime.enabled || ctx.signal?.aborted) {
			stopReason = "aborted";
			break;
		}
		const batch = foldLedger(ctx.sessionManager.getBranch() as Entry[]).activeObservations
			.filter((observation) => selected.has(observation.timestamp));
		if (batch.length === 0) {
			stopReason = "completed";
			break;
		}

		attempts += 1;
		runtime.consolidatorInFlight = true;
		let result: ConsolidatorDispatchResult;
		try {
			result = await dispatchConsolidator(pi, runtime, ctx, batch, {
				acquireLock: (projectDir, owner, signal) =>
					waitForProjectLock(projectDir, owner, {
						timeoutMs: flushLockWaitEnvOverride("PI_OM_FLUSH_LOCK_WAIT_MS", FLUSH_LOCK_WAIT_TIMEOUT_MS),
						retryDelayMs: flushLockWaitEnvOverride("PI_OM_FLUSH_LOCK_RETRY_MS", FLUSH_LOCK_RETRY_DELAY_MS),
						signal: ctx.signal ? AbortSignal.any([signal, ctx.signal]) : signal,
					}),
			});
		} catch (error) {
			// Also reset the guard if dispatch fails before entering its own try/finally.
			runtime.consolidatorInFlight = false;
			result = { outcome: "failed", error: error instanceof Error ? error.message : String(error) };
		}

		// Preserve the full-batch archive rather than replacing it with a retry's subset.
		archivePath ??= result.archivePath;
		// Count before any stop check: bank writes stand even when the tombstone is skipped.
		if (result.counts) {
			counts.promoted += result.counts.promoted;
			counts.retained += result.counts.retained;
			counts.discarded += result.counts.discarded;
		}
		counts.discarded += result.screened ?? 0;
		drainedTotal += result.drained ?? 0;

		if (result.tombstoneSkipped || ctx.sessionManager.getSessionId() !== sessionId) {
			stopReason = "session-replaced";
			break;
		}
		if (!runtime.enabled || ctx.signal?.aborted) {
			stopReason = "aborted";
			break;
		}
		stopReason = result.outcome;
		lastError = result.error ?? result.lockMessage;
		if (result.outcome !== "partial" || (result.drained ?? 0) === 0) break;
	}

	// New observations are excluded from retries, but still prevent a completion claim.
	const stillActive = foldLedger(ctx.sessionManager.getBranch() as Entry[]).activeObservations.length;
	if ((stopReason === "completed" || stopReason === "all-screened") && stillActive > 0) stopReason = "partial";
	debugLog("flush.report", { outcome: stopReason, attempts, drained: drainedTotal, stillActive, counts });

	if (stopReason === "completed" || stopReason === "all-screened") {
		const summary = attempts === 0
			? "nothing to consolidate"
			: `promoted ${counts.promoted}, retained in archive ${counts.retained}, discarded ${counts.discarded}` +
				(archivePath ? `; archive: ${archivePath}` : "") + ". Safe to leave this session.";
		notify(`om: flush complete — ${summary}`, "info");
		return;
	}

	const progress = `promoted ${counts.promoted}, retained in archive ${counts.retained}, discarded ${counts.discarded}`;
	const remaining = `${stillActive} observation(s) remain active`;
	const retry = "Not safe to leave — run /om:consolidate --flush again.";
	let message: string;
	let level: "warning" | "error" = "warning";
	switch (stopReason) {
		case "lock-busy":
			message =
				`busy — the project memory lock is ${lastError ?? "held by another process"}; ` +
				`${drainedTotal} observation(s) consolidated, ${remaining}. Run /om:consolidate --flush again later.`;
			break;
		case "failed":
			message = `failed: ${lastError ?? "consolidation did not complete"} — ${progress}; ${remaining}. ${retry}`;
			level = "error";
			break;
		case "aborted":
			message = `aborted — ${progress}; ${remaining}. ${retry}`;
			break;
		case "session-replaced":
			message =
				`incomplete — the session was replaced during consolidation; ${progress}; ` +
				`${remaining} in the new session. Not safe to leave — flush again there.`;
			break;
		default:
			message = `incomplete — ${progress}; ${remaining} after ${attempts} attempt(s). ${retry}`;
	}
	notify(`om: flush ${message}`, level);
}
