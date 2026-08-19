import type { Writable } from "node:stream";
import { finished } from "node:stream/promises";
import { inspect } from "node:util";
import {
	type CodexOwnerCredential,
	CodexOwnerCredentialError,
} from "../src/codex-owner-credential.js";

const REDACTED_CREDENTIAL = "[CodexOwnerCredential redacted]";

export interface FakeCodexOwnerCredential extends CodexOwnerCredential {
	readonly useCount: number;
	readonly disposeCount: number;
}

export function createFakeCodexOwnerCredential(apiKey: string): FakeCodexOwnerCredential {
	return new PrivateFakeCodexOwnerCredential(Buffer.from(apiKey, "utf8"));
}

class PrivateFakeCodexOwnerCredential implements FakeCodexOwnerCredential {
	#bytes: Buffer | null;
	#useCount = 0;
	#disposeCount = 0;

	constructor(bytes: Buffer) {
		this.#bytes = bytes;
	}

	get useCount(): number {
		return this.#useCount;
	}

	get disposeCount(): number {
		return this.#disposeCount;
	}

	async use(operation: (apiKey: string) => Promise<void>): Promise<void> {
		const bytes = this.takeBytes();
		this.#useCount += 1;
		let apiKey = "";
		try {
			apiKey = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
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
			const settled = finished(destination, { readable: false, cleanup: true });
			destination.end(bytes);
			await settled;
		} finally {
			bytes.fill(0);
		}
	}

	dispose(): void {
		this.#disposeCount += 1;
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
