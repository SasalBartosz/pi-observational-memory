/**
 * Shared worker agent extension (L4), loaded into a subprocess `pi` via `-e`. Branches on
 * the OM_WORKER env var: `observer` (distills conversation chunks into timestamped
 * observations), `consolidator` (promotes established observations into the shared project
 * memory bank), or `reviewer` (manually verifies, merges, and prunes that bank).
 *
 * The worker is headless (`pi -p`): builtin tools are disabled (`--no-builtin-tools`), the
 * system prompt is fully replaced with the role prompt, and the role registers only the tools
 * it needs. Output is handed back to the orchestrator via result files (see src/spawn/runs.ts):
 * the observer records observations; the consolidator acknowledges individual observations;
 * the reviewer accounts for every initial memory file. Bank edits use scoped tools, and a
 * clean exit code alone is not a success signal.
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
import { readConsolidatorBatch, writeReviewerResult } from "../src/spawn/runs.js";
import { trackWorkerCost } from "./cost.js";
import { registerConsolidatorOutcomeTool } from "./consolidator/outcomes.js";
import { CONSOLIDATOR_SYSTEM } from "./consolidator/prompt.js";
import { registerConsolidatorTools } from "./consolidator/tools.js";
import { OBSERVER_SYSTEM } from "./observer/prompt.js";
import { registerObserverTool } from "./observer/tool.js";
import { REVIEWER_SYSTEM } from "./reviewer/prompt.js";
import { registerReviewerTools } from "./reviewer/tools.js";
import { fail, ok, type ToolText } from "./tool-text.js";

const ReportMemoryReviewSchema = Type.Object({
	reviewId: Type.String({ description: "The review id given in your prompt." }),
	files: Type.Array(
		Type.Object({
			path: Type.String({ description: "A memory filename that existed when the review began." }),
			disposition: Type.Union([
				Type.Literal("kept"),
				Type.Literal("updated"),
				Type.Literal("merged"),
				Type.Literal("deleted"),
			]),
		}),
		{ description: "Exactly one outcome for every memory file present at review start." },
	),
	createdFiles: Type.Array(Type.String(), { description: "Every newly created memory filename; empty when none." }),
	summary: Type.String({ description: "A factual summary of the review changes, as detailed as needed." }),
});

type ReportMemoryReviewInput = Static<typeof ReportMemoryReviewSchema>;

/** Terminal completion contract for the manual reviewer; the orchestrator validates it
 * against both the initial file set and the final bank before accepting the run. */
function registerReviewerOutcomeTool(pi: ExtensionAPI, resultPath: string, reviewId: string): void {
	pi.registerTool({
		name: "report_memory_review",
		label: "Report memory review",
		description:
			"Final step: report exactly one disposition for every memory file that existed at review start, " +
			"list every newly created file, and summarize the maintenance. Call after all edits are complete.",
		parameters: ReportMemoryReviewSchema,
		async execute(_id: string, params: ReportMemoryReviewInput): Promise<ToolText> {
			if (params.reviewId !== reviewId) return fail("reviewId mismatch — use the review id given in your prompt");
			const seen = new Set<string>();
			for (const file of params.files) {
				if (seen.has(file.path)) return fail(`duplicate file outcome for ${file.path}`);
				seen.add(file.path);
			}
			const created = new Set<string>();
			for (const path of params.createdFiles) {
				if (created.has(path)) return fail(`duplicate created file ${path}`);
				created.add(path);
			}
			if (params.summary.trim().length === 0) return fail("summary must not be empty");
			writeReviewerResult(resultPath, {
				reviewId,
				files: params.files,
				createdFiles: params.createdFiles,
				summary: params.summary.trim(),
			});
			return ok(
				`Recorded review outcomes for ${params.files.length} existing file(s) and ${params.createdFiles.length} new file(s). ` +
				"If all memory edits are complete, finish with a one-sentence confirmation.",
				{ reviewId, reviewed: params.files.length, created: params.createdFiles.length },
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
		// Only the extension reads the canonical ids; the model reports numeric labels.
		const batchPath = process.env.OM_BATCH_PATH;
		if (!batchPath) throw new Error("OM_BATCH_PATH not set for consolidator worker");
		const batch = readConsolidatorBatch(batchPath);
		registerConsolidatorTools(pi, memoryRoot);
		registerConsolidatorOutcomeTool(pi, resultPath, batch);

		pi.on("before_agent_start", async () => {
			return { systemPrompt: CONSOLIDATOR_SYSTEM };
		});

		pi.on("agent_end", async (_event: unknown, ctx: { shutdown: () => void }) => {
			ctx.shutdown();
		});
		return;
	}

	if (role === "reviewer") {
		const memoryRoot = process.env.OM_MEMORY_DIR;
		const projectRoot = process.env.OM_PROJECT_DIR;
		const reviewId = process.env.OM_REVIEW_ID;
		if (!memoryRoot) throw new Error("OM_MEMORY_DIR not set for reviewer worker");
		if (!projectRoot) throw new Error("OM_PROJECT_DIR not set for reviewer worker");
		if (!reviewId) throw new Error("OM_REVIEW_ID not set for reviewer worker");
		if (!resultPath) throw new Error("OM_RESULT_PATH not set for reviewer worker");
		registerReviewerTools(pi, memoryRoot, projectRoot);
		registerReviewerOutcomeTool(pi, resultPath, reviewId);

		pi.on("before_agent_start", async () => ({ systemPrompt: REVIEWER_SYSTEM }));
		pi.on("agent_end", async (_event: unknown, ctx: { shutdown: () => void }) => {
			ctx.shutdown();
		});
	}
}
