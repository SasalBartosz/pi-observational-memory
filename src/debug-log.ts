/**
 * Optional NDJSON debug log (`debugLog` config key, default off). One process-wide context
 * is set at activation (`setDebugLogContext` from session_start / `/om on`); every
 * `debugLog(event, data)` call after that appends one JSON line to the per-session log file
 * under the pi agent dir. Used to trace the cross-process paths of this fork: lock
 * acquire/release/busy, archive writes, outcome validation, flush waits, tombstone commits.
 *
 * Logging must never affect memory behavior: all I/O is wrapped in try/catch, and with the
 * config key off (the default) `debugLog` is a bare flag check.
 */
import { existsSync, mkdirSync, renameSync, statSync, unlinkSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const MAX_BYTES = 10 * 1024 * 1024;

type DebugLogContext = {
	enabled: boolean;
	cwd?: string;
	sessionId?: string;
};

let context: DebugLogContext = { enabled: false };

/**
 * Set the process-wide debug-log context. Called at activation (session_start, `/om on`),
 * after the config is loaded and paths are resolved. pi runs one orchestrator session per
 * process (workers are separate processes that never activate the orchestrator), so a
 * module-level context is sufficient — no per-async-flow scoping needed.
 */
export function setDebugLogContext(next: DebugLogContext): void {
	context = next;
}

function logPath(sessionId: string | undefined): string {
	const sanitized = sessionId
		?.trim()
		.replace(/[^A-Za-z0-9._-]+/g, "_")
		.replace(/^_+|_+$/g, "")
		.slice(0, 128);
	const file =
		sanitized && /[A-Za-z0-9]/.test(sanitized)
			? join("observational-memory", "debug", `${sanitized}.ndjson`)
			: join("observational-memory", "debug.ndjson");
	return join(getAgentDir(), file);
}

function rotateIfNeeded(path: string): void {
	if (!existsSync(path)) return;
	if (statSync(path).size < MAX_BYTES) return;
	const backupPath = `${path}.1`;
	if (existsSync(backupPath)) unlinkSync(backupPath);
	renameSync(path, backupPath);
}

export function debugLog(event: string, data: Record<string, unknown> = {}): void {
	if (context.enabled !== true) return;

	try {
		const path = logPath(context.sessionId);
		mkdirSync(dirname(path), { recursive: true });
		rotateIfNeeded(path);
		const payload = {
			ts: new Date().toISOString(),
			event,
			cwd: context.cwd,
			sessionId: context.sessionId,
			data,
		};
		appendFileSync(path, `${JSON.stringify(payload)}\n`, "utf-8");
	} catch {
		// Debug logging must never affect memory behavior.
	}
}
