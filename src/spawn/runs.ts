/**
 * File-based IPC between the in-process orchestrator and subprocess workers.
 *
 * A subprocess cannot append to the master's ledger, so it writes its output to a transient
 * result file under `<cwd>/.memory/runtime/<sessionId>/runs/`. The orchestrator reads +
 * validates it after the process exits, then commits to the right tier (observations →
 * ledger; consolidator outcomes → validated before tombstoning).
 *
 * Worker recordings themselves live in pi's GLOBAL session store, not here (decision 11).
 * IPC is transient and fully separate from durable memory: the runtime dir may be cleaned
 * periodically, but never while workers are live; session archives are not part of that
 * cleanup.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** What the observer model emits, before the orchestrator re-derives precise timestamp-ids. */
export type RawObservation = {
	timestamp: string; // "YYYY-MM-DD HH:MM"
	content: string;
};

export type ObserverRunResult = {
	observations: RawObservation[];
};

/** The consolidator's report for one submitted observation. */
export type ConsolidatorDisposition = "promoted" | "retained" | "discarded";

/** One outcome: what the consolidator did with a submitted observation. */
export type ConsolidatorOutcome = {
	/** The observation's timestamp-id, exactly as submitted. */
	timestamp: string;
	disposition: ConsolidatorDisposition;
};

/** The consolidator result contract: every submitted observation accounted for exactly once. */
export type ConsolidatorRunResult = {
	batchId: string;
	outcomes: ConsolidatorOutcome[];
};

/**
 * Transient run dir under a session's runtime root. Always called with the session runtime
 * dir (`<cwd>/.memory/runtime/<sessionId>`), so IPC files land in
 * `<cwd>/.memory/runtime/<sessionId>/runs/` — outside the durable bank.
 */
export function runsDir(runtimeDir: string): string {
	return join(runtimeDir, "runs");
}

export function runResultPath(runtimeDir: string, runId: string): string {
	return join(runsDir(runtimeDir), `${runId}.result.json`);
}

/**
 * The consolidator's result file (the validated-outcome contract the orchestrator checks
 * before tombstoning). Same runs dir as the observer's result/cost files.
 */
export function consolidatorResultPath(runtimeDir: string, runId: string): string {
	return join(runsDir(runtimeDir), `${runId}.consolidation.json`);
}

/**
 * Per-run cost handoff file. Written by the worker EXTENSION (never the model) from pi's
 * built-in `usage.cost.total`, read by the orchestrator after the process exits. Uniform
 * across roles — both observer and consolidator report cost here.
 */
export function runCostPath(runtimeDir: string, runId: string): string {
	return join(runsDir(runtimeDir), `${runId}.cost.json`);
}

export type WorkerCostResult = {
	costUsd: number;
};

export function writeWorkerCost(path: string, cost: WorkerCostResult): void {
	atomicWrite(path, JSON.stringify(cost));
}

/** Best-effort read of a worker cost file; returns undefined on missing/malformed input. */
export function readWorkerCost(path: string): WorkerCostResult | undefined {
	try {
		const raw = JSON.parse(readFileSync(path, "utf-8")) as unknown;
		if (!raw || typeof raw !== "object") return undefined;
		const cost = (raw as { costUsd?: unknown }).costUsd;
		if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0) return undefined;
		return { costUsd: cost };
	} catch {
		return undefined;
	}
}

/** Atomic write (temp + rename) so a reader never sees a half-written file. */
export function atomicWrite(path: string, content: string): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
	writeFileSync(tmp, content, "utf-8");
	renameSync(tmp, path);
}

function isRawObservation(value: unknown): value is RawObservation {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	return typeof v.timestamp === "string" && typeof v.content === "string" && v.content.trim().length > 0;
}

/** Parse + validate an observer result file. Throws on malformed input. */
export function readObserverResult(path: string): ObserverRunResult {
	const raw = JSON.parse(readFileSync(path, "utf-8")) as unknown;
	if (!raw || typeof raw !== "object" || !Array.isArray((raw as { observations?: unknown }).observations)) {
		throw new Error("observer result missing observations array");
	}
	const observations = (raw as { observations: unknown[] }).observations.filter(isRawObservation);
	return { observations };
}

export function writeObserverResult(path: string, result: ObserverRunResult): void {
	atomicWrite(path, JSON.stringify(result));
}

const DISPOSITIONS: readonly ConsolidatorDisposition[] = ["promoted", "retained", "discarded"];

function isConsolidatorOutcome(value: unknown): value is ConsolidatorOutcome {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	return (
		typeof v.timestamp === "string" &&
		v.timestamp.length > 0 &&
		typeof v.disposition === "string" &&
		(DISPOSITIONS as readonly string[]).includes(v.disposition)
	);
}

export function writeConsolidatorResult(path: string, result: ConsolidatorRunResult): void {
	atomicWrite(path, JSON.stringify(result));
}

/**
 * Parse + validate a consolidator result file. Strict (throws on any malformed field, no
 * silent filtering): this is the validated-outcome contract the orchestrator checks before
 * tombstoning, so a partial or malformed report must fail loudly.
 */
export function readConsolidatorResult(path: string): ConsolidatorRunResult {
	const raw = JSON.parse(readFileSync(path, "utf-8")) as unknown;
	if (!raw || typeof raw !== "object") throw new Error("consolidator result is not an object");
	const v = raw as Record<string, unknown>;
	if (typeof v.batchId !== "string" || v.batchId.length === 0) {
		throw new Error("consolidator result missing batchId");
	}
	if (!Array.isArray(v.outcomes)) throw new Error("consolidator result missing outcomes array");
	for (const outcome of v.outcomes) {
		if (!isConsolidatorOutcome(outcome)) {
			throw new Error("consolidator result has a malformed outcome entry");
		}
	}
	return { batchId: v.batchId, outcomes: v.outcomes };
}
