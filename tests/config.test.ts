import { describe, expect, it } from "vitest";

import { DEFAULTS } from "../src/config.js";

describe("observational-memory defaults", () => {
	it("uses the requested token thresholds", () => {
		expect(DEFAULTS.compactAtContextTokens).toBe(250_000);
		expect(DEFAULTS.chunkTokens).toBe(15_000);
		expect(DEFAULTS.consolidateAtPoolTokens).toBe(25_000);
	});

	it("uses GLM 5.3 Flash for every worker role", () => {
		for (const model of Object.values(DEFAULTS.models)) {
			expect(model.provider).toBe("openrouter");
			expect(model.id).toBe("z-ai/glm-5.3-flash");
		}
		expect(DEFAULTS.models.reviewer.thinking).toBe("high");
	});
});
