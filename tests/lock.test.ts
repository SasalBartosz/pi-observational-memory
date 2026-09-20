import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	acquireProjectLock,
	inspectProjectLock,
	projectLockPath,
	releaseProjectLock,
	type LockHandle,
	type ProjectLockOwner,
} from "../src/memory/lock.js";

let projectDir: string;

beforeEach(() => {
	const cwd = mkdtempSync(join(tmpdir(), "om-lock-"));
	projectDir = join(cwd, ".memory", "project");
});

afterEach(() => {
	rmSync(join(projectDir, "..", ".."), { recursive: true, force: true });
});

function owner(overrides: Partial<ProjectLockOwner> = {}): ProjectLockOwner {
	return { pid: process.pid, sessionId: "sess-1", ...overrides };
}

/** Simulate a second, independent Pi process: its own owner identity, same projectDir. */
function secondOwner(): ProjectLockOwner {
	return owner({ sessionId: "sess-2" });
}

function lockPath(): string {
	return projectLockPath(projectDir);
}

/** Write a raw lock file, as if a (possibly dead) foreign process had left it behind. */
function writeRawLock(content: string): void {
	mkdirSync(projectDir, { recursive: true });
	writeFileSync(lockPath(), content, "utf-8");
}

function acquireOrThrow(o: ProjectLockOwner): LockHandle {
	const result = acquireProjectLock(projectDir, o);
	expect(result).not.toBe("busy");
	return result as LockHandle;
}

describe("acquireProjectLock", () => {
	it("creates the lock atomically and returns a handle", () => {
		const handle = acquireOrThrow(owner());
		expect(lockPath()).toBe(handle.path);
	});

	it("creates the project dir when it does not exist yet", () => {
		expect(acquireProjectLock(projectDir, owner())).not.toBe("busy");
	});

	it("returns \"busy\" for a second client while held (atomic exclusive create)", () => {
		const first = acquireProjectLock(projectDir, owner());
		expect(first).not.toBe("busy");
		const second = acquireProjectLock(projectDir, secondOwner());
		expect(second).toBe("busy");
	});

	it("returns \"busy\" even for a stale lock (no stealing)", () => {
		const deadPid = reapChildPid();
		writeRawLock(`${JSON.stringify({ pid: deadPid, sessionId: "ghost", token: "t", acquiredAt: "2026-01-01T00:00:00.000Z" })}\n`);
		expect(acquireProjectLock(projectDir, owner())).toBe("busy");
	});
});

describe("lock file content", () => {
	it("round-trips pid, sessionId, runId, token and acquiredAt", () => {
		const o = owner({ runId: "run-42" });
		const handle = acquireOrThrow(o);
		const info = inspectProjectLock(projectDir);
		expect(info).toMatchObject({
			pid: o.pid,
			sessionId: o.sessionId,
			runId: "run-42",
			token: handle.token,
			stale: false,
		});
		expect(info?.acquiredAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
		expect(() => new Date(info!.acquiredAt).toISOString()).not.toThrow();
	});

	it("omits runId from the file when unset", () => {
		const handle = acquireOrThrow(owner());
		const raw = JSON.parse(readRaw());
		expect(raw.token).toBe(handle.token);
		expect("runId" in raw && raw.runId !== undefined).toBe(false);
	});
});

describe("releaseProjectLock", () => {
	it("frees the lock so re-acquire succeeds", () => {
		const handle = acquireOrThrow(owner());
		releaseProjectLock(handle);
		expect(acquireProjectLock(projectDir, owner())).not.toBe("busy");
	});

	it("does not throw when the lock file is already gone", () => {
		const handle = acquireOrThrow(owner());
		releaseProjectLock(handle);
		expect(() => releaseProjectLock(handle)).not.toThrow();
	});

	it("does not unlink a lock replaced by another owner (token mismatch)", () => {
		const ours = acquireOrThrow(owner());
		// Simulate the lock file having been replaced behind our back: a foreign owner
		// with a different token now owns the file.
		const foreignToken = "foreign-token-uuid";
		writeRawLock(
			`${JSON.stringify({ pid: process.pid, sessionId: "sess-2", token: foreignToken, acquiredAt: new Date().toISOString() })}\n`,
		);
		expect(() => releaseProjectLock(ours)).not.toThrow();
		const info = inspectProjectLock(projectDir);
		expect(info).toBeDefined();
		expect(info?.token).toBe(foreignToken); // file survived — not ours to unlink
	});

	it("does not unlink an unparseable lock file", () => {
		const ours = acquireOrThrow(owner());
		writeRawLock("not json at all");
		expect(() => releaseProjectLock(ours)).not.toThrow();
		expect(inspectProjectLock(projectDir)).toBeDefined();
	});
});

describe("inspectProjectLock", () => {
	it("returns undefined when no lock exists", () => {
		expect(inspectProjectLock(projectDir)).toBeUndefined();
	});

	it("reports a live holder as not stale with a \"held by\" message", () => {
		const o = owner({ sessionId: "sess-9" });
		acquireOrThrow(o);
		const info = inspectProjectLock(projectDir);
		expect(info?.stale).toBe(false);
		expect(info?.message).toContain(`held by pid ${o.pid}`);
		expect(info?.message).toContain("session sess-9");
	});

	it("reports a lock with a dead pid as stale but leaves cleanup manual", () => {
		const deadPid = reapChildPid();
		expect(deadPid).toBeGreaterThan(0);
		writeRawLock(
			`${JSON.stringify({ pid: deadPid, sessionId: "ghost", token: "tok", acquiredAt: "2026-01-01T00:00:00.000Z" })}\n`,
		);
		const info = inspectProjectLock(projectDir);
		expect(info?.stale).toBe(true);
		expect(info?.message).toContain("stale");
		expect(info?.message).toContain(String(deadPid));
	});

	it("reports a malformed lock file as stale", () => {
		writeRawLock("{{{");
		const info = inspectProjectLock(projectDir);
		expect(info?.stale).toBe(true);
		expect(info?.message).toContain("malformed");
	});
});

/**
 * Spawn a child process that exits immediately, then return its (now dead) pid.
 * `spawnSync` waits for exit and reaps the child, so the pid is no longer running.
 */
function reapChildPid(): number {
	const result = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
	expect(result.status).toBe(0);
	return result.pid ?? -1;
}

function readRaw(): string {
	try {
		return readFileSync(lockPath(), "utf-8");
	} catch {
		return "";
	}
}
