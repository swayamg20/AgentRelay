import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { RelayError } from "./errors.js";
import { PublicRateLimiter, publicClientIp, publicRateLimit } from "./public-rate-limit.js";
import type { AppEnv } from "./types.js";

describe("public in-process rate limits", () => {
	it("bounds each fixed window and expires buckets", () => {
		const limiter = new PublicRateLimiter();
		expect(limiter.allow("key", 2, 1000)).toBe(true);
		expect(limiter.allow("key", 2, 1001)).toBe(true);
		expect(limiter.allow("key", 2, 1002)).toBe(false);
		expect(limiter.allow("other", 2, 1002)).toBe(true);
		expect(limiter.allow("key", 2, 61000)).toBe(true);
	});

	it("bounds memory under unique-key flooding without evicting active limits", () => {
		const limiter = new PublicRateLimiter();
		for (let index = 0; index < 10_000; index++) {
			expect(limiter.allow(`key:${index}`, 1, 0)).toBe(true);
		}
		expect(limiter.allow("new", 1, 0)).toBe(false);
		expect(limiter.allow("key:0", 1, 0)).toBe(false);
		expect(limiter.allow("new", 1, 60_000)).toBe(true);
	});

	it("honors the first forwarded IP, normalizes IPv6, and falls back to the socket", async () => {
		const app = new Hono<AppEnv>();
		app.get("/", (context) => context.text(publicClientIp(context)));
		const first = await app.request("/", { headers: { "x-forwarded-for": "192.0.2.1, 10.0.0.1" } });
		expect(await first.text()).toBe("192.0.2.1");
		const ipv6 = await app.request("/", {
			headers: { "x-forwarded-for": "2001:0DB8:0:0:0:0:0:1" },
		});
		expect(await ipv6.text()).toBe("2001:db8::1");
		const mapped = await app.request("/", { headers: { "x-forwarded-for": "::ffff:192.0.2.1" } });
		expect(await mapped.text()).toBe("192.0.2.1");
		const hexMapped = await app.request("/", { headers: { "x-forwarded-for": "::ffff:c000:201" } });
		expect(await hexMapped.text()).toBe("192.0.2.1");
		const scoped = await app.request("/", { headers: { "x-forwarded-for": "fe80::1%eth0" } });
		expect(await scoped.text()).toBe("fe80::1");
		const invalid = await app.request(
			"/",
			{ headers: { "x-forwarded-for": "not-an-ip, 192.0.2.2" } },
			{ incoming: { socket: { remoteAddress: "192.0.2.3" } } },
		);
		expect(await invalid.text()).toBe("192.0.2.3");
		const missing = await app.request("/");
		expect(await missing.text()).toBe("unknown");
	});

	it("enforces independent IP and link write budgets across distinct IPs", async () => {
		const app = new Hono<AppEnv>();
		app.post("/:id", publicRateLimit(new PublicRateLimiter(), "share"), (context) =>
			context.text("ok"),
		);
		app.onError((error, context) => {
			if (!(error instanceof RelayError)) throw error;
			return context.text(error.message, error.httpStatus as 429);
		});
		for (let index = 0; index < 20; index++) {
			const response = await app.request("/same-link", {
				method: "POST",
				headers: { "x-forwarded-for": `192.0.2.${index}` },
			});
			expect(response.status).toBe(200);
		}
		const denied = await app.request("/same-link", {
			method: "POST",
			headers: { "x-forwarded-for": "192.0.2.100" },
		});
		expect(denied.status).toBe(429);
		expect(denied.headers.get("retry-after")).toBe("60");
		for (let index = 0; index < 10; index++) {
			const response = await app.request(`/other-link-${index}`, {
				method: "POST",
				headers: { "x-forwarded-for": "192.0.2.200" },
			});
			expect(response.status).toBe(200);
		}
		expect(
			(
				await app.request("/other-link-11", {
					method: "POST",
					headers: { "x-forwarded-for": "192.0.2.200" },
				})
			).status,
		).toBe(429);
	});
});
