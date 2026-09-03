import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { Database } from "../db/client.js";
import { RelayError } from "../errors.js";
import { MailboxSignalHub } from "../events/mailbox-signal.js";
import type { AppEnv } from "../types.js";
import { registerMailboxEventStream } from "./mailbox-events-stream.js";

const AGENT = {
	id: "11111111-1111-4111-8111-111111111111",
	handle: "alice@acme",
	email: "alice@acme.com",
	role: "engineer",
	status: "active",
	apiKeyId: "22222222-2222-4222-8222-222222222222",
};

describe("mailbox event SSE hints", () => {
	it("emits only content-free readiness and recipient change hints", async () => {
		const source = notificationSource();
		const hub = new MailboxSignalHub(source);
		await hub.start();
		const credentials = credentialDb(() => true);
		const response = await buildApp(credentials.db, hub).request("/me/mailbox/events/stream");
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("text/event-stream");
		const reader = requiredReader(response);

		expect(await readChunk(reader)).toBe('event: ready\ndata: {"type":"ready"}\n\n');
		source.notify(AGENT.id);
		expect(await readChunk(reader)).toBe(
			'event: mailbox.changed\ndata: {"type":"mailbox.changed"}\n\n',
		);
		expect(credentials.limit).toHaveBeenCalledOnce();

		await hub.stop();
		expect((await readResult(reader)).done).toBe(true);
		expect(source.unlisten).toHaveBeenCalledOnce();
	});

	it("closes without emitting a change after the authenticated credential is revoked", async () => {
		let active = true;
		const source = notificationSource();
		const hub = new MailboxSignalHub(source);
		await hub.start();
		const credentials = credentialDb(() => active);
		const response = await buildApp(credentials.db, hub, 10).request("/me/mailbox/events/stream");
		const reader = requiredReader(response);
		expect(await readChunk(reader)).toContain('data: {"type":"ready"}');

		active = false;
		expect((await readResult(reader)).done).toBe(true);
		expect(credentials.limit).toHaveBeenCalledOnce();
		await hub.stop();
	});

	it("hub shutdown closes streams without waiting for a database round trip", async () => {
		const source = notificationSource();
		const hub = new MailboxSignalHub(source);
		await hub.start();
		const credentials = credentialDb(() => {
			throw new Error("credential lookup must not run during shutdown");
		});
		const response = await buildApp(credentials.db, hub).request("/me/mailbox/events/stream");
		const reader = requiredReader(response);
		expect(await readChunk(reader)).toContain('data: {"type":"ready"}');

		await hub.stop();
		expect((await readResult(reader)).done).toBe(true);
		expect(credentials.limit).not.toHaveBeenCalled();
	});

	it("caps concurrent streams per credential and releases the slot on abort", async () => {
		const source = notificationSource();
		const hub = new MailboxSignalHub(source);
		await hub.start();
		const credentials = credentialDb(() => true);
		const app = buildApp(credentials.db, hub);
		const firstReader = requiredReader(await app.request("/me/mailbox/events/stream"));
		const secondReader = requiredReader(await app.request("/me/mailbox/events/stream"));
		await Promise.all([readChunk(firstReader), readChunk(secondReader)]);

		const limited = await app.request("/me/mailbox/events/stream");
		expect(limited.status).toBe(429);
		expect(await limited.json()).toEqual({ code: "rate_limited" });

		await firstReader.cancel();
		const replacementReader = requiredReader(await app.request("/me/mailbox/events/stream"));
		expect(await readChunk(replacementReader)).toContain('data: {"type":"ready"}');

		await hub.stop();
		expect((await readResult(secondReader)).done).toBe(true);
		expect((await readResult(replacementReader)).done).toBe(true);
	});
});

function buildApp(db: Database, hub: MailboxSignalHub, heartbeatMs = 60_000): Hono<AppEnv> {
	const app = new Hono<AppEnv>();
	app.use("*", async (c, next) => {
		c.set("agent", AGENT);
		await next();
	});
	registerMailboxEventStream(app, { db, hub, heartbeatMs });
	app.onError((error, c) => {
		if (error instanceof RelayError) {
			return c.json({ code: error.code }, error.httpStatus as never);
		}
		throw error;
	});
	return app;
}

function notificationSource(): {
	listen: (
		channel: string,
		onNotify: (payload: string) => void,
		onListen?: () => void,
	) => Promise<{ unlisten: () => Promise<void> }>;
	notify: (payload: string) => void;
	unlisten: ReturnType<typeof vi.fn>;
} {
	let listener: (payload: string) => void = () => undefined;
	const unlisten = vi.fn(async () => undefined);
	return {
		listen: async (_channel, onNotify, onListen) => {
			listener = onNotify;
			onListen?.();
			return { unlisten };
		},
		notify: (payload) => listener(payload),
		unlisten,
	};
}

function credentialDb(isActive: () => boolean): {
	db: Database;
	limit: ReturnType<typeof vi.fn>;
} {
	const limit = vi.fn(async () =>
		isActive()
			? [
					{
						keyId: AGENT.apiKeyId,
					},
				]
			: [],
	);
	const db = {
		select: () => ({
			from: () => ({
				innerJoin: () => ({
					where: () => ({ limit }),
				}),
			}),
		}),
	} as unknown as Database;
	return { db, limit };
}

function requiredReader(response: Response): ReadableStreamDefaultReader<Uint8Array> {
	if (!response.body) throw new Error("expected SSE response body");
	return response.body.getReader();
}

async function readChunk(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
	const result = await readResult(reader);
	if (result.done || !result.value) throw new Error("SSE stream closed before the next event");
	return new TextDecoder().decode(result.value);
}

function readResult(
	reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<ReadableStreamReadResult<Uint8Array>> {
	return withTimeout(reader.read(), 1_000);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(
			() => reject(new Error("timed out waiting for SSE stream")),
			timeoutMs,
		);
		promise.then(
			(value) => {
				clearTimeout(timeout);
				resolve(value);
			},
			(error: unknown) => {
				clearTimeout(timeout);
				reject(error);
			},
		);
	});
}
