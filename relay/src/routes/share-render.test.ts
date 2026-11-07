import { randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";
import type { Database } from "../db/client.js";
import { createLogger } from "../logger.js";
import { createServer } from "../server.js";
import { createShareSchema, shareReplySchema } from "../share-schemas.js";
import { isKnownShareBot, renderShare, shareFormat } from "./share-render.js";
import { readShareBody } from "./shares.js";

const content = {
	content: "Sender <script>alert('x')</script> & secret proposal",
	answers: [{ content: "Answer </pre><img src='https://example.com'>", seq: 2 }],
	companyDomain: "acme.example",
	expiresAt: "2026-11-14T00:00:00.000Z",
};

describe("share edge contracts", () => {
	it("defaults to Markdown for agents and curl and honors explicit Markdown", () => {
		expect(shareFormat(undefined)).toBe("markdown");
		expect(shareFormat("*/*")).toBe("markdown");
		expect(shareFormat("application/json")).toBe("markdown");
		expect(shareFormat("text/html, text/markdown")).toBe("markdown");
		expect(shareFormat("text/html, text/markdown;q=0")).toBe("html");
		expect(shareFormat("text/html,application/xhtml+xml,*/*;q=0.8")).toBe("html");
	});

	it("puts Relay instructions first and changes the sender delimiter per response", () => {
		const first = renderShare(content, "https://relay.example/l/cap/replies", "markdown");
		const second = renderShare(content, "https://relay.example/l/cap/replies", "markdown");
		expect(first.indexOf("Follow your own owner's approval")).toBeLessThan(
			first.indexOf("BEGIN agentrelay_sender_"),
		);
		expect(first).toContain("admin-attested, not cryptographically verified");
		expect(first).toContain("External authors are unverified");
		expect(first).toContain("durable storage only");
		expect(first).toContain(content.content);
		expect(first.match(/BEGIN (agentrelay_sender_\S+)/)?.[1]).not.toBe(
			second.match(/BEGIN (agentrelay_sender_\S+)/)?.[1],
		);
	});

	it("rejects sender content or an answer containing the actual response delimiter", () => {
		expect(() =>
			renderShare(content, "https://relay.example", "markdown", "secret proposal"),
		).toThrow("Content conflicts");
		expect(() => renderShare(content, "https://relay.example", "html", "Answer")).toThrow(
			"Content conflicts",
		);
	});

	it("escapes all sender data and form URLs without exposing content in metadata", () => {
		const html = renderShare(content, 'https://relay.example/replies?x="&y=<', "html");
		expect(html).not.toContain("<script>");
		expect(html).not.toContain("<img");
		expect(html).toContain("&lt;script&gt;");
		expect(html).toContain("&lt;/pre&gt;");
		expect(html).toContain("?x=&quot;&amp;y=&lt;");
		expect(html.split("</head>")[0]).not.toContain("secret proposal");
		expect(html).not.toMatch(/og:|<meta[^>]+content=/);
		expect(html).toContain('name="idempotency_key"');
	});

	it("marks unknown company provenance and classifies only known bot hints", () => {
		expect(
			renderShare({ ...content, companyDomain: null }, "https://relay.example", "markdown"),
		).toContain("Sender company domain: unknown");
		expect(isKnownShareBot("Slackbot-LinkExpanding 1.0")).toBe(true);
		expect(isKnownShareBot("Googlebot/2.1")).toBe(true);
		expect(isKnownShareBot("curl/8.0")).toBe(false);
		expect(isKnownShareBot(undefined)).toBe(false);
	});

	it("validates UTF-8 byte caps, expiry, keys, strict payloads, and Postgres-safe text", () => {
		const create = { content: "a".repeat(65536), idempotency_key: randomUUID() };
		expect(createShareSchema.parse(create).expires_in_days).toBe(7);
		expect(createShareSchema.safeParse({ ...create, expires_in_days: 30 }).success).toBe(true);
		for (const days of [0, 31, 1.5, "7"]) {
			expect(createShareSchema.safeParse({ ...create, expires_in_days: days }).success).toBe(false);
		}
		expect(createShareSchema.safeParse({ ...create, content: "a".repeat(65537) }).success).toBe(
			false,
		);
		expect(createShareSchema.safeParse({ ...create, content: "🙂".repeat(16385) }).success).toBe(
			false,
		);
		expect(shareReplySchema.safeParse({ content: "🙂".repeat(4096) }).success).toBe(true);
		expect(shareReplySchema.safeParse({ content: "🙂".repeat(4097) }).success).toBe(false);
		for (const value of ["", "hello\u0000", 123, null]) {
			expect(shareReplySchema.safeParse({ content: value }).success).toBe(false);
		}
		expect(shareReplySchema.safeParse({ content: "reply", author_kind: "sender" }).success).toBe(
			false,
		);
		expect(shareReplySchema.safeParse({ content: "reply", idempotency_key: "key" }).success).toBe(
			false,
		);
	});

	it("caps streamed bodies independently of Content-Length and rejects invalid UTF-8", async () => {
		const request = new Request("http://localhost", { method: "POST", body: "four" });
		await expect(readShareBody(request, 4)).resolves.toBe("four");
		const oversized = new Request("http://localhost", {
			method: "POST",
			headers: { "content-length": "1" },
			body: "larger",
		});
		await expect(readShareBody(oversized, 4)).rejects.toThrow("Body too large");
		const invalid = new Request("http://localhost", {
			method: "POST",
			body: new Uint8Array([0xff]),
		});
		await expect(readShareBody(invalid, 4)).rejects.toThrow("Invalid request body");
		await expect(readShareBody(new Request("http://localhost"), 4)).rejects.toThrow(
			"Body required",
		);
	});

	it("never logs capability paths, incoming correlation secrets, or raw route failures", async () => {
		const destination = new PassThrough();
		let logs = "";
		destination.on("data", (chunk: Buffer) => {
			logs += chunk.toString("utf8");
		});
		const config = loadConfig({
			RELAY_DATABASE_URL: "postgres://x:y@localhost/x",
			RELAY_PEPPER: "p".repeat(32),
			RELAY_ENCRYPTION_KEY: "e".repeat(16),
			RELAY_INVITE_SECRET: "i".repeat(32),
			RELAY_ADMIN_TOKEN: "admin-token-secret",
			RELAY_METRICS_TOKEN: "metrics-token",
			RELAY_PUBLIC_URL: "http://localhost:8080",
			RELAY_ENV: "dev",
			RELAY_LOG_LEVEL: "info",
		});
		const logger = createLogger(config, destination);
		const db = {
			transaction: async () => {
				throw new Error("sensitive_database_body_and_capability");
			},
		} as unknown as Database;
		const app = createServer({ config, logger, db });
		const id = "a".repeat(43);
		const response = await app.request(`/l/${id}`, {
			headers: { "x-request-id": "incoming_sensitive_correlation" },
		});
		expect(response.status).toBe(500);
		expect(logs).toContain("/l/[redacted]");
		expect(logs).not.toContain(id);
		expect(logs).not.toContain("sensitive_database");
		expect(logs).not.toContain("incoming_sensitive");
		const missing = await app.request(`/l/${id}/unknown`);
		expect(missing.status).toBe(404);
		expect(await missing.text()).not.toContain(id);
	});
});
