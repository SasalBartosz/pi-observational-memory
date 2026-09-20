/**
 * `.memory/` substrate — the three-root, cwd-scoped storage layout:
 *
 *   <cwd>/.memory/
 *   ├── project/                        shared durable bank (INDEX.md, OVERVIEW.md, topics)
 *   ├── sessions/<sessionId>/archive/   session-only pre-drain archives (persistent)
 *   └── runtime/<sessionId>/runs/       transient worker IPC (result/cost files)
 *
 * The filesystem IS the long-term recall interface: the master reads topic files with ordinary
 * `ls`/`read`/`grep`. Topic files are NOT rolled back by `/tree` (they track the repo, not the
 * session branch). Nothing in the bank is dated — no timestamps, session attribution, or
 * change logs; Git and session logs own history.
 *
 * All writes are atomic (temp + rename) so a reader never sees a half-written file.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

export const INDEX_FILENAME = "INDEX.md";
/**
 * The undated, current-state project orientation. Consolidator-authored prose (no front-matter),
 * rewritten wholesale to reflect established understanding and carried by every orientation
 * block (compaction + bootstrap). Like INDEX.md a special file, NOT a topic file: it is excluded
 * from `listTopics` and read verbatim.
 */
export const OVERVIEW_FILENAME = "OVERVIEW.md";

/** The cwd-level `.memory/` base; the three roots (project / sessions / runtime) live below it. */
export function memoryBaseDir(cwd: string): string {
	return join(cwd, ".memory");
}

/**
 * The shared durable bank `<cwd>/.memory/project` — INDEX.md, OVERVIEW.md, and topic files read
 * by every session in this cwd; also the consolidator's sandbox. Derived directly from the
 * given cwd: no Git-root search, no project-identity layer.
 */
export function projectMemoryDir(cwd: string): string {
	return join(memoryBaseDir(cwd), "project");
}

/**
 * The session-local pre-drain archive dir `<cwd>/.memory/sessions/<sessionId>/archive` — where
 * consolidator batches are written verbatim before draining. Persistent, unlike the runtime dir.
 */
export function sessionArchiveDir(cwd: string, sessionId: string): string {
	return join(memoryBaseDir(cwd), "sessions", sessionId, "archive");
}

/**
 * The transient runtime dir `<cwd>/.memory/runtime/<sessionId>` — the worker spawn cwd and the
 * `runs/` IPC files beneath it. Safe to clean periodically, but never while workers are live;
 * session archives are not part of that cleanup.
 */
export function sessionRuntimeDir(cwd: string, sessionId: string): string {
	return join(memoryBaseDir(cwd), "runtime", sessionId);
}

/** A session context with just enough surface to resolve the three storage roots. */
export type ResolvePathsCtx = {
	cwd: string;
	sessionManager: { getSessionId: () => string };
};

/**
 * Compute the three storage roots (project bank / session archive / runtime dir) from
 * `ctx.cwd` + the session id — the single derivation every activation goes through. Pure:
 * creates nothing; each root is created lazily by its first writer.
 */
export function resolvePaths(ctx: ResolvePathsCtx): {
	sessionId: string;
	projectDir: string;
	archiveDir: string;
	runtimeDir: string;
} {
	const sessionId = ctx.sessionManager.getSessionId();
	return {
		sessionId,
		projectDir: projectMemoryDir(ctx.cwd),
		archiveDir: sessionArchiveDir(ctx.cwd, sessionId),
		runtimeDir: sessionRuntimeDir(ctx.cwd, sessionId),
	};
}

export function indexPath(root: string): string {
	return join(root, INDEX_FILENAME);
}

export function overviewPath(root: string): string {
	return join(root, OVERVIEW_FILENAME);
}

/**
 * Read the OVERVIEW.md body (undated current-state orientation), trimmed. Returns undefined
 * when missing or effectively empty.
 */
export function readOverview(root: string): string | undefined {
	const path = overviewPath(root);
	if (!existsSync(path)) return undefined;
	try {
		const body = readFileSync(path, "utf-8").trim();
		return body.length > 0 ? body : undefined;
	} catch {
		return undefined;
	}
}

/** Atomic write (temp + rename). Creates parent dirs as needed. */
export function atomicWrite(path: string, content: string): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
	writeFileSync(tmp, content, "utf-8");
	renameSync(tmp, path);
}

export type TopicFrontMatter = {
	id?: string;
	title?: string;
	summary?: string;
};

export type Topic = TopicFrontMatter & {
	/** Path relative to the project cwd, e.g. ".memory/project/auth.md". */
	path: string;
	/** Bare filename, e.g. "auth.md". */
	filename: string;
};

const FRONT_MATTER_RE = /^---\n([\s\S]*?)\n---\n?/;

/**
 * Parse leading YAML-ish front-matter. Intentionally tiny (no YAML dep): supports exactly the
 * flat routing fields the consolidator authors — `id`, `title`, `summary` (nothing else; the
 * schema carries no dates or timestamps). Returns the parsed fields plus the body after the
 * front-matter block.
 */
export function parseFrontMatter(content: string): { front: TopicFrontMatter; body: string } {
	const match = FRONT_MATTER_RE.exec(content);
	if (!match) return { front: {}, body: content };
	const front: TopicFrontMatter = {};
	for (const line of match[1].split("\n")) {
		const idx = line.indexOf(":");
		if (idx < 0) continue;
		const key = line.slice(0, idx).trim();
		let value = line.slice(idx + 1).trim();
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}
		if (key === "id" || key === "title" || key === "summary") {
			front[key] = value;
		}
	}
	return { front, body: content.slice(match[0].length) };
}

/**
 * List parsed topic files (every `*.md` except INDEX.md/OVERVIEW.md) under the project bank,
 * sorted by filename. The project cwd is passed in explicitly (not derived from the bank path)
 * so each topic's `path` renders relative to it — e.g. `.memory/project/auth.md` — and the
 * master can `read`/`grep` it directly from the map.
 */
export function listTopics(projectDir: string, cwd: string): Topic[] {
	if (!existsSync(projectDir)) return [];
	const topics: Topic[] = [];
	for (const filename of readdirSync(projectDir)) {
		if (!filename.endsWith(".md") || filename === INDEX_FILENAME || filename === OVERVIEW_FILENAME) continue;
		let content: string;
		try {
			content = readFileSync(join(projectDir, filename), "utf-8");
		} catch {
			continue;
		}
		const { front } = parseFrontMatter(content);
		topics.push({ ...front, path: relative(cwd, join(projectDir, filename)), filename });
	}
	topics.sort((a, b) => (a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0));
	return topics;
}
