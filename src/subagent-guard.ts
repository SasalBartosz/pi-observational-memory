/**
 * Process-role classification for suppressing the orchestrator outside main sessions (plan §10).
 *
 * Behavior matrix:
 *  - `OM_WORKER` set — this extension's own worker subprocesses (see spawn/launch.ts
 *    `buildWorkerEnv`). Defense in depth: the orchestrator must never activate inside its own
 *    workers, so the extension factory returns immediately and registers NOTHING. (The worker
 *    extension `agent/index.ts` is the intentional in-process worker and is untouched by this.)
 *  - `PI_SUBAGENT_ID` / `PI_SUBAGENT_SESSION` set — pi's subagent launcher on interactive
 *    subagent sessions. Register nothing except stub `/om` commands that report suppression:
 *    no gate restore, no memory-dir resolution/creation, no triggers/hooks/status UI. A copied
 *    `om.enabled` ledger entry inherited from a `session-mode: fork` parent cannot re-enable the
 *    pipeline because no `session_start` handler exists to restore the gate.
 *  - plain main session — full activation. User forks are main sessions: classification is by
 *    environment markers ONLY, never by `parentSession` (a fork is a legitimate main session).
 *
 * `PI_OM_PASSIVE=1` is the documented opt-out for OTHER launchers: it disables triggers via
 * config (`passive: true`), but is not the full no-init guard — the rest of the extension still
 * initializes normally.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type ProcessRole = "main" | "worker" | "subagent";

/** Message reported by the stub /om commands when the orchestrator is suppressed. */
export const SUBAGENT_SUPPRESSED_MESSAGE = "OM is suppressed in subagent sessions";

/**
 * Classify the current process role from environment markers. Pure: pass `env` explicitly in
 * tests; defaults to `process.env` in production. Worker wins over subagent (a marker set
 * inside our own worker is the strongest signal). Never inspects session/parent state.
 */
export function classifyProcessRole(env: NodeJS.ProcessEnv = process.env): ProcessRole {
	if (env.OM_WORKER) return "worker";
	if (env.PI_SUBAGENT_ID || env.PI_SUBAGENT_SESSION) return "subagent";
	return "main";
}

/**
 * Register the minimal stub commands for a suppressed subagent session: `/om`, `/om:consolidate`
 * and `/om:compact` each report suppression instead of activating anything. The ONLY thing
 * registered — no handlers, no gate, no dirs, no status UI.
 */
export function registerSubagentStubs(pi: ExtensionAPI): void {
	for (const name of ["om", "om:consolidate", "om:compact"] as const) {
		pi.registerCommand(name, {
			description: `Observational memory (${SUBAGENT_SUPPRESSED_MESSAGE.toLowerCase()})`,
			handler: async (_args: string, ctx: any) => {
				if (ctx?.hasUI && ctx.ui) ctx.ui.notify(SUBAGENT_SUPPRESSED_MESSAGE, "warning");
			},
		});
	}
}
