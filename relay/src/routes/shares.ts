import { Hono } from "hono";
import { bearerAuth } from "../auth/middleware.js";
import type { Database } from "../db/client.js";
import { RelayError } from "../errors.js";
import { PublicRateLimiter, publicRateLimit } from "../public-rate-limit.js";
import {
	answerShare,
	createShare,
	fetchShare,
	listShareReplies,
	postShareReply,
	revokeShare,
} from "../services/shares.js";
import {
	createShareSchema,
	shareAnswerSchema,
	shareIdSchema,
	shareReplySchema,
} from "../share-schemas.js";
import type { AppEnv } from "../types.js";
import {
	isKnownShareBot,
	renderShare,
	renderShareReplyReceipt,
	shareFormat,
} from "./share-render.js";

export interface ShareRoutesOptions {
	db: Database;
	pepper: string;
	publicUrl: string;
}

export function shareSecurityHeaders() {
	return {
		"Content-Security-Policy":
			"default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
		"X-Robots-Tag": "noindex, nofollow, noarchive",
		"X-Content-Type-Options": "nosniff",
		"Referrer-Policy": "no-referrer",
		"Cache-Control": "no-store",
		Vary: "Accept",
	};
}

export async function readShareBody(request: Request, maxBytes: number): Promise<string> {
	const reader = request.body?.getReader();
	if (!reader) throw new RelayError("invalid_params", "Body required");
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const chunk = await reader.read();
			if (chunk.done) break;
			size += chunk.value.byteLength;
			if (size > maxBytes) {
				await reader.cancel();
				throw new RelayError("invalid_params", "Body too large");
			}
			chunks.push(chunk.value);
		}
		return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
	} catch (error) {
		if (error instanceof RelayError) throw error;
		throw new RelayError("invalid_params", "Invalid request body");
	} finally {
		reader.releaseLock();
	}
}

function parseJson(body: string): unknown {
	try {
		return JSON.parse(body);
	} catch {
		throw new RelayError("invalid_params", "Invalid JSON body");
	}
}

function parseId(id: string): string {
	const parsed = shareIdSchema.safeParse(id);
	if (!parsed.success) throw new RelayError("thread_not_found", "Link unavailable");
	return parsed.data;
}

export function createPublicShareRoutes(opts: ShareRoutesOptions): Hono<AppEnv> {
	const router = new Hono<AppEnv>();
	router.use("*", async (context, next) => {
		for (const [name, value] of Object.entries(shareSecurityHeaders())) {
			context.header(name, value);
		}
		await next();
	});
	const admission = publicRateLimit(new PublicRateLimiter(), "share");
	router.get("/:id", admission, async (context) => {
		const id = parseId(context.req.param("id"));
		const format = shareFormat(context.req.header("accept"));
		const content = await fetchShare(
			opts.db,
			id,
			format,
			isKnownShareBot(context.req.header("user-agent")),
		);
		const body = renderShare(content, `${opts.publicUrl}/l/${id}/replies`, format);
		context.header("Content-Type", `text/${format}; charset=utf-8`);
		return context.body(body);
	});
	router.post("/:id/replies", admission, async (context) => {
		const id = parseId(context.req.param("id"));
		const contentType = context.req.header("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
		if (contentType !== "application/json" && contentType !== "application/x-www-form-urlencoded") {
			throw new RelayError("invalid_params", "Use JSON or the HTML reply form");
		}
		const body = await readShareBody(context.req.raw, 100_000);
		const channel = contentType === "application/json" ? "api" : "form";
		let input: unknown;
		if (channel === "api") {
			input = parseJson(body);
		} else {
			const form = new URLSearchParams(body);
			if (new Set(form.keys()).size !== Array.from(form.keys()).length) {
				throw new RelayError("invalid_params", "Duplicate form fields");
			}
			input = Object.fromEntries(form);
		}
		const parsed = shareReplySchema.safeParse(input);
		if (!parsed.success) throw new RelayError("invalid_params", "Invalid reply payload");
		const receipt = await postShareReply(
			opts.db,
			id,
			parsed.data,
			channel,
			context.get("requestId"),
		);
		const status = receipt.replayed ? 200 : 201;
		return channel === "api"
			? context.json(receipt, status)
			: context.html(renderShareReplyReceipt(), status);
	});
	return router;
}

export function createOwnerShareRoutes(opts: ShareRoutesOptions): Hono<AppEnv> {
	const router = new Hono<AppEnv>();
	router.use("*", bearerAuth({ db: opts.db, pepper: opts.pepper }));
	router.use("*", async (context, next) => {
		context.header("Cache-Control", "no-store");
		await next();
	});
	router.post("/", async (context) => {
		const sender = context.get("agent");
		if (!sender) throw new RelayError("unauthenticated", "Auth required");
		const body = await readShareBody(context.req.raw, 400_000);
		const parsed = createShareSchema.safeParse(parseJson(body));
		if (!parsed.success) throw new RelayError("invalid_params", "Invalid link payload");
		const receipt = await createShare(opts.db, sender.id, parsed.data, context.get("requestId"));
		return context.json(
			{ ...receipt, url: `${opts.publicUrl}/l/${receipt.link_id}` },
			receipt.replayed ? 200 : 201,
		);
	});
	router.post("/:id/revoke", async (context) => {
		const sender = context.get("agent");
		if (!sender) throw new RelayError("unauthenticated", "Auth required");
		const receipt = await revokeShare(
			opts.db,
			sender.id,
			parseId(context.req.param("id")),
			context.get("requestId"),
		);
		return context.json(receipt);
	});
	router.get("/:id/replies", async (context) => {
		const sender = context.get("agent");
		if (!sender) throw new RelayError("unauthenticated", "Auth required");
		return context.json(
			await listShareReplies(opts.db, sender.id, parseId(context.req.param("id"))),
		);
	});
	router.post("/:id/answers", async (context) => {
		const sender = context.get("agent");
		if (!sender) throw new RelayError("unauthenticated", "Auth required");
		const parsed = shareAnswerSchema.safeParse(
			parseJson(await readShareBody(context.req.raw, 100_000)),
		);
		if (!parsed.success) throw new RelayError("invalid_params", "Invalid answer payload");
		const receipt = await answerShare(
			opts.db,
			sender.id,
			parseId(context.req.param("id")),
			parsed.data,
			context.get("requestId"),
		);
		return context.json(receipt, receipt.replayed ? 200 : 201);
	});
	return router;
}
