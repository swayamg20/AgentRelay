import { type Server, type Socket, createServer } from "node:net";
import {
	DEFAULT_HOST_EVENT_STREAM_POLICY,
	type HostEvent,
	type HostTurnCorrelation,
	acceptHostEvent,
	createHostEventStreamState,
} from "@agentrelay/protocol";
import { CapsuleAuthority } from "./capsule-authority.js";
import type { CapsuleRequest, CapsuleUnaryResult } from "./capsule-protocol.js";
import type {
	CapsuleRuntime,
	CapsuleRuntimeActivation,
	CapsuleRuntimeController,
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
import {
	RuntimeAuthorityDeniedError,
	runtimeAuthorityDenyCodeSchema,
} from "./runtime-authority.js";

/** Provider-neutral private Unix-socket server for one Mission Capsule runtime. */
export class PersistentCapsuleServer {
	readonly #identity: CapsuleServerIdentity;
	readonly #controller: CapsuleRuntimeController;
	readonly #authority: CapsuleAuthority;
	readonly #server: Server;
	readonly #socketIdentity: CapsuleSocketIdentity;
	readonly #connections = new Map<Socket, AbortController>();
	readonly #handlers = new Set<Promise<void>>();
	readonly #closedPromise: Promise<void>;
	#resolveClosed!: () => void;
	#closing: Promise<void> | null = null;
	#runtimeActivation: Promise<CapsuleRuntime> | null = null;

	private constructor(
		identity: CapsuleServerIdentity,
		controller: CapsuleRuntimeController,
		server: Server,
		socketIdentity: CapsuleSocketIdentity,
		authorityEvidenceSink: PersistentCapsuleServerOptions["authorityEvidenceSink"],
	) {
		this.#identity = identity;
		this.#controller = controller;
		this.#server = server;
		this.#socketIdentity = socketIdentity;
		this.#authority = new CapsuleAuthority({
			evidenceSink: authorityEvidenceSink,
			retire: () => void this.close().catch(() => undefined),
		});
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
		let controller: CapsuleRuntimeController | null = null;
		let capsule: PersistentCapsuleServer | null = null;
		let retirementPending = false;
		let retirementScheduled = false;
		const retire = () => {
			if (capsule === null) {
				retirementPending = true;
				return;
			}
			if (retirementScheduled) return;
			retirementScheduled = true;
			setImmediate(() => void capsule?.close().catch(() => undefined));
		};
		try {
			// Only the socket-owning process may open durable state. Provider activation
			// remains fenced until this generation has installed runtime authority.
			socketIdentity = await publishCapsuleSocket(server, identity.socketPath);
			controller = await options.openController({ retire });
			const activeCapsule = new PersistentCapsuleServer(
				identity,
				controller,
				server,
				socketIdentity,
				options.authorityEvidenceSink,
			);
			capsule = activeCapsule;
			server.removeListener("connection", rejectUntilReady);
			server.on("connection", (socket) => activeCapsule.accept(socket));
			if (retirementPending) retire();
			return activeCapsule;
		} catch (error) {
			await Promise.allSettled([
				controller?.close(),
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
			this.#authority.dispose();
			await captureFailure(
				removeCapsuleSocketIfOwned(this.socketPath, this.#socketIdentity),
				failures,
			);
			const serverClose = captureFailure(closeCapsuleServer(this.#server), failures);
			for (const [socket, controller] of this.#connections) {
				controller.abort();
				socket.destroy();
			}
			// Controller close fences an in-flight activation and releases an active
			// provider while handlers drain so neither side can wait on the other.
			const controllerClose = captureFailure(this.#controller.close(), failures);
			await Promise.all([Promise.allSettled([...this.#handlers]), controllerClose, serverClose]);
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
				return this.writeUnary(socket, request, await this.#controller.probe());
			case "install_authority":
				this.#authority.install(request.params.grant, request.params.current_lease);
				return this.writeUnary(socket, request, {});
			case "assert_authority":
				await this.#authority.assert(request.params.request);
				return this.writeUnary(socket, request, {});
			case "renew_authority":
				this.#authority.renew(request.params.mission_id, request.params.renewal);
				return this.writeUnary(socket, request, {});
			case "revoke_authority":
				this.#authority.revoke(
					request.params.mission_id,
					request.params.grant_id,
					request.params.reason,
				);
				return this.writeUnary(socket, request, {});
			case "ensure_session":
				return this.writeUnary(
					socket,
					request,
					await this.#authority.performSession(request.params.input, async (authority) => {
						const runtime = await this.activateRuntime(authority);
						return runtime.ensureSession(request.params.input);
					}),
				);
			case "lookup_turn":
				// An authenticated read is needed to discover recoverable local state before
				// a fresh delivery grant is installed. It cannot activate or mutate the runtime.
				return this.writeUnary(
					socket,
					request,
					await this.#controller.lookupTurn(
						request.params.delivery_id,
						request.params.execution_attempt,
					),
				);
			case "start_turn": {
				const events = await this.#authority.performStart(
					request.params.input,
					async (authority) => {
						const runtime = await this.activateRuntime(authority);
						return runtime.startTurn(request.params.input);
					},
				);
				this.#authority.beginTurn();
				return this.streamEvents(
					socket,
					request,
					events,
					turnCorrelation(request.params.input),
					"runtime_start",
					signal,
				);
			}
			case "recover_turn": {
				const events = await this.#authority.performRecovery(
					request.params.turn,
					request.params.input,
					async (authority) => {
						const runtime = await this.activateRuntime(authority);
						return runtime.recoverTurn(request.params.turn, request.params.input);
					},
				);
				this.#authority.beginTurn();
				return this.streamEvents(
					socket,
					request,
					events,
					request.params.turn,
					"runtime_recover",
					signal,
				);
			}
			case "cancel_turn":
				await this.#authority.performCancel(request.params.turn, async (authority) => {
					const runtime = await this.activateRuntime(authority);
					return runtime.cancelTurn(request.params.turn);
				});
				return this.writeUnary(socket, request, {});
			case "shutdown":
				await this.writeUnary(socket, request, {});
				setImmediate(() => void this.close().catch(() => undefined));
		}
	}

	private activateRuntime(authority: CapsuleRuntimeActivation): Promise<CapsuleRuntime> {
		this.#runtimeActivation ??= this.performActivation(authority);
		return this.#runtimeActivation;
	}

	private async performActivation(authority: CapsuleRuntimeActivation): Promise<CapsuleRuntime> {
		assertActivationLive(authority.signal);
		const runtime = await this.#controller.activate(authority);
		try {
			assertActivationLive(authority.signal);
			return runtime;
		} catch (error) {
			await this.#controller.close().catch(() => undefined);
			throw error;
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
		operation: "runtime_start" | "runtime_recover",
		signal: AbortSignal,
	): Promise<void> {
		let state = createHostEventStreamState(expectedTurn);
		const iterator = events[Symbol.asyncIterator]();
		const authoritySignal = this.#authority.streamSignal(signal);
		let completed = false;
		try {
			while (true) {
				const result = await nextRuntimeEvent(iterator, authoritySignal);
				if (result === null) return;
				if (result.done) {
					completed = true;
					break;
				}
				const accepted = acceptHostEvent(state, result.value, DEFAULT_HOST_EVENT_STREAM_POLICY);
				state = accepted.state;
				await this.#authority.gateEvent(accepted.event, state, operation, () =>
					writeCapsuleFrame(socket, {
						version: 1,
						capsule_id: this.#identity.capsuleId,
						request_id: request.request_id,
						kind: "event",
						event: accepted.event,
					}),
				);
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

function assertActivationLive(signal: AbortSignal): void {
	if (!signal.aborted) return;
	const parsed = runtimeAuthorityDenyCodeSchema.safeParse(signal.reason);
	throw new RuntimeAuthorityDeniedError(parsed.success ? parsed.data : "revoked");
}
