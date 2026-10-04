import { describe, expect, it } from "vitest";

import { contextPressurePercent } from "../src/hooks/compaction-trigger.js";
import type { Entry } from "../src/ledger/index.js";
import { textCustomMessage } from "./fixtures/session.js";

function branchWithTokens(tokens: number): Entry[] {
	return [textCustomMessage("raw-1", "x".repeat(tokens * 4)) as Entry];
}

describe("percentage-based context pressure", () => {
	it("uses Pi's reported percentage for the active model window", () => {
		const below = contextPressurePercent(
			{
				getContextUsage: () => ({ tokens: 749_000, contextWindow: 1_000_000, percent: 74.9 }),
				sessionManager: { getBranch: () => [] },
			},
			75,
		);
		const due = contextPressurePercent(
			{
				getContextUsage: () => ({ tokens: 750_000, contextWindow: 1_000_000, percent: 75 }),
				sessionManager: { getBranch: () => [] },
			},
			75,
		);

		expect(below.due).toBe(false);
		expect(due.due).toBe(true);
		expect(due.contextWindow).toBe(1_000_000);
	});

	it("derives a percentage when Pi temporarily has no live token estimate", () => {
		const pressure = contextPressurePercent(
			{
				getContextUsage: () => ({ tokens: null, contextWindow: 100, percent: null }),
				sessionManager: { getBranch: () => branchWithTokens(75) },
			},
			75,
		);

		expect(pressure.tokens).toBe(75);
		expect(pressure.percent).toBe(75);
		expect(pressure.due).toBe(true);
	});

	it("falls back to model metadata and declines to trigger when the window is unknown", () => {
		const branch = branchWithTokens(75);
		expect(
			contextPressurePercent(
				{ model: { contextWindow: 100 }, sessionManager: { getBranch: () => branch } },
				75,
			).due,
		).toBe(true);

		const unknown = contextPressurePercent({ sessionManager: { getBranch: () => branch } }, 75);
		expect(unknown.percent).toBeNull();
		expect(unknown.due).toBe(false);
	});
});
