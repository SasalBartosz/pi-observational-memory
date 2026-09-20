/**
 * Cross-process project consolidation lock (plan §4).
 *
 * The lock coordinates independent Pi processes that consolidate into the same shared
 * durable bank (`<projectDir>/.memory/project/`). It is purely cooperative: there is no
 * OS-enforced mutex around the bank's topic files, only this lock file, which must be
 * acquired before a consolidator touches the shared bank and released after the worker
 * has fully exited (call in `finally`).
 *
 * Acquisition uses atomic exclusive create (`open(path, "wx")`) — the lock file either
 * comes into existence as ours or it already belongs to someone else; there is no
 * exists-check-then-write race window.
 *
 * Busy behavior is the caller's choice, NOT this module's: background (threshold-triggered)
 * consolidation defers silently to a later trigger; an explicit flush waits with a
 * bounded, cancellable retry and reports "busy" on timeout. That retry logic lives in the
 * callers (consolidator-trigger / consolidate command), never here. While waiting, a
 * consolidator must never be spawned.
 *
 * Stale-lock policy (MVP): a lock whose recorded PID is dead may be *reported* stale via
 * `inspectProjectLock()`, but there is NO age-based stealing, NO heartbeat/lease
 * machinery, and NO automatic breaking of stale locks — `acquireProjectLock()` still
 * returns "busy" for a stale lock. Cleanup of a stale lock file is manual (or by a future
 * operator command); callers should use `inspectProjectLock()` to surface the situation
 * ("lock held by dead pid X — remove <path> manually") to the user.
 */
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { debugLog } from "../debug-log.js";

/** The lock file name inside the project bank directory. */
export const CONSOLIDATION_LOCK_FILENAME = ".consolidation.lock";

export interface ProjectLockOwner {
	pid: number;
	sessionId: string;
	runId?: string;
}

/** Handle returned by a successful acquire; the proof of ownership passed to release. */
export interface LockHandle {
	/** Absolute path of the lock file on disk. */
	path: string;
	/** The project bank directory the lock lives in. */
	projectDir: string;
	/** Random ownership token recorded in the lock file; release only unlinks on match. */
	token: string;
	owner: ProjectLockOwner;
}

/** Snapshot of an on-disk lock, as returned by `inspectProjectLock`. */
export interface LockInfo {
	path: string;
	pid: number;
	sessionId: string;
	runId?: string;
	token: string;
	acquiredAt: string;
	/** True when the recorded PID is dead (the lock is dangling; manual cleanup needed). */
	stale: boolean;
	/** Human-readable status for surfacing to the user. */
	message: string;
}

export function projectLockPath(projectDir: string): string {
	return join(projectDir, CONSOLIDATION_LOCK_FILENAME);
}

/**
 * True when `pid` is running. `process.kill(pid, 0)` delivers no signal — it only
 * probes for existence. ESRCH means the pid is dead; EPERM means it exists but is
 * owned by someone else (still alive). Any other error is treated conservatively
 * as alive.
 */
export function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ESRCH") return false;
		if (code === "EPERM") return true;
		return true;
	}
}

/**
 * Acquire the project consolidation lock via atomic exclusive create.
 *
 * Returns a `LockHandle` on success, or `"busy"` when the lock file already exists
 * (whoever created it owns the bank — even if their process has since died; stale
 * locks are never broken here, see the module doc). Any other filesystem error
 * propagates to the caller.
 */
export function acquireProjectLock(projectDir: string, owner: ProjectLockOwner): LockHandle | "busy" {
	const path = projectLockPath(projectDir);
	// The bank directory may not exist yet in a fresh project — create it before locking.
	mkdirSync(projectDir, { recursive: true });

	let fd: number;
	try {
		fd = openSync(path, "wx"); // atomic: fails with EEXIST if anyone got there first
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "EEXIST") {
			debugLog("lock.acquire.busy", { path, owner });
			return "busy";
		}
		throw error;
	}

	const token = randomUUID();
	const acquiredAt = new Date().toISOString();
	const content = {
		pid: owner.pid,
		sessionId: owner.sessionId,
		runId: owner.runId,
		token,
		acquiredAt,
	};
	try {
		writeSync(fd, `${JSON.stringify(content, null, "\t")}\n`);
	} finally {
		closeSync(fd);
	}

	debugLog("lock.acquire", { path, owner, token, acquiredAt });
	return { path, projectDir, token, owner };
}

/**
 * Release the project consolidation lock. Owner-checked: the lock file is re-read and
 * only unlinked when the token it records matches ours. If the file is missing, or has
 * been replaced by a different owner (token mismatch / unparseable content), the file
 * is left alone — this function logs a warning via `debugLog` and never throws, so it
 * is always safe to call in a `finally` block.
 */
export function releaseProjectLock(handle: LockHandle): void {
	let raw: string;
	try {
		raw = readFileSync(handle.path, "utf-8");
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") {
			debugLog("lock.release.missing", { path: handle.path, token: handle.token });
			return;
		}
		if (code === "EISDIR" || code === "EPERM" || code === "EACCES") {
			debugLog("lock.release.error", { path: handle.path, code });
			return;
		}
		debugLog("lock.release.error", { path: handle.path, code: String((error as Error)?.message ?? error) });
		return;
	}

	let stored: { token?: string; pid?: number; sessionId?: string } = {};
	try {
		stored = JSON.parse(raw) as typeof stored;
	} catch {
		debugLog("lock.release.malformed", { path: handle.path });
		return;
	}

	if (stored.token !== handle.token) {
		debugLog("lock.release.token-mismatch", {
			path: handle.path,
			expected: handle.token,
			found: stored.token ?? undefined,
		});
		return;
	}

	try {
		unlinkSync(handle.path);
		debugLog("lock.release", { path: handle.path, token: handle.token });
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return;
		debugLog("lock.release.error", { path: handle.path, code });
	}
}

/**
 * Read the lock file and report its state. Returns `undefined` when no lock file
 * exists. A lock whose recorded PID is dead is reported with `stale: true` and a
 * "stale" message so callers can tell the user to clean it up manually —
 * `acquireProjectLock` will still return "busy" for it (no stealing).
 */
export function inspectProjectLock(projectDir: string): LockInfo | undefined {
	const path = projectLockPath(projectDir);
	let raw: string;
	try {
		raw = readFileSync(path, "utf-8");
	} catch {
		return undefined; // no lock file (ENOENT) or unreadable — treat as unlocked
	}

	let parsed: {
		pid?: number;
		sessionId?: string;
		runId?: string;
		token?: string;
		acquiredAt?: string;
	} = {};
	try {
		parsed = JSON.parse(raw) as typeof parsed;
	} catch {
		return {
			path,
			pid: NaN,
			sessionId: "",
			token: "",
			acquiredAt: "",
			stale: true,
			message: `malformed lock file at ${path} — remove it manually`,
		};
	}

	const pid = parsed.pid ?? NaN;
	const sessionId = parsed.sessionId ?? "unknown";
	const stale = !Number.isFinite(pid) || !isPidAlive(pid);
	const message = stale
		? `stale lock at ${path} (pid ${Number.isFinite(pid) ? pid : "unknown"} is no longer running; manual cleanup needed)`
		: `held by pid ${pid} (session ${sessionId})`;

	if (stale) {
		debugLog("lock.inspect.stale", { path, pid, sessionId });
	}

	return {
		path,
		pid,
		sessionId,
		runId: parsed.runId,
		token: parsed.token ?? "",
		acquiredAt: parsed.acquiredAt ?? "",
		stale,
		message,
	};
}
