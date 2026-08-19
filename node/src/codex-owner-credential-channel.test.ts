import { execFile } from "node:child_process";
import { constants, type PathLike, close, fstatSync, open, write } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	CODEX_OWNER_CREDENTIAL_FD,
	CodexOwnerCredentialChannel,
} from "./codex-owner-credential-channel.js";
import { MAX_CODEX_OWNER_CREDENTIAL_BYTES } from "./codex-owner-credential.js";

const run = promisify(execFile);
const cleanupDirectories = new Set<string>();
const cleanupFds = new Set<number>();

afterEach(async () => {
	vi.useRealTimers();
	for (const fd of cleanupFds) await closeFd(fd).catch(() => undefined);
	cleanupFds.clear();
	for (const directory of cleanupDirectories) {
		await rm(directory, { recursive: true, force: true });
	}
	cleanupDirectories.clear();
});

describe("CodexOwnerCredentialChannel", () => {
	it("reserves inherited fd 3 for the internal owner credential channel", () => {
		expect(CODEX_OWNER_CREDENTIAL_FD).toBe(3);
	});

	it("claims a delayed maximum-size credential and transfers only after fd closure", async () => {
		const fixture = await openFifo();
		let retireCalls = 0;
		const owner = new CodexOwnerCredentialChannel(
			{ fd: fixture.reader, testOnlyActivationTimeoutMs: 1_000 },
			() => {
				retireCalls += 1;
			},
		);
		const credentialPromise = owner.claim(new AbortController().signal);
		const input = Buffer.alloc(MAX_CODEX_OWNER_CREDENTIAL_BYTES + 1, 0x61);
		input[input.length - 1] = 0x0a;
		await writeAll(fixture.writer, input.subarray(0, 4_096));
		await new Promise<void>((resolve) => setImmediate(resolve));
		await writeAll(fixture.writer, input.subarray(4_096));
		await closeTrackedFd(fixture.writer);

		const credential = await credentialPromise;
		expectFdClosed(fixture.reader);
		await credential.use(async (apiKey) => {
			expect(Buffer.byteLength(apiKey)).toBe(MAX_CODEX_OWNER_CREDENTIAL_BYTES);
		});
		await owner.close();
		expect(retireCalls).toBe(0);
	});

	it("destroys an unclaimed pending fd at the fixed non-resettable deadline", async () => {
		const fixture = await openFifo();
		let retireCalls = 0;
		vi.useFakeTimers();
		const owner = new CodexOwnerCredentialChannel(
			{ fd: fixture.reader, testOnlyActivationTimeoutMs: 100 },
			() => {
				retireCalls += 1;
			},
		);

		await vi.advanceTimersByTimeAsync(100);

		expectFdClosed(fixture.reader);
		expect(retireCalls).toBe(1);
		await owner.close();
		await owner.close();
		await vi.advanceTimersByTimeAsync(100);
		expect(retireCalls).toBe(1);
		await closeTrackedFd(fixture.writer);
	});

	it("lets a reading deadline abort the stream without raw-closing it twice", async () => {
		const fixture = await openFifo();
		let retireCalls = 0;
		vi.useFakeTimers();
		const owner = new CodexOwnerCredentialChannel(
			{ fd: fixture.reader, testOnlyActivationTimeoutMs: 100 },
			() => {
				retireCalls += 1;
			},
		);
		const claimed = owner.claim(new AbortController().signal);
		const claimFailure = expect(claimed).rejects.toMatchObject({ reason: "cancelled" });

		await vi.advanceTimersByTimeAsync(100);

		await claimFailure;
		expectFdClosed(fixture.reader);
		expect(retireCalls).toBe(1);
		await expect(owner.close()).resolves.toBeUndefined();
		await expect(owner.close()).resolves.toBeUndefined();
		expect(retireCalls).toBe(1);
		await closeTrackedFd(fixture.writer);
	});

	it("does not let a later deadline reclaim a successfully transferred credential", async () => {
		const fixture = await openFifo();
		let retireCalls = 0;
		vi.useFakeTimers();
		const owner = new CodexOwnerCredentialChannel(
			{ fd: fixture.reader, testOnlyActivationTimeoutMs: 100 },
			() => {
				retireCalls += 1;
			},
		);
		const claimed = owner.claim(new AbortController().signal);
		await writeAll(fixture.writer, Buffer.from("transferred-owner-key"));
		await closeTrackedFd(fixture.writer);
		const credential = await claimed;

		await vi.advanceTimersByTimeAsync(100);

		expectFdClosed(fixture.reader);
		expect(retireCalls).toBe(0);
		await credential.use(async (apiKey) => expect(apiKey).toBe("transferred-owner-key"));
		await owner.close();
	});

	it("aborts and awaits a reader before shutdown completes", async () => {
		const fixture = await openFifo();
		let retireCalls = 0;
		const owner = new CodexOwnerCredentialChannel(
			{ fd: fixture.reader, testOnlyActivationTimeoutMs: 1_000 },
			() => {
				retireCalls += 1;
			},
		);
		const claimed = owner.claim(new AbortController().signal);
		const claimFailure = expect(claimed).rejects.toMatchObject({ reason: "cancelled" });

		await owner.close();

		await claimFailure;
		expectFdClosed(fixture.reader);
		expect(retireCalls).toBe(1);
		await closeTrackedFd(fixture.writer);
	});

	it("retires exactly once when the inherited channel is invalid", async () => {
		let retireCalls = 0;
		const owner = new CodexOwnerCredentialChannel(
			{ fd: -1, testOnlyActivationTimeoutMs: 1_000 },
			() => {
				retireCalls += 1;
			},
		);

		await expect(owner.claim(new AbortController().signal)).rejects.toMatchObject({
			reason: "channel",
		});
		await owner.close();
		await owner.close();
		expect(retireCalls).toBe(1);
	});
});

async function openFifo(): Promise<{ reader: number; writer: number }> {
	const directory = await mkdtemp(join(tmpdir(), "agentrelay-owner-channel-test-"));
	cleanupDirectories.add(directory);
	const path = join(directory, "credential.pipe");
	await run("mkfifo", [path]);
	const [reader, writer] = await Promise.all([
		openFd(path, constants.O_RDONLY),
		openFd(path, constants.O_WRONLY),
	]);
	cleanupFds.add(reader);
	cleanupFds.add(writer);
	return { reader, writer };
}

function openFd(path: PathLike, flags: number): Promise<number> {
	return new Promise((resolve, reject) => {
		open(path, flags, (error, fd) => (error ? reject(error) : resolve(fd)));
	});
}

function closeFd(fd: number): Promise<void> {
	return new Promise((resolve, reject) => {
		close(fd, (error) => (error ? reject(error) : resolve()));
	});
}

async function closeTrackedFd(fd: number): Promise<void> {
	await closeFd(fd);
	cleanupFds.delete(fd);
}

async function writeAll(fd: number, bytes: Buffer): Promise<void> {
	let offset = 0;
	while (offset < bytes.length) {
		const written = await new Promise<number>((resolve, reject) => {
			write(fd, bytes, offset, bytes.length - offset, null, (error, count) =>
				error ? reject(error) : resolve(count),
			);
		});
		if (written === 0) throw new Error("FIFO write made no progress");
		offset += written;
	}
}

function expectFdClosed(fd: number): void {
	let error: unknown;
	try {
		fstatSync(fd);
	} catch (caught) {
		error = caught;
	}
	expect(error).toMatchObject({ code: "EBADF" });
	cleanupFds.delete(fd);
}
