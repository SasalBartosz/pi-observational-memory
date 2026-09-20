import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { afterAll, expect, it } from "vitest";
import { debugLog, setDebugLogContext } from "../src/debug-log.js";

const sessionId = `debug-log-test-${process.pid}`;
const logPath = join(getAgentDir(), "observational-memory", "debug", `${sessionId}.ndjson`);

afterAll(() => {
	setDebugLogContext({ enabled: false });
	rmSync(dirname(logPath), { recursive: true, force: true });
});

it("writes only when enabled, one NDJSON line per event", () => {
	setDebugLogContext({ enabled: false, cwd: "/tmp", sessionId });
	debugLog("off.event", {});
	expect(existsSync(logPath)).toBe(false);

	setDebugLogContext({ enabled: true, cwd: "/tmp", sessionId });
	debugLog("on.event", { runId: "r1", ok: true });

	const lines = readFileSync(logPath, "utf-8").trim().split("\n");
	expect(lines).toHaveLength(1);
	const payload = JSON.parse(lines[0]);
	expect(payload.event).toBe("on.event");
	expect(payload.sessionId).toBe(sessionId);
	expect(payload.cwd).toBe("/tmp");
	expect(payload.data).toEqual({ runId: "r1", ok: true });
});
