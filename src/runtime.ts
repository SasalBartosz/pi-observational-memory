import { type Config, DEFAULTS, loadConfig } from "./config.js";
import { foldLedger, poolTokens, rawTokensSinceObservationCoverage, sumSessionCost, type Entry } from "./ledger/index.js";
import { releaseProjectLock, type LockHandle } from "./memory/lock.js";
import { resolvePaths } from "./memory/paths.js";
import { StatusController } from "./ui/status-controller.js";

/**
 * In-process orchestrator state. Event-driven only — no daemon/timer beyond the status
 * spinner. Ephemeral: rebuilt on session_start, cleared on session_shutdown.
 */
export class Runtime {
	config: Config = { ...DEFAULTS };
	configLoaded = false;

	/** The per-session on/off gate (default OFF). Outermost guard in every handler. */
	enabled = false;

	/**
	 * Immutable session-header id captured at activation (survives /name, /resume, /tree);
	 * empty before the first session_start. The three storage roots below derive from it.
	 */
	sessionId = "";

	/**
	 * The shared durable bank `<cwd>/.memory/project` — INDEX/OVERVIEW/topic reads and the
	 * consolidator's sandbox. Captured at activation (session_start, `/om on`) from `ctx.cwd` +
	 * the session id — never from a worker's cwd or a mid-session shell `cd`. Empty before the
	 * first activation.
	 */
	projectDir = "";

	/** Session-local pre-drain archives `<cwd>/.memory/sessions/<sessionId>/archive`. Captured at activation like projectDir. */
	archiveDir = "";

	/** Transient worker IPC root `<cwd>/.memory/runtime/<sessionId>` — also every worker's spawn cwd. Captured at activation like projectDir. */
	runtimeDir = "";

	/**
	 * In-flight observer subprocesses, keyed by runId. `coversUpToId` is the source-entry id at
	 * the END of the observer's chunk — it lets compaction decide whether the observer can affect
	 * the rendered block (an observer whose chunk lands entirely in the verbatim tail is excluded
	 * from the projection regardless, so compaction need not wait for it).
	 */
	readonly observersInFlight = new Map<string, { controller: AbortController; coversUpToId: string }>();

	/** In-flight observer async tasks, so compaction can wait for settled memory state (design R5). */
	readonly observerTasks = new Set<Promise<void>>();

	/**
	 * Strictly one consolidator at a time (design risk 4). The flag is held from dispatch through
	 * tombstone-commit so the pool clock cannot fire a second overlapping run. Runs in the
	 * background — compaction does NOT wait for it (R5).
	 */
	consolidatorInFlight = false;
	consolidatorController: AbortController | undefined;
	/**
	 * The cross-process project lock held by the in-flight consolidator, if any (plan §4). Kept
	 * here so `/om off` and session replacement can abort the worker and then release the lock
	 * in that order (never release while the worker may still write). `releaseConsolidatorLock()`
	 * is idempotent: it clears the field first, so a later release from the dispatch's own
	 * `finally` (or vice versa) is a safe no-op.
	 */
	consolidatorLock: LockHandle | undefined;

	/**
	 * coversUpToId of the most-recent chunk DISPATCHED (committed or still in flight). Combined
	 * with the committed ledger watermark, this is the effective observation watermark: it keeps
	 * parallel observers from re-selecting the same slice and lets zero-observation chunks (which
	 * commit no ledger entry) still advance the clock. In-memory only — lost on resume (harmless;
	 * worst case a chunk is re-observed).
	 */
	dispatchedCoversUpToId: string | undefined;

	/** Guards so compaction trigger + hook never re-enter. */
	compactInFlight = false;
	compactHookInFlight = false;

	/**
	 * Fingerprint of the bank content (overview + topics) at the last bootstrap injection (plan
	 * §9). Per-session in-memory state, reset by `activatePaths()` on every activation —
	 * session_start (fresh, resume, reload, forks) and `/om on` — so the first agent turn after
	 * an activation injects once, then re-injects only when the bank content changes.
	 */
	lastBootstrapFingerprint: string | undefined;

	/**
	 * Signature of the last bootstrap read failure, so the warning notify does not repeat on
	 * every agent turn while the bank stays unreadable (plan §9).
	 */
	lastBootstrapError: string | undefined;

	/** Last worker error message, surfaced by /om:status. */
	lastWorkerError: string | undefined;

	/**
	 * Whether the last compaction waited for in-flight observers or skipped the wait (fast path:
	 * no in-flight observer could affect the rendered block). Surfaced by /om:status.
	 */
	lastCompactionObserverWait: "skipped" | "waited" | undefined;

	readonly status = new StatusController();

	// ── Toast coalescer ──────────────────────────────────────────────────────────
	// Parallel observers fire finish toasts from independent async tasks. If two
	// land in the same event-loop tick, pi's showStatus() would replace the first
	// with the second. queueToast() accumulates info lines and flushes them as a
	// single multi-line notify on the next tick so both lines remain visible.

	private pendingInfoToastLines: string[] = [];
	private infoToastFlushTimer: ReturnType<typeof setTimeout> | undefined;

	/**
	 * Queue an info-level toast line for batched delivery on the next event-loop tick.
	 * Non-info levels (warning/error) bypass the queue and fire immediately so they
	 * always use their own styling and are never merged with info lines.
	 */
	queueToast(
		line: string,
		level: "info" | "warning" | "error",
		notify: (message: string, level: "info" | "warning" | "error") => void,
	): void {
		if (level !== "info") {
			notify(line, level);
			return;
		}
		this.pendingInfoToastLines.push(line);
		if (this.infoToastFlushTimer !== undefined) return;
		this.infoToastFlushTimer = setTimeout(() => {
			this.infoToastFlushTimer = undefined;
			const lines = this.pendingInfoToastLines.splice(0);
			if (lines.length > 0) notify(lines.join("\n"), "info");
		}, 0);
		this.infoToastFlushTimer.unref?.();
	}

	/** Discard any pending toast lines (called on session shutdown). */
	cancelPendingToasts(): void {
		if (this.infoToastFlushTimer !== undefined) {
			clearTimeout(this.infoToastFlushTimer);
			this.infoToastFlushTimer = undefined;
		}
		this.pendingInfoToastLines = [];
	}

	ensureConfig(cwd: string): void {
		if (this.configLoaded) return;
		this.config = loadConfig(cwd);
		this.configLoaded = true;
	}

	/**
	 * Resolve and capture the three storage roots (project bank / session archive / runtime
	 * dir) from `ctx.cwd` + the session id. Called at activation (session_start, `/om on`); on
	 * session replacement the caller aborts in-flight workers first, then re-resolves here so
	 * an old run never commits into the new session's ledger. Pure — creates no directories.
	 */
	activatePaths(ctx: { cwd: string; sessionManager: { getSessionId: () => string } }): void {
		const paths = resolvePaths(ctx);
		this.sessionId = paths.sessionId;
		this.projectDir = paths.projectDir;
		this.archiveDir = paths.archiveDir;
		this.runtimeDir = paths.runtimeDir;
		// Reset the per-session bootstrap injection state (plan §9): a new activation means a
		// new session context, so the next agent turn re-orients once even if the bank is
		// unchanged. In-memory only — a plain /om off→on cycle re-injects once, by design.
		this.lastBootstrapFingerprint = undefined;
		this.lastBootstrapError = undefined;
	}

	/** Recompute the live footer gauges (next-observer + pool + context) from the current branch. */
	refreshFooterGauges(branch: Entry[], contextTokens?: number | null): void {
		if (!this.enabled) return;
		const folded = foldLedger(branch);
		this.status.setGauges({
			nextValue: rawTokensSinceObservationCoverage(branch),
			nextMax: this.config.chunkTokens,
			poolValue: poolTokens(folded.activeObservations),
			poolMax: this.config.consolidateAtPoolTokens,
			ctxValue: contextTokens ?? 0,
			ctxMax: this.config.compactAtContextTokens,
		});
	}

	/**
	 * Recompute accumulated session cost for the footer from ALL entries (every branch), so the
	 * displayed spend never rolls back under /tree. Pass `getEntries()`, not `getBranch()`.
	 */
	refreshCost(allEntries: Entry[]): void {
		if (!this.enabled) return;
		const { costUsd, runs } = sumSessionCost(allEntries);
		this.status.setCost(costUsd, runs);
	}

	/** Abort and forget all in-flight workers (session shutdown / disable). */
	abortAllWorkers(): void {
		this.cancelPendingToasts();
		for (const { controller } of this.observersInFlight.values()) {
			controller.abort();
		}
		this.observersInFlight.clear();
		// Order matters (§4): abort the consolidator worker FIRST, then release the project lock
		// only if we still hold it — never the other way around, and never while a worker we
		// spawned is guaranteed live. The dispatch's own `finally` also releases; whichever runs
		// first wins the field, the other is a no-op.
		this.consolidatorController?.abort();
		this.consolidatorController = undefined;
		this.releaseConsolidatorLock();
		this.consolidatorInFlight = false;
	}

	/**
	 * Release the held consolidator project lock, if any. Idempotent and safe anywhere: the
	 * field is cleared before the owner-checked release (which never throws).
	 */
	releaseConsolidatorLock(): void {
		const handle = this.consolidatorLock;
		if (!handle) return;
		this.consolidatorLock = undefined;
		releaseProjectLock(handle);
	}

	/** Track an observer task for the lifetime of its async run. */
	trackObserverTask(task: Promise<void>): void {
		this.observerTasks.add(task);
		void task.finally(() => this.observerTasks.delete(task));
	}

	/** Resolve once no observer tasks are in flight (compaction blocks on this). */
	async whenObserversIdle(): Promise<void> {
		while (this.observerTasks.size > 0) {
			await Promise.allSettled([...this.observerTasks]);
		}
	}

	get observerSlotsAvailable(): number {
		return Math.max(0, this.config.observerConcurrency - this.observersInFlight.size);
	}
}
