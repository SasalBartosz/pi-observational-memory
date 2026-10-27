import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { registerReviewerTools } from "../agent/reviewer/tools.js";

const MAX_OUTPUT_BYTES = 50 * 1024;
const tempDirs: string[] = [];

function makeTools(files: Record<string, string>, setup?: (cwd: string) => void, projectSubdir = "") {
	const cwd = mkdtempSync(join(tmpdir(), "om-review-output-"));
	tempDirs.push(cwd);
	const memory = join(cwd, ".memory", "project");
	mkdirSync(memory, { recursive: true });
	for (const [path, text] of Object.entries(files)) {
		const abs = join(cwd, path);
		mkdirSync(dirname(abs), { recursive: true });
		writeFileSync(abs, text, "utf-8");
	}
	setup?.(cwd);
	const tools = new Map<string, any>();
	registerReviewerTools({ registerTool: (def: any) => tools.set(def.name, def) } as any, memory, join(cwd, projectSubdir));
	return async (name: string, params: Record<string, unknown>): Promise<string> => {
		const result = await tools.get(name).execute("test", params);
		const text = result.content[0].text as string;
		expect(Buffer.byteLength(text, "utf-8")).toBeLessThanOrEqual(MAX_OUTPUT_BYTES);
		return text;
	};
}

afterEach(() => {
	while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("bounded reviewer grep output", () => {
	it("returns ordinary matching lines with their paths and line numbers", async () => {
		const run = makeTools({ "src/app.ts": "unrelated\r\n  needle\r\nother\r\n" });
		expect(await run("project_grep", { path: "src", pattern: "needle$" })).toBe("src/app.ts:2:   needle");
		expect(await run("project_grep", { pattern: "absent" })).toBe("(no matches)");
	});

	it.each([
		["beginning", `needle${"x".repeat(79_204)}`],
		["middle", `${"x".repeat(40_000)}needle${"x".repeat(39_204)}`],
		["end", `${"x".repeat(79_204)}needle`],
	])("shows a marked excerpt for a match at the %s of a huge line without excluding runs/", async (_position, line) => {
		const path = "runs/checkpoints/_METADATA";
		const run = makeTools({ [path]: line });
		const result = await run("project_grep", { pattern: "needle" });
		expect(result).toContain(`${path}:1: `);
		expect(result).toContain("needle");
		expect(result).toContain("line truncated: 79210 bytes");
		const range = /columns (\d+)-(\d+) of (\d+)/.exec(result)!;
		const start = Number(range[1]);
		const end = Number(range[2]);
		expect(end - start + 1).toBe(500);
		expect(Number(range[3])).toBe(line.length);
		expect(result).toContain(line.slice(start - 1, end));
		expect(result.length).toBeLessThan(1_000);
		expect(await run("project_list", {})).toContain("runs/");
	});

	it("keeps Unicode characters intact and reports Unicode columns for a late match", async () => {
		const line = `${"🙂漢".repeat(12_000)}needle${"🙂漢".repeat(1_000)}`;
		const run = makeTools({ "unicode.txt": line });
		const result = await run("project_grep", { pattern: "needle" });
		expect(result).toContain("needle");
		expect(result).not.toContain("\uFFFD");
		expect(result).toContain(`${Buffer.byteLength(line, "utf-8")} bytes`);
		const range = /columns (\d+)-(\d+) of (\d+)/.exec(result)!;
		const start = Number(range[1]);
		const end = Number(range[2]);
		expect(end - start + 1).toBe(500);
		expect(Number(range[3])).toBe(Array.from(line).length);
		expect(result).toContain(Array.from(line).slice(start - 1, end).join(""));
		// Reported excerpt columns can be used directly by the read tool.
		const read = await run("project_read", { path: "unicode.txt", offset: 1, column: start, limit: 1 });
		expect(read.startsWith(Array.from(line).slice(start - 1, end).join(""))).toBe(true);
	});

	it("caps aggregate UTF-8 bytes across files, including long paths, line numbers, and notices", async () => {
		const line = `needle ${"漢🙂".repeat(220)}`;
		const files = Object.fromEntries(Array.from({ length: 4 }, (_, i) => [
			`nested/${"p".repeat(220)}-${i}.txt`,
			Array.from({ length: 20 }, () => line).join("\n"),
		]));
		const run = makeTools(files);
		const result = await run("project_grep", { pattern: "needle" });
		const hits = result.split("\n").filter((row) => row.startsWith("nested/"));
		expect(hits.length).toBeGreaterThan(20);
		expect(hits.length).toBeLessThan(80);
		for (const hit of hits) expect(hit.endsWith(line)).toBe(true);
		expect(new Set(hits.map((hit) => hit.split(":")[0])).size).toBeGreaterThan(1);
		expect(result).toContain("output truncated at 50 KiB limit");
		expect(result).toContain("additional matches may exist");
		expect(result).not.toContain("limited to 200 hits");
	});

	it("applies the aggregate cap to many individually truncated matches", async () => {
		const line = `needle${"x".repeat(79_204)}`;
		const files = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`runs/${i}/_METADATA`, line]));
		const run = makeTools(files);
		const result = await run("project_grep", { pattern: "needle" });
		const hits = result.split("\n").filter((row) => row.startsWith("runs/"));
		expect(hits.length).toBeGreaterThan(1);
		expect(hits.length).toBeLessThan(100);
		for (const hit of hits) expect(hit).toContain("[line truncated: 79210 bytes;");
		expect(result).toContain("output truncated at 50 KiB limit");
	});

	it("retains the hit limit independently of the byte limit", async () => {
		const run = makeTools({ "many.txt": "needle\n".repeat(201) });
		const result = await run("project_grep", { pattern: "needle" });
		expect(result.split("\n").filter((row) => row.startsWith("many.txt:"))).toHaveLength(200);
		expect(result).toContain("limited to 200 hits");
		expect(result).toContain("additional matches may exist");
		expect(result).not.toContain("50 KiB limit");
	});

	it("skips oversized and binary files with a counted notice and rejects invalid regexes", async () => {
		const run = makeTools({
			"oversized.txt": `needle${"x".repeat(1_000_000)}`,
			"binary.dat": "needle\0binary",
			"safe.txt": "needle",
		});
		expect(await run("project_grep", { pattern: "needle" })).toBe(
			"safe.txt:1: needle\n\n[not searched: 1 file over 1 MB, 1 binary or unreadable file]",
		);
		expect(await run("project_grep", { path: "oversized.txt", pattern: "needle" })).toBe(
			"(no matches)\n\n[not searched: 1 file over 1 MB]",
		);
		expect(await run("project_grep", { pattern: "[" })).toContain("invalid regex");
	});

	it("reports skipped files alongside limit notices", async () => {
		const run = makeTools({ "a-binary.dat": "needle\0", "many.txt": "needle\n".repeat(201) });
		const result = await run("project_grep", { pattern: "needle" });
		expect(result.endsWith(
			"\n\n[limited to 200 hits; additional matches may exist. Narrow the pattern or path.]\n[not searched: 1 binary or unreadable file]",
		)).toBe(true);
	});

	it("also bounds invalid-regex diagnostics that echo a huge pattern", async () => {
		const run = makeTools({});
		const result = await run("project_grep", { pattern: `${"x".repeat(80_000)}[` });
		expect(result).toContain("invalid regex");
		expect(result).toContain("[truncated]");
	});
});

describe("git-ignored paths in reviewer grep", () => {
	const git = (cwd: string, ...args: string[]): void => {
		execFileSync("git", args, { cwd, stdio: "ignore" });
	};
	const files = {
		".gitignore": "runs/\n*.log\n",
		"src/app.ts": "needle",
		"runs/recipe/checkpoints/1/_METADATA": "needle",
		"debug.log": "needle",
		"keep.log": "needle",
	};
	const setup = (cwd: string): void => {
		git(cwd, "init", "-q");
		git(cwd, "add", "-f", "keep.log"); // Tracked files stay searchable even when they match an ignore rule.
	};

	it("skips untracked ignored paths during directory searches and counts them", async () => {
		const run = makeTools(files, setup);
		expect(await run("project_grep", { pattern: "needle" })).toBe(
			"keep.log:1: needle\nsrc/app.ts:1: needle\n\n[not searched: 2 git-ignored paths (pass one as path to search it)]",
		);
		expect(await run("project_list", {})).toContain("runs/");
	});

	it("searches an ignored directory or file when it is requested explicitly", async () => {
		const run = makeTools(files, setup);
		expect(await run("project_grep", { path: "runs", pattern: "needle" })).toBe(
			"runs/recipe/checkpoints/1/_METADATA:1: needle",
		);
		expect(await run("project_grep", { path: "runs/recipe", pattern: "needle" })).toBe(
			"runs/recipe/checkpoints/1/_METADATA:1: needle",
		);
		expect(await run("project_grep", { path: "debug.log", pattern: "needle" })).toBe("debug.log:1: needle");
	});

	it("applies repository ignore rules to a project rooted in a subdirectory", async () => {
		const run = makeTools(
			{ ".gitignore": "runs/\n", "proj/src/app.ts": "needle", "proj/runs/_METADATA": "needle" },
			(cwd) => git(cwd, "init", "-q"),
			"proj",
		);
		expect(await run("project_grep", { pattern: "needle" })).toBe(
			"src/app.ts:1: needle\n\n[not searched: 1 git-ignored path (pass one as path to search it)]",
		);
		expect(await run("project_grep", { path: "runs", pattern: "needle" })).toBe("runs/_METADATA:1: needle");
	});

	it("searches everything outside a git work tree", async () => {
		const run = makeTools({ "src/app.ts": "needle", "runs/_METADATA": "needle" });
		expect(await run("project_grep", { pattern: "needle" })).toBe("runs/_METADATA:1: needle\nsrc/app.ts:1: needle");
	});
});

describe("bounded reviewer list output", () => {
	it("lists small directories unchanged", async () => {
		const run = makeTools({ "src/b.ts": "", "src/a.ts": "", "src/nested/c.ts": "" });
		expect(await run("project_list", { path: "src" })).toBe("a.ts\nb.ts\nnested/");
	});

	it("caps a huge directory listing and reports how many entries were shown", async () => {
		const names = Array.from({ length: 300 }, (_, i) => `${String(i).padStart(3, "0")}-${"n".repeat(200)}`);
		const run = makeTools(Object.fromEntries(names.map((name) => [`big/${name}`, ""])));
		const result = await run("project_list", { path: "big" });
		const shown = result.split("\n\n[listing truncated")[0]!.split("\n");
		expect(shown.length).toBeGreaterThan(1);
		expect(shown.length).toBeLessThan(300);
		expect(shown).toEqual(names.slice(0, shown.length));
		expect(result).toContain(`showing ${shown.length} of 300 entries`);
	});
});

describe("bounded reviewer read output", () => {
	it("preserves small reads and supports Unicode columns on the first selected line only", async () => {
		const run = makeTools({ "small.txt": "header\nα🙂éneedle\nlast" });
		expect(await run("project_read", { path: "small.txt" })).toBe("header\nα🙂éneedle\nlast");
		expect(await run("project_read", { path: "small.txt", offset: 2, column: 4 })).toBe("needle\nlast");
		expect(await run("project_read", { path: "small.txt", offset: 2, limit: 1 })).toBe("α🙂éneedle\n\n[truncated; continue with offset 3]");
		expect(await run("project_read", { path: "small.txt", offset: 99 })).toBe("");
	});

	it("paginates a huge first line without losing or splitting multibyte characters", async () => {
		// The leading ASCII character puts the byte cap inside a later multibyte character.
		const line = `a${"🙂é漢".repeat(14_000)}TAIL`;
		const run = makeTools({ "long.txt": line });
		const chunks: string[] = [];
		let column = 1;
		for (let page = 0; page < 10; page++) {
			const result = await run("project_read", { path: "long.txt", offset: 1, column });
			expect(result).not.toContain("\uFFFD");
			const marker = result.indexOf("\n\n[truncated within line ");
			if (marker === -1) {
				chunks.push(result);
				break;
			}
			chunks.push(result.slice(0, marker));
			expect(result).toContain(`line 1 (${Buffer.byteLength(line, "utf-8")} bytes total)`);
			const next = /continue with offset (\d+), column (\d+)/.exec(result)!;
			expect(Number(next[1])).toBe(1);
			expect(Number(next[2])).toBeGreaterThan(column);
			column = Number(next[2]);
		}
		expect(chunks.length).toBeGreaterThan(2);
		expect(chunks.join("")).toBe(line);
	});

	it("stops before a later oversized line, then resumes within that line before advancing", async () => {
		const line = "x".repeat(79_210);
		const run = makeTools({ "long.txt": `header\n${line}\ntrailer` });
		expect(await run("project_read", { path: "long.txt" })).toBe("header\n\n[truncated; continue with offset 2]");
		const first = await run("project_read", { path: "long.txt", offset: 2 });
		const next = /continue with offset (\d+), column (\d+)/.exec(first)!;
		expect(Number(next[1])).toBe(2);
		const second = await run("project_read", { path: "long.txt", offset: 2, column: Number(next[2]) });
		expect(first.split("\n\n[truncated")[0] + second).toBe(`${line}\ntrailer`);
		expect(second).not.toContain("[truncated");
	});

	it("retains the line limit independently of the byte limit", async () => {
		const lines = Array.from({ length: 401 }, (_, i) => `line ${i + 1}`);
		const run = makeTools({ "lines.txt": lines.join("\n") });
		expect(await run("project_read", { path: "lines.txt" })).toBe(`${lines.slice(0, 400).join("\n")}\n\n[truncated; continue with offset 401]`);
		expect(await run("project_read", { path: "lines.txt", offset: 401 })).toBe("line 401");
	});

	it("counts newlines and UTF-8 bytes when limiting multiple complete lines", async () => {
		const lines = Array.from({ length: 300 }, (_, i) => `${i}: ${"🙂".repeat(110)}`);
		const run = makeTools({ "lines.txt": lines.join("\n") });
		const first = await run("project_read", { path: "lines.txt" });
		const next = Number(/continue with offset (\d+)/.exec(first)![1]);
		expect(next).toBeGreaterThan(1);
		expect(next).toBeLessThan(300);
		expect(first.split("\n\n[truncated")[0]).toBe(lines.slice(0, next - 1).join("\n"));
		const second = await run("project_read", { path: "lines.txt", offset: next });
		expect(second.startsWith(`${lines[next - 1]}\n`)).toBe(true);
	});
});
