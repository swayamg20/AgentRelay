import { randomBytes } from "node:crypto";
import { chmod, link, lstat, rename, unlink } from "node:fs/promises";
import type { Server, Socket } from "node:net";
import { dirname, join } from "node:path";
import {
	type CapsuleRequest,
	type CapsuleResponse,
	MAX_CAPSULE_REQUEST_FRAME_BYTES,
	MAX_CAPSULE_RESPONSE_FRAME_BYTES,
	capsuleRequestSchema,
	capsuleResponseSchema,
} from "./capsule-protocol.js";
import { syncDirectory } from "./durable-file.js";
import { ensurePrivateStateDirectory } from "./private-state-file.js";

const REQUEST_FRAME_TIMEOUT_MS = 5_000;

export interface CapsuleSocketIdentity {
	readonly dev: number;
	readonly ino: number;
}

export async function ensurePrivateCapsuleDirectory(directory: string): Promise<void> {
	await ensurePrivateStateDirectory(directory);
}

export async function publishCapsuleSocket(
	server: Server,
	socketPath: string,
): Promise<CapsuleSocketIdentity> {
	await ensurePrivateCapsuleDirectory(dirname(socketPath));
	await assertSocketPathAvailable(socketPath);
	const boundSocketPath = join(dirname(socketPath), `.b-${randomBytes(8).toString("hex")}.sock`);
	let publishedIdentity: CapsuleSocketIdentity | null = null;
	try {
		await listen(server, boundSocketPath);
		await chmod(boundSocketPath, 0o600);
		const stats = await lstat(boundSocketPath);
		if (!stats.isSocket() || (stats.mode & 0o777) !== 0o600) {
			throw new Error(`Capsule socket was not created privately: ${socketPath}`);
		}
		const identity = { dev: stats.dev, ino: stats.ino };
		// The server only knows this now-unlinked bind alias, so an older process
		// cannot unlink a replacement later published at socketPath.
		await link(boundSocketPath, socketPath);
		publishedIdentity = identity;
		await unlink(boundSocketPath);
		await syncDirectory(dirname(socketPath));
		return identity;
	} catch (error) {
		await Promise.allSettled([
			closeCapsuleServer(server),
			unlink(boundSocketPath),
			publishedIdentity === null
				? Promise.resolve()
				: removeCapsuleSocketIfOwned(socketPath, publishedIdentity),
		]);
		throw error;
	}
}

export async function removeCapsuleSocketIfOwned(
	path: string,
	expected: CapsuleSocketIdentity,
): Promise<void> {
	const quarantinePath = join(dirname(path), `.close-${randomBytes(8).toString("hex")}.sock`);
	try {
		await rename(path, quarantinePath);
	} catch (error) {
		if (errorCode(error) === "ENOENT") return;
		throw error;
	}

	const moved = await lstat(quarantinePath);
	if (moved.isSocket() && moved.dev === expected.dev && moved.ino === expected.ino) {
		await unlink(quarantinePath);
		await syncDirectory(dirname(path));
		return;
	}

	try {
		await link(quarantinePath, path);
	} catch (error) {
		if (errorCode(error) === "EEXIST") return;
		throw error;
	}
	await unlink(quarantinePath);
	await syncDirectory(dirname(path));
}

export function closeCapsuleServer(server: Server): Promise<void> {
	return new Promise((resolve, reject) => {
		if (!server.listening) {
			resolve();
			return;
		}
		server.close((error) => (error ? reject(error) : resolve()));
	});
}

export function readCapsuleRequest(socket: Socket, signal?: AbortSignal): Promise<CapsuleRequest> {
	return new Promise((resolve, reject) => {
		let raw = "";
		let bytes = 0;
		socket.setEncoding("utf8");
		const timeout = setTimeout(
			() => fail(new Error("Timed out waiting for a complete capsule request frame")),
			REQUEST_FRAME_TIMEOUT_MS,
		);
		const cleanup = () => {
			clearTimeout(timeout);
			socket.removeListener("data", onData);
			socket.removeListener("end", onEnd);
			socket.removeListener("close", onClose);
			socket.removeListener("error", onError);
			signal?.removeEventListener("abort", onAbort);
		};
		const fail = (error: Error) => {
			cleanup();
			reject(error);
		};
		const onError = (error: Error) => fail(error);
		const onEnd = () => fail(new Error("Capsule request ended before a complete frame"));
		const onClose = () => fail(new Error("Capsule connection closed before a complete frame"));
		const onAbort = () => fail(new Error("Capsule server closed before a complete request frame"));
		const onData = (chunk: string) => {
			bytes += Buffer.byteLength(chunk, "utf8");
			if (bytes > MAX_CAPSULE_REQUEST_FRAME_BYTES) {
				fail(new Error("Capsule request frame exceeds the byte limit"));
				return;
			}
			raw += chunk;
			const newline = raw.indexOf("\n");
			if (newline < 0) return;
			if (raw.slice(newline + 1).trim().length > 0) {
				fail(new Error("Capsule connection accepts exactly one request frame"));
				return;
			}
			cleanup();
			try {
				resolve(capsuleRequestSchema.parse(JSON.parse(raw.slice(0, newline))));
			} catch (error) {
				reject(error);
			}
		};
		socket.on("data", onData);
		socket.once("end", onEnd);
		socket.once("close", onClose);
		socket.once("error", onError);
		if (signal?.aborted) onAbort();
		else signal?.addEventListener("abort", onAbort, { once: true });
	});
}

export async function writeCapsuleError(
	socket: Socket,
	request: CapsuleRequest,
	capsuleId: string,
	code: Extract<CapsuleResponse, { kind: "error" }>["code"],
	message: string,
): Promise<void> {
	await writeCapsuleFrame(socket, {
		version: 1,
		capsule_id: capsuleId,
		request_id: request.request_id,
		kind: "error",
		code,
		message: message.slice(0, 2_000),
	});
	socket.end();
}

export function writeCapsuleFrame(socket: Socket, responseValue: CapsuleResponse): Promise<void> {
	const response = capsuleResponseSchema.parse(responseValue);
	const frame = `${JSON.stringify(response)}\n`;
	if (Buffer.byteLength(frame, "utf8") > MAX_CAPSULE_RESPONSE_FRAME_BYTES) {
		throw new Error("Capsule response frame exceeds the byte limit");
	}
	if (socket.destroyed || !socket.writable) {
		return Promise.reject(new Error("Capsule connection is not writable"));
	}
	if (socket.write(frame)) return Promise.resolve();
	return new Promise((resolve, reject) => {
		const cleanup = () => {
			socket.removeListener("drain", onDrain);
			socket.removeListener("error", onError);
			socket.removeListener("close", onClose);
		};
		const onDrain = () => {
			cleanup();
			resolve();
		};
		const onError = (error: Error) => {
			cleanup();
			reject(error);
		};
		const onClose = () => {
			cleanup();
			reject(new Error("Capsule connection closed during response write"));
		};
		socket.once("drain", onDrain);
		socket.once("error", onError);
		socket.once("close", onClose);
	});
}

async function assertSocketPathAvailable(path: string): Promise<void> {
	try {
		const stats = await lstat(path);
		if (!stats.isSocket()) throw new Error(`Refusing to replace non-socket capsule path: ${path}`);
		throw new Error(`Refusing to replace existing capsule socket path: ${path}`);
	} catch (error) {
		if (errorCode(error) === "ENOENT") return;
		throw error;
	}
}

function listen(server: Server, path: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const onError = (error: Error) => reject(error);
		server.once("error", onError);
		server.listen(path, () => {
			server.removeListener("error", onError);
			resolve();
		});
	});
}

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? String(error.code)
		: undefined;
}
