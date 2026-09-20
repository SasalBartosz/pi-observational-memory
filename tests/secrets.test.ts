import { describe, expect, it } from "vitest";

import { findSecretPattern, looksLikeSecret, screenSecrets, SECRET_PATTERNS } from "../src/memory/secrets.js";
import { observation } from "./fixtures/session.js";

describe("looksLikeSecret (best-effort patterns)", () => {
	it("matches AWS-style access-key ids", () => {
		expect(looksLikeSecret("the deploy uses AKIAABCDEFGHIJKLMNOP")).toBe(true);
		expect(looksLikeSecret("temporary creds ASIA0123456789ABCDEF")).toBe(true);
		expect(findSecretPattern("key AKIAABCDEFGHIJKLMNOP")).toBe("aws-access-key");
	});

	it("matches PEM private-key block headers", () => {
		expect(looksLikeSecret("-----BEGIN RSA PRIVATE KEY-----\nMIIE...")).toBe(true);
		expect(looksLikeSecret("-----BEGIN OPENSSH PRIVATE KEY-----")).toBe(true);
	});

	it("matches sk-/GitHub-style API tokens", () => {
		expect(looksLikeSecret("set OPENAI_API_KEY to sk-abc123def456ghi789jkl")).toBe(true);
		expect(looksLikeSecret("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456")).toBe(true);
		expect(looksLikeSecret("gho_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456")).toBe(true);
	});

	it("matches password/token-style assignments with a value", () => {
		expect(looksLikeSecret("password=hunter2secret")).toBe(true);
		expect(looksLikeSecret("DB token: postgres-secret-1234")).toBe(true);
		expect(looksLikeSecret("api_key: sk_live_abcdef")).toBe(true);
	});

	it("does not match ordinary project prose", () => {
		expect(looksLikeSecret("the auth service uses JWT tokens")).toBe(false);
		expect(looksLikeSecret("postgres runs on port 5432")).toBe(false);
		expect(looksLikeSecret("password is weak in this scheme")).toBe(false); // no `=`/`:` value
		expect(looksLikeSecret("we discussed AKIA naming conventions only")).toBe(false); // too short to be a key
	});
});

describe("screenSecrets", () => {
	it("partitions the batch in order without touching either half", () => {
		const safe1 = observation("2026-05-02T10:00:01", { content: "uses vite for builds" });
		const secret = observation("2026-05-02T10:00:02", { content: "aws key AKIAABCDEFGHIJKLMNOP for deploys" });
		const safe2 = observation("2026-05-02T10:00:03", { content: "tests run with vitest" });

		const { safe, screened } = screenSecrets([safe1, secret, safe2]);

		expect(safe).toEqual([safe1, safe2]);
		expect(screened).toEqual([secret]);
	});

	it("keeps a clean batch intact", () => {
		const batch = [observation("2026-05-02T10:00:01", { content: "plain prose" })];
		const { safe, screened } = screenSecrets(batch);
		expect(safe).toEqual(batch);
		expect(screened).toEqual([]);
	});

	it("exposes the pattern list for documentation/debugging", () => {
		expect(SECRET_PATTERNS.map((p) => p.name)).toContain("secret-assignment");
	});
});
