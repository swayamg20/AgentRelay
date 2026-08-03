import { randomBytes } from "node:crypto";
import { chmod, link, lstat, mkdir, rename, unlink } from "node:fs/promises";
import { type Server, type Socket, createServer } from "node:net";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ZodError } from "zod";
import {
	CAPSULE_ADAPTER_INFO,
	type CapsuleRequest,
	type CapsuleResponse,
	type CapsuleUnaryResult,
	MAX_CAPSULE_REQUEST_FRAME_BYTES,
	MAX_CAPSULE_RESPONSE_FRAME_BYTES,
	capsuleRequestSchema,
} from "./capsule-protocol.js";
import { syncDirectory } from "./durable-file.js";
import {
	CapsuleOperationError,
	FakeCapsuleStore,
	readCapsuleLaunchDescriptor,
} from "./fake-capsule-store.js";

const STREAM_POLL_MS = 20;
const REQUEST_FRAME_TIMEOUT_MS = 5_000;

interface SocketIdentity {
	readonly dev: number;
	readonly ino: number;
}

/** Local Unix-socket server for one credential-isolated, Mission-scoped fake capsule. */
export class PersistentFakeCapsuleServer {
	readonly #store: FakeCapsuleStore;
	readonly #server: Server;
	readonly #socketPath: string;
	readonly #socketIdentity: SocketIdentity;
	readonly #connections = new Set<Socket>();
	readonly #closedPromise: Promise<void>;
	#resolveClosed!: () => void;
	#closed = false;

	private constructor(
		store: FakeCapsuleStore,
		server: Server,
		socketPath: string,
		socketIdentity: SocketIdentity,
	) {
		this.#store = store;
		this.#server = server;
		this.#socketPath = socketPath;
		this.#socketIdentity = socketIdentity;
		this.#closedPromise = new Promise((resolve) => {
			this.#resolveClosed = resolve;
		});
	}

	static async start(directory: string): Promise<PersistentFakeCapsuleServer> {
		await ensurePrivateDirectory(directory);
		const descriptor = await readCapsuleLaunchDescriptor(directory);
		const socketPath = descriptor.socket_path;
		await ensurePrivateDirectory(dirname(socketPath));
		await assertSocketPathAvailable(socketPath);
		const boundSocketPath = join(dirname(socketPath), `.b-${randomBytes(8).toString("hex")}.sock`);
		const server = createServer({ allowHalfOpen: true });
		const rejectUntilReady = (socket: Socket) => socket.destroy();
		server.on("connection", rejectUntilReady);
		let store: FakeCapsuleStore | null = null;
		let socketIdentity: SocketIdentity | null = null;
		try {
			// Bind before opening durable state. A losing duplicate must never schedule
			// completion timers that can later overwrite the live capsule's state.
			await listen(server, boundSocketPath);
			await chmod(boundSocketPath, 0o600);
			const boundStats = await lstat(boundSocketPath);
			if (!boundStats.isSocket() || (boundStats.mode & 0o777) !== 0o600) {
				throw new Error(`Capsule socket was not created privately: ${socketPath}`);
			}
			socketIdentity = { dev: boundStats.dev, ino: boundStats.ino };
			// Node unlinks the path passed to listen() on close. Publish a hard link and
			// immediately remove that bind alias so an old server can never unlink a
			// replacement later installed at the descriptor path.
			await link(boundSocketPath, socketPath);
			await unlink(boundSocketPath);
			await syncDirectory(dirname(socketPath));
			store = await FakeCapsuleStore.open(directory);
			const capsule = new PersistentFakeCapsuleServer(store, server, socketPath, socketIdentity);
			server.removeListener("connection", rejectUntilReady);
			server.on("connection", (socket) => capsule.accept(socket));
			return capsule;
		} catch (error) {
			await store?.close().catch(() => undefined);
			if (socketIdentity !== null) {
				await removeSocketLinkIfOwned(socketPath, socketIdentity).catch(() => undefined);
			}
			await closeServer(server).catch(() => undefined);
			await unlink(boundSocketPath).catch(() => undefined);
			throw error;
		}
	}

	get socketPath(): string {
		return this.#socketPath;
	}

	waitUntilClosed(): Promise<void> {
		return this.#closedPromise;
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		try {
			// Remove our public link while this server is still live. The server itself
			// only knows the already-unlinked private bind alias.
			await removeSocketLinkIfOwned(this.#socketPath, this.#socketIdentity);
			for (const socket of this.#connections) socket.destroy();
			await closeServer(this.#server);
			await this.#store.close();
		} finally {
			this.#resolveClosed();
		}
	}

	private accept(socket: Socket): void {
		this.#connections.add(socket);
		socket.once("close", () => this.#connections.delete(socket));
		void this.handle(socket);
	}

	private async handle(socket: Socket): Promise<void> {
		let request: CapsuleRequest | null = null;
		try {
			request = await readRequest(socket);
			const descriptor = this.#store.descriptor;
			if (
				request.capsule_id !== descriptor.capsule_id ||
				request.capability_token !== descriptor.capability_token
			) {
				await writeError(
					socket,
					request,
					descriptor.capsule_id,
					"authentication_failed",
					"Capsule capability authentication failed",
				);
				return;
			}

			switch (request.method) {
				case "probe":
					await this.writeUnary(socket, request, CAPSULE_ADAPTER_INFO);
					return;
				case "ensure_session":
					await this.writeUnary(
						socket,
						request,
						await this.#store.ensureSession(request.params.input),
					);
					return;
				case "lookup_turn":
					await this.writeUnary(
						socket,
						request,
						await this.#store.lookupTurn(
							request.params.delivery_id,
							request.params.execution_attempt,
						),
					);
					return;
				case "start_turn": {
					const turn = await this.#store.startTurn(request.params.input);
					await this.streamTurn(socket, request, turn);
					return;
				}
				case "recover_turn":
					await this.#store.eventsForTurn(request.params.turn, request.params.input);
					await this.streamTurn(socket, request, request.params.turn, request.params.input);
					return;
				case "cancel_turn":
					await this.#store.cancelTurn(request.params.turn);
					await this.writeUnary(socket, request, {});
					return;
				case "shutdown":
					await this.writeUnary(socket, request, {});
					void delay(20).then(() => this.close());
					return;
			}
		} catch (error) {
			if (request === null || socket.destroyed) {
				socket.destroy();
				return;
			}
			const descriptor = this.#store.descriptor;
			const code =
				error instanceof CapsuleOperationError
					? error.code
					: error instanceof ZodError
						? "invalid_request"
						: "internal";
			await writeError(socket, request, descriptor.capsule_id, code, safeError(error)).catch(() =>
				socket.destroy(),
			);
		}
	}

	private async writeUnary(
		socket: Socket,
		request: CapsuleRequest,
		value: CapsuleUnaryResult,
	): Promise<void> {
		await writeFrame(socket, {
			version: 1,
			capsule_id: this.#store.descriptor.capsule_id,
			request_id: request.request_id,
			kind: "result",
			value,
		});
		await writeFrame(socket, {
			version: 1,
			capsule_id: this.#store.descriptor.capsule_id,
			request_id: request.request_id,
			kind: "end",
		});
		socket.end();
	}

	private async streamTurn(
		socket: Socket,
		request: CapsuleRequest,
		turn: Parameters<FakeCapsuleStore["eventsForTurn"]>[0],
		expectedInput?: Parameters<FakeCapsuleStore["eventsForTurn"]>[1],
	): Promise<void> {
		let sent = 0;
		while (!socket.destroyed && !this.#closed) {
			const events = await this.#store.eventsForTurn(turn, expectedInput);
			for (const event of events.slice(sent)) {
				await writeFrame(socket, {
					version: 1,
					capsule_id: this.#store.descriptor.capsule_id,
					request_id: request.request_id,
					kind: "event",
					event,
				});
				sent += 1;
			}
			if (await this.#store.isTurnTerminal(turn)) {
				await writeFrame(socket, {
					version: 1,
					capsule_id: this.#store.descriptor.capsule_id,
					request_id: request.request_id,
					kind: "end",
				});
				socket.end();
				return;
			}
			await delay(STREAM_POLL_MS);
		}
	}
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const stats = await lstat(directory);
	if (!stats.isDirectory() || stats.isSymbolicLink()) {
		throw new Error(`Capsule directory must be a real directory: ${directory}`);
	}
	if ((stats.mode & 0o777) !== 0o700) {
		throw new Error(`Capsule directory must have mode 0700: ${directory}`);
	}
}

async function assertSocketPathAvailable(path: string): Promise<void> {
	try {
		const stats = await lstat(path);
		if (!stats.isSocket()) {
			throw new Error(`Refusing to replace non-socket capsule path: ${path}`);
		}
		throw new Error(`Refusing to replace existing capsule socket path: ${path}`);
	} catch (error) {
		if (errorCode(error) === "ENOENT") return;
		throw error;
	}
}

async function removeSocketLinkIfOwned(path: string, expected: SocketIdentity): Promise<void> {
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

	// A replacement raced with close. Restore its hard link when the public path is
	// still free; if another server already published there, preserve both inodes.
	try {
		await link(quarantinePath, path);
	} catch (error) {
		if (errorCode(error) === "EEXIST") return;
		throw error;
	}
	await unlink(quarantinePath);
	await syncDirectory(dirname(path));
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

function closeServer(server: Server): Promise<void> {
	return new Promise((resolve, reject) => {
		if (!server.listening) {
			resolve();
			return;
		}
		server.close((error) => (error ? reject(error) : resolve()));
	});
}

function readRequest(socket: Socket): Promise<CapsuleRequest> {
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
			socket.removeListener("error", onError);
		};
		const fail = (error: Error) => {
			cleanup();
			reject(error);
		};
		const onError = (error: Error) => fail(error);
		const onEnd = () => fail(new Error("Capsule request ended before a complete frame"));
		const onData = (chunk: string) => {
			bytes += Buffer.byteLength(chunk, "utf8");
			if (bytes > MAX_CAPSULE_REQUEST_FRAME_BYTES) {
				fail(new Error("Capsule request frame exceeds the byte limit"));
				return;
			}
			raw += chunk;
			const newline = raw.indexOf("\n");
			if (newline < 0) return;
			const remainder = raw.slice(newline + 1);
			if (remainder.trim().length > 0) {
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
		socket.once("error", onError);
	});
}

async function writeError(
	socket: Socket,
	request: CapsuleRequest,
	capsuleId: string,
	code: Extract<CapsuleResponse, { kind: "error" }>["code"],
	message: string,
): Promise<void> {
	await writeFrame(socket, {
		version: 1,
		capsule_id: capsuleId,
		request_id: request.request_id,
		kind: "error",
		code,
		message: message.slice(0, 2_000),
	});
	socket.end();
}

function writeFrame(socket: Socket, response: CapsuleResponse): Promise<void> {
	const frame = `${JSON.stringify(response)}\n`;
	if (Buffer.byteLength(frame, "utf8") > MAX_CAPSULE_RESPONSE_FRAME_BYTES) {
		throw new Error("Capsule response frame exceeds the byte limit");
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

function safeError(error: unknown): string {
	return (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
}

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? String(error.code)
		: undefined;
}
