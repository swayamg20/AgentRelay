import { fetch as undiciFetch } from "undici";
import { z } from "zod";

const cursorSchema = z
	.string()
	.regex(/^[1-9][0-9]*$/)
	.max(19);
const replayLimitSchema = z.number().int().positive().max(200);
const mailboxEventSchema = z
	.object({
		event_id: z.string().uuid(),
		cursor: cursorSchema,
		kind: z.enum([
			"thread.created",
			"message.appended",
			"thread.accepted",
			"thread.completed",
			"thread.cancelled",
		]),
		thread_id: z.string().uuid(),
		actor_handle: z.string().min(1).max(120),
		created_at: z.string().datetime(),
	})
	.strict();

const mailboxEventPageSchema = z
	.object({
		events: z.array(mailboxEventSchema),
		next_cursor: cursorSchema.nullable(),
	})
	.strict();

const liveSignalSchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("ready") }).strict(),
	z.object({ type: z.literal("mailbox.changed") }).strict(),
	z.object({ type: z.literal("resync") }).strict(),
	z.object({ type: z.literal("heartbeat") }).strict(),
]);

export type MailboxEvent = z.infer<typeof mailboxEventSchema>;
export type MailboxEventPage = z.infer<typeof mailboxEventPageSchema>;
export type MailboxLiveSignal = z.infer<typeof liveSignalSchema>;

type Fetch = typeof undiciFetch;

export class MailboxEventHttpError extends Error {
	constructor(
		public readonly operation: string,
		public readonly status: number,
	) {
		super(`AgentRelay ${operation} failed with HTTP ${status}`);
		this.name = "MailboxEventHttpError";
	}
}

export interface MailboxEventClient {
	list(afterCursor: string | null, limit?: number, signal?: AbortSignal): Promise<MailboxEventPage>;
	stream(
		signal: AbortSignal,
		onSignal: (signal: MailboxLiveSignal) => Promise<void>,
	): Promise<void>;
}

export function createMailboxEventClient(opts: {
	relayUrl: string;
	apiKey: string;
	fetch?: Fetch;
}): MailboxEventClient {
	const relayUrl = new URL(opts.relayUrl).toString().replace(/\/$/, "");
	const fetchImpl = opts.fetch ?? undiciFetch;
	const headers = { authorization: `Bearer ${opts.apiKey}` };

	return {
		async list(afterCursor, limit, signal) {
			if (afterCursor !== null) cursorSchema.parse(afterCursor);
			const parsedLimit = replayLimitSchema.parse(limit ?? 100);
			const url = new URL(`${relayUrl}/agents/me/mailbox/events`);
			if (afterCursor !== null) url.searchParams.set("after_cursor", afterCursor);
			url.searchParams.set("limit", String(parsedLimit));
			const response = await fetchImpl(url, { headers, signal });
			if (!response.ok) throw await responseError("mailbox replay", response);
			return mailboxEventPageSchema.parse(await response.json());
		},

		async stream(signal, onSignal) {
			const response = await fetchImpl(`${relayUrl}/agents/me/mailbox/events/stream`, {
				headers: { ...headers, accept: "text/event-stream" },
				signal,
			});
			if (!response.ok) throw await responseError("mailbox stream", response);
			if (!response.body) throw new Error("AgentRelay mailbox stream returned no body");
			await consumeSse(response.body, onSignal);
		},
	};
}

export async function consumeSse(
	body: ReadableStream<Uint8Array>,
	onSignal: (signal: MailboxLiveSignal) => Promise<void>,
): Promise<void> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let dataLines: string[] = [];

	const dispatch = async () => {
		if (dataLines.length === 0) return;
		const raw = dataLines.join("\n");
		dataLines = [];
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			return;
		}
		const signal = liveSignalSchema.safeParse(parsed);
		if (signal.success) await onSignal(signal.data);
	};

	try {
		while (true) {
			const { done, value } = await reader.read();
			buffer += decoder.decode(value, { stream: !done });
			let newline = buffer.indexOf("\n");
			while (newline >= 0) {
				const line = buffer.slice(0, newline).replace(/\r$/, "");
				buffer = buffer.slice(newline + 1);
				if (line.length === 0) await dispatch();
				else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
				newline = buffer.indexOf("\n");
			}
			if (done) break;
		}
		if (buffer.length > 0) {
			const line = buffer.replace(/\r$/, "");
			if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
		}
		await dispatch();
	} finally {
		reader.releaseLock();
	}
}

async function responseError(operation: string, response: Response): Promise<Error> {
	await response.body?.cancel().catch(() => undefined);
	return new MailboxEventHttpError(operation, response.status);
}
