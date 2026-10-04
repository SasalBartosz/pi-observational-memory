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
import { consolidatorResultPath, reviewerResultPath, runCostPath, runResultPath } from "./runs.js";

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
	/** Consolidator/reviewer: the shared project-memory bank (the mutable sandbox root). */
	projectDir?: string;
	/** Reviewer only: the project cwd exposed through read-only inspection tools. */
	sourceDir?: string;
	/** Consolidator only: the deterministic batch id that pins its outcome contract. */
	batchId?: string;
	/** Reviewer only: id echoed in the terminal review report. */
	reviewId?: string;
};

/**
 * Build the env a worker subprocess needs, split by role. Every role gets result/cost IPC
 * paths under the transient session runtime dir. Consolidator and reviewer get OM_MEMORY_DIR
 * for scoped bank mutation; only the reviewer also gets OM_PROJECT_DIR for read-only source
 * inspection. Kickoff input travels as the recorded `pi -p` prompt, not via env/file.
 */
export function buildWorkerEnv(role: "observer" | "consolidator" | "reviewer", opts: WorkerLaunchEnv): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		OM_WORKER: role,
		OM_RUN_ID: opts.runId,
		// Each role has a separate validated result shape, all under the same transient runs dir.
		OM_RESULT_PATH:
			role === "consolidator"
				? consolidatorResultPath(opts.runtimeDir, opts.runId)
				: role === "reviewer"
					? reviewerResultPath(opts.runtimeDir, opts.runId)
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
	if (role === "reviewer") {
		if (!opts.projectDir) throw new Error("reviewer worker requires projectDir (the shared-bank sandbox)");
		if (!opts.sourceDir) throw new Error("reviewer worker requires sourceDir (the read-only project root)");
		if (!opts.reviewId) throw new Error("reviewer worker requires reviewId (the validated completion contract)");
		env.OM_MEMORY_DIR = opts.projectDir;
		env.OM_PROJECT_DIR = opts.sourceDir;
		env.OM_REVIEW_ID = opts.reviewId;
	}
	return env;
}
