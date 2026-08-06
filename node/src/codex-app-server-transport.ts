import { z } from "zod";
import { BoundedAsyncQueue } from "./bounded-async-queue.js";
import {
	type CodexAppServerCommand,
	CodexAppServerError,
	type CodexAppServerProcess,
	readCodexLines,
	startCodexAppServerProcess,
	stopCodexAppServerProcess,
	writeCodexFrame,
} from "./codex-app-server-process.js";
import type { CodexServerMessage } from "./codex-app-server-protocol.js";
import { parseCodexServerMessage } from "./codex-app-server-protocol.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const MAX_QUEUED_EVENTS = 1_024;
const MAX_QUEUED_EVENT_BYTES = 32 * 1_048_576;

export interface CodexAppServerTransportOptions {
	readonly command: CodexAppServerCommand;
	readonly cwd: string;
	readonly env: NodeJS.ProcessEnv;
	readonly requestTimeoutMs?: number;
	readonly handleServerRequest: (request: CodexServerRequest) => CodexServerRequestDecision;
}

export interface CodexServerRequest {
	readonly id: string | number;
	readonly method: string;
	readonly params: unknown;
}

export type CodexServerRequestDecision =
	| { readonly kind: "result"; readonly value: unknown; readonly fatal?: Error }
	| {
			readonly kind: "error";
			readonly code: number;
			readonly message: string;
			readonly fatal?: Error;
	  };

export interface CodexAppServerEvent {
	readonly kind: "notification";
	readonly method: string;
	readonly params: unknown;
}

interface PendingRequest {
	readonly method: string;
	readonly resolve: (value: unknown) => void;
	readonly reject: (error: Error) => void;
	readonly timeout: NodeJS.Timeout;
}

export class CodexAppServerResponseError extends CodexAppServerError {
	constructor(
		readonly method: string,
		readonly code: number,
		readonly data: unknown,
		message: string,
	) {
		super("provider", `Codex app-server method ${method} failed (${code}): ${message}`);
		this.name = "CodexAppServerResponseError";
	}
}

/** Correlated, bounded JSONL transport for one version-pinned app-server process. */
export class CodexAppServerTransport {
	readonly #process: CodexAppServerProcess;
	readonly #requestTimeoutMs: number;
	readonly #handleServerRequest: CodexAppServerTransportOptions["handleServerRequest"];
	readonly #events = new BoundedAsyncQueue<CodexAppServerEvent>(
		MAX_QUEUED_EVENTS,
		MAX_QUEUED_EVENT_BYTES,
		() => new CodexAppServerError("protocol", "Codex event queue exceeded its bound"),
	);
	readonly #pending = new Map<number, PendingRequest>();
	#nextRequestId = 0;
	#writeTail: Promise<void> = Promise.resolve();
	#failure: Error | null = null;
	#closing = false;

	private constructor(
		processRef: CodexAppServerProcess,
		requestTimeoutMs: number,
		handleServerRequest: CodexAppServerTransportOptions["handleServerRequest"],
	) {
		this.#process = processRef;
		this.#requestTimeoutMs = requestTimeoutMs;
		this.#handleServerRequest = handleServerRequest;
		void this.readLoop();
		void processRef.inputError.then((error) => {
			if (!this.#closing && this.#failure === null) {
				this.fail(
					new CodexAppServerError("transport", "Cannot write to Codex app-server", {
						cause: error,
					}),
				);
			}
		});
		void processRef.exited.then(() => {
			if (!this.#closing && this.#failure === null) {
				void stopCodexAppServerProcess(processRef).catch((error) =>
					this.fail(error instanceof Error ? error : new Error(String(error))),
				);
			}
		});
	}

	static async start(options: CodexAppServerTransportOptions): Promise<CodexAppServerTransport> {
		const requestTimeoutMs = z
			.number()
			.int()
			.min(100)
			.max(120_000)
			.parse(options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
		const processRef = await startCodexAppServerProcess(options);
		return new CodexAppServerTransport(processRef, requestTimeoutMs, options.handleServerRequest);
	}

	get cwd(): string {
		return this.#process.cwd;
	}

	request(method: string, params: unknown): Promise<unknown> {
		this.assertOpen();
		const id = this.#nextRequestId;
		this.#nextRequestId += 1;
		const response = new Promise<unknown>((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.#pending.delete(id);
				const error = new CodexAppServerError(
					"transport",
					`Timed out waiting for Codex app-server method ${method}`,
				);
				reject(error);
				this.fail(error);
			}, this.#requestTimeoutMs);
			this.#pending.set(id, { method, resolve, reject, timeout });
		});
		void this.send({ method, id, params }).catch((error) => {
			const pending = this.#pending.get(id);
			if (pending === undefined) return;
			clearTimeout(pending.timeout);
			this.#pending.delete(id);
			pending.reject(error instanceof Error ? error : new Error(String(error)));
		});
		return response;
	}

	sendNotification(method: string, params?: unknown): Promise<void> {
		return this.send(params === undefined ? { method } : { method, params });
	}

	events(): AsyncIterable<CodexAppServerEvent> {
		return this.#events;
	}

	async close(): Promise<void> {
		if (this.#closing) {
			await stopCodexAppServerProcess(this.#process);
			return;
		}
		this.#closing = true;
		this.rejectPending(new CodexAppServerError("closed", "Codex app-server transport closed"));
		this.#events.close();
		await stopCodexAppServerProcess(this.#process);
	}

	private async send(message: unknown): Promise<void> {
		this.assertOpen();
		const write = this.#writeTail.then(() => writeCodexFrame(this.#process.child.stdin, message));
		this.#writeTail = write.catch(() => undefined);
		try {
			await write;
		} catch (error) {
			const failure = new CodexAppServerError("transport", "Cannot write to Codex app-server", {
				cause: error,
			});
			this.fail(failure);
			throw failure;
		}
	}

	private async readLoop(): Promise<void> {
		try {
			for await (const line of readCodexLines(this.#process.child.stdout)) {
				await this.handleMessage(
					parseCodexServerMessage(JSON.parse(line)),
					Buffer.byteLength(line, "utf8"),
				);
			}
			if (!this.#closing && this.#failure === null) {
				const { exitCode: code, signalCode: signal } = this.#process.child;
				throw new CodexAppServerError(
					"transport",
					code === null && signal === null
						? "Codex app-server output ended before the process exited"
						: `Codex app-server exited unexpectedly (code=${code}, signal=${signal})`,
				);
			}
		} catch (error) {
			if (this.#closing) return;
			this.fail(
				error instanceof CodexAppServerError
					? error
					: new CodexAppServerError("protocol", "Invalid Codex app-server response", {
							cause: error,
						}),
			);
		}
	}

	private async handleMessage(message: CodexServerMessage, frameBytes: number): Promise<void> {
		switch (message.kind) {
			case "response":
				this.settleResponse(message.id, message.result);
				return;
			case "response_error":
				this.settleResponse(message.id, undefined, message.error);
				return;
			case "notification":
				this.#events.push(
					{ kind: "notification", method: message.method, params: message.params },
					frameBytes,
				);
				return;
			case "request":
				await this.handleServerRequest(message);
		}
	}

	private async handleServerRequest(request: CodexServerRequest): Promise<void> {
		const decision = this.#handleServerRequest(request);
		await this.send(
			decision.kind === "result"
				? { id: request.id, result: decision.value }
				: { id: request.id, error: { code: decision.code, message: decision.message } },
		);
		if (decision.fatal !== undefined) throw decision.fatal;
	}

	private settleResponse(
		id: string | number,
		result: unknown,
		error?: { readonly code: number; readonly message: string; readonly data?: unknown },
	): void {
		if (typeof id !== "number") {
			throw new CodexAppServerError("protocol", "Codex response used an unexpected string ID");
		}
		const pending = this.#pending.get(id);
		if (pending === undefined) {
			throw new CodexAppServerError("protocol", `Codex response has unknown request ID ${id}`);
		}
		clearTimeout(pending.timeout);
		this.#pending.delete(id);
		if (error === undefined) {
			pending.resolve(result);
			return;
		}
		pending.reject(
			new CodexAppServerResponseError(pending.method, error.code, error.data, error.message),
		);
	}

	private fail(error: Error): void {
		if (this.#failure !== null) return;
		this.#failure = error;
		this.rejectPending(error);
		this.#events.close(error);
		void stopCodexAppServerProcess(this.#process).catch(() => undefined);
	}

	private rejectPending(error: Error): void {
		for (const pending of this.#pending.values()) {
			clearTimeout(pending.timeout);
			pending.reject(error);
		}
		this.#pending.clear();
	}

	private assertOpen(): void {
		if (this.#failure !== null) throw this.#failure;
		if (this.#closing) throw new CodexAppServerError("closed", "Codex transport is closed");
	}
}
