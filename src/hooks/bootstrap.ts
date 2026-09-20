/**
 * New-session bootstrap injection (plan §9).
 *
 * On `before_agent_start` — the pi hook whose return value can inject a context message into
 * the conversation right before the agent loop runs — render the shared bounded orientation
 * block (same renderer compaction uses, so orientation survives compaction unchanged) and
 * inject it as a non-displayed custom message. Dedup per session via a content fingerprint on
 * Runtime: re-inject only when the bank changed since the last injection; never append the
 * same block every turn.
 *
 * Failure policy: a missing/empty bank injects nothing; malformed/unreadable bank files skip
 * injection with a warning notify (when UI is available) and NEVER block the agent turn.
 */
import { createHash } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { renderBootstrapBlock } from "../memory/index-render.js";
import { listTopics, readOverview, type Topic } from "../memory/paths.js";
import type { Runtime } from "../runtime.js";

/** Custom-message type of the injected orientation block (persisted in the session ledger). */
export const OM_BOOTSTRAP = "om.bootstrap";

/**
 * Stable fingerprint of the bank CONTENT the block renders from: sha256 hex over the raw
 * (pre-truncation) overview text plus every topic's routing fields. Hashing the inputs rather
 * than the rendered block means edits hidden by the token cap still change the fingerprint.
 */
export function computeBootstrapFingerprint(overview: string | undefined, topics: Topic[]): string {
	const topicPart = topics
		.map((topic) => [topic.filename, topic.path, topic.id ?? "", topic.title ?? "", topic.summary ?? ""].join("\u0001"))
		.join("\u0002");
	return createHash("sha256").update(`${overview ?? ""}\u0002${topicPart}`).digest("hex");
}

export function registerBootstrapHook(pi: ExtensionAPI, runtime: Runtime): void {
	pi.on("before_agent_start", async (_event: any, ctx: any) => {
		// Same outermost guard as every other handler: invisible when the gate is off.
		if (!runtime.enabled) return undefined;
		try {
			runtime.ensureConfig(ctx.cwd);
			// projectDir is captured at activation (session_start / /om on); empty means never
			// activated, in which case there is nothing to orient from.
			if (!runtime.projectDir) return undefined;
			const overview = readOverview(runtime.projectDir);
			const topics = listTopics(runtime.projectDir, ctx.cwd);
			const block = renderBootstrapBlock(overview, topics, runtime.config.bootstrapTokens);
			const fingerprint = computeBootstrapFingerprint(overview, topics);
			if (block === undefined) {
				// Empty bank: inject nothing. Record the fingerprint anyway so an unchanged empty
				// bank stays silent; content appearing later changes it → exactly one injection.
				runtime.lastBootstrapFingerprint = fingerprint;
				return undefined;
			}
			if (fingerprint === runtime.lastBootstrapFingerprint) return undefined;
			runtime.lastBootstrapFingerprint = fingerprint;
			// pi injects returned messages as custom messages ahead of the user prompt (they
			// reach the LLM as user-role content); display:false keeps them out of the TUI.
			return {
				message: {
					customType: OM_BOOTSTRAP,
					content: block,
					display: false,
				},
			};
		} catch (err) {
			// Malformed/unreadable bank: never block the agent turn. Skip injection and warn —
			// only when the failure differs from the last one, so a persistently unreadable bank
			// does not toast on every single turn.
			const signature = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
			if (signature !== runtime.lastBootstrapError) {
				runtime.lastBootstrapError = signature;
				if (ctx?.hasUI && ctx.ui) {
					ctx.ui.notify(`om: project memory unreadable (${signature}); skipping bootstrap`, "warning");
				}
			}
			return undefined;
		}
	});
}
