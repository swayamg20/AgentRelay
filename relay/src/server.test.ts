import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { RelayError } from "./errors.js";
import { createLogger } from "./logger.js";
import { createServer } from "./server.js";

const TEST_ENV = {
	RELAY_DATABASE_URL: "postgres://test:test@localhost:5433/test",
	RELAY_PEPPER: "a".repeat(32),
	RELAY_ENCRYPTION_KEY: "b".repeat(16),
	RELAY_INVITE_SECRET: "i".repeat(32),
	RELAY_ADMIN_TOKEN: "admin-token",
	RELAY_METRICS_TOKEN: "metrics-token",
	RELAY_PUBLIC_URL: "http://localhost:8080",
	RELAY_ENV: "dev" as const,
	RELAY_LOG_LEVEL: "fatal" as const,
};

function buildApp(opts: { ready?: boolean; throwError?: Error } = {}) {
	const config = loadConfig({ ...TEST_ENV } as NodeJS.ProcessEnv);
	const logger = createLogger(config);
	const app = createServer({
		config,
		logger,
		readinessProbe: async () => opts.ready ?? true,
	});
	if (opts.throwError) {
		app.get("/__boom", () => {
			throw opts.throwError;
		});
	}
	return app;
}

describe("relay server", () => {
	it("GET /healthz returns ok", async () => {
		const app = buildApp();
		const res = await app.request("/healthz");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ status: "ok" });
	});

	it("GET /readyz returns ready when probe succeeds", async () => {
		const app = buildApp({ ready: true });
		const res = await app.request("/readyz");
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ status: "ready" });
	});

	it("GET /readyz returns 503 when probe fails", async () => {
		const app = buildApp({ ready: false });
		const res = await app.request("/readyz");
		expect(res.status).toBe(503);
		const body = (await res.json()) as { code: string; request_id: string };
		expect(body.code).toBe("internal");
		expect(body.request_id).toMatch(/^req_/);
	});

	it("echoes incoming x-request-id header", async () => {
		const app = buildApp();
		const res = await app.request("/healthz", {
			headers: { "x-request-id": "req_test-123" },
		});
		expect(res.headers.get("x-request-id")).toBe("req_test-123");
	});

	it("mints a request id when none is supplied", async () => {
		const app = buildApp();
		const res = await app.request("/healthz");
		expect(res.headers.get("x-request-id")).toMatch(/^req_/);
	});

	it("unknown route returns method_not_found envelope", async () => {
		const app = buildApp();
		const res = await app.request("/no-such-route");
		expect(res.status).toBe(404);
		const body = (await res.json()) as { code: string; request_id: string };
		expect(body.code).toBe("method_not_found");
		expect(body.request_id).toMatch(/^req_/);
	});

	it("RelayError is rendered via the configured envelope", async () => {
		const app = buildApp({
			throwError: new RelayError("recipient_not_found", "no agent 'ghost'", { handle: "ghost" }),
		});
		const res = await app.request("/__boom");
		expect(res.status).toBe(404);
		const body = (await res.json()) as {
			code: string;
			message: string;
			details: Record<string, unknown>;
		};
		expect(body.code).toBe("recipient_not_found");
		expect(body.message).toContain("ghost");
		expect(body.details).toEqual({ handle: "ghost" });
	});

	it("unhandled errors return generic internal envelope", async () => {
		const app = buildApp({ throwError: new Error("kaboom") });
		const res = await app.request("/__boom");
		expect(res.status).toBe(500);
		const body = (await res.json()) as { code: string; message: string };
		expect(body.code).toBe("internal");
		expect(body.message).toBe("Internal server error");
	});
});
