import { and, eq, isNull } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import type { Database } from "../db/client.js";
import { agents, apiKeys } from "../db/schema.js";
import { RelayError } from "../errors.js";
import type { AppEnv } from "../types.js";
import { hashKey, isWellFormedKey } from "./keys.js";

export interface AuthenticatedAgent {
	id: string;
	handle: string;
	email: string;
	role: string;
	status: string;
	apiKeyId: string;
}

const lastUsedDebounce = new Map<string, number>();
const LAST_USED_DEBOUNCE_MS = 60_000;

function shouldUpdateLastUsed(keyId: string): boolean {
	const now = Date.now();
	const prev = lastUsedDebounce.get(keyId);
	if (prev && now - prev < LAST_USED_DEBOUNCE_MS) return false;
	lastUsedDebounce.set(keyId, now);
	return true;
}

export function clearLastUsedDebounce(): void {
	lastUsedDebounce.clear();
}

export interface BearerAuthOptions {
	db: Database;
	pepper: string;
}

function extractBearer(header: string | undefined): string | null {
	if (!header) return null;
	const m = /^Bearer\s+(.+)$/i.exec(header);
	return m?.[1]?.trim() ?? null;
}

/**
 * Resolves a Bearer API key to an active agent (lld §7.1).
 * Throws RelayError('unauthenticated') on any failure.
 */
export function bearerAuth(opts: BearerAuthOptions): MiddlewareHandler<AppEnv> {
	const { db, pepper } = opts;
	return async (c, next) => {
		const raw = extractBearer(c.req.header("authorization"));
		if (!raw || !isWellFormedKey(raw)) {
			throw new RelayError("unauthenticated", "Missing or malformed bearer token");
		}
		const hash = hashKey(raw, pepper);
		const rows = await db
			.select({
				keyId: apiKeys.id,
				agentId: apiKeys.agentId,
				handle: agents.handle,
				email: agents.email,
				role: agents.role,
				status: agents.status,
			})
			.from(apiKeys)
			.innerJoin(agents, eq(agents.id, apiKeys.agentId))
			.where(and(eq(apiKeys.keyHash, hash), isNull(apiKeys.revokedAt)))
			.limit(1);
		const row = rows[0];
		if (!row) throw new RelayError("unauthenticated", "Invalid or revoked API key");
		if (row.status !== "active") {
			throw new RelayError("forbidden", "Agent is disabled");
		}

		const agent: AuthenticatedAgent = {
			id: row.agentId,
			handle: row.handle,
			email: row.email,
			role: row.role,
			status: row.status,
			apiKeyId: row.keyId,
		};
		c.set("agent", agent);

		if (shouldUpdateLastUsed(row.keyId)) {
			// fire-and-forget; failure here must not block the request.
			db.update(apiKeys)
				.set({ lastUsedAt: new Date() })
				.where(eq(apiKeys.id, row.keyId))
				.catch((err: unknown) => {
					c.get("logger")?.warn({ err, keyId: row.keyId }, "last_used_at update failed");
				});
		}

		await next();
	};
}

export interface AdminAuthOptions {
	adminToken: string;
}

/** Constant-time comparison of admin bearer (lld §3.3). */
export function adminAuth(opts: AdminAuthOptions): MiddlewareHandler<AppEnv> {
	return async (c, next) => {
		const raw = extractBearer(c.req.header("authorization"));
		if (!raw) throw new RelayError("unauthenticated", "Admin token required");
		const a = Buffer.from(raw);
		const b = Buffer.from(opts.adminToken);
		if (a.length !== b.length) {
			throw new RelayError("forbidden", "Invalid admin token");
		}
		// timingSafeEqual via constantTimeEqual already length-checks, but Buffer.from
		// truncates oddly so we reuse the routine via a fresh import path.
		const { timingSafeEqual } = await import("node:crypto");
		if (!timingSafeEqual(a, b)) {
			throw new RelayError("forbidden", "Invalid admin token");
		}
		await next();
	};
}
