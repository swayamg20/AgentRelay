import { describe, expect, it } from "vitest";
import { constantTimeEqual, generateKey, hashKey, isWellFormedKey } from "./keys.js";

describe("auth/keys", () => {
	const pepper = "p".repeat(32);

	it("generates a well-formed live key", () => {
		const k = generateKey("live", pepper);
		expect(k.raw.startsWith("ah_live_")).toBe(true);
		expect(k.raw.length).toBe("ah_live_".length + 32);
		expect(isWellFormedKey(k.raw)).toBe(true);
		expect(k.hash.length).toBe(32);
		expect(k.salt.length).toBe(16);
	});

	it("generates a well-formed test key", () => {
		const k = generateKey("test", pepper);
		expect(k.raw.startsWith("ah_test_")).toBe(true);
		expect(isWellFormedKey(k.raw)).toBe(true);
	});

	it("hash is deterministic for (pepper, key)", () => {
		const k = generateKey("live", pepper);
		expect(hashKey(k.raw, pepper).equals(k.hash)).toBe(true);
	});

	it("hash changes with pepper", () => {
		const k = generateKey("live", pepper);
		const other = hashKey(k.raw, "q".repeat(32));
		expect(other.equals(k.hash)).toBe(false);
	});

	it("rejects malformed keys", () => {
		expect(isWellFormedKey("garbage")).toBe(false);
		expect(isWellFormedKey("ah_prod_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toBe(false);
		expect(isWellFormedKey("ah_live_AAAA")).toBe(false); // wrong length + uppercase
	});

	it("constantTimeEqual handles equal/unequal/different-length", () => {
		const a = Buffer.from("hello!!!");
		const b = Buffer.from("hello!!!");
		const c = Buffer.from("hellooo!");
		const d = Buffer.from("short");
		expect(constantTimeEqual(a, b)).toBe(true);
		expect(constantTimeEqual(a, c)).toBe(false);
		expect(constantTimeEqual(a, d)).toBe(false);
	});
});
