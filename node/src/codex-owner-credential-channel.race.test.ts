import { afterEach, describe, expect, it, vi } from "vitest";
import { type CodexOwnerCredential, CodexOwnerCredentialError } from "./codex-owner-credential.js";

const readCredential = vi.hoisted(() => vi.fn());

vi.mock("./codex-owner-credential.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./codex-owner-credential.js")>()),
	readCodexOwnerCredentialFromOwnedFd: readCredential,
}));

import { CodexOwnerCredentialChannel } from "./codex-owner-credential-channel.js";

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	readCredential.mockReset();
});

describe("CodexOwnerCredentialChannel cancellation races", () => {
	it.each(["close", "deadline"] as const)(
		"lets %s cancel and dispose a credential produced before delivery",
		async (cause) => {
			const produced = deferred<CodexOwnerCredential>();
			const credential = recordingCredential();
			readCredential.mockReturnValueOnce(produced.promise);
			let retireCalls = 0;
			if (cause === "deadline") vi.useFakeTimers();
			const owner = new CodexOwnerCredentialChannel(
				{ fd: -1, testOnlyActivationTimeoutMs: 100 },
				() => {
					retireCalls += 1;
				},
			);
			const claimed = owner.claim(new AbortController().signal);
			const claimFailure = expect(claimed).rejects.toMatchObject({ reason: "cancelled" });
			const readerSignal = readCredential.mock.calls[0]?.[1] as AbortSignal;
			let closing: Promise<void> | null = null;

			if (cause === "close") closing = owner.close();
			else await vi.advanceTimersByTimeAsync(100);
			expect(readerSignal.aborted).toBe(true);
			produced.resolve(credential.value);

			await claimFailure;
			await expect(closing ?? owner.close()).resolves.toBeUndefined();
			expect(credential.dispose).toHaveBeenCalledOnce();
			expect(retireCalls).toBe(1);
		},
	);

	it.each(["close", "deadline"] as const)(
		"lets %s replace an undelivered read failure with fixed cancellation",
		async (cause) => {
			const produced = deferred<CodexOwnerCredential>();
			readCredential.mockReturnValueOnce(produced.promise);
			let retireCalls = 0;
			if (cause === "deadline") vi.useFakeTimers();
			const owner = new CodexOwnerCredentialChannel(
				{ fd: -1, testOnlyActivationTimeoutMs: 100 },
				() => {
					retireCalls += 1;
				},
			);
			const claimed = owner.claim(new AbortController().signal);
			const claimFailure = expect(claimed).rejects.toEqual(
				new CodexOwnerCredentialError("cancelled"),
			);
			let closing: Promise<void> | null = null;

			if (cause === "close") closing = owner.close();
			else await vi.advanceTimersByTimeAsync(100);
			produced.reject(new CodexOwnerCredentialError("channel"));

			await claimFailure;
			await expect(closing ?? owner.close()).resolves.toBeUndefined();
			expect(retireCalls).toBe(1);
		},
	);

	it("arms one refed timer and never resets it when reading starts", async () => {
		const produced = deferred<CodexOwnerCredential>();
		const credential = recordingCredential();
		readCredential.mockReturnValueOnce(produced.promise);
		const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
		const owner = new CodexOwnerCredentialChannel(
			{ fd: -1, testOnlyActivationTimeoutMs: 1_000 },
			() => undefined,
		);
		const timer = setTimeoutSpy.mock.results[0]?.value as NodeJS.Timeout;

		const claimed = owner.claim(new AbortController().signal);

		expect(setTimeoutSpy).toHaveBeenCalledOnce();
		expect(timer.hasRef()).toBe(true);
		produced.resolve(credential.value);
		const transferred = await claimed;
		transferred.dispose();
		expect(setTimeoutSpy).toHaveBeenCalledOnce();
		await owner.close();
	});
});

function recordingCredential() {
	const dispose = vi.fn();
	return {
		dispose,
		value: {
			use: async () => undefined,
			writeTo: async () => undefined,
			dispose,
		} satisfies CodexOwnerCredential,
	};
}

interface Deferred<T> {
	readonly promise: Promise<T>;
	resolve(value: T): void;
	reject(reason: unknown): void;
}

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((done, fail) => {
		resolve = done;
		reject = fail;
	});
	return { promise, reject, resolve };
}
