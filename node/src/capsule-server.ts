import { type Server, type Socket, createServer } from "node:net";
import {
	DEFAULT_HOST_EVENT_STREAM_POLICY,
	type HostEvent,
	type HostTurnCorrelation,
	acceptHostEvent,
	createHostEventStreamState,
} from "@agentrelay/protocol";
import type { CapsuleRequest, CapsuleUnaryResult } from "./capsule-protocol.js";
import type {
	CapsuleRuntime,
	CapsuleServerIdentity,
	PersistentCapsuleServerOptions,
} from "./capsule-runtime.js";
import {
	type CapsuleSocketIdentity,
	closeCapsuleServer,
	publishCapsuleSocket,
	readCapsuleRequest,
	removeCapsuleSocketIfOwned,
	writeCapsuleError,
	writeCapsuleFrame,
} from "./capsule-server-io.js";
import {
	captureFailure,
	nextRuntimeEvent,
	parseCapsuleServerIdentity,
	publicCapsuleError,
	turnCorrelation,
} from "./capsule-server-runtime.js";

/** Provider-neutral private Unix-socket server for one Mission Capsule runtime. */
export class PersistentCapsuleServer {
	readonly #identity: CapsuleServerIdentity;
	readonly #runtime: CapsuleRuntime;
	readonly #server: Server;
	readonly #socketIdentity: CapsuleSocketIdentity;
	readonly #connections = new Map<Socket, AbortController>();
	readonly #handlers = new Set<Promise<void>>();
	readonly #closedPromise: Promise<void>;
	#resolveClosed!: () => void;
	#closing: Promise<void> | null = null;

	private constructor(
		identity: CapsuleServerIdentity,
		runtime: CapsuleRuntime,
		server: Server,
		socketIdentity: CapsuleSocketIdentity,
	) {
		this.#identity = identity;
		this.#runtime = runtime;
		this.#server = server;
		this.#socketIdentity = socketIdentity;
		this.#closedPromise = new Promise((resolve) => {
			this.#resolveClosed = resolve;
		});
	}

	static async start(options: PersistentCapsuleServerOptions): Promise<PersistentCapsuleServer> {
		const identity = parseCapsuleServerIdentity(options.identity);
		const server = createServer({ allowHalfOpen: true });
		const rejectUntilReady = (socket: Socket) => socket.destroy();
		server.on("connection", rejectUntilReady);
		let socketIdentity: CapsuleSocketIdentity | null = null;
		let runtime: CapsuleRuntime | null = null;
		let capsule: PersistentCapsuleServer | null = null;
		let retirementPending = false;
		const retire = () => {
			if (capsule === null) {
				retirementPending = true;
				return;
			}
			void capsule.close().catch(() => undefined);
		};
		try {
			// Only the socket-owning process may open durable state, schedule work, or
			// spawn a provider process.
			socketIdentity = await publishCapsuleSocket(server, identity.socketPath);
			runtime = await options.openRuntime({ retire });
			const activeCapsule = new PersistentCapsuleServer(identity, runtime, server, socketIdentity);
			capsule = activeCapsule;
			server.removeListener("connection", rejectUntilReady);
			server.on("connection", (socket) => activeCapsule.accept(socket));
			if (retirementPending) retire();
			return activeCapsule;
		} catch (error) {
			await Promise.allSettled([
				runtime?.close(),
				socketIdentity === null
					? Promise.resolve()
					: removeCapsuleSocketIfOwned(identity.socketPath, socketIdentity),
				closeCapsuleServer(server),
			]);
			throw error;
		}
	}

	get socketPath(): string {
		return this.#identity.socketPath;
	}

	waitUntilClosed(): Promise<void> {
		return this.#closedPromise;
	}

	close(): Promise<void> {
		this.#closing ??= this.performClose();
		return this.#closing;
	}

	private async performClose(): Promise<void> {
		const failures: unknown[] = [];
		try {
			await captureFailure(
				removeCapsuleSocketIfOwned(this.socketPath, this.#socketIdentity),
				failures,
			);
			const serverClose = captureFailure(closeCapsuleServer(this.#server), failures);
			for (const [socket, controller] of this.#connections) {
				controller.abort();
				socket.destroy();
			}
			// Runtime close is the cancellation hook for provider-backed operations.
			// Start it while handlers drain so neither side can wait on the other.
			const runtimeClose = captureFailure(this.#runtime.close(), failures);
			await Promise.all([Promise.allSettled([...this.#handlers]), runtimeClose, serverClose]);
		} finally {
			this.#resolveClosed();
		}
		if (failures.length > 0) {
			throw new AggregateError(failures, "Capsule server shutdown failed");
		}
	}

	private accept(socket: Socket): void {
		if (this.#closing !== null) {
			socket.destroy();
			return;
		}
		const controller = new AbortController();
		this.#connections.set(socket, controller);
		socket.on("error", () => {
			controller.abort();
			socket.destroy();
		});
		socket.once("close", () => {
			controller.abort();
			this.#connections.delete(socket);
		});
		const handler = this.handle(socket, controller.signal).finally(() => {
			this.#handlers.delete(handler);
		});
		this.#handlers.add(handler);
		void handler.catch(() => undefined);
	}

	private async handle(socket: Socket, signal: AbortSignal): Promise<void> {
		let request: CapsuleRequest | null = null;
		try {
			request = await readCapsuleRequest(socket, signal);
			if (
				request.capsule_id !== this.#identity.capsuleId ||
				request.capability_token !== this.#identity.capabilityToken
			) {
				await writeCapsuleError(
					socket,
					request,
					this.#identity.capsuleId,
					"authentication_failed",
					"Capsule capability authentication failed",
				);
				return;
			}
			await this.dispatch(socket, request, signal);
		} catch (error) {
			if (request === null || socket.destroyed || signal.aborted) {
				socket.destroy();
				return;
			}
			const response = publicCapsuleError(error);
			await writeCapsuleError(
				socket,
				request,
				this.#identity.capsuleId,
				response.code,
				response.message,
			).catch(() => socket.destroy());
			if (response.code === "internal") {
				setImmediate(() => void this.close().catch(() => undefined));
			}
		}
	}

	private async dispatch(socket: Socket, request: CapsuleRequest, signal: AbortSignal) {
		switch (request.method) {
			case "probe":
				return this.writeUnary(socket, request, await this.#runtime.probe());
			case "ensure_session":
				return this.writeUnary(
					socket,
					request,
					await this.#runtime.ensureSession(request.params.input),
				);
			case "lookup_turn":
				return this.writeUnary(
					socket,
					request,
					await this.#runtime.lookupTurn(
						request.params.delivery_id,
						request.params.execution_attempt,
					),
				);
			case "start_turn":
				return this.streamEvents(
					socket,
					request,
					this.#runtime.startTurn(request.params.input),
					turnCorrelation(request.params.input),
					signal,
				);
			case "recover_turn":
				return this.streamEvents(
					socket,
					request,
					this.#runtime.recoverTurn(request.params.turn, request.params.input),
					request.params.turn,
					signal,
				);
			case "cancel_turn":
				await this.#runtime.cancelTurn(request.params.turn);
				return this.writeUnary(socket, request, {});
			case "shutdown":
				await this.writeUnary(socket, request, {});
				setImmediate(() => void this.close().catch(() => undefined));
		}
	}

	private async writeUnary(
		socket: Socket,
		request: CapsuleRequest,
		value: CapsuleUnaryResult,
	): Promise<void> {
		await writeCapsuleFrame(socket, {
			version: 1,
			capsule_id: this.#identity.capsuleId,
			request_id: request.request_id,
			kind: "result",
			value,
		});
		await this.writeEnd(socket, request);
	}

	private async streamEvents(
		socket: Socket,
		request: CapsuleRequest,
		events: AsyncIterable<HostEvent>,
		expectedTurn: HostTurnCorrelation,
		signal: AbortSignal,
	): Promise<void> {
		let state = createHostEventStreamState(expectedTurn);
		const iterator = events[Symbol.asyncIterator]();
		let completed = false;
		try {
			while (true) {
				const result = await nextRuntimeEvent(iterator, signal);
				if (result === null) return;
				if (result.done) {
					completed = true;
					break;
				}
				const accepted = acceptHostEvent(state, result.value, DEFAULT_HOST_EVENT_STREAM_POLICY);
				state = accepted.state;
				await writeCapsuleFrame(socket, {
					version: 1,
					capsule_id: this.#identity.capsuleId,
					request_id: request.request_id,
					kind: "event",
					event: accepted.event,
				});
			}
		} finally {
			if (!completed) await iterator.return?.();
		}
		if (state.phase !== "terminal") throw new Error("Capsule runtime stream ended before terminal");
		await this.writeEnd(socket, request);
	}

	private async writeEnd(socket: Socket, request: CapsuleRequest): Promise<void> {
		await writeCapsuleFrame(socket, {
			version: 1,
			capsule_id: this.#identity.capsuleId,
			request_id: request.request_id,
			kind: "end",
		});
		socket.end();
	}
}
