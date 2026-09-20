/**
 * Consolidator clock. When the active observation pool crosses `consolidateAtPoolTokens`,
 * promote the oldest observations (above `poolTargetTokens`) into durable
 * `.memory/project/` topic files via a subprocess consolidator, then tombstone exactly the
 * batch it was handed.
 *
 * Runs in the BACKGROUND, mirroring the observer trigger (turn_end / agent_start), strictly
 * one at a time (design risk 4). Compaction does not wait for it (R5).
 *
 * Tombstone safety (design risk 4): the orchestrator tombstones the batch it handed the
 * consolidator, intersected with what is STILL active at exit — never an observation an
 * observer committed during the run (those are not in the handed batch). The consolidator does
 * not report back: it must consolidate everything it was given (filing or discarding junk is a
 * valid outcome), so on clean exit we trust it and drop the whole batch. This guarantees the
 * buffer always drains; a flaked-out partial run is recoverable from the worker's global session
 * recording (the standing safety net for lossy rewrites) and is the critic tier's job to catch.
 */
import { mkdirSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
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
import { renderIndexFile } from "../memory/index-render.js";
import { atomicWrite, indexPath, listTopics, readOverview } from "../memory/paths.js";
import type { Runtime } from "../runtime.js";
import { buildWorkerArgv, buildWorkerEnv, spawnWorker } from "../spawn/launch.js";
import { recordWorkerCost } from "./observer-trigger.js";

type TriggerCtx = {
	cwd: string;
	hasUI: boolean;
	ui?: { notify: (message: string, level?: "info" | "warning" | "error") => void };
	sessionManager: { getBranch: () => Entry[]; getEntries: () => Entry[] };
	getContextUsage?: () => { tokens: number | null } | undefined;
};

let runCounter = 0;

function nextRunId(): string {
	runCounter += 1;
	const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
	return `cons-${stamp}-${process.pid}-${runCounter}`;
}

/**
 * Build the consolidator's `-p` prompt: current index + current overview + the overflow
 * lines. The overview is included verbatim so the consolidator rewrites it in place
 * (wholesale, undated — never a dated running history). Nothing in the prompt or the bank
 * carries timestamps; front matter is exactly id/title/summary.
 */
function buildConsolidatorPrompt(
	projectDir: string,
	cwd: string,
	promote: Observation[],
	overviewTargetTokens: number,
): string {
	const indexText = renderIndexFile(listTopics(projectDir, cwd));
	const overviewText = readOverview(projectDir);
	const overviewWords = Math.round((overviewTargetTokens * 3) / 4);
	const obsLines = sortObservations(promote).map(observationToLine).join("\n");
	return (
		"You are folding the observations below into the durable topic files under .memory/project/. " +
		"Front matter is exactly id/title/summary — no dates or timestamps anywhere in the bank.\n\n" +
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
		`(~${overviewWords} words), undated current-state orientation: no advice or next steps. ` +
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
	// never the consolidator (design R5). The consolidatorInFlight flag enforces one-at-a-time.
	void dispatchConsolidator(pi, runtime, ctx, promote);
}

async function dispatchConsolidator(
	pi: ExtensionAPI,
	runtime: Runtime,
	ctx: TriggerCtx,
	promote: Observation[],
): Promise<void> {
	const runId = nextRunId();
	const controller = new AbortController();
	runtime.consolidatorController = controller;
	runtime.status.workerStart("consolidator", runId);

	try {
		// The worker's scoped `ls`/`read` tools expect the sandbox root to exist; the shared bank
		// is otherwise created lazily by its first durable write.
		mkdirSync(runtime.projectDir, { recursive: true });
		const prompt = buildConsolidatorPrompt(
			runtime.projectDir,
			ctx.cwd,
			promote,
			runtime.config.overviewTargetTokens,
		);
		const argv = buildWorkerArgv({
			model: runtime.config.models.consolidator,
			sessionName: `om-consolidator-${runId}`,
			kickoffPrompt: prompt,
		});
		const env = buildWorkerEnv("consolidator", {
			runtimeDir: runtime.runtimeDir,
			projectDir: runtime.projectDir,
			runId,
		});
		const exit = await spawnWorker({ argv, cwd: runtime.runtimeDir, env, signal: controller.signal });
		// Capture cost before the exit-code check so a partial run's spend is still recorded.
		recordWorkerCost(pi, runtime, ctx, "consolidator", runId);
		if (exit.code !== 0) {
			throw new Error(`consolidator exited with code ${exit.code}${exit.stderr ? `: ${exit.stderr.trim().slice(0, 200)}` : ""}`);
		}

		// Trust the consolidator: on clean exit it has folded (or discarded) everything we handed it.
		// Re-fold against the CURRENT branch so we never tombstone something already dropped or an
		// observation an observer committed during this run (those are not in the handed batch).
		const branch = ctx.sessionManager.getBranch();
		const stillActive = new Set(foldLedger(branch).activeObservations.map((o) => o.timestamp));
		const toDrop = promote.map((o) => o.timestamp).filter((t) => stillActive.has(t));

		if (toDrop.length > 0) {
			const coversUpToId = lastSourceEntryId(branch);
			if (coversUpToId) {
				pi.appendEntry(OM_OBSERVATIONS_DROPPED, { observationTimestamps: toDrop, coversUpToId });
			}
		}

		// Re-render INDEX.md so live ls/grep truth leads the pushed map (design risk 3).
		atomicWrite(indexPath(runtime.projectDir), renderIndexFile(listTopics(runtime.projectDir, ctx.cwd)));

		runtime.status.workerDone(runId, toDrop.length);
		runtime.refreshFooterGauges(ctx.sessionManager.getBranch(), ctx.getContextUsage?.()?.tokens ?? null);
		if (ctx.hasUI && ctx.ui) {
			runtime.queueToast(`om: consolidator promoted ${toDrop.length} obs`, "info", ctx.ui.notify.bind(ctx.ui));
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		runtime.lastWorkerError = message;
		runtime.status.workerError(runId);
		if (ctx.hasUI) ctx.ui?.notify(`om: consolidator failed: ${message}`, "error");
	} finally {
		runtime.consolidatorController = undefined;
		runtime.consolidatorInFlight = false;
	}
}

export function registerConsolidatorTrigger(pi: ExtensionAPI, runtime: Runtime): void {
	const handler = (_event: unknown, ctx: TriggerCtx) => evaluateConsolidatorTrigger(pi, runtime, ctx);
	pi.on("turn_end", handler as never);
	pi.on("agent_start", handler as never);
}
