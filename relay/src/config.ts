import { z } from "zod";

// Database connection — needed by every entry point (server, migrate, drizzle-kit).
const databaseSchema = z.object({
	RELAY_DATABASE_URL: z
		.string()
		.url()
		.or(z.string().startsWith("postgres://"))
		.or(z.string().startsWith("postgresql://")),
	RELAY_DB_POOL_SIZE: z.coerce.number().int().positive().default(20),
});

export type RelayDatabaseConfig = z.infer<typeof databaseSchema>;

/**
 * Minimal config for migration / db-only entry points. Validates only
 * RELAY_DATABASE_URL (+ pool size). Used by db:migrate so first-time setup
 * doesn't have to fabricate every production secret just to apply schemas.
 */
export function loadDatabaseConfig(env: NodeJS.ProcessEnv = process.env): RelayDatabaseConfig {
	const parsed = databaseSchema.safeParse(env);
	if (!parsed.success) {
		const issues = parsed.error.issues
			.map((i) => `  - ${i.path.join(".")}: ${i.message}`)
			.join("\n");
		throw new Error(`Invalid database configuration:\n${issues}`);
	}
	return parsed.data;
}

// Full server schema per lld.md §12.1. Extends databaseSchema to keep them in sync.
const envSchema = databaseSchema.extend({
	RELAY_PEPPER: z.string().min(32, "RELAY_PEPPER must be at least 32 bytes"),
	RELAY_ENCRYPTION_KEY: z.string().min(16, "RELAY_ENCRYPTION_KEY must be at least 16 bytes"),
	RELAY_INVITE_SECRET: z.string().min(32, "RELAY_INVITE_SECRET must be at least 32 bytes"),
	RELAY_ADMIN_TOKEN: z.string().min(8),
	RELAY_METRICS_TOKEN: z.string().min(8),
	RELAY_PUBLIC_URL: z.string().url(),
	RELAY_ENV: z.enum(["production", "staging", "dev"]).default("production"),
	RELAY_LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
	RELAY_PORT: z.coerce.number().int().positive().default(8080),
	RELAY_AUDIT_RETENTION_DAYS: z.coerce.number().int().positive().default(90),
	RELAY_RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(60),
	OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
});

export type RelayConfig = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RelayConfig {
	const parsed = envSchema.safeParse(env);
	if (!parsed.success) {
		const issues = parsed.error.issues
			.map((i) => `  - ${i.path.join(".")}: ${i.message}`)
			.join("\n");
		throw new Error(`Invalid relay configuration:\n${issues}`);
	}
	return parsed.data;
}
