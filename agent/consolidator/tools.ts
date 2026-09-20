/**
 * The consolidator's file tool belt. `--no-builtin-tools` is set on the worker, so this
 * extension registers its own read/write/edit/ls/grep — all path-scoped to the shared
 * project bank (design risk 6). The bank edits are half the output; the run's other half
 * is the outcome report, handled by the dedicated tool in agent/index.ts that writes OUTSIDE
 * this sandbox (to OM_RESULT_PATH in the transient runtime dir).
 *
 * Scoping: every path argument is resolved against OM_MEMORY_DIR (the shared bank) and
 * rejected if it escapes that directory, so a wayward model cannot read or clobber the
 * user's project. INDEX.md is generated (writes to it are rejected), and dotfiles —
 * `.consolidation.lock` and any replay metadata — are orchestrator-owned and rejected in
 * every tool; ls/grep additionally skip them when listing/searching.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Static } from "typebox";
import { atomicWrite } from "../../src/memory/paths.js";
import { fail, ok, type ToolText } from "../tool-text.js";

/**
 * Resolve a requested path against the sandbox root, or return undefined if it escapes.
 * Returns both the absolute path and its bank-relative form (used for the guards below).
 */
function scoped(root: string, requested: string): { abs: string; rel: string } | undefined {
	const abs = resolve(root, requested);
	const rel = relative(root, abs);
	if (rel.startsWith("..")) return undefined;
	return { abs, rel };
}

/** True when any path segment is a dotfile (`.consolidation.lock`, replay metadata, temp files). */
function isHiddenPath(rel: string): boolean {
	return rel.split("/").some((segment) => segment.startsWith("."));
}

const ReadSchema = Type.Object({
	path: Type.String({ description: "Path inside the memory bank, e.g. 'auth.md' or 'OVERVIEW.md'." }),
});
const WriteSchema = Type.Object({
	path: Type.String({ description: "Path inside the memory bank to (over)write, e.g. 'auth.md'." }),
	content: Type.String({ description: "Full file content, including YAML front-matter." }),
});
const EditSchema = Type.Object({
	path: Type.String({ description: "Path inside the memory bank to edit." }),
	oldText: Type.String({ description: "Exact text to replace (must occur exactly once)." }),
	newText: Type.String({ description: "Replacement text." }),
});
const LsSchema = Type.Object({
	path: Type.Optional(Type.String({ description: "Subdirectory inside the memory bank. Defaults to the bank root." })),
});
const GrepSchema = Type.Object({
	pattern: Type.String({ description: "JavaScript regular expression to search for." }),
	path: Type.Optional(Type.String({ description: "Restrict to this file/subdir inside the memory bank." })),
});

type ReadInput = Static<typeof ReadSchema>;
type WriteInput = Static<typeof WriteSchema>;
type EditInput = Static<typeof EditSchema>;
type LsInput = Static<typeof LsSchema>;
type GrepInput = Static<typeof GrepSchema>;

function listFilesRecursive(dir: string): string[] {
	const out: string[] = [];
	for (const name of readdirSync(dir)) {
		if (name.startsWith(".")) continue; // skip dotfiles: lock, replay metadata, temp files
		const full = join(dir, name);
		if (statSync(full).isDirectory()) out.push(...listFilesRecursive(full));
		else out.push(full);
	}
	return out;
}

/**
 * Register the consolidator's scoped file tools (read/write/edit/ls/grep), all confined to
 * the shared project bank. INDEX.md and dotfiles (`.consolidation.lock`, replay metadata)
 * are orchestrator-owned: writes to them are rejected, and ls/grep never list them.
 */
export function registerConsolidatorTools(pi: ExtensionAPI, memoryRoot: string): void {
	const root = resolve(memoryRoot);

	const HIDDEN_ERROR =
		"hidden files (dotfiles such as .consolidation.lock) are orchestrator-managed; do not read, write, or edit them";

	pi.registerTool({
		name: "read",
		label: "Read memory file",
		description: "Read a file in the memory bank (topic file or OVERVIEW.md).",
		parameters: ReadSchema,
		async execute(_id: string, params: ReadInput): Promise<ToolText> {
			const p = scoped(root, params.path);
			if (!p) return fail("path escapes the memory bank");
			if (isHiddenPath(p.rel)) return fail(HIDDEN_ERROR);
			if (!existsSync(p.abs)) return fail(`no such file: ${params.path}`);
			return ok(readFileSync(p.abs, "utf-8"));
		},
	});

	pi.registerTool({
		name: "write",
		label: "Write memory file",
		description: "Create or overwrite a file in the memory bank (atomic). Do not write INDEX.md.",
		parameters: WriteSchema,
		async execute(_id: string, params: WriteInput): Promise<ToolText> {
			const p = scoped(root, params.path);
			if (!p) return fail("path escapes the memory bank");
			if (/(^|\/)INDEX\.md$/i.test(p.rel)) return fail("INDEX.md is generated automatically; do not write it");
			if (isHiddenPath(p.rel)) return fail(HIDDEN_ERROR);
			atomicWrite(p.abs, params.content);
			return ok(`Wrote ${params.path} (${params.content.length} bytes).`);
		},
	});

	pi.registerTool({
		name: "edit",
		label: "Edit memory file",
		description: "Replace an exact substring in a file in the memory bank (atomic). Do not edit INDEX.md.",
		parameters: EditSchema,
		async execute(_id: string, params: EditInput): Promise<ToolText> {
			const p = scoped(root, params.path);
			if (!p) return fail("path escapes the memory bank");
			if (/(^|\/)INDEX\.md$/i.test(p.rel)) return fail("INDEX.md is generated automatically; do not edit it");
			if (isHiddenPath(p.rel)) return fail(HIDDEN_ERROR);
			if (!existsSync(p.abs)) return fail(`no such file: ${params.path}`);
			const current = readFileSync(p.abs, "utf-8");
			const occurrences = current.split(params.oldText).length - 1;
			if (occurrences === 0) return fail("oldText not found");
			if (occurrences > 1) return fail(`oldText is ambiguous (${occurrences} matches); add more context`);
			atomicWrite(p.abs, current.replace(params.oldText, params.newText));
			return ok(`Edited ${params.path}.`);
		},
	});

	pi.registerTool({
		name: "ls",
		label: "List memory files",
		description: "List files in the memory bank (dotfiles are hidden).",
		parameters: LsSchema,
		async execute(_id: string, params: LsInput): Promise<ToolText> {
			const p = scoped(root, params.path ?? ".");
			if (!p) return fail("path escapes the memory bank");
			if (isHiddenPath(p.rel)) return fail(HIDDEN_ERROR);
			if (!existsSync(p.abs)) return ok("(the memory bank is empty)");
			const entries = readdirSync(p.abs).filter((n) => !n.startsWith("."));
			return ok(entries.length > 0 ? entries.sort().join("\n") : "(empty)");
		},
	});

	pi.registerTool({
		name: "grep",
		label: "Search memory files",
		description: "Search files in the memory bank with a regular expression (dotfiles are skipped).",
		parameters: GrepSchema,
		async execute(_id: string, params: GrepInput): Promise<ToolText> {
			let re: RegExp;
			try {
				re = new RegExp(params.pattern);
			} catch (e) {
				return fail(`invalid regex: ${(e as Error).message}`);
			}
			const p = scoped(root, params.path ?? ".");
			if (!p) return fail("path escapes the memory bank");
			if (isHiddenPath(p.rel)) return fail(HIDDEN_ERROR);
			if (!existsSync(p.abs)) return ok("(no matches)");
			const files = statSync(p.abs).isDirectory() ? listFilesRecursive(p.abs) : [p.abs];
			const hits: string[] = [];
			for (const file of files) {
				const lines = readFileSync(file, "utf-8").split("\n");
				const relPath = relative(root, file);
				lines.forEach((line, i) => {
					if (re.test(line)) hits.push(`${relPath}:${i + 1}: ${line.trim()}`);
				});
				if (hits.length >= 200) break;
			}
			return ok(hits.length > 0 ? hits.join("\n") : "(no matches)");
		},
	});
}
