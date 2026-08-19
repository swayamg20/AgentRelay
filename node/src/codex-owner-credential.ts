import { type Stats, close, createReadStream, fstat } from "node:fs";
import { Socket } from "node:net";
import type { Readable, Writable } from "node:stream";
import { finished } from "node:stream/promises";
import { inspect } from "node:util";

export const MAX_CODEX_OWNER_CREDENTIAL_BYTES = 8 * 1_024;

export type CodexOwnerCredentialFailure =
	| "channel"
	| "cancelled"
	| "empty"
	| "oversized"
	| "malformed"
	| "unavailable"
	| "write";

const FAILURE_MESSAGES: Readonly<Record<CodexOwnerCredentialFailure, string>> = Object.freeze({
	channel: "Codex owner credential channel is invalid",
	cancelled: "Codex owner credential read was cancelled",
	empty: "Codex owner credential is empty",
	oversized: "Codex owner credential exceeds the byte limit",
	malformed: "Codex owner credential is malformed",
	unavailable: "Codex owner credential is unavailable",
	write: "Codex owner credential transfer failed",
});

const REDACTED_CREDENTIAL = "[CodexOwnerCredential redacted]";
const FATAL_UTF8_DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const UNICODE_CONTROL = /\p{Cc}/u;

export class CodexOwnerCredentialError extends Error {
	constructor(readonly reason: CodexOwnerCredentialFailure) {
		super(FAILURE_MESSAGES[reason]);
		this.name = "CodexOwnerCredentialError";
	}
}

export interface CodexOwnerCredential {
	/** Makes the API key available only for the duration of one trusted operation. */
	use(operation: (apiKey: string) => Promise<void>): Promise<void>;
	/** Transfers the credential once and owns, ends, and settles the destination. */
	writeTo(destination: Writable): Promise<void>;
	dispose(): void;
}

/**
 * Takes ownership of an already-open inherited pipe channel and closes it on every outcome.
 * Node may represent that channel as a FIFO or Unix socket; files, TTYs, and devices are rejected.
 */
export async function readCodexOwnerCredentialFromOwnedFd(
	fd: number,
	signal: AbortSignal,
): Promise<CodexOwnerCredential> {
	const encoded = await readOwnedCredentialChannel(fd, signal);
	try {
		const credentialLength = encoded.at(-1) === 0x0a ? encoded.length - 1 : encoded.length;
		if (credentialLength === 0) throw new CodexOwnerCredentialError("empty");
		if (credentialLength > MAX_CODEX_OWNER_CREDENTIAL_BYTES) {
			throw new CodexOwnerCredentialError("oversized");
		}

		const credentialBytes = encoded.subarray(0, credentialLength);
		let decoded: string;
		try {
			decoded = FATAL_UTF8_DECODER.decode(credentialBytes);
		} catch {
			throw new CodexOwnerCredentialError("malformed");
		}
		if (UNICODE_CONTROL.test(decoded)) {
			throw new CodexOwnerCredentialError("malformed");
		}

		return new PrivateCodexOwnerCredential(Buffer.from(credentialBytes));
	} finally {
		encoded.fill(0);
	}
}

class PrivateCodexOwnerCredential implements CodexOwnerCredential {
	#bytes: Buffer | null;

	constructor(bytes: Buffer) {
		this.#bytes = bytes;
	}

	async use(operation: (apiKey: string) => Promise<void>): Promise<void> {
		const bytes = this.takeBytes();
		let apiKey = "";
		try {
			// JSON-RPC requires a JS string; keeping it callback-scoped avoids retaining another copy.
			apiKey = FATAL_UTF8_DECODER.decode(bytes);
			bytes.fill(0);
			await operation(apiKey);
		} finally {
			apiKey = "";
			bytes.fill(0);
		}
	}

	async writeTo(destination: Writable): Promise<void> {
		const bytes = this.takeBytes();
		try {
			await endWritable(destination, bytes);
		} finally {
			bytes.fill(0);
		}
	}

	dispose(): void {
		this.#bytes?.fill(0);
		this.#bytes = null;
	}

	toString(): string {
		return REDACTED_CREDENTIAL;
	}

	toJSON(): string {
		return REDACTED_CREDENTIAL;
	}

	[Symbol.toPrimitive](): string {
		return REDACTED_CREDENTIAL;
	}

	[inspect.custom](): string {
		return REDACTED_CREDENTIAL;
	}

	private takeBytes(): Buffer {
		if (this.#bytes === null) throw new CodexOwnerCredentialError("unavailable");
		const bytes = this.#bytes;
		this.#bytes = null;
		return bytes;
	}
}

function readOwnedCredentialChannel(fd: number, signal: AbortSignal): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		if (!Number.isSafeInteger(fd) || fd < 0 || fd > 0x7fffffff) {
			reject(new CodexOwnerCredentialError("channel"));
			return;
		}

		const collected = Buffer.alloc(MAX_CODEX_OWNER_CREDENTIAL_BYTES + 1);
		let collectedBytes = 0;
		let reader: Readable | null = null;
		let ended = false;
		let settled = false;
		let closingFd = false;
		let failure: CodexOwnerCredentialFailure | null = null;

		const settle = (result?: Buffer) => {
			if (settled) return;
			settled = true;
			signal.removeEventListener("abort", onAbort);
			if (result === undefined) collected.fill(0);
			if (failure === null && result !== undefined) resolve(result);
			else reject(new CodexOwnerCredentialError(failure ?? "channel"));
		};

		const closeBeforeReader = (reason: CodexOwnerCredentialFailure) => {
			if (closingFd || settled) return;
			closingFd = true;
			failure = reason;
			try {
				close(fd, () => settle());
			} catch {
				settle();
			}
		};

		const onAbort = () => {
			failure = "cancelled";
			if (reader === null) closeBeforeReader("cancelled");
			else reader.destroy();
		};

		signal.addEventListener("abort", onAbort, { once: true });
		if (signal.aborted) {
			onAbort();
			return;
		}
		const onStats = (error: NodeJS.ErrnoException | null, stats: Stats) => {
			if (settled || closingFd) return;
			if (error !== null) {
				closeBeforeReader("channel");
				return;
			}
			if (signal.aborted) {
				closeBeforeReader("cancelled");
				return;
			}
			if (!stats.isFIFO() && !stats.isSocket()) {
				closeBeforeReader("channel");
				return;
			}

			try {
				reader = openCredentialReader(fd, stats);
			} catch {
				closeBeforeReader("channel");
				return;
			}

			reader.on("data", (chunk: Buffer) => {
				if (!Buffer.isBuffer(chunk)) {
					failure = "channel";
					reader?.destroy();
					return;
				}
				if (failure !== null) {
					chunk.fill(0);
					return;
				}
				if (collectedBytes + chunk.length > MAX_CODEX_OWNER_CREDENTIAL_BYTES + 1) {
					chunk.fill(0);
					failure = "oversized";
					reader?.destroy();
					return;
				}
				chunk.copy(collected, collectedBytes);
				collectedBytes += chunk.length;
				chunk.fill(0);
			});
			reader.once("end", () => {
				ended = true;
			});
			reader.once("error", () => {
				failure ??= signal.aborted ? "cancelled" : "channel";
			});
			reader.once("close", () => {
				if (failure !== null || !ended) {
					settle();
					return;
				}
				const result = Buffer.from(collected.subarray(0, collectedBytes));
				collected.fill(0);
				settle(result);
			});
		};
		try {
			fstat(fd, onStats);
		} catch {
			closeBeforeReader("channel");
		}
	});
}

function openCredentialReader(fd: number, stats: Stats): Readable {
	if (stats.isSocket()) return new Socket({ fd, readable: true, writable: false });
	return createReadStream("", {
		fd,
		autoClose: true,
		highWaterMark: MAX_CODEX_OWNER_CREDENTIAL_BYTES + 2,
	});
}

async function endWritable(destination: Writable, bytes: Buffer): Promise<void> {
	const closeObserved = writableClose(destination);
	let completion: Promise<void>;
	try {
		completion = finished(destination, { readable: false, cleanup: true });
	} catch {
		destroyWritable(destination);
		await closeObserved;
		throw new CodexOwnerCredentialError("write");
	}
	try {
		destination.end(bytes);
		await completion;
		if (!destination.closed) destroyWritable(destination);
		await closeObserved;
	} catch {
		destroyWritable(destination);
		await completion.catch(() => undefined);
		await closeObserved;
		throw new CodexOwnerCredentialError("write");
	}
}

function writableClose(destination: Writable): Promise<void> {
	if (destination.closed) return Promise.resolve();
	return new Promise((resolve) => destination.once("close", resolve));
}

function destroyWritable(destination: Writable): void {
	try {
		if (!destination.destroyed) destination.destroy();
	} catch {
		// The fixed transfer error below remains the only downstream failure surface.
	}
}
