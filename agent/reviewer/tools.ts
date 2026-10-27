import { execFileSync } from "node:child_process";
import {
	existsSync,
	lstatSync,
	readFileSync,
	readdirSync,
	realpathSync,
	statSync,
	unlinkSync,
} from "node:fs";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { DEFAULT_MAX_BYTES, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Static } from "typebox";
import { atomicWrite } from "../../src/memory/paths.js";
import { fail, ok, type ToolText } from "../tool-text.js";

const MAX_READ_LINES = 400;
const MAX_GREP_HITS = 200;
const MAX_GREP_LINE_CHARS = 500;
const MAX_GREP_FILE_BYTES = 1_000_000;
const MAX_OUTPUT_BYTES = DEFAULT_MAX_BYTES;
// Leave room for the bounded status/continuation notices inside the response byte cap.
const MAX_CONTENT_BYTES = MAX_OUTPUT_BYTES - 512;
const TOPIC_FILENAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;

const ReadMemorySchema = Type.Object({
	path: Type.String({ description: "Root-level memory Markdown filename, e.g. 'auth.md' or 'OVERVIEW.md'." }),
});
const WriteMemorySchema = Type.Object({
	path: Type.String({ description: "Root-level memory Markdown filename. New topic names must be lowercase kebab-case." }),
	content: Type.String({ description: "Complete replacement content." }),
});
const EditMemorySchema = Type.Object({
	path: Type.String({ description: "Root-level memory Markdown filename." }),
	oldText: Type.String({ description: "Exact text to replace; it must occur exactly once." }),
	newText: Type.String({ description: "Replacement text." }),
});
const DeleteMemorySchema = Type.Object({
	path: Type.String({ description: "Root-level memory Markdown filename to remove after merging or pruning it." }),
});
const EmptySchema = Type.Object({});
const ProjectPathSchema = Type.Object({
	path: Type.Optional(Type.String({ description: "Project-relative file or directory. Defaults to the project root." })),
});
const ProjectReadSchema = Type.Object({
	path: Type.String({ description: "Project-relative file path." }),
	offset: Type.Optional(Type.Integer({ minimum: 1, description: "First line to return (1-indexed). Defaults to 1." })),
	column: Type.Optional(Type.Integer({ minimum: 1, description: "First Unicode character in the first returned line (1-indexed). Defaults to 1. Use the continuation column to resume a truncated long line." })),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_READ_LINES, description: `Maximum lines to return (up to ${MAX_READ_LINES}).` })),
});
const ProjectGrepSchema = Type.Object({
	pattern: Type.String({ description: "JavaScript regular expression to search for." }),
	path: Type.Optional(Type.String({ description: "Project-relative file or directory. Defaults to the project root." })),
});

type ReadMemoryInput = Static<typeof ReadMemorySchema>;
type WriteMemoryInput = Static<typeof WriteMemorySchema>;
type EditMemoryInput = Static<typeof EditMemorySchema>;
type DeleteMemoryInput = Static<typeof DeleteMemorySchema>;
type ProjectPathInput = Static<typeof ProjectPathSchema>;
type ProjectReadInput = Static<typeof ProjectReadSchema>;
type ProjectGrepInput = Static<typeof ProjectGrepSchema>;

function flatMemoryPath(root: string, requested: string, forWrite = false): { abs: string; filename: string } | undefined {
	const filename = requested.trim();
	if (filename !== basename(filename) || !filename.endsWith(".md") || filename.startsWith(".")) return undefined;
	if (filename.toLowerCase() === "index.md") return undefined;
	if (forWrite && filename !== "OVERVIEW.md" && !TOPIC_FILENAME_RE.test(filename)) return undefined;
	return { abs: resolve(root, filename), filename };
}

const DENIED_PROJECT_SEGMENTS = new Set([
	".git",
	".memory",
	".pi",
	"node_modules",
	"dist",
	"build",
	"coverage",
	".next",
	"target",
	".venv",
	"venv",
]);

function isLikelySecretName(name: string): boolean {
	const lower = name.toLowerCase();
	return (
		lower === ".env" ||
		lower.startsWith(".env.") ||
		lower === ".npmrc" ||
		lower === ".netrc" ||
		lower === "credentials" ||
		lower === "credentials.json" ||
		lower === "secrets.json" ||
		/\.(?:pem|key|p12|pfx|jks)$/i.test(lower)
	);
}

function deniedProjectPath(rel: string): boolean {
	if (!rel || rel === ".") return false;
	for (const segment of rel.split(/[\\/]/)) {
		if (DENIED_PROJECT_SEGMENTS.has(segment) || isLikelySecretName(segment)) return true;
	}
	return false;
}

function within(root: string, candidate: string): boolean {
	const rel = relative(root, candidate);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function scopedProjectPath(root: string, requested: string): { abs: string; rel: string } | undefined {
	const lexical = resolve(root, requested || ".");
	if (!within(root, lexical)) return undefined;
	const lexicalRel = relative(root, lexical) || ".";
	if (deniedProjectPath(lexicalRel) || !existsSync(lexical)) return undefined;
	let real: string;
	try {
		real = realpathSync(lexical);
	} catch {
		return undefined;
	}
	if (!within(root, real)) return undefined;
	const realRel = relative(root, real) || ".";
	if (deniedProjectPath(realRel)) return undefined;
	return { abs: real, rel: lexicalRel };
}

/**
 * Git-ignored, untracked paths under the project root, relative to it with `/` separators.
 * Fully ignored directories collapse to one `dir/` entry. Empty outside a git work tree.
 */
function listGitIgnored(root: string): Set<string> {
	try {
		const out = execFileSync("git", ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"], {
			cwd: root,
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "ignore"],
			maxBuffer: 64 * 1024 * 1024,
			timeout: 10_000,
		});
		return new Set(out.split("\0").filter(Boolean));
	} catch {
		return new Set();
	}
}

function gitIgnoredPath(ignored: Set<string>, rel: string): boolean {
	if (ignored.size === 0 || !rel || rel === ".") return false;
	const segments = rel.split(/[\\/]/);
	let prefix = "";
	for (let i = 0; i < segments.length; i++) {
		prefix = i === 0 ? segments[0]! : `${prefix}/${segments[i]}`;
		if (ignored.has(`${prefix}/`)) return true;
	}
	return ignored.has(prefix);
}

/** Collect searchable files below `start`; `skip` prunes extra entries (e.g. git-ignored ones). */
function collectProjectFiles(root: string, start: string, out: string[], skip?: (rel: string) => boolean): void {
	let entries;
	try {
		entries = readdirSync(start, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		const abs = resolve(start, entry.name);
		const rel = relative(root, abs);
		if (deniedProjectPath(rel) || entry.isSymbolicLink()) continue;
		if (skip?.(rel)) continue;
		if (entry.isDirectory()) collectProjectFiles(root, abs, out, skip);
		else if (entry.isFile()) out.push(abs);
	}
}

function plural(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** Keep a UTF-8 prefix without splitting a multibyte character. */
function bytePrefix(text: string, maxBytes: number): string {
	const bytes = Buffer.from(text, "utf-8");
	if (bytes.length <= maxBytes) return text;
	let end = maxBytes;
	while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
	return bytes.subarray(0, end).toString("utf-8");
}

function fromColumn(line: string, column: number): string {
	let index = 0;
	let current = 1;
	for (const char of line) {
		if (current >= column) break;
		index += char.length;
		current++;
	}
	return line.slice(index);
}

function readLines(path: string, offset: number, limit: number, column: number): string {
	const lines = readFileSync(path, "utf-8").split("\n");
	const start = Math.min(lines.length, Math.max(0, offset - 1));
	const selected: string[] = [];
	let bytes = 0;
	for (let i = start; i < lines.length && selected.length < limit; i++) {
		const original = lines[i] ?? "";
		const line = i === start ? fromColumn(original, column) : original;
		const lineBytes = Buffer.byteLength(line, "utf-8");
		const separatorBytes = selected.length > 0 ? 1 : 0;
		if (bytes + separatorBytes + lineBytes > MAX_CONTENT_BYTES) {
			if (selected.length > 0) break;
			const preview = bytePrefix(line, MAX_CONTENT_BYTES);
			const nextColumn = column + Array.from(preview).length;
			return `${preview}\n\n[truncated within line ${i + 1} (${Buffer.byteLength(original, "utf-8")} bytes total); continue with offset ${i + 1}, column ${nextColumn}]`;
		}
		selected.push(line);
		bytes += separatorBytes + lineBytes;
	}
	const next = start + selected.length;
	const suffix = next < lines.length ? `\n\n[truncated; continue with offset ${next + 1}]` : "";
	return `${selected.join("\n")}${suffix}`;
}

/** Show the first match in context, even when it occurs deep inside a huge line. */
function grepPreview(line: string, matchIndex: number): string {
	if (line.length <= MAX_GREP_LINE_CHARS) return line;
	const chars = Array.from(line);
	if (chars.length <= MAX_GREP_LINE_CHARS) return line;
	const matchColumn = Array.from(line.slice(0, matchIndex)).length;
	const start = Math.max(0, Math.min(matchColumn - Math.floor(MAX_GREP_LINE_CHARS / 2), chars.length - MAX_GREP_LINE_CHARS));
	const end = start + MAX_GREP_LINE_CHARS;
	const preview = chars.slice(start, end).join("");
	return `${start > 0 ? "…" : ""}${preview}${end < chars.length ? "…" : ""} [line truncated: ${Buffer.byteLength(line, "utf-8")} bytes; columns ${start + 1}-${end} of ${chars.length}]`;
}

/** Register reviewer tools: mutable memory-bank tools plus read-only, secret-aware project inspection. */
export function registerReviewerTools(pi: ExtensionAPI, memoryRoot: string, projectRoot: string): void {
	const memory = resolve(memoryRoot);
	const project = realpathSync(resolve(projectRoot));
	// The project is read-only during review, so the ignore set is computed once on first grep.
	let ignoredPaths: Set<string> | undefined;
	const gitIgnored = (rel: string): boolean => gitIgnoredPath((ignoredPaths ??= listGitIgnored(project)), rel);

	pi.registerTool({
		name: "memory_list",
		label: "List memory files",
		description: "List the root-level memory Markdown files. INDEX.md and lock metadata are hidden.",
		parameters: EmptySchema,
		async execute(): Promise<ToolText> {
			if (!existsSync(memory)) return ok("(memory bank is empty)");
			const files = readdirSync(memory)
				.filter((name) => name.endsWith(".md") && name.toLowerCase() !== "index.md" && !name.startsWith("."))
				.sort();
			return ok(files.length > 0 ? files.join("\n") : "(memory bank is empty)");
		},
	});

	pi.registerTool({
		name: "memory_read",
		label: "Read memory file",
		description: "Read one root-level memory Markdown file.",
		parameters: ReadMemorySchema,
		async execute(_id: string, params: ReadMemoryInput): Promise<ToolText> {
			const p = flatMemoryPath(memory, params.path);
			if (!p) return fail("use a root-level .md memory filename; INDEX.md is generated and unavailable");
			if (!existsSync(p.abs)) return fail(`no such memory file: ${params.path}`);
			if (lstatSync(p.abs).isSymbolicLink()) return fail("symbolic links are not readable by the reviewer");
			return ok(readFileSync(p.abs, "utf-8"));
		},
	});

	pi.registerTool({
		name: "memory_write",
		label: "Write memory file",
		description: "Atomically create or replace OVERVIEW.md or a lowercase-kebab-case topic file. INDEX.md is unavailable.",
		parameters: WriteMemorySchema,
		async execute(_id: string, params: WriteMemoryInput): Promise<ToolText> {
			const p = flatMemoryPath(memory, params.path, true);
			if (!p) return fail("write OVERVIEW.md or a root-level lowercase-kebab-case .md topic; INDEX.md is generated");
			atomicWrite(p.abs, params.content);
			return ok(`Wrote ${p.filename} (${params.content.length} bytes).`);
		},
	});

	pi.registerTool({
		name: "memory_edit",
		label: "Edit memory file",
		description: "Atomically replace one exact substring in a root-level memory file. INDEX.md is unavailable.",
		parameters: EditMemorySchema,
		async execute(_id: string, params: EditMemoryInput): Promise<ToolText> {
			const p = flatMemoryPath(memory, params.path);
			if (!p) return fail("use a root-level .md memory filename; INDEX.md is generated and unavailable");
			if (!existsSync(p.abs)) return fail(`no such memory file: ${params.path}`);
			if (lstatSync(p.abs).isSymbolicLink()) return fail("symbolic links are not editable by the reviewer");
			const current = readFileSync(p.abs, "utf-8");
			const occurrences = current.split(params.oldText).length - 1;
			if (occurrences === 0) return fail("oldText not found");
			if (occurrences > 1) return fail(`oldText is ambiguous (${occurrences} matches); add more context`);
			atomicWrite(p.abs, current.replace(params.oldText, params.newText));
			return ok(`Edited ${p.filename}.`);
		},
	});

	pi.registerTool({
		name: "memory_delete",
		label: "Delete memory file",
		description: "Delete a stale or merged root-level memory Markdown file. INDEX.md is unavailable.",
		parameters: DeleteMemorySchema,
		async execute(_id: string, params: DeleteMemoryInput): Promise<ToolText> {
			const p = flatMemoryPath(memory, params.path);
			if (!p) return fail("use a root-level .md memory filename; INDEX.md is generated and unavailable");
			if (!existsSync(p.abs)) return fail(`no such memory file: ${params.path}`);
			if (lstatSync(p.abs).isSymbolicLink()) return fail("symbolic links are not deletable by the reviewer");
			unlinkSync(p.abs);
			return ok(`Deleted ${p.filename}.`);
		},
	});

	pi.registerTool({
		name: "project_list",
		label: "List project files",
		description: `List a project directory read-only (up to ${MAX_OUTPUT_BYTES / 1024} KiB including notices). Memory, VCS internals, dependencies, generated output, and likely secret paths are excluded.`,
		parameters: ProjectPathSchema,
		async execute(_id: string, params: ProjectPathInput): Promise<ToolText> {
			const p = scopedProjectPath(project, params.path ?? ".");
			if (!p) return fail("path is missing, outside the project, or excluded for safety");
			if (!statSync(p.abs).isDirectory()) return fail("project_list requires a directory");
			const entries = readdirSync(p.abs, { withFileTypes: true })
				.filter((entry) => !deniedProjectPath(relative(project, resolve(p.abs, entry.name))))
				.map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`)
				.sort();
			if (entries.length === 0) return ok("(empty)");
			const shown: string[] = [];
			let bytes = 0;
			for (const entry of entries) {
				const entryBytes = Buffer.byteLength(entry, "utf-8") + (shown.length > 0 ? 1 : 0);
				if (bytes + entryBytes > MAX_CONTENT_BYTES) break;
				shown.push(entry);
				bytes += entryBytes;
			}
			const suffix = shown.length < entries.length
				? `\n\n[listing truncated at ${MAX_OUTPUT_BYTES / 1024} KiB limit: showing ${shown.length} of ${entries.length} entries. List a subdirectory or grep a narrower path.]`
				: "";
			return ok(`${shown.join("\n")}${suffix}`);
		},
	});

	pi.registerTool({
		name: "project_read",
		label: "Read project file",
		description: `Read a bounded slice of a project file, read-only (up to ${MAX_READ_LINES} lines / ${MAX_OUTPUT_BYTES / 1024} KiB including notices). Truncation is marked; use the returned offset and optional column to continue, including within a long line.`,
		parameters: ProjectReadSchema,
		async execute(_id: string, params: ProjectReadInput): Promise<ToolText> {
			const p = scopedProjectPath(project, params.path);
			if (!p) return fail("path is missing, outside the project, or excluded for safety");
			if (!statSync(p.abs).isFile()) return fail("project_read requires a file");
			const offset = params.offset ?? 1;
			const limit = Math.min(params.limit ?? MAX_READ_LINES, MAX_READ_LINES);
			try {
				return ok(readLines(p.abs, offset, limit, params.column ?? 1));
			} catch {
				return fail("file is not readable as UTF-8 text");
			}
		},
	});

	pi.registerTool({
		name: "project_grep",
		label: "Search project files",
		description: `Search project text files read-only with a JavaScript regular expression (up to ${MAX_GREP_HITS} hits / ${MAX_OUTPUT_BYTES / 1024} KiB including notices). Long matching lines show at most ${MAX_GREP_LINE_CHARS} characters around the first match, marked with original size and Unicode column range. Use project_read with offset/column for more. Excluded paths are never searched. Directory searches skip git-ignored paths unless you pass an ignored path explicitly; files over ${MAX_GREP_FILE_BYTES / 1_000_000} MB and binary files are skipped. Skipped paths are counted in a notice.`,
		parameters: ProjectGrepSchema,
		async execute(_id: string, params: ProjectGrepInput): Promise<ToolText> {
			let re: RegExp;
			try {
				re = new RegExp(params.pattern);
			} catch (error) {
				const message = (error as Error).message;
				const preview = bytePrefix(message, MAX_CONTENT_BYTES);
				return fail(`invalid regex: ${preview}${preview.length < message.length ? " [truncated]" : ""}`);
			}
			const p = scopedProjectPath(project, params.path ?? ".");
			if (!p) return fail("path is missing, outside the project, or excluded for safety");
			const files: string[] = [];
			let skippedIgnored = 0;
			let skippedLarge = 0;
			let skippedBinary = 0;
			if (statSync(p.abs).isDirectory()) {
				// Searching inside an explicitly requested ignored directory is an opt-in, so only
				// prune ignored descendants when the starting directory itself is not ignored.
				const skip = gitIgnored(p.rel)
					? undefined
					: (rel: string): boolean => {
						if (!gitIgnored(rel)) return false;
						skippedIgnored++;
						return true;
					};
				collectProjectFiles(project, p.abs, files, skip);
			} else files.push(p.abs);
			const hits: string[] = [];
			let outputBytes = 0;
			let byteLimitReached = false;
			for (const file of files) {
				try {
					if (statSync(file).size > MAX_GREP_FILE_BYTES) {
						skippedLarge++;
						continue;
					}
					const text = readFileSync(file, "utf-8");
					if (text.includes("\0")) {
						skippedBinary++;
						continue;
					}
					const lines = text.split("\n");
					for (let i = 0; i < lines.length; i++) {
						const line = (lines[i] ?? "").replace(/\r$/, "");
						re.lastIndex = 0;
						const match = re.exec(line);
						if (!match) continue;
						const hit = `${relative(project, file)}:${i + 1}: ${grepPreview(line, match.index)}`;
						const hitBytes = Buffer.byteLength(hit, "utf-8") + (hits.length > 0 ? 1 : 0);
						if (outputBytes + hitBytes > MAX_CONTENT_BYTES) {
							byteLimitReached = true;
							break;
						}
						hits.push(hit);
						outputBytes += hitBytes;
						if (hits.length >= MAX_GREP_HITS) break;
					}
				} catch {
					// Unreadable project files are reported with binary ones.
					skippedBinary++;
				}
				if (byteLimitReached || hits.length >= MAX_GREP_HITS) break;
			}
			const notices: string[] = [];
			if (byteLimitReached) notices.push(`output truncated at ${MAX_OUTPUT_BYTES / 1024} KiB limit`);
			if (hits.length >= MAX_GREP_HITS) notices.push(`limited to ${MAX_GREP_HITS} hits`);
			const skipped: string[] = [];
			if (skippedIgnored > 0) skipped.push(`${plural(skippedIgnored, "git-ignored path")} (pass one as path to search it)`);
			if (skippedLarge > 0) skipped.push(`${plural(skippedLarge, "file")} over ${MAX_GREP_FILE_BYTES / 1_000_000} MB`);
			if (skippedBinary > 0) skipped.push(`${plural(skippedBinary, "binary or unreadable file")}`);
			let suffix = notices.length > 0 ? `\n\n[${notices.join("; ")}; additional matches may exist. Narrow the pattern or path.]` : "";
			if (skipped.length > 0) suffix += `${suffix ? "\n" : "\n\n"}[not searched: ${skipped.join(", ")}]`;
			const body = hits.length > 0 ? hits.join("\n") : byteLimitReached ? "(no matches fit within output limit)" : "(no matches)";
			return ok(`${body}${suffix}`);
		},
	});
}
