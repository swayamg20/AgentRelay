import { describe, expect, it } from "vitest";
import {
	SHARE_PREVIEW_TTL_MS,
	answerShareInput,
	assertShareHasNoSecrets,
	createSharePreview,
	publicationDigest,
	shareHandoffInput,
	verifySharePreview,
} from "./share-publication.js";

const LINK = "a".repeat(43);

describe("share content and secret scan", () => {
	it("bounds UTF-8 bytes, rejects NUL/empty content and unknown publishing fields", () => {
		expect(shareHandoffInput.parse({ content: "é".repeat(32 * 1024) }).expires_in_days).toBe(7);
		expect(shareHandoffInput.safeParse({ content: "é".repeat(32 * 1024 + 1) }).success).toBe(false);
		expect(answerShareInput.safeParse({ link_id: LINK, content: "é".repeat(8192) }).success).toBe(
			true,
		);
		expect(answerShareInput.safeParse({ link_id: LINK, content: "é".repeat(8193) }).success).toBe(
			false,
		);
		for (const content of ["", "body\u0000body"]) {
			expect(shareHandoffInput.safeParse({ content }).success).toBe(false);
		}
		for (const expires_in_days of [0, 31, 1.5, "7"]) {
			expect(shareHandoffInput.safeParse({ content: "body", expires_in_days }).success).toBe(false);
		}
		expect(
			shareHandoffInput.safeParse({ content: "body", thread_id: "implicit export" }).success,
		).toBe(false);
		expect(answerShareInput.safeParse({ link_id: "../escape", content: "body" }).success).toBe(
			false,
		);
	});

	it.each([
		"-----BEGIN PRIVATE KEY-----",
		"-----BEGIN RSA PRIVATE KEY-----",
		"-----BEGIN OPENSSH PRIVATE KEY-----",
		`ah_live_${"a".repeat(32)}`,
		`ar_node_test_${"b".repeat(32)}`,
		`sk-proj-${"a".repeat(24)}`,
		`sk-ant-api03-${"b".repeat(24)}`,
		`AKIA${"A".repeat(16)}`,
		`ASIA${"B".repeat(16)}`,
		`ghp_${"a".repeat(36)}`,
		`github_pat_${"b".repeat(30)}`,
		"xoxb-1111111111-2222222222-example",
		`AIza${"a".repeat(35)}`,
		"https://hooks.slack.com/services/T/B/synthetic",
		"postgres://user:password@db.example/database",
		"https://name:credential@example.test",
		"redis://:synthetic-password@cache.example",
		"eyJaaaaaaaaa.bbbbbbbbbb.cccccccccc",
		'"api_key": "synthetic-credential"',
		"CLIENT_SECRET=synthetic-credential",
		"password: synthetic-password",
		"AWS_SECRET_ACCESS_KEY=synthetic-access-secret",
		"RELAY_PEPPER=synthetic-relay-pepper",
		"RELAY_ADMIN_TOKEN=synthetic-admin-token",
		"Authorization: Bearer synthetic-opaque-bearer",
		"Authorization: Basic c3ludGhldGljOm9ubHk=",
	])("blocks known secret-like text without returning its value: %s", (secret) => {
		expect(() => assertShareHasNoSecrets(`selected text ${secret}`, "local-key")).toThrow(
			"secret scan blocked",
		);
		try {
			assertShareHasNoSecrets(secret, "local-key");
		} catch (error) {
			expect(String(error)).not.toContain(secret);
		}
	});

	it("blocks the configured bearer even if it has no recognized prefix", () => {
		expect(() =>
			assertShareHasNoSecrets("here is opaque-configured-bearer", "opaque-configured-bearer"),
		).toThrow("secret scan blocked");
	});

	it("allows ordinary selected content but does not claim arbitrary secrets are detectable", () => {
		expect(() =>
			assertShareHasNoSecrets(
				"Proposal: review the API contract at https://example.test/docs.",
				"local-key",
			),
		).not.toThrow();
		expect(() =>
			assertShareHasNoSecrets("An unfamiliar opaque value is not a safety proof.", "local-key"),
		).not.toThrow();
	});
});

describe("exact publication preview", () => {
	const publication = { kind: "create" as const, content: "selected body", expires_in_days: 7 };
	const digest = publicationDigest(publication, "https://relay.example", "sender-id");

	it("uses random preview/retry identity and binds content, expiry, operation and local account", () => {
		const first = createSharePreview(digest, 1000);
		const second = createSharePreview(digest, 1000);
		expect(first.token).not.toBe(second.token);
		expect(first.idempotency_key).not.toBe(second.idempotency_key);
		expect(verifySharePreview(first, first.token, digest, 1001)).toEqual(first);
		for (const changed of [
			publicationDigest(
				{ ...publication, content: "changed" },
				"https://relay.example",
				"sender-id",
			),
			publicationDigest(
				{ ...publication, expires_in_days: 8 },
				"https://relay.example",
				"sender-id",
			),
			publicationDigest(
				{ kind: "answer", content: publication.content, link_id: LINK },
				"https://relay.example",
				"sender-id",
			),
			publicationDigest(publication, "https://other.example", "sender-id"),
			publicationDigest(publication, "https://relay.example", "other-id"),
		])
			expect(() => verifySharePreview(first, first.token, changed, 1001)).toThrow(
				"preview missing, changed, or expired",
			);
	});

	it("rejects absent, different, expired or future previews", () => {
		const preview = createSharePreview(digest, 1000);
		expect(() => verifySharePreview(undefined, preview.token, digest, 1000)).toThrow();
		expect(() =>
			verifySharePreview(preview, createSharePreview(digest).token, digest, 1000),
		).toThrow();
		expect(() => verifySharePreview(preview, preview.token, digest, 999)).toThrow();
		expect(() =>
			verifySharePreview(preview, preview.token, digest, 1000 + SHARE_PREVIEW_TTL_MS),
		).toThrow();
	});
});
