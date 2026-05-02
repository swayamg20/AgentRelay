import { describe, expect, it } from "vitest";
import { loadConfig, loadDatabaseConfig } from "./config.js";

const VALID_ENV = {
	RELAY_DATABASE_URL: "postgres://u:p@localhost:5433/db",
	RELAY_PEPPER: "p".repeat(32),
	RELAY_ENCRYPTION_KEY: "e".repeat(16),
	RELAY_ADMIN_TOKEN: "admin-token",
	RELAY_METRICS_TOKEN: "metrics-token",
	RELAY_PUBLIC_URL: "http://localhost:8080",
};

describe("loadConfig", () => {
	it("parses valid env with defaults", () => {
		const cfg = loadConfig(VALID_ENV as NodeJS.ProcessEnv);
		expect(cfg.RELAY_PORT).toBe(8080);
		expect(cfg.RELAY_ENV).toBe("production");
		expect(cfg.RELAY_AUDIT_RETENTION_DAYS).toBe(90);
		expect(cfg.RELAY_RATE_LIMIT_PER_MIN).toBe(60);
	});

	it("coerces numeric env vars from strings", () => {
		const cfg = loadConfig({
			...VALID_ENV,
			RELAY_PORT: "9090",
			RELAY_AUDIT_RETENTION_DAYS: "30",
		} as NodeJS.ProcessEnv);
		expect(cfg.RELAY_PORT).toBe(9090);
		expect(cfg.RELAY_AUDIT_RETENTION_DAYS).toBe(30);
	});

	it("rejects too-short pepper", () => {
		expect(() => loadConfig({ ...VALID_ENV, RELAY_PEPPER: "short" } as NodeJS.ProcessEnv)).toThrow(
			/RELAY_PEPPER/,
		);
	});

	it("rejects missing required fields", () => {
		const { RELAY_ADMIN_TOKEN: _omit, ...rest } = VALID_ENV;
		expect(() => loadConfig(rest as NodeJS.ProcessEnv)).toThrow(/RELAY_ADMIN_TOKEN/);
	});

	it("rejects an invalid RELAY_ENV value", () => {
		expect(() => loadConfig({ ...VALID_ENV, RELAY_ENV: "qa" } as NodeJS.ProcessEnv)).toThrow(
			/RELAY_ENV/,
		);
	});
});

describe("loadDatabaseConfig (R8)", () => {
	it("accepts only RELAY_DATABASE_URL — no production secrets needed", () => {
		const cfg = loadDatabaseConfig({
			RELAY_DATABASE_URL: "postgres://u:p@localhost:5433/db",
		} as NodeJS.ProcessEnv);
		expect(cfg.RELAY_DATABASE_URL).toContain("postgres://");
		expect(cfg.RELAY_DB_POOL_SIZE).toBe(20);
	});

	it("coerces RELAY_DB_POOL_SIZE override", () => {
		const cfg = loadDatabaseConfig({
			RELAY_DATABASE_URL: "postgres://u:p@localhost:5433/db",
			RELAY_DB_POOL_SIZE: "5",
		} as NodeJS.ProcessEnv);
		expect(cfg.RELAY_DB_POOL_SIZE).toBe(5);
	});

	it("rejects missing RELAY_DATABASE_URL", () => {
		expect(() => loadDatabaseConfig({} as NodeJS.ProcessEnv)).toThrow(/RELAY_DATABASE_URL/);
	});

	it("does not require RELAY_PEPPER / RELAY_ADMIN_TOKEN / etc. — that was the bug", () => {
		expect(() =>
			loadDatabaseConfig({
				RELAY_DATABASE_URL: "postgres://u:p@localhost:5433/db",
			} as NodeJS.ProcessEnv),
		).not.toThrow();
	});
});
