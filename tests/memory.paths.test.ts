import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	atomicWrite,
	listTopics,
	overviewPath,
	parseFrontMatter,
	projectMemoryDir,
	readOverview,
	resolvePaths,
	sessionArchiveDir,
	sessionRuntimeDir,
} from "../src/memory/paths.js";

let cwd: string;

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "om-mem-"));
});

afterEach(() => {
	rmSync(cwd, { recursive: true, force: true });
});

/** Write a topic file into the shared project bank. */
function writeTopic(filename: string, content: string): void {
	const projectDir = projectMemoryDir(cwd);
	mkdirSync(projectDir, { recursive: true });
	writeFileSync(join(projectDir, filename), content, "utf-8");
}

describe("three-root resolution", () => {
	it("derives the project bank, session archive, and runtime dir from cwd + session id", () => {
		expect(projectMemoryDir(cwd)).toBe(join(cwd, ".memory", "project"));
		expect(sessionArchiveDir(cwd, "sess-1")).toBe(join(cwd, ".memory", "sessions", "sess-1", "archive"));
		expect(sessionRuntimeDir(cwd, "sess-1")).toBe(join(cwd, ".memory", "runtime", "sess-1"));
	});

	it("scopes the archive and runtime dirs per session, keeps the bank shared", () => {
		expect(sessionArchiveDir(cwd, "a")).not.toBe(sessionArchiveDir(cwd, "b"));
		expect(sessionRuntimeDir(cwd, "a")).not.toBe(sessionRuntimeDir(cwd, "b"));
		expect(projectMemoryDir(cwd)).toBe(projectMemoryDir(cwd)); // one shared bank per cwd
	});

	it("derives everything directly from the given cwd — no parent/project-identity walking", () => {
		// A nested cwd gets its own bank; nothing searches upward for a Git root.
		const nested = join(cwd, "packages", "app");
		expect(projectMemoryDir(nested)).toBe(join(nested, ".memory", "project"));
		expect(sessionArchiveDir(nested, "s")).toBe(join(nested, ".memory", "sessions", "s", "archive"));
	});

	it("resolvePaths computes all three roots (and the session id) from the session context", () => {
		const ctx = { cwd, sessionManager: { getSessionId: () => "sess-1" } };
		expect(resolvePaths(ctx)).toEqual({
			sessionId: "sess-1",
			projectDir: projectMemoryDir(cwd),
			archiveDir: sessionArchiveDir(cwd, "sess-1"),
			runtimeDir: sessionRuntimeDir(cwd, "sess-1"),
		});
	});
});



describe("parseFrontMatter", () => {
	it("parses flat id/title/summary front-matter and returns the body", () => {
		const { front, body } = parseFrontMatter(
			"---\nid: auth\ntitle: Authentication\nsummary: JWT + sessions\n---\nBody text here.\n",
		);
		expect(front).toEqual({ id: "auth", title: "Authentication", summary: "JWT + sessions" });
		expect(body).toBe("Body text here.\n");
	});

	it("strips surrounding quotes", () => {
		const { front } = parseFrontMatter('---\nsummary: "quoted, with comma"\n---\nx');
		expect(front.summary).toBe("quoted, with comma");
	});

	it("no longer accepts the removed `updated` key", () => {
		const { front } = parseFrontMatter("---\nid: auth\nupdated: 2026-06-25 14:00\n---\nx");
		expect(front).toEqual({ id: "auth" });
	});

	it("returns empty front-matter when absent", () => {
		const { front, body } = parseFrontMatter("no front matter");
		expect(front).toEqual({});
		expect(body).toBe("no front matter");
	});
});

describe("listTopics", () => {
	it("returns parsed topics excluding INDEX.md and OVERVIEW.md, sorted by filename", () => {
		writeTopic("INDEX.md", "# Project Memory Index");
		writeTopic("OVERVIEW.md", "Current-state orientation.");
		writeTopic("zebra.md", "---\nid: zebra\ntitle: Zebra\nsummary: z\n---\nbody");
		writeTopic("auth.md", "---\nid: auth\ntitle: Auth\nsummary: a\n---\nbody");
		const topics = listTopics(projectMemoryDir(cwd), cwd);
		expect(topics.map((t) => t.filename)).toEqual(["auth.md", "zebra.md"]);
		expect(topics[0]).toMatchObject({
			id: "auth",
			title: "Auth",
			summary: "a",
			path: join(".memory", "project", "auth.md"),
		});
	});

	it("returns [] when the project bank does not exist", () => {
		expect(listTopics(projectMemoryDir(cwd), cwd)).toEqual([]);
	});

	it("renders paths relative to the passed cwd, not derived from the bank path", () => {
		writeTopic("auth.md", "---\nid: auth\n---\nbody");
		// The cwd is an explicit parameter — a differently-rooted view of the same bank
		// renders paths against that cwd.
		const otherCwd = join(cwd, "other");
		const topics = listTopics(projectMemoryDir(cwd), otherCwd);
		expect(topics[0].path).toBe(join("..", ".memory", "project", "auth.md"));
	});
});

describe("readOverview", () => {
	it("returns undefined when OVERVIEW.md is absent", () => {
		expect(readOverview(projectMemoryDir(cwd))).toBeUndefined();
	});

	it("returns the trimmed body when present", () => {
		writeTopic("OVERVIEW.md", "\nAuth service uses JWT with short-lived sessions.\n\n");
		expect(readOverview(projectMemoryDir(cwd))).toBe("Auth service uses JWT with short-lived sessions.");
	});

	it("returns undefined when OVERVIEW.md is effectively empty", () => {
		writeTopic("OVERVIEW.md", "   \n\n");
		expect(readOverview(projectMemoryDir(cwd))).toBeUndefined();
	});

	it("exposes the overview path inside the bank", () => {
		expect(overviewPath(projectMemoryDir(cwd))).toBe(join(projectMemoryDir(cwd), "OVERVIEW.md"));
	});
});

describe("atomicWrite", () => {
	it("writes content, creating parent dirs", () => {
		const path = join(cwd, ".memory", "project", "auth.md");
		atomicWrite(path, "hello");
		expect(readFileSync(path, "utf-8")).toBe("hello");
	});
});
