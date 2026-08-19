import { closeSync } from "node:fs";
import {
	type CodexOwnerCredential,
	CodexOwnerCredentialError,
	readCodexOwnerCredentialFromOwnedFd,
} from "./codex-owner-credential.js";

export const CODEX_OWNER_CREDENTIAL_FD = 3;

const OWNER_CREDENTIAL_ACTIVATION_TIMEOUT_MS = 30_000;

export interface InheritedCodexOwnerCredentialChannel {
	readonly fd: number;
	/** Overrides the fixed production deadline in local tests only. */
	readonly testOnlyActivationTimeoutMs?: number;
}

/** Process-local owner for one inherited credential channel until it is claimed. */
export class CodexOwnerCredentialChannel {
	readonly #retire: () => void;
	readonly #timeout: NodeJS.Timeout;
	#fd: number | null;
	#state: "pending" | "reading" | "transferred" | "closed" = "pending";
	#readerAbort: AbortController | null = null;
	#reader: Promise<CodexOwnerCredential> | null = null;
	#readerCancelled = false;
	#closeFailure: CodexOwnerCredentialError | null = null;
	#retired = false;

	constructor(channel: InheritedCodexOwnerCredentialChannel, retire: () => void) {
		const timeoutMs = channel.testOnlyActivationTimeoutMs ?? OWNER_CREDENTIAL_ACTIVATION_TIMEOUT_MS;
		if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
			throw new Error("Codex owner credential activation timeout is invalid");
		}
		this.#fd = channel.fd;
		this.#retire = retire;
		// This deadline intentionally keeps the Capsule alive until the inherited secret
		// is either claimed or destroyed. It is armed once and is never extended by reads.
		this.#timeout = setTimeout(() => this.expire(), timeoutMs);
	}

	claim(signal: AbortSignal): Promise<CodexOwnerCredential> {
		if (this.#state !== "pending" || this.#fd === null) {
			return Promise.reject(new CodexOwnerCredentialError("unavailable"));
		}

		const fd = this.#fd;
		const readerAbort = new AbortController();
		this.#fd = null;
		this.#state = "reading";
		this.#readerAbort = readerAbort;

		// State ownership moves before the reader is invoked, so timeout and shutdown
		// can only abort the reader and can never raw-close an fd owned by its stream.
		const reader = readCodexOwnerCredentialFromOwnedFd(
			fd,
			AbortSignal.any([signal, readerAbort.signal]),
		);
		const tracked = reader
			.then(
				(credential) => {
					if (this.#readerCancelled) {
						credential.dispose();
						this.#state = "closed";
						this.retireOnce();
						throw new CodexOwnerCredentialError("cancelled");
					}
					this.#state = "transferred";
					return credential;
				},
				(error: unknown) => {
					this.#state = "closed";
					this.retireOnce();
					if (this.#readerCancelled) throw new CodexOwnerCredentialError("cancelled");
					throw error;
				},
			)
			.finally(() => {
				// The owned reader closes the fd before it settles.
				clearTimeout(this.#timeout);
				this.#readerAbort = null;
				this.#reader = null;
			});
		this.#reader = tracked;
		return tracked;
	}

	async close(): Promise<void> {
		if (this.#state === "pending") this.closePendingFd();
		if (this.#state === "reading") {
			this.#readerCancelled = true;
			this.#readerAbort?.abort();
		}
		await this.#reader?.catch(() => undefined);
		if (this.#closeFailure !== null) throw this.#closeFailure;
	}

	private expire(): void {
		if (this.#state === "pending") this.closePendingFd();
		else if (this.#state === "reading") {
			this.#readerCancelled = true;
			this.#readerAbort?.abort();
		} else return;
		this.retireOnce();
	}

	private closePendingFd(): void {
		if (this.#state !== "pending" || this.#fd === null) return;
		const fd = this.#fd;
		this.#fd = null;
		this.#state = "closed";
		try {
			closeSync(fd);
		} catch {
			this.#closeFailure = new CodexOwnerCredentialError("channel");
		} finally {
			clearTimeout(this.#timeout);
		}
	}

	private retireOnce(): void {
		if (this.#retired) return;
		this.#retired = true;
		this.#retire();
	}
}
