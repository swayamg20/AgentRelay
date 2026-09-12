import { createConnection } from "node:net";
import { Agent, WebSocket } from "undici";
import { z } from "zod";
import { nativeCodexHeaders } from "./codex-socket.js";
import { LiveSessionError } from "./contracts.js";

const packetSchema = z.object({
	id: z.union([z.string(), z.number()]).optional(),
	method: z.string().optional(),
	params: z.unknown(),
	result: z.unknown(),
	error: z.unknown().optional(),
});

export class CodexLiveRpc {
	private readonly dispatcher;
	private readonly socket: WebSocket;
	private nextId = 1;
	private failure: Error | undefined;
	private readonly pending = new Map<
		number,
		{ resolve(value: unknown): void; reject(error: Error): void }
	>();
	private readonly ready: Promise<void>;
	onRequest: (method: string, params: unknown) => unknown = () => {
		throw new Error("No live turn");
	};
	onNotification: (method: string, params: unknown) => void = () => {};
	onFailure: (error: Error) => void = () => {};

	constructor(socketPath: string) {
		this.dispatcher = new Agent({
			connect: (_options, callback) => {
				const stream = createConnection(socketPath);
				const failed = (error: Error) => callback(error, null);
				stream.once("error", failed);
				stream.once("connect", () => {
					stream.removeListener("error", failed);
					callback(null, stream);
				});
				return stream;
			},
		}).compose(
			(dispatch) => (options, handler) =>
				dispatch({ ...options, headers: nativeCodexHeaders(options.headers) }, handler),
		);
		this.socket = new WebSocket("ws://localhost", { dispatcher: this.dispatcher });
		this.ready = new Promise<void>((resolve, reject) => {
			const timeout = setTimeout(() => {
				reject(this.error("handshake_timeout"));
				this.fail("handshake_timeout");
			}, 10_000);
			this.socket.addEventListener(
				"open",
				() => {
					clearTimeout(timeout);
					resolve();
				},
				{ once: true },
			);
			this.socket.addEventListener(
				"error",
				() => {
					clearTimeout(timeout);
					reject(this.error("transport_failed"));
				},
				{ once: true },
			);
			this.socket.addEventListener(
				"close",
				() => {
					clearTimeout(timeout);
					reject(this.error("transport_closed"));
				},
				{ once: true },
			);
		});
		void this.ready.catch(() => {});
		this.socket.addEventListener("error", () => this.fail("transport_failed"));
		this.socket.addEventListener("close", () => this.fail("transport_closed"));
		this.socket.addEventListener("message", (event) => {
			try {
				if (typeof event.data !== "string" || Buffer.byteLength(event.data) > 4 * 1024 * 1024)
					throw new Error("invalid frame");
				const packet = packetSchema.parse(JSON.parse(event.data));
				if (packet.method && packet.id !== undefined) {
					try {
						this.send({ id: packet.id, result: this.onRequest(packet.method, packet.params) });
					} catch {
						this.send({
							id: packet.id,
							error: { code: -32601, message: "Not permitted in this live session" },
						});
						this.fail("operation_denied");
					}
				} else if (typeof packet.id === "number") {
					const waiting = this.pending.get(packet.id);
					this.pending.delete(packet.id);
					if (packet.error !== undefined) waiting?.reject(this.error("rpc_rejected"));
					else waiting?.resolve(packet.result);
				} else if (packet.method) this.onNotification(packet.method, packet.params);
			} catch {
				this.fail("invalid_host_event");
			}
		});
	}

	async request(method: string, params: unknown): Promise<unknown> {
		await this.ready;
		if (this.failure) throw this.failure;
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => this.fail("rpc_timeout"), 30_000);
			this.pending.set(id, {
				resolve: (value) => {
					clearTimeout(timeout);
					resolve(value);
				},
				reject: (error) => {
					clearTimeout(timeout);
					reject(error);
				},
			});
			try {
				this.send({ id, method, params });
			} catch {
				this.fail("transport_failed");
			}
		});
	}

	notify(method: string, params: unknown) {
		this.send({ method, params });
	}

	fail(code: string) {
		if (this.failure) return;
		this.failure = this.error(code);
		for (const waiting of this.pending.values()) waiting.reject(this.failure);
		this.pending.clear();
		this.onFailure(this.failure);
	}

	async close() {
		this.fail("closed");
		this.socket.close();
		await this.dispatcher.destroy();
	}

	private send(packet: unknown) {
		this.socket.send(JSON.stringify(packet));
	}
	private error(code: string) {
		return new LiveSessionError(
			code,
			`Codex live connection stopped (${code}); upstream diagnostics were not logged`,
		);
	}
}
