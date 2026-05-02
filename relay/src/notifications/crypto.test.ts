import { describe, expect, it } from "vitest";
import { decryptWebhook, encryptWebhook } from "./crypto.js";

describe("webhook crypto", () => {
	const secret = "test-encryption-key";

	it("round-trips a webhook URL", () => {
		const url = "https://hooks.slack.com/services/T0/B0/secret123";
		const enc = encryptWebhook(url, secret);
		expect(enc.startsWith("enc:v1:")).toBe(true);
		expect(enc).not.toContain(url);
		expect(decryptWebhook(enc, secret)).toBe(url);
	});

	it("produces different ciphertexts each call (IV randomness)", () => {
		const a = encryptWebhook("x", secret);
		const b = encryptWebhook("x", secret);
		expect(a).not.toBe(b);
	});

	it("refuses payloads with wrong secret (auth tag fails)", () => {
		const enc = encryptWebhook("x", secret);
		expect(() => decryptWebhook(enc, "other-secret")).toThrow();
	});

	it("rejects unmarked payloads", () => {
		expect(() => decryptWebhook("not-encrypted", secret)).toThrow(/v1/);
	});
});
