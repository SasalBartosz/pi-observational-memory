/** Index-based reporting with atomic persistence and missing-only repairs across calls. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Static } from "typebox";
import {
	writeConsolidatorResult,
	type ConsolidatorBatch,
	type ConsolidatorDisposition,
	type ConsolidatorOutcome,
} from "../../src/spawn/runs.js";
import { ok, type ToolText } from "../tool-text.js";

const ReportConsolidationOutcomesSchema = Type.Object({
	batchId: Type.String({ description: "The batch id given in your prompt." }),
	outcomes: Type.Array(
		Type.Object({
			index: Type.Integer({ minimum: 1, description: "The observation's 1-based numeric label in your prompt." }),
			disposition: Type.Union(
				[Type.Literal("promoted"), Type.Literal("retained"), Type.Literal("discarded")],
				{ description: "promoted = written into shared memory; retained = archive only, no longer active; discarded = noise." },
			),
		}),
		{ description: "Entries to add or correct. Previously reported entries need not be repeated." },
	),
});

type ReportConsolidationOutcomesInput = Static<typeof ReportConsolidationOutcomesSchema>;
/**
 * Reject the entire call before changing either the accumulated report or its file. pi has
 * already checked params against the schema (integer index >= 1, known disposition); only
 * the batch-dependent rules are left here.
 */
function validateOutcomeCall(params: ReportConsolidationOutcomesInput, batch: ConsolidatorBatch): string | undefined {
	if (params.batchId !== batch.batchId) return "batchId mismatch — use the batch id given in your prompt";

	const seen = new Set<number>();
	for (const { index } of params.outcomes) {
		if (index > batch.timestamps.length) {
			return `invalid observation index ${index} — use a numeric label from your prompt (1..${batch.timestamps.length})`;
		}
		if (seen.has(index)) return `duplicate index ${index} within this call — give each observation one entry per call`;
		seen.add(index);
	}
	return undefined;
}

export function registerConsolidatorOutcomeTool(pi: ExtensionAPI, resultPath: string, batch: ConsolidatorBatch): void {
	let reported = new Map<number, ConsolidatorDisposition>();

	pi.registerTool({
		name: "report_consolidation_outcomes",
		label: "Report consolidation outcomes",
		executionMode: "sequential",
		description:
			"After bank edits, report each observation's disposition using its 1-based numeric label " +
			"in the prompt, not its timestamp. promoted = knowledge written into shared memory; retained = " +
			"preserved only in the session archive, not the active pool; discarded = noise. Calls merge: " +
			"repeat the tool with only missing or corrected entries. Invalid calls change nothing. " +
			"An incomplete report returns an error listing missing indices; finish only when it succeeds.",
		parameters: ReportConsolidationOutcomesSchema,
		async execute(_id: string, params: ReportConsolidationOutcomesInput): Promise<ToolText> {
			const error = validateOutcomeCall(params, batch);
			if (error) throw new Error(error);

			const next = new Map(reported);
			for (const { index, disposition } of params.outcomes) next.set(index, disposition);

			const outcomes: ConsolidatorOutcome[] = [];
			const missing: number[] = [];
			const counts = { promoted: 0, retained: 0, discarded: 0 };
			batch.timestamps.forEach((timestamp, offset) => {
				const index = offset + 1;
				const disposition = next.get(index);
				if (disposition === undefined) {
					missing.push(index);
				} else {
					outcomes.push({ timestamp, disposition });
					counts[disposition] += 1;
				}
			});

			// Commit in memory only after persistence succeeds, so a failed write is retryable.
			writeConsolidatorResult(resultPath, { batchId: batch.batchId, outcomes });
			reported = next;
			if (missing.length > 0) {
				throw new Error(
					`Recorded ${outcomes.length}/${batch.timestamps.length} outcomes. Missing indices: ${missing.join(", ")}. ` +
					"Call report_consolidation_outcomes again with just the missing or corrected entries; previous entries are kept.",
				);
			}

			return ok(
				`Recorded all ${outcomes.length} outcomes ` +
					`(${counts.promoted} promoted, ${counts.retained} retained in archive, ${counts.discarded} discarded). ` +
					"If all bank edits are done, finish with a one-sentence confirmation.",
				{ batchId: batch.batchId, total: outcomes.length, ...counts },
			);
		},
	});
}
