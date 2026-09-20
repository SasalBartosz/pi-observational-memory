import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import observationalMemory from "../src/index.js";
import { classifyProcessRole, registerSubagentStubs, SUBAGENT_SUPPRESSED_MESSAGE } from "../src/subagent-guard.js";
import { rawMessage, type TestEntry } from "./fixtures/session.js";

/** Environment markers read by the guard — saved/restored around each test. */
const ENV_KEYS = ["OM_WORKER", "PI_SUBAGENT_ID", "PI_SUBAGENT_SESSION"] as const;

let savedEnv: Record<string, string | undefined> = {};
let tempDirs: string[] = [];

beforeEach(() => {
	savedEnv = {};
	for (const key of ENV_KEYS) {
		savedEnv[key] = process.env[key];
		delete process.env[key];
	}
});

afterEach(() => {
	for (const key of ENV_KEYS) {
		const value = savedEnv[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
	tempDirs = [];
});

/** Minimal fake ExtensionAPI capturing every registration. */
function makeFakePi() {
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	const commands = new Map<string, { description: string; handler: (args: string, ctx: unknown) => Promise<void> }>();
	const entries: { type: string; data: unknown }[] = [];
	return {
		handlers,
		commands,
		entries,
		on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		registerCommand: (name: string, def: { description: string; handler: (args: string, ctx: unknown) => Promise<void> }) => {
			commands.set(name, def);
		},
		appendEntry: (type: string, data: unknown) => {
			entries.push({ type, data });
		},
	};
}

/** A ctx good enough for the session_start + before_agent_start handlers in main mode. */
function makeSessionCtx(cwd: string, branch: TestEntry[]) {
	return {
		cwd,
		mode: "tui",
		hasUI: false,
		sessionManager: {
			getSessionId: () => "sess-1",
			getBranch: () => branch,
			getEntries: () => branch,
		},
	};
}

describe("classifyProcessRole", () => {
	it("classifies an unmarked process as a main session", () => {
		expect(classifyProcessRole({})).toBe("main");
	});

	it("classifies our own worker subprocesses by OM_WORKER", () => {
		expect(classifyProcessRole({ OM_WORKER: "observer" })).toBe("worker");
		expect(classifyProcessRole({ OM_WORKER: "consolidator" })).toBe("worker");
	});

	it("classifies pi's interactive subagent sessions by either marker", () => {
		expect(classifyProcessRole({ PI_SUBAGENT_ID: "sub-1" })).toBe("subagent");
		expect(classifyProcessRole({ PI_SUBAGENT_SESSION: "sess-9" })).toBe("subagent");
	});

	it("worker marker wins over subagent markers (strongest signal first)", () => {
		expect(classifyProcessRole({ OM_WORKER: "observer", PI_SUBAGENT_ID: "sub-1" })).toBe("worker");
	});

	it("does not classify forks/main sessions by unrelated session markers", () => {
		// A user fork is a legitimate main session: only the three markers above matter.
		expect(classifyProcessRole({ SESSION_MODE: "fork", PI_SESSION_ID: "abc" })).toBe("main");
	});
});

describe("extension factory suppression matrix", () => {
	it("registers nothing at all when OM_WORKER is set", () => {
		process.env.OM_WORKER = "observer";
		const pi = makeFakePi();
		observationalMemory(pi as never);
		expect(pi.handlers.size).toBe(0);
		expect(pi.commands.size).toBe(0);
	});

	it("in a subagent session, registers only stub commands and no handlers", () => {
		process.env.PI_SUBAGENT_ID = "sub-1";
		const pi = makeFakePi();
		observationalMemory(pi as never);
		expect(pi.handlers.size).toBe(0);
		expect([...pi.commands.keys()].sort()).toEqual(["om", "om:compact", "om:consolidate"]);
	});

	it("stub /om on reports suppression and never appends a gate entry", async () => {
		process.env.PI_SUBAGENT_SESSION = "sess-9";
		const pi = makeFakePi();
		observationalMemory(pi as never);

		const notifications: [string, string][] = [];
		const ctx = { hasUI: true, ui: { notify: (m: string, l: string) => notifications.push([m, l]) } };
		for (const name of ["om", "om:consolidate", "om:compact"]) {
			await pi.commands.get(name)!.handler("on", ctx);
		}
		expect(notifications).toEqual([
			[SUBAGENT_SUPPRESSED_MESSAGE, "warning"],
			[SUBAGENT_SUPPRESSED_MESSAGE, "warning"],
			[SUBAGENT_SUPPRESSED_MESSAGE, "warning"],
		]);
		// A gate entry appended here would re-enable the pipeline on resume.
		expect(pi.entries).toEqual([]);
	});

	it("a copied om.enabled ledger entry cannot re-enable the pipeline in a subagent session", async () => {
		// The inherited branch carries an enabled gate entry from a session-mode: fork parent.
		const branch: TestEntry[] = [
			rawMessage("raw-1", "hello"),
			{
				type: "custom",
				id: "om-en-1",
				parentId: null,
				timestamp: "2026-05-02T10:00:00.000Z",
				customType: "om.enabled",
				data: { enabled: true },
			},
		];
		const cwd = mkdtempSync(join(tmpdir(), "om-guard-subagent-"));
		tempDirs.push(cwd);
		mkdirSync(join(cwd, ".memory", "project"), { recursive: true });
		writeFileSync(join(cwd, ".memory", "project", "OVERVIEW.md"), "Shared orientation.", "utf-8");

		process.env.PI_SUBAGENT_ID = "sub-1";
		const pi = makeFakePi();
		observationalMemory(pi as never);

		// No session_start handler exists, so nothing ever reads/restores the gate — and the
		// before_agent_start injection path is never even registered.
		expect(pi.handlers.has("session_start")).toBe(false);
		expect(pi.handlers.has("before_agent_start")).toBe(false);

		// Belt and braces: driving the stub /om on must still not append a gate entry that a
		// subsequent main-session resume would restore from.
		await pi.commands.get("om")!.handler("on", { hasUI: false });
		expect(pi.entries).toEqual([]);

		// The bank exists, but no bootstrap handler was registered to inject it.
		const fired = pi.handlers.get("before_agent_start") ?? [];
		expect(fired.length).toBe(0);
	});

	it("a plain main session activates normally: gate restores from the ledger and bootstraps", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "om-guard-main-"));
		tempDirs.push(cwd);
		mkdirSync(join(cwd, ".memory", "project"), { recursive: true });
		writeFileSync(join(cwd, ".memory", "project", "OVERVIEW.md"), "Shared orientation.", "utf-8");

		const pi = makeFakePi();
		observationalMemory(pi as never);

		// The full pipeline registers.
		expect(pi.handlers.has("session_start")).toBe(true);
		expect(pi.handlers.has("session_shutdown")).toBe(true);
		expect(pi.handlers.has("before_agent_start")).toBe(true);
		expect([...pi.commands.keys()]).toEqual(
			expect.arrayContaining(["om", "om:status", "om:compact", "om:consolidate"]),
		);

		// Gate restore from an om.enabled ledger entry (the fork-inherited case, legitimate here).
		const branch: TestEntry[] = [
			rawMessage("raw-1", "hello"),
			{
				type: "custom",
				id: "om-en-1",
				parentId: null,
				timestamp: "2026-05-02T10:00:00.000Z",
				customType: "om.enabled",
				data: { enabled: true },
			},
		];
		const ctx = makeSessionCtx(cwd, branch);
		for (const handler of pi.handlers.get("session_start")!) {
			await handler({ type: "session_start" }, ctx);
		}

		// The restored gate + the bootstrap hook: the first agent turn gets the orientation block.
		const injections: any[] = [];
		for (const handler of pi.handlers.get("before_agent_start")!) {
			const result = await handler({ type: "before_agent_start" }, { cwd });
			if (result && typeof result === "object" && "message" in result) injections.push(result.message);
		}
		expect(injections.length).toBe(1);
		expect(injections[0].customType).toBe("om.bootstrap");
		expect(injections[0].content).toContain("Shared orientation.");
		expect(injections[0].display).toBe(false);

		// Not a subagent stub: the /om command here is the real toggler.
		const om = pi.commands.get("om")!;
		expect(om.description).not.toContain("suppressed");
	});
});

describe("registerSubagentStubs (isolated)", () => {
	it("registers exactly the three stub commands", () => {
		const pi = makeFakePi();
		registerSubagentStubs(pi as never);
		expect([...pi.commands.keys()].sort()).toEqual(["om", "om:compact", "om:consolidate"]);
	});
});
