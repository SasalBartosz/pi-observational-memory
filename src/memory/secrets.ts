/**
 * Best-effort secret screen for consolidator batches (plan §7d step 1).
 *
 * Observations matching one of the patterns below are excluded from BOTH the session
 * archive and the batch submitted to the consolidator subprocess — credentials must never
 * be handed to a worker model or written into a file a future session might read. Screened
 * observations are accounted as immediately `discarded` by the orchestrator and drain with
 * the batch after outcome validation.
 *
 * This is deliberately BASIC and best-effort, not a leakage guarantee: it catches the
 * common machine-shaped secret formats (cloud access-key ids, PEM private-key headers,
 * `sk-`/`ghp_`-style API tokens, `password=`/`token=`-style assignments). False positives
 * are possible (an observation quoting `token: <value>` prose gets screened) and false
 * negatives are certain for anything not machine-shaped. When in doubt the screen errs on
 * the side of excluding the observation: an over-excluded observation is only dropped from
 * the pool, while a leaked credential pollutes durable project memory.
 */
import type { Observation } from "../ledger/index.js";

/** One named secret pattern; the name surfaces in the debug log when a line is screened. */
export type SecretPattern = {
	name: string;
	re: RegExp;
};

export const SECRET_PATTERNS: readonly SecretPattern[] = [
	// AWS-style access-key ids (AKIA…/ASIA… + 16 upper alphanumerics).
	{ name: "aws-access-key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
	// PEM private-key block headers (RSA/EC/OpenSSH/PGP …).
	{ name: "private-key-block", re: /-----BEGIN\s+[A-Z0-9 ]*PRIVATE KEY-----/ },
	// OpenAI-style `sk-…` API tokens.
	{ name: "sk-token", re: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
	// GitHub-style `ghp_`/`gho_`/`ghu_`/`ghs_`/`ghr_` tokens.
	{ name: "github-token", re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
	// `password=` / `token=`-style assignments with a non-empty value (`:` or `=`, any case).
	{ name: "secret-assignment", re: /\b(?:password|passwd|secret|api[_-]?key|token)\s*[:=]\s*["']?[^\s"']{4,}/i },
];

/** The name of the first pattern matching `content`, or undefined when it looks clean. */
export function findSecretPattern(content: string): string | undefined {
	for (const { name, re } of SECRET_PATTERNS) {
		if (re.test(content)) return name;
	}
	return undefined;
}

/** True when `content` matches any secret pattern (best-effort, see module doc). */
export function looksLikeSecret(content: string): boolean {
	return findSecretPattern(content) !== undefined;
}

/**
 * Split a batch into what may be archived/submitted (`safe`) and what the screen pulled
 * out (`screened`). Order is preserved in both halves.
 */
export function screenSecrets(
	observations: Observation[],
): { safe: Observation[]; screened: Observation[] } {
	const safe: Observation[] = [];
	const screened: Observation[] = [];
	for (const observation of observations) {
		(looksLikeSecret(observation.content) ? screened : safe).push(observation);
	}
	return { safe, screened };
}
