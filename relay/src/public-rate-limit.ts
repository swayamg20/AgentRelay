import { isIP } from "node:net";
import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context, MiddlewareHandler } from "hono";
import { RelayError } from "./errors.js";
import type { AppEnv } from "./types.js";

const WINDOW_MS = 60_000;
const MAX_BUCKETS = 10_000;

export class PublicRateLimiter {
	private readonly buckets = new Map<string, { count: number; expiresAt: number }>();
	private nextCleanup = 0;

	allow(key: string, limit: number, now = Date.now()): boolean {
		if (now >= this.nextCleanup) {
			for (const [bucketKey, bucket] of this.buckets) {
				if (bucket.expiresAt <= now) this.buckets.delete(bucketKey);
			}
			this.nextCleanup = now + 1_000;
		}
		let bucket = this.buckets.get(key);
		if (!bucket || bucket.expiresAt <= now) {
			if (!bucket && this.buckets.size >= MAX_BUCKETS) return false;
			bucket = { count: 0, expiresAt: now + WINDOW_MS };
			this.buckets.set(key, bucket);
		}
		bucket.count++;
		return bucket.count <= limit;
	}
}

export function publicClientIp(context: Context<AppEnv>): string {
	const forwarded = context.req.header("x-forwarded-for")?.split(",", 1)[0]?.trim();
	if (forwarded && isIP(forwarded)) return normalizeIp(forwarded);
	try {
		const address = getConnInfo(context).remote.address;
		if (address && isIP(address)) return normalizeIp(address);
	} catch {}
	return "unknown";
}

function normalizeIp(address: string): string {
	const normalized = address.toLowerCase().split("%", 1)[0] ?? address;
	if (isIP(normalized) !== 6) return normalized;
	const canonical = new URL(`http://[${normalized}]/`).hostname.slice(1, -1);
	const mapped = /^::ffff:([0-9a-f]+):([0-9a-f]+)$/.exec(canonical);
	if (!mapped) return canonical;
	const high = Number.parseInt(mapped[1]!, 16);
	const low = Number.parseInt(mapped[2]!, 16);
	return `${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`;
}

export function publicRateLimit(
	limiter: PublicRateLimiter,
	scope: "share" | "invite",
): MiddlewareHandler<AppEnv> {
	return async (context, next) => {
		const reading = context.req.method === "GET" || context.req.method === "HEAD";
		const action = reading ? "read" : "write";
		const ipAllowed = limiter.allow(
			`${scope}:${action}:ip:${publicClientIp(context)}`,
			reading ? 60 : 10,
		);
		const linkId = context.req.param("id");
		const linkAllowed =
			scope !== "share" ||
			!linkId ||
			limiter.allow(`share:${action}:link:${linkId}`, reading ? 120 : 20);
		if (!ipAllowed || !linkAllowed) {
			context.header("Retry-After", "60");
			throw new RelayError("rate_limited", "Too many requests; retry later");
		}
		await next();
	};
}
