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
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Static } from "typebox";
import { atomicWrite } from "../../src/memory/paths.js";
import { fail, ok, type ToolText } from "../tool-text.js";

const MAX_READ_LINES = 400;
const MAX_READ_CHARS = 50_000;
const MAX_GREP_HITS = 200;
const MAX_GREP_FILE_BYTES = 1_000_000;
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

function collectProjectFiles(root: string, start: string, out: string[]): void {
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
		if (entry.isDirectory()) collectProjectFiles(root, abs, out);
		else if (entry.isFile()) out.push(abs);
	}
}

function readLines(path: string, offset: number, limit: number): { text: string; truncated: boolean; nextOffset?: number } {
	const lines = readFileSync(path, "utf-8").split("\n");
	const start = Math.min(lines.length, Math.max(0, offset - 1));
	const selected: string[] = [];
	let chars = 0;
	for (let i = start; i < lines.length && selected.length < limit; i++) {
		const line = lines[i] ?? "";
		if (selected.length > 0 && chars + line.length + 1 > MAX_READ_CHARS) break;
		selected.push(line);
		chars += line.length + 1;
	}
	const consumed = selected.length;
	const truncated = start + consumed < lines.length;
	return { text: selected.join("\n"), truncated, nextOffset: truncated ? start + consumed + 1 : undefined };
}

/** Register reviewer tools: mutable memory-bank tools plus read-only, secret-aware project inspection. */
export function registerReviewerTools(pi: ExtensionAPI, memoryRoot: string, projectRoot: string): void {
	const memory = resolve(memoryRoot);
	const project = realpathSync(resolve(projectRoot));

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
		description: "List a project directory read-only. Memory, VCS internals, dependencies, generated output, and likely secret paths are excluded.",
		parameters: ProjectPathSchema,
		async execute(_id: string, params: ProjectPathInput): Promise<ToolText> {
			const p = scopedProjectPath(project, params.path ?? ".");
			if (!p) return fail("path is missing, outside the project, or excluded for safety");
			if (!statSync(p.abs).isDirectory()) return fail("project_list requires a directory");
			const entries = readdirSync(p.abs, { withFileTypes: true })
				.filter((entry) => !deniedProjectPath(relative(project, resolve(p.abs, entry.name))))
				.map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`)
				.sort();
			return ok(entries.length > 0 ? entries.join("\n") : "(empty)");
		},
	});

	pi.registerTool({
		name: "project_read",
		label: "Read project file",
		description: `Read a bounded slice of a project file, read-only (up to ${MAX_READ_LINES} lines / ${MAX_READ_CHARS} characters).`,
		parameters: ProjectReadSchema,
		async execute(_id: string, params: ProjectReadInput): Promise<ToolText> {
			const p = scopedProjectPath(project, params.path);
			if (!p) return fail("path is missing, outside the project, or excluded for safety");
			if (!statSync(p.abs).isFile()) return fail("project_read requires a file");
			const offset = params.offset ?? 1;
			const limit = Math.min(params.limit ?? MAX_READ_LINES, MAX_READ_LINES);
			try {
				const result = readLines(p.abs, offset, limit);
				const suffix = result.truncated ? `\n\n[truncated; continue with offset ${result.nextOffset}]` : "";
				return ok(`${result.text}${suffix}`);
			} catch {
				return fail("file is not readable as UTF-8 text");
			}
		},
	});

	pi.registerTool({
		name: "project_grep",
		label: "Search project files",
		description: `Search project text files read-only with a JavaScript regular expression (up to ${MAX_GREP_HITS} hits). Excluded paths are never searched.`,
		parameters: ProjectGrepSchema,
		async execute(_id: string, params: ProjectGrepInput): Promise<ToolText> {
			let re: RegExp;
			try {
				re = new RegExp(params.pattern);
			} catch (error) {
				return fail(`invalid regex: ${(error as Error).message}`);
			}
			const p = scopedProjectPath(project, params.path ?? ".");
			if (!p) return fail("path is missing, outside the project, or excluded for safety");
			const files: string[] = [];
			if (statSync(p.abs).isDirectory()) collectProjectFiles(project, p.abs, files);
			else files.push(p.abs);
			const hits: string[] = [];
			for (const file of files) {
				try {
					if (statSync(file).size > MAX_GREP_FILE_BYTES) continue;
					const text = readFileSync(file, "utf-8");
					if (text.includes("\0")) continue;
					const lines = text.split("\n");
					for (let i = 0; i < lines.length; i++) {
						re.lastIndex = 0;
						if (re.test(lines[i] ?? "")) hits.push(`${relative(project, file)}:${i + 1}: ${(lines[i] ?? "").trim()}`);
						if (hits.length >= MAX_GREP_HITS) break;
					}
				} catch {
					// Ignore unreadable/non-text project files.
				}
				if (hits.length >= MAX_GREP_HITS) break;
			}
			const suffix = hits.length >= MAX_GREP_HITS ? `\n[limited to ${MAX_GREP_HITS} hits]` : "";
			return ok(hits.length > 0 ? `${hits.join("\n")}${suffix}` : "(no matches)");
		},
	});
}
