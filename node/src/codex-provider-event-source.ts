import type { CodexAppServerClientEvent } from "./codex-app-server-client.js";
import type { CodexCapsuleClient } from "./codex-capsule-runner-contract.js";
import { raceWithUnrefTimeout } from "./unref-timer.js";

export type CodexProviderEventPoll =
	| { readonly kind: "event"; readonly event: CodexAppServerClientEvent }
	| { readonly kind: "timeout" }
	| { readonly kind: "done" };

/** Owns the one allowed provider notification consumer for a Capsule generation. */
export class CodexProviderEventSource {
	readonly #events: AsyncIterator<CodexAppServerClientEvent>;
	#pending: Promise<IteratorResult<CodexAppServerClientEvent>> | null;

	constructor(client: CodexCapsuleClient) {
		this.#events = client.events()[Symbol.asyncIterator]();
		this.#pending = this.readNext();
	}

	async poll(timeoutMs: number, signal?: AbortSignal): Promise<CodexProviderEventPoll> {
		const pending = this.#pending;
		if (pending === null) return { kind: "done" };
		const result = await raceWithUnrefTimeout(pending, timeoutMs, signal);
		if (result.kind === "timeout") return result;
		if (result.value.done) {
			this.#pending = null;
			return { kind: "done" };
		}
		this.#pending = this.readNext();
		return { kind: "event", event: result.value.value };
	}

	async close(): Promise<void> {
		await this.#events.return?.();
	}

	private readNext(): Promise<IteratorResult<CodexAppServerClientEvent>> {
		const pending = this.#events.next();
		void pending.catch(() => undefined);
		return pending;
	}
}
