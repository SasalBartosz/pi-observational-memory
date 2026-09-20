/**
 * Subprocess worker launch — the yt-edit `pi -e <ext> -p` pattern (L2).
 *
 * NOT the subagents extension: that uses `--no-session --mode json`, which would defeat
 * decision 11's requirement that every worker be an ordinary recorded GLOBAL session. We
 * spawn a plain headless `pi` with no `--session-dir`, so the run is recorded under the
 * project path in `~/.pi/agent/sessions` and is openable in the session browser.
 */
import { spawn } from "node:child_process";
import { mkdirSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import type { ConfiguredModel } from "../config.js";
import { consolidatorResultPath, runCostPath, runResultPath } from "./runs.js";

/** Repo root = two levels up from src/spawn/. The shared agent extension lives at agent/index.ts. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const AGENT_EXTENSION_PATH = join(REPO_ROOT, "agent", "index.ts");

export function modelArg(model: ConfiguredModel): string {
	return `${model.provider}/${model.id}`;
}

/** Resolve the `pi` entry point (subagents' trick), falling back to `pi` on PATH. */
export function resolvePiBinary(): { command: string; baseArgs: string[] } {
	const entry = process.argv[1];
	if (entry) {
		try {
			const realEntry = realpathSync(entry);
			if (/\.(?:mjs|cjs|js)$/i.test(realEntry)) {
				return { command: process.execPath, baseArgs: [realEntry] };
			}
		} catch {
			// fall through
		}
	}
	return { command: "pi", baseArgs: [] };
}

export function buildWorkerArgv(opts: {
	model: ConfiguredModel;
	sessionName: string;
	kickoffPrompt: string;
	agentExtensionPath?: string;
}): string[] {
	const pi = resolvePiBinary();
	const args = [
		...pi.baseArgs,
		"--no-extensions",
		"--no-skills",
		"--no-prompt-templates",
		"--no-context-files",
		"--no-builtin-tools",
		"--model",
		modelArg(opts.model),
	];
	if (opts.model.thinking) args.push("--thinking", opts.model.thinking);
	args.push("-e", opts.agentExtensionPath ?? AGENT_EXTENSION_PATH);
	args.push("-n", opts.sessionName);
	args.push("-p", opts.kickoffPrompt);
	return [pi.command, ...args];
}

export type WorkerExit = { code: number | null; signal: NodeJS.Signals | null; stderr: string };

/**
 * Spawn a headless worker; resolve when it exits. Workers run in their master session's
 * runtime dir (`.memory/runtime/<sessionId>/`, not the project cwd) so pi keys the run into a
 * distinct global session bucket and it never clutters the project's `/resume` picker. The
 * purpose is unchanged from the old single-root layout — only the bucket moves out of the
 * durable bank. The runtime dir is ensured to exist before spawn — `spawn()` would ENOENT
 * otherwise (it is created lazily on first worker dispatch).
 */
export function spawnWorker(opts: {
	argv: string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
	signal?: AbortSignal;
}): Promise<WorkerExit> {
	const [command, ...rest] = opts.argv;
	mkdirSync(opts.cwd, { recursive: true });
	return new Promise<WorkerExit>((resolvePromise) => {
		const proc = spawn(command, rest, {
			cwd: opts.cwd,
			env: opts.env,
			stdio: ["ignore", "ignore", "pipe"],
		});
		let stderr = "";
		proc.stderr?.on("data", (d: Buffer) => {
			stderr += d.toString();
		});
		proc.on("error", () => resolvePromise({ code: 1, signal: null, stderr: stderr || "spawn error" }));
		proc.on("close", (code, signal) => resolvePromise({ code, signal, stderr }));

		if (opts.signal) {
			const kill = () => {
				proc.kill("SIGTERM");
				setTimeout(() => {
					if (!proc.killed) proc.kill("SIGKILL");
				}, 3000).unref?.();
			};
			if (opts.signal.aborted) kill();
			else opts.signal.addEventListener("abort", kill, { once: true });
		}
	});
}

export type WorkerLaunchEnv = {
	/** Absolute session runtime dir — the worker's result/cost IPC files land under its runs/. */
	runtimeDir: string;
	runId: string;
	/** Consolidator role only: the shared project bank — the sandbox root for its scoped file tools. */
	projectDir?: string;
	/** Consolidator role only: the deterministic batch id — pins the outcome contract to this batch. */
	batchId?: string;
};

/**
 * Build the env a worker subprocess needs, split by role. Both roles get their result/cost
 * IPC paths under the session runtime dir (transient, outside the durable bank). Only the
 * consolidator gets OM_MEMORY_DIR, pointing at the shared project bank — its sandbox is the
 * bank and nothing else. The chunk itself is NOT passed via env/file — it is the `pi -p`
 * prompt (recorded user message) so the run stays faithfully inspectable on resume.
 */
export function buildWorkerEnv(role: "observer" | "consolidator", opts: WorkerLaunchEnv): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		OM_WORKER: role,
		OM_RUN_ID: opts.runId,
		// Result IPC lives under the runtime dir; the consolidator's result file is the
		// validated-outcome contract (its own filename, same runs dir).
		OM_RESULT_PATH:
			role === "consolidator"
				? consolidatorResultPath(opts.runtimeDir, opts.runId)
				: runResultPath(opts.runtimeDir, opts.runId),
		// Per-run cost handoff: the worker extension writes pi's built-in usage.cost.total here.
		OM_COST_PATH: runCostPath(opts.runtimeDir, opts.runId),
	};
	if (role === "consolidator") {
		if (!opts.projectDir) {
			throw new Error("consolidator worker requires projectDir (the shared-bank sandbox)");
		}
		if (!opts.batchId) {
			throw new Error("consolidator worker requires batchId (the validated-outcome contract)");
		}
		// Sandbox root for the consolidator's scoped file tools (design risk 6).
		env.OM_MEMORY_DIR = opts.projectDir;
		// The batch id the worker must echo back in report_consolidation_outcomes; the
		// orchestrator rejects a result file whose batchId does not match the submitted batch.
		env.OM_BATCH_ID = opts.batchId;
	}
	return env;
}
