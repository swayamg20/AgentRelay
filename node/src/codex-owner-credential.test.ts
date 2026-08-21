import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { constants, type PathLike, close, fstatSync, open, write } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { inspect, promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	CodexOwnerCredentialError,
	MAX_CODEX_OWNER_CREDENTIAL_BYTES,
	readCodexOwnerCredentialFromOwnedFd,
	readCodexOwnerCredentialSourceFromOwnedFd,
} from "./codex-owner-credential.js";

const run = promisify(execFile);
const cleanupDirectories = new Set<string>();
const cleanupFds = new Set<number>();

afterEach(async () => {
	vi.restoreAllMocks();
	for (const fd of cleanupFds) await closeFd(fd).catch(() => undefined);
	cleanupFds.clear();
	for (const directory of cleanupDirectories) {
		await rm(directory, { recursive: true, force: true });
	}
	cleanupDirectories.clear();
});

describe("Codex owner credential", () => {
	it("reads an opaque non-prefixed key, closes its channel, and redacts inspection", async () => {
		const secret = "owner key without provider prefix";
		const fixture = await openFifo();
		const credentialPromise = readCodexOwnerCredentialFromOwnedFd(
			fixture.reader,
			new AbortController().signal,
		);
		await writeAll(fixture.writer, Buffer.from(secret));
		await closeTrackedFd(fixture.writer);

		const credential = await credentialPromise;
		expectFdClosed(fixture.reader);
		let observed = "";
		await credential.use(async (apiKey) => {
			observed = apiKey;
		});
		expect(observed).toBe(secret);
		expect(String(credential)).toBe("[CodexOwnerCredential redacted]");
		expect(`${credential}`).toBe("[CodexOwnerCredential redacted]");
		expect(JSON.stringify(credential)).toBe('"[CodexOwnerCredential redacted]"');
		expect(inspect(credential)).toBe("[CodexOwnerCredential redacted]");
		for (const rendered of [String(credential), JSON.stringify(credential), inspect(credential)]) {
			expect(rendered).not.toContain(secret);
		}
		credential.dispose();
	});

	it("accepts one terminal LF without trimming any other bytes", async () => {
		const secret = "  exact opaque key  ";
		const fixture = await openFifo();
		const credentialPromise = readCodexOwnerCredentialFromOwnedFd(
			fixture.reader,
			new AbortController().signal,
		);
		const encoded = Buffer.from(`${secret}\n`);
		for (const chunk of [encoded.subarray(0, 3), encoded.subarray(3, 11), encoded.subarray(11)]) {
			await writeAll(fixture.writer, chunk);
			await new Promise<void>((resolve) => setImmediate(resolve));
		}
		await closeTrackedFd(fixture.writer);

		const credential = await credentialPromise;
		expectFdClosed(fixture.reader);
		await credential.use(async (apiKey) => expect(apiKey).toBe(secret));
		credential.dispose();
	});

	it("preserves a UTF-8 key whose code point arrives across writes", async () => {
		const secret = "opaque-λ-key";
		const encoded = Buffer.from(secret);
		const split = encoded.indexOf(0xce) + 1;
		const fixture = await openFifo();
		const credentialPromise = readCodexOwnerCredentialFromOwnedFd(
			fixture.reader,
			new AbortController().signal,
		);
		await writeAll(fixture.writer, encoded.subarray(0, split));
		await new Promise<void>((resolve) => setImmediate(resolve));
		await writeAll(fixture.writer, encoded.subarray(split));
		await closeTrackedFd(fixture.writer);

		const credential = await credentialPromise;
		expectFdClosed(fixture.reader);
		await credential.use(async (apiKey) => expect(apiKey).toBe(secret));
		credential.dispose();
	});

	it("preserves a leading UTF-8 BOM as part of the opaque key", async () => {
		const secret = "\ufeffopaque-key";
		const credential = await credentialFromBytes(Buffer.from(secret));

		await credential.use(async (apiKey) => expect(apiKey).toBe(secret));
	});

	it.each([
		["empty input", Buffer.alloc(0), "empty"],
		["only a terminal LF", Buffer.from("\n"), "empty"],
		["an embedded LF", Buffer.from("opaque\nkey"), "malformed"],
		["two terminal LFs", Buffer.from("opaque\n\n"), "malformed"],
		["CRLF", Buffer.from("opaque\r\n"), "malformed"],
		["a NUL", Buffer.from("opaque\0key"), "malformed"],
		["an ASCII control", Buffer.from("opaque\u001fkey"), "malformed"],
		["a Unicode control", Buffer.from("opaque\u0085key"), "malformed"],
		["invalid UTF-8", Buffer.from([0x6b, 0x65, 0x79, 0xc3, 0x28]), "malformed"],
	] as const)("rejects %s and closes the owned channel", async (_label, input, reason) => {
		const fixture = await openFifo();
		const credentialPromise = readCodexOwnerCredentialFromOwnedFd(
			fixture.reader,
			new AbortController().signal,
		);
		if (input.length > 0) await writeAll(fixture.writer, input);
		await closeTrackedFd(fixture.writer);

		await expect(credentialPromise).rejects.toMatchObject({
			name: "CodexOwnerCredentialError",
			reason,
		});
		expectFdClosed(fixture.reader);
	});

	it("rejects an oversized key, closes the channel, and does not echo it", async () => {
		const secretFragment = "do-not-echo-this-key";
		const input = Buffer.alloc(MAX_CODEX_OWNER_CREDENTIAL_BYTES + 1, 0x61);
		input.set(secretFragment);
		const fixture = await openFifo();
		const credentialPromise = readCodexOwnerCredentialFromOwnedFd(
			fixture.reader,
			new AbortController().signal,
		);
		await writeAll(fixture.writer, input);
		await closeTrackedFd(fixture.writer);

		const error = await captureFailure(credentialPromise);
		expect(error).toMatchObject({ reason: "oversized" });
		expect(inspect(error)).not.toContain(secretFragment);
		expectFdClosed(fixture.reader);
	});

	it("stops a channel as soon as it exceeds the bounded envelope", async () => {
		const input = Buffer.alloc(MAX_CODEX_OWNER_CREDENTIAL_BYTES + 2, 0x61);
		const fixture = await openFifo();
		const credentialPromise = readCodexOwnerCredentialFromOwnedFd(
			fixture.reader,
			new AbortController().signal,
		);
		await writeAll(fixture.writer, input);

		await expect(credentialPromise).rejects.toMatchObject({ reason: "oversized" });
		expectFdClosed(fixture.reader);
		await closeTrackedFd(fixture.writer);
	});

	it("accepts the maximum key size plus its optional terminal LF", async () => {
		const input = Buffer.alloc(MAX_CODEX_OWNER_CREDENTIAL_BYTES + 1, 0x61);
		input[input.length - 1] = 0x0a;
		const fixture = await openFifo();
		const credentialPromise = readCodexOwnerCredentialFromOwnedFd(
			fixture.reader,
			new AbortController().signal,
		);
		await writeAll(fixture.writer, input);
		await closeTrackedFd(fixture.writer);

		const credential = await credentialPromise;
		expectFdClosed(fixture.reader);
		await credential.use(async (apiKey) => {
			expect(Buffer.byteLength(apiKey)).toBe(MAX_CODEX_OWNER_CREDENTIAL_BYTES);
		});
	});

	it("rejects regular files, directories, and non-TTY character devices", async () => {
		const directory = await privateTempDirectory();
		const file = join(directory, "credential.txt");
		await writeFile(file, "never-read-secret", { mode: 0o600 });
		const nestedDirectory = join(directory, "nested");
		await mkdir(nestedDirectory);

		for (const path of [file, nestedDirectory, "/dev/null"]) {
			const fd = await openFd(path, constants.O_RDONLY);
			cleanupFds.add(fd);
			await expect(
				readCodexOwnerCredentialFromOwnedFd(fd, new AbortController().signal),
			).rejects.toMatchObject({ reason: "channel" });
			expectFdClosed(fd);
			cleanupFds.delete(fd);
		}
	});

	it("reads and closes the exact inherited child fd pipe shape", async () => {
		const secret = "lazy-inherited-owner-key";
		const expectedDigest = createHash("sha256").update(secret).digest("hex");
		const credential = await credentialFromBytes(Buffer.from(secret));
		const sourceUrl = new URL("./codex-owner-credential.ts", import.meta.url).href;
		const childSource = `
			import { createHash } from "node:crypto";
			import { fstatSync } from "node:fs";
			import { readCodexOwnerCredentialFromOwnedFd } from ${JSON.stringify(sourceUrl)};
			await new Promise((resolve, reject) => {
				process.once("message", (message) =>
					message === "activate" ? resolve() : reject(new Error("Unexpected activation")),
				);
			});
			process.disconnect();
			const inherited = fstatSync(3);
			if (!inherited.isFIFO() && !inherited.isSocket()) process.exitCode = 2;
			const credential = await readCodexOwnerCredentialFromOwnedFd(3, new AbortController().signal);
			let digest = "";
			await credential.use(async (apiKey) => {
				digest = createHash("sha256").update(apiKey).digest("hex");
			});
			try {
				fstatSync(3);
				process.exitCode = 3;
			} catch (error) {
				if (error?.code !== "EBADF") process.exitCode = 4;
			}
			process.stdout.write(digest + "\\n");
		`;
		const childEnvironment = { ...process.env };
		const child = spawn(
			process.execPath,
			["--import", "tsx", "--input-type=module", "-e", childSource],
			{
				cwd: fileURLToPath(new URL("..", import.meta.url)),
				env: childEnvironment,
				stdio: ["ignore", "pipe", "pipe", "pipe", "ipc"],
			},
		);
		const credentialPipe = child.stdio[3];
		if (!(credentialPipe instanceof Writable) || child.stdout === null || child.stderr === null) {
			throw new Error("Expected inherited child pipes");
		}
		const stdout = collectUtf8(child.stdout);
		const stderr = collectUtf8(child.stderr);
		expect(child.spawnargs.join("\0")).not.toContain(secret);
		expect(Object.values(childEnvironment).join("\0")).not.toContain(secret);
		await credential.writeTo(credentialPipe);
		expect(credentialPipe.closed).toBe(true);
		await sendChildMessage(child, "activate");
		const [exitCode] = await once(child, "close");

		expect(exitCode).toBe(0);
		expect(await stdout).toBe(`${expectedDigest}\n`);
		expect(await stderr).toBe("");
	});

	it("aborts a pending read, closes the channel, and redacts the abort reason", async () => {
		const secret = "abort-reason-secret";
		const fixture = await openFifo();
		const controller = new AbortController();
		const credentialPromise = readCodexOwnerCredentialFromOwnedFd(
			fixture.reader,
			controller.signal,
		);
		await new Promise<void>((resolve) => setImmediate(resolve));
		controller.abort(new Error(secret));

		const error = await captureFailure(credentialPromise);
		expect(error).toMatchObject({ reason: "cancelled" });
		expect(inspect(error)).not.toContain(secret);
		expect("cause" in error).toBe(false);
		expectFdClosed(fixture.reader);
		await closeTrackedFd(fixture.writer);
	});

	it("closes the owned channel when the signal is already aborted", async () => {
		const fixture = await openFifo();
		const controller = new AbortController();
		controller.abort(new Error("pre-abort-secret"));

		await expect(
			readCodexOwnerCredentialFromOwnedFd(fixture.reader, controller.signal),
		).rejects.toMatchObject({ reason: "cancelled" });
		expectFdClosed(fixture.reader);
		await closeTrackedFd(fixture.writer);
	});

	it.each([-1, 0x80000000, Number.NaN])(
		"returns a sanitized rejection for invalid fd %s even when already aborted",
		async (fd) => {
			const controller = new AbortController();
			controller.abort(new Error("invalid-fd-abort-secret"));
			let result: Promise<unknown> | null = null;
			expect(() => {
				result = readCodexOwnerCredentialFromOwnedFd(fd, controller.signal);
			}).not.toThrow();
			await expect(result).rejects.toMatchObject({ reason: "channel" });
		},
	);

	it("atomically allows only one callback-scoped use", async () => {
		const secret = "one-use-owner-key";
		const credential = await credentialFromBytes(Buffer.from(secret));
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let entered = 0;
		const operation = credential.use(async (apiKey) => {
			expect(apiKey).toBe(secret);
			entered += 1;
			await gate;
		});
		await vi.waitFor(() => expect(entered).toBe(1));
		await expect(credential.use(async () => undefined)).rejects.toMatchObject({
			reason: "unavailable",
		});
		await expect(credential.writeTo(new CaptureWritable())).rejects.toMatchObject({
			reason: "unavailable",
		});
		release();
		await operation;
		credential.dispose();
		credential.dispose();
	});

	it("propagates the trusted callback failure and still consumes the credential", async () => {
		const credential = await credentialFromBytes(Buffer.from("callback-owner-key"));
		const authorityFailure = new Error("runtime authority ended");

		await expect(
			credential.use(async () => {
				throw authorityFailure;
			}),
		).rejects.toBe(authorityFailure);
		await expect(credential.use(async () => undefined)).rejects.toMatchObject({
			reason: "unavailable",
		});
	});

	it("transfers one bounded Buffer write, ends the destination, and disposes", async () => {
		const secret = "one-shot-transfer-key";
		const credential = await credentialFromBytes(Buffer.from(secret));
		const destination = new CaptureWritable();

		await credential.writeTo(destination);

		expect(destination.writes).toBe(1);
		expect(Buffer.concat(destination.chunks).toString()).toBe(secret);
		expect(destination.writableEnded).toBe(true);
		expect(destination.writableFinished).toBe(true);
		await expect(credential.use(async () => undefined)).rejects.toMatchObject({
			reason: "unavailable",
		});
		await expect(credential.writeTo(new CaptureWritable())).rejects.toMatchObject({
			reason: "unavailable",
		});
	});

	it("waits for a backpressured destination to finish", async () => {
		const credential = await credentialFromBytes(Buffer.from("backpressure-owner-key"));
		const destination = new DelayedWritable();
		let settled = false;
		const transfer = credential.writeTo(destination).finally(() => {
			settled = true;
		});
		await vi.waitFor(() => expect(destination.pendingWrite).not.toBeNull());
		expect(settled).toBe(false);

		destination.release();
		await transfer;
		expect(settled).toBe(true);
		expect(destination.writableFinished).toBe(true);
	});

	it("sanitizes write failures and zeroes the operation-local Buffer", async () => {
		const secret = "write-error-secret";
		const credential = await credentialFromBytes(Buffer.from(secret));
		let received: Buffer | null = null;
		const destination = new Writable({
			write(chunk: Buffer, _encoding, callback) {
				received = chunk;
				callback(new Error(`destination leaked ${chunk.toString()}`));
			},
		});

		const error = await captureFailure(credential.writeTo(destination));
		expect(error).toEqual(new CodexOwnerCredentialError("write"));
		expect(inspect(error)).not.toContain(secret);
		expect("cause" in error).toBe(false);
		expect(received).not.toBeNull();
		expect(received?.every((byte) => byte === 0)).toBe(true);
		expect(destination.closed).toBe(true);
		await expect(credential.use(async () => undefined)).rejects.toMatchObject({
			reason: "unavailable",
		});
	});

	it("destroys a destination that closes before the transfer finishes", async () => {
		const credential = await credentialFromBytes(Buffer.from("premature-close-key"));
		let received: Buffer | null = null;
		const destination = new Writable({
			write(chunk: Buffer) {
				received = chunk;
				this.destroy();
			},
		});

		await expect(credential.writeTo(destination)).rejects.toEqual(
			new CodexOwnerCredentialError("write"),
		);
		expect(destination.destroyed).toBe(true);
		expect(destination.closed).toBe(true);
		expect(received?.every((byte) => byte === 0)).toBe(true);
	});
});

describe("Codex owner credential source", () => {
	it("returns independent one-shot credentials for repeated Capsule launches", async () => {
		const secret = "reusable-process-local-owner-key";
		const source = await credentialSourceFromBytes(Buffer.from(secret));

		const first = await source.claim(new AbortController().signal);
		const second = await source.claim(new AbortController().signal);
		await first.use(async (apiKey) => expect(apiKey).toBe(secret));
		await expect(first.use(async () => undefined)).rejects.toMatchObject({
			reason: "unavailable",
		});
		await second.use(async (apiKey) => expect(apiKey).toBe(secret));
		await expect(second.use(async () => undefined)).rejects.toMatchObject({
			reason: "unavailable",
		});

		source.close();
	});

	it("linearizes an issued claim before close and abort, then rejects future claims", async () => {
		const secret = "claim-close-race-owner-key";
		const source = await credentialSourceFromBytes(Buffer.from(secret));
		const controller = new AbortController();

		const issued = source.claim(controller.signal);
		controller.abort(new Error("late-abort-secret"));
		source.close();
		source.close();

		const credential = await issued;
		await credential.use(async (apiKey) => expect(apiKey).toBe(secret));
		await expect(source.claim(new AbortController().signal)).rejects.toEqual(
			new CodexOwnerCredentialError("unavailable"),
		);
	});

	it("returns fixed redacted cancellation and unavailable failures", async () => {
		const secret = "source-error-owner-key";
		const source = await credentialSourceFromBytes(Buffer.from(secret));
		const controller = new AbortController();
		controller.abort(new Error(secret));

		const cancelled = await captureFailure(source.claim(controller.signal));
		expect(cancelled).toEqual(new CodexOwnerCredentialError("cancelled"));
		expect("cause" in cancelled).toBe(false);
		const credential = await source.claim(new AbortController().signal);
		await credential.use(async (apiKey) => expect(apiKey).toBe(secret));

		source.close();
		const unavailable = await captureFailure(source.claim(new AbortController().signal));
		expect(unavailable).toEqual(new CodexOwnerCredentialError("unavailable"));
		for (const failure of [cancelled, unavailable]) {
			for (const rendered of [String(failure), JSON.stringify(failure), inspect(failure)]) {
				expect(rendered).not.toContain(secret);
			}
		}
	});

	it("redacts every source coercion without exposing a generic secret property", async () => {
		const secret = "source-inspection-owner-key";
		const source = await credentialSourceFromBytes(Buffer.from(secret));

		expect(String(source)).toBe("[CodexOwnerCredentialSource redacted]");
		expect(`${source}`).toBe("[CodexOwnerCredentialSource redacted]");
		expect(JSON.stringify(source)).toBe('"[CodexOwnerCredentialSource redacted]"');
		expect(inspect(source)).toBe("[CodexOwnerCredentialSource redacted]");
		expect(Reflect.ownKeys(source)).toEqual([]);
		for (const rendered of [String(source), JSON.stringify(source), inspect(source)]) {
			expect(rendered).not.toContain(secret);
		}

		source.close();
	});

	it("accepts exactly the maximum bytes and rejects one byte more", async () => {
		const maximum = Buffer.alloc(MAX_CODEX_OWNER_CREDENTIAL_BYTES + 1, 0x61);
		maximum[maximum.length - 1] = 0x0a;
		const source = await credentialSourceFromBytes(maximum);
		const credential = await source.claim(new AbortController().signal);
		await credential.use(async (apiKey) => {
			expect(Buffer.byteLength(apiKey)).toBe(MAX_CODEX_OWNER_CREDENTIAL_BYTES);
		});
		source.close();

		const oversized = Buffer.alloc(MAX_CODEX_OWNER_CREDENTIAL_BYTES + 1, 0x62);
		await expect(credentialSourceFromBytes(oversized)).rejects.toEqual(
			new CodexOwnerCredentialError("oversized"),
		);
	});

	it("zeroes the consumed reader credential and the retained source Buffer", async () => {
		const secret = "zeroized-source-owner-key";
		const fillSpy = vi.spyOn(Buffer.prototype, "fill");
		const source = await credentialSourceFromBytes(Buffer.from(`${secret}\n`));
		const originalBytes = fillSpy.mock.instances.find(
			(instance) => Buffer.isBuffer(instance) && instance.length === Buffer.byteLength(secret),
		);
		expect(originalBytes).toBeDefined();
		expect(originalBytes?.every((byte) => byte === 0)).toBe(true);

		fillSpy.mockClear();
		source.close();
		source.close();
		const retainedBytes = fillSpy.mock.instances.find(
			(instance) => Buffer.isBuffer(instance) && instance.length === Buffer.byteLength(secret),
		);
		expect(retainedBytes).toBeDefined();
		expect(retainedBytes).not.toBe(originalBytes);
		expect(retainedBytes?.every((byte) => byte === 0)).toBe(true);
		expect(fillSpy).toHaveBeenCalledTimes(1);
	});
});

class CaptureWritable extends Writable {
	readonly chunks: Buffer[] = [];
	writes = 0;

	_write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
		this.writes += 1;
		this.chunks.push(Buffer.from(chunk));
		callback();
	}
}

class DelayedWritable extends Writable {
	pendingWrite: (() => void) | null = null;

	constructor() {
		super({ highWaterMark: 1 });
	}

	_write(_chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
		this.pendingWrite = callback;
	}

	release(): void {
		const pending = this.pendingWrite;
		if (pending === null) throw new Error("No pending destination write");
		this.pendingWrite = null;
		pending();
	}
}

async function credentialFromBytes(bytes: Buffer) {
	const fixture = await openFifo();
	const credentialPromise = readCodexOwnerCredentialFromOwnedFd(
		fixture.reader,
		new AbortController().signal,
	);
	await writeAll(fixture.writer, bytes);
	await closeTrackedFd(fixture.writer);
	const credential = await credentialPromise;
	expectFdClosed(fixture.reader);
	return credential;
}

async function credentialSourceFromBytes(bytes: Buffer) {
	const fixture = await openFifo();
	const sourcePromise = readCodexOwnerCredentialSourceFromOwnedFd(
		fixture.reader,
		new AbortController().signal,
	);
	await writeAll(fixture.writer, bytes);
	await closeTrackedFd(fixture.writer);
	const source = await sourcePromise;
	expectFdClosed(fixture.reader);
	return source;
}

async function openFifo(): Promise<{ reader: number; writer: number }> {
	const directory = await privateTempDirectory();
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

async function privateTempDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "agentrelay-owner-credential-test-"));
	cleanupDirectories.add(directory);
	return directory;
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

async function captureFailure(promise: Promise<unknown>): Promise<Error> {
	try {
		await promise;
	} catch (error) {
		if (error instanceof Error) return error;
	}
	throw new Error("Expected operation to fail");
}

async function collectUtf8(stream: NodeJS.ReadableStream): Promise<string> {
	let result = "";
	stream.setEncoding("utf8");
	for await (const chunk of stream) result += String(chunk);
	return result;
}

function sendChildMessage(child: ReturnType<typeof spawn>, message: string): Promise<void> {
	return new Promise((resolve, reject) => {
		child.send(message, (error) => (error ? reject(error) : resolve()));
	});
}
