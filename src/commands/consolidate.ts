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

/**
 * `/om:consolidate` — force consolidation NOW.
 *
 * Without `--flush`: overflow-only — promote the oldest observations above `poolTargetTokens`,
 * fired even when the pool is below `consolidateAtPoolTokens` (an explicit selection, never a
 * threshold hack). Fire-and-forget like a background trigger.
 *
 * `--flush` (plan §8, short-session/end-of-task): the full pipeline, awaited synchronously so
 * the user gets a final report and knows it is safe to leave:
 *   1. tail observation — one observer over the remaining uncovered conversation, even below
 *      `chunkTokens` (`flushObserverTail`, which first waits for in-flight observers);
 *   2. full-pool consolidation — ALL active observations, bypassing both the pool threshold
 *      and the overflow selection;
 *   3. bounded lock wait — the project lock is retried for up to FLUSH_LOCK_WAIT_TIMEOUT_MS
 *      (cancellable via ctx.signal when the agent provides one); on timeout the flush reports
 *      the holder (inspectProjectLock) and exits WITHOUT spawning.
 *
 * Gates: no-op with a message when om is off; refused when passive (passive = no workers,
 * including flush). The flush's own report carries promoted / retained / discarded counts plus
 * the archive path from the om.observations.archived entry.
 */

/** Lock-wait bounds are env-overridable so tests (or operators) can shrink them. */
function flushLockWaitEnvOverride(name: string, fallback: number): number {
	const raw = process.env[name];
	const parsed = typeof raw === "string" ? Number(raw) : NaN;
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/**
 * Bounded wait for an in-process consolidator run started earlier (a background trigger that
 * fired before the command). Returns false when it is still running after the budget — the
 * flush defers to it rather than racing the in-process guard.
 */
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

			// Gates: off → no-op with a message; passive → refuse (passive = no workers at all).
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

			// ── Non-flush: explicit overflow-only consolidation. ─────────────────────────
			// Same selection the background trigger would make (everything above
			// poolTargetTokens), but fired regardless of consolidateAtPoolTokens — no
			// threshold mutation, just the direct dispatch path.
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
			// Same one-at-a-time guard the threshold trigger holds; dispatchConsolidator resets
			// it in its finally. The .catch covers a (theoretical) pre-try prologue throw.
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
	// ── 1. Tail observation: whatever remains uncovered, even below chunkTokens. ────────
	// flushObserverTail first awaits any in-flight observers, so a chunk dispatched moments
	// ago is never double-observed.
	notify("om: flush — observing the remaining conversation…", "info");
	await flushObserverTail(pi, runtime, ctx);

	// ── 2. Full-pool consolidation — ALL active observations, no overflow selection. ────
	// A background consolidator may have fired just before the command: wait for it (bounded)
	// so this pass sees the settled pool instead of racing the in-process guard.
	if (!(await waitForConsolidatorIdle(runtime, FLUSH_LOCK_WAIT_TIMEOUT_MS))) {
		notify(
			"om: flush deferred — a consolidation started earlier is still running; run /om:consolidate --flush again when it finishes",
			"warning",
		);
		return;
	}

	const branch = ctx.sessionManager.getBranch() as Entry[];
	const active = foldLedger(branch).activeObservations;
	if (active.length === 0) {
		notify("om: flush complete — nothing to consolidate", "info");
		return;
	}

	notify(`om: flushing — consolidating ${active.length} observation(s)…`, "info");
	debugLog("flush.consolidate", { observations: active.length, poolTokens: poolTokens(active) });
	runtime.consolidatorInFlight = true;
	let result: ConsolidatorDispatchResult;
	try {
		result = await dispatchConsolidator(pi, runtime, ctx, active, {
			// Bounded, cancellable lock wait — the user is waiting, so a busy lock is retried,
			// never silently deferred. ctx.signal is the agent's abort signal (usually
			// undefined for commands run while idle — the timeout is the practical bound).
			acquireLock: (projectDir, owner) =>
				waitForProjectLock(projectDir, owner, {
					timeoutMs: flushLockWaitEnvOverride("PI_OM_FLUSH_LOCK_WAIT_MS", FLUSH_LOCK_WAIT_TIMEOUT_MS),
					retryDelayMs: flushLockWaitEnvOverride("PI_OM_FLUSH_LOCK_RETRY_MS", FLUSH_LOCK_RETRY_DELAY_MS),
					signal: ctx.signal,
				}),
		});
	} catch (error) {
		// dispatchConsolidator never rejects in practice (it catches internally); this covers a
		// pre-try prologue throw so the guard never sticks.
		runtime.consolidatorInFlight = false;
		result = { outcome: "failed", error: error instanceof Error ? error.message : String(error) };
	}

	debugLog("flush.report", { outcome: result.outcome, drained: result.drained, counts: result.counts });
	switch (result.outcome) {
		case "completed": {
			const counts = result.counts ?? { promoted: 0, retained: 0, discarded: 0 };
			const discarded = counts.discarded + (result.screened ?? 0);
			let line =
				`om: flush complete — promoted ${counts.promoted}, retained locally ${counts.retained}, discarded ${discarded}` +
				(result.archivePath ? `; archive: ${result.archivePath}` : "") +
				". Safe to leave this session.";
			if (result.tombstoneSkipped) {
				line += " (The session was replaced during the run — the observations remain active; flush again in the new session.)";
			}
			notify(line, "info");
			return;
		}
		case "all-screened":
			notify(
				`om: flush complete — ${result.drained ?? 0} observation(s) looked secret and were discarded locally (never sent to a worker). Safe to leave this session.`,
				"info",
			);
			return;
		case "lock-busy":
			notify(
				`om: flush busy — the project memory lock is ${result.lockMessage ?? "held by another process"}; nothing was consolidated. ` +
					"Run /om:consolidate --flush again later.",
				"warning",
			);
			return;
		case "deferred":
			// Only reachable with the default (single-try) lock waiter — i.e. never from the
			// flush path. Handled for completeness.
			notify("om: flush deferred — the project memory lock is held by another process", "warning");
			return;
		case "failed":
			notify(
				`om: flush failed: ${result.error} — the observations remain active; run /om:consolidate --flush again.`,
				"error",
			);
			return;
	}
}