import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { shareLinkId } from "./share-publication.js";

const lifecycle = {
	link_id: shareLinkId,
	expires_at: z.string().datetime(),
	revoked_at: z.string().datetime().nullable(),
	content_deleted_at: z.string().datetime().nullable(),
};

const createReceipt = z.object({
	...lifecycle,
	url: z
		.string()
		.url()
		.refine((value) => {
			const url = new URL(value);
			return (
				["https:", "http:"].includes(url.protocol) &&
				!url.username &&
				!url.password &&
				!url.search &&
				!url.hash
			);
		}),
	replayed: z.boolean(),
});

const answerReceipt = z.object({
	link_id: shareLinkId,
	answer_id: z.string().uuid(),
	sequence: z.number().int().positive(),
	created_at: z.string().datetime(),
	replayed: z.boolean(),
});

const externalReply = z.object({
	reply_id: z.string().uuid(),
	sequence: z.number().int().positive(),
	channel: z.enum(["api", "form"]),
	content: z
		.string()
		.refine(
			(content) => Buffer.byteLength(content, "utf8") <= 16 * 1024 && !content.includes("\u0000"),
		)
		.nullable(),
	created_at: z.string().datetime(),
	released_at: z.string().datetime().nullable(),
	origin: z.literal("external_unverified"),
});

const repliesReceipt = z.object({
	...lifecycle,
	replies: z.array(externalReply).max(10),
});

const releaseReceipt = z.object({
	link_id: shareLinkId,
	reply_id: z.string().uuid(),
	released_at: z.string().datetime(),
	origin: z.literal("external_unverified"),
	replayed: z.boolean(),
});

export const shareCursor = z
	.string()
	.regex(/^(0|[1-9][0-9]{0,18})$/)
	.pipe(z.string().refine((value) => BigInt(value) <= 9223372036854775807n));

const inboxInput = z
	.object({
		after_cursor: shareCursor.default("0"),
		limit: z.number().int().min(1).max(10).default(10),
		since: z.string().datetime().optional(),
	})
	.strict();

export const shareInboxReceipt = z.object({
	replies: z
		.array(
			externalReply.extend({
				cursor: shareCursor,
				link_id: shareLinkId,
				released_at: z.string().datetime(),
			}),
		)
		.max(10),
	next_cursor: shareCursor,
	has_more: z.boolean(),
});

export interface ShareClient {
	create(
		content: string,
		expiresInDays: number,
		idempotencyKey: string,
	): Promise<z.infer<typeof createReceipt>>;
	answer(
		linkId: string,
		content: string,
		idempotencyKey: string,
	): Promise<z.infer<typeof answerReceipt>>;
	replies(linkId: string): Promise<z.infer<typeof repliesReceipt>>;
	release(replyId: string): Promise<z.infer<typeof releaseReceipt>>;
	inbox(input: z.input<typeof inboxInput>): Promise<z.infer<typeof shareInboxReceipt>>;
}

export function createShareClient(options: {
	relayUrl: string;
	apiKey: string;
	fetch?: typeof fetch;
	sleep?: (milliseconds: number) => Promise<void>;
}): ShareClient {
	const config = z
		.object({
			relayUrl: z
				.string()
				.url()
				.refine((value) => {
					const url = new URL(value);
					return (
						["https:", "http:"].includes(url.protocol) &&
						!url.username &&
						!url.password &&
						!url.search &&
						!url.hash
					);
				}),
			apiKey: z.string().min(1),
		})
		.safeParse(options);
	if (!config.success) throw new Error("share: invalid local Relay configuration.");
	const relayUrl = config.data.relayUrl.replace(/\/+$/, "");
	const apiKey = config.data.apiKey;
	const httpFetch = options.fetch ?? fetch;
	const sleep = options.sleep ?? delay;

	async function request<Receipt>(
		path: string,
		body: unknown,
		schema: z.ZodType<Receipt>,
		retryHint = "retry with the same preview token.",
	): Promise<Receipt> {
		const serialized = body === undefined ? undefined : JSON.stringify(body);
		for (let attempt = 0; attempt < 3; attempt++) {
			let response: Response;
			try {
				response = await httpFetch(`${relayUrl}${path}`, {
					method: body === undefined ? "GET" : "POST",
					headers: {
						authorization: `Bearer ${apiKey}`,
						"content-type": "application/json",
					},
					body: serialized,
					redirect: "error",
					signal: AbortSignal.timeout(15_000),
				});
			} catch {
				if (attempt < 2) {
					await sleep(100 * 4 ** attempt);
					continue;
				}
				throw new Error(`share: Relay request failed; ${retryHint}`);
			}
			if (response.status >= 500 && attempt < 2) {
				await response.body?.cancel().catch(() => undefined);
				await sleep(100 * 4 ** attempt);
				continue;
			}
			if (!response.ok) {
				await response.body?.cancel().catch(() => undefined);
				throw new Error(
					`share: Relay returned HTTP ${response.status}; no response content is shown.`,
				);
			}
			let parsed: z.SafeParseReturnType<unknown, Receipt>;
			try {
				const reader = response.body?.getReader();
				if (!reader) throw new Error("missing response body");
				const chunks: Uint8Array[] = [];
				let size = 0;
				try {
					while (true) {
						const chunk = await reader.read();
						if (chunk.done) break;
						size += chunk.value.byteLength;
						if (size > 1_000_000) {
							await reader.cancel();
							throw new Error("receipt too large");
						}
						chunks.push(chunk.value);
					}
				} finally {
					reader.releaseLock();
				}
				parsed = schema.safeParse(
					JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))),
				);
			} catch {
				throw new Error(`share: invalid Relay receipt; ${retryHint}`);
			}
			if (!parsed.success) throw new Error(`share: invalid Relay receipt; ${retryHint}`);
			return parsed.data;
		}
		throw new Error("share: Relay request failed.");
	}

	return {
		create: async (content, expiresInDays, idempotencyKey) => {
			const receipt = await request(
				"/shares",
				{ content, expires_in_days: expiresInDays, idempotency_key: idempotencyKey },
				createReceipt,
			);
			if (!new URL(receipt.url).pathname.endsWith(`/l/${receipt.link_id}`))
				throw new Error("share: invalid Relay link receipt.");
			return receipt;
		},
		answer: async (linkId, content, idempotencyKey) => {
			shareLinkId.parse(linkId);
			const receipt = await request(
				`/shares/${linkId}/answers`,
				{ content, idempotency_key: idempotencyKey },
				answerReceipt,
			);
			if (receipt.link_id !== linkId) throw new Error("share: invalid Relay answer receipt.");
			return receipt;
		},
		replies: async (linkId) => {
			shareLinkId.parse(linkId);
			const receipt = await request(`/shares/${linkId}/replies`, undefined, repliesReceipt);
			if (receipt.link_id !== linkId) throw new Error("share: invalid Relay replies receipt.");
			return receipt;
		},
		release: async (replyId) => {
			if (!z.string().uuid().safeParse(replyId).success) {
				throw new Error("share: invalid reply ID.");
			}
			const receipt = await request(
				`/shares/replies/${replyId}/release`,
				{ confirmation: "release_to_inbox" },
				releaseReceipt,
				"retry release of the same reply ID.",
			);
			if (receipt.reply_id !== replyId) throw new Error("share: invalid Relay release receipt.");
			return receipt;
		},
		inbox: async (input) => {
			const validated = inboxInput.safeParse(input);
			if (!validated.success) throw new Error("share: invalid local inbox query.");
			const parsed = validated.data;
			const query = new URLSearchParams({
				after_cursor: parsed.after_cursor,
				limit: String(parsed.limit),
			});
			if (parsed.since) query.set("since", parsed.since);
			const receipt = await request(
				`/shares/inbox?${query}`,
				undefined,
				shareInboxReceipt,
				"retry the same inbox read.",
			);
			let previous = BigInt(parsed.after_cursor);
			for (const reply of receipt.replies) {
				if (BigInt(reply.cursor) <= previous) throw new Error("share: invalid Relay inbox order.");
				previous = BigInt(reply.cursor);
			}
			if (
				receipt.next_cursor !== (receipt.replies.at(-1)?.cursor ?? parsed.after_cursor) ||
				receipt.replies.length > parsed.limit ||
				(receipt.has_more && receipt.replies.length !== parsed.limit)
			) {
				throw new Error("share: invalid Relay inbox cursor.");
			}
			return receipt;
		},
	};
}
