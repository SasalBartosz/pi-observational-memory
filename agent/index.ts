/**
 * Shared worker agent extension (L4), loaded into a subprocess `pi` via `-e`. Branches on
 * the OM_WORKER env var: `observer` (distills conversation chunks into timestamped
 * observations) or `consolidator` (promotes established observations into the shared
 * project memory bank).
 *
 * The worker is headless (`pi -p`): builtin tools are disabled (`--no-builtin-tools`), the
 * system prompt is fully replaced with the role prompt, and the role registers only the tools
 * it needs. Output is handed back to the orchestrator via result files (see src/spawn/runs.ts):
 * the observer records observations; the consolidator's bank edits go through its scoped
 * tools AND the run must end with report_consolidation_outcomes — the validated outcome file
 * (one disposition per submitted observation timestamp) is what the orchestrator accepts
 * before tombstoning the batch. A clean exit code alone is not a success signal.
 *
 * Chunk delivery: the orchestrator passes the conversation chunk as the `pi -p` prompt, so it
 * is recorded as a real user message. We deliberately do NOT inject it via the `context` hook
 * — that is non-destructive and never persists to the session, which would leave the chunk
 * invisible when inspecting/resuming the observer run and defeat the observability goal
 * (decision 11). The system prompt carries role + rules only.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Static } from "typebox";
import { atomicWrite } from "../src/memory/paths.js";
import { trackWorkerCost } from "./cost.js";
import { CONSOLIDATOR_SYSTEM } from "./consolidator/prompt.js";
import { registerConsolidatorTools } from "./consolidator/tools.js";
import { OBSERVER_SYSTEM } from "./observer/prompt.js";
import { registerObserverTool } from "./observer/tool.js";
import { fail, ok, type ToolText } from "./tool-text.js";

const DISPOSITIONS = ["promoted", "retained", "discarded"] as const;
const DISPOSITION_SET = new Set<string>(DISPOSITIONS);

const ReportConsolidationOutcomesSchema = Type.Object({
	batchId: Type.String({ description: "The batch id given in your prompt." }),
	outcomes: Type.Array(
		Type.Object({
			timestamp: Type.String({
				description:
					"Observation id exactly as shown at the start of its line in the prompt, e.g. '2026-09-20T14:03:22'.",
			}),
			disposition: Type.Union([Type.Literal("promoted"), Type.Literal("retained"), Type.Literal("discarded")], {
				description:
					"promoted = written into shared memory; retained = kept session-local (the archive preserves it); discarded = noise only.",
			}),
		}),
		{ description: "One entry per submitted observation timestamp, each timestamp exactly once." },
	),
});

type ReportConsolidationOutcomesInput = Static<typeof ReportConsolidationOutcomesSchema>;

/**
 * The consolidator's terminal tool (the outcome contract). Unlike the scoped file tools, it
 * writes OUTSIDE the sandbox — to OM_RESULT_PATH in the transient runtime dir — so the model
 * cannot be sandbox-confused into reporting via bank files. Validates the model-supplied
 * batchId against OM_BATCH_ID, rejects unknown dispositions and duplicate timestamps, then
 * writes `{ batchId, outcomes }` atomically. Last write wins: a correcting second call
 * simply replaces the file (completeness — every submitted timestamp exactly once — is
 * validated by the orchestrator after exit, since only it knows the submitted batch).
 */
function registerConsolidatorOutcomeTool(pi: ExtensionAPI, resultPath: string, batchId: string): void {
	pi.registerTool({
		name: "report_consolidation_outcomes",
		label: "Report consolidation outcomes",
		description:
			"Final step: report the disposition of every observation in the submitted batch — " +
			"promoted (written into shared memory), retained (kept session-local; the archive preserves it), " +
			"or discarded (noise only). Call exactly once after all memory edits are done, covering every " +
			"submitted timestamp exactly once, then emit a short plain-text confirmation to end the run.",
		parameters: ReportConsolidationOutcomesSchema,
		async execute(_id: string, params: ReportConsolidationOutcomesInput): Promise<ToolText> {
			if (params.batchId !== batchId) {
				return fail("batchId mismatch — use the batch id given in your prompt");
			}
			const counts = { promoted: 0, retained: 0, discarded: 0 };
			const seen = new Set<string>();
			for (const outcome of params.outcomes) {
				if (!DISPOSITION_SET.has(outcome.disposition)) {
					return fail(`invalid disposition '${String(outcome.disposition)}' (use promoted, retained, or discarded)`);
				}
				if (seen.has(outcome.timestamp)) {
					return fail(`duplicate outcome for ${outcome.timestamp} — every timestamp must appear exactly once`);
				}
				seen.add(outcome.timestamp);
				counts[outcome.disposition] += 1;
			}
			atomicWrite(resultPath, JSON.stringify({ batchId, outcomes: params.outcomes }));
			const total = params.outcomes.length;
			return ok(
				`Recorded ${total} outcome${total === 1 ? "" : "s"} ` +
					`(${counts.promoted} promoted, ${counts.retained} retained, ${counts.discarded} discarded). ` +
					"If every submitted observation is accounted for and all bank edits are done, " +
					"finish with a one-sentence plain-text confirmation.",
				{ batchId, total, ...counts },
			);
		},
	});
}

export default function omWorker(pi: ExtensionAPI): void {
	const role = process.env.OM_WORKER;
	const resultPath = process.env.OM_RESULT_PATH;

	// Shared across roles: pull pi's built-in cost and hand it back via the cost file.
	// Registered first so it writes the cost file before each role's agent_end shutdown.
	trackWorkerCost(pi);

	if (role === "observer") {
		if (!resultPath) throw new Error("OM_RESULT_PATH not set for observer worker");
		registerObserverTool(pi, resultPath);

		pi.on("before_agent_start", async () => {
			return { systemPrompt: OBSERVER_SYSTEM };
		});

		// Headless `pi -p` exits when the agent loop ends; shutdown is a belt-and-suspenders.
		pi.on("agent_end", async (_event: unknown, ctx: { shutdown: () => void }) => {
			ctx.shutdown();
		});
		return;
	}

	if (role === "consolidator") {
		const memoryRoot = process.env.OM_MEMORY_DIR;
		if (!memoryRoot) throw new Error("OM_MEMORY_DIR not set for consolidator worker");
		if (!resultPath) throw new Error("OM_RESULT_PATH not set for consolidator worker");
		const batchId = process.env.OM_BATCH_ID;
		if (!batchId) throw new Error("OM_BATCH_ID not set for consolidator worker");
		// Two outputs: scoped edits to the shared bank (OM_MEMORY_DIR sandbox), and the
		// validated outcome report (result file, outside the sandbox). The orchestrator
		// checks the outcome file — every submitted timestamp accounted for — before it
		// tombstones the batch; exit code alone is not success.
		registerConsolidatorTools(pi, memoryRoot);
		registerConsolidatorOutcomeTool(pi, resultPath, batchId);

		pi.on("before_agent_start", async () => {
			return { systemPrompt: CONSOLIDATOR_SYSTEM };
		});

		pi.on("agent_end", async (_event: unknown, ctx: { shutdown: () => void }) => {
			ctx.shutdown();
		});
		return;
	}
}
