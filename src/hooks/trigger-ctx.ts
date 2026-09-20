import type { Entry } from "../ledger/index.js";

/**
 * The pi event-handler context surface the triggers and commands rely on. One shared shape
 * for every hook: the fields a given handler doesn't use are simply ignored (pi always
 * provides them).
 */
export type TriggerCtx = {
	cwd: string;
	hasUI: boolean;
	ui?: { notify: (message: string, level?: "info" | "warning" | "error") => void };
	sessionManager: {
		getBranch: () => Entry[];
		getEntries: () => Entry[];
		getSessionId: () => string;
	};
	getContextUsage?: () => { tokens: number | null } | undefined;
};
