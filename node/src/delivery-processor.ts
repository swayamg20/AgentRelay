import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import {
	type AgentHostAdapter,
	DEFAULT_HOST_EVENT_STREAM_POLICY,
	type Delivery,
	type DeliveryLease,
	type DeliveryReleaseResult,
	type DeliveryStartResult,
	type HostEvent,
	type HostEventStreamPolicy,
	type HostTurnRef,
	MAX_HOST_PEER_MESSAGES,
	type MissionDeliveryItem,
	type NodeDeliveryResultPayload,
	type NodeMissionAssignment,
	type StartTurnInput,
	acceptHostEvent,
	createHostEventStreamState,
	deriveHostMissionInputs,
} from "@agentrelay/protocol";
import type { NodeConfig } from "./config.js";
import {
	type JournalDelivery,
	type NodeJournal,
	type OperationIntent,
	startTurnInputDigest,
	terminalResultFromEvents,
} from "./journal.js";
import { PolicyError, resolvePolicyProfile } from "./policy.js";
import { type NodeRelayClient, RelayHttpError } from "./relay-client.js";
import { WorkspacePreflightError, preflightWorkspace } from "./workspace.js";

const TERMINAL_PHASES = new Set(["acknowledged", "dead_lettered", "authority_lost"]);
const MIN_SAFE_LEASE_WINDOW_MS = 100;
const HOST_ABORT_GRACE_MS = 5_000;

export interface DeliveryProcessorOptions {
	readonly config: NodeConfig;
	readonly client: NodeRelayClient;
	readonly journal: NodeJournal;
	readonly adapter: AgentHostAdapter;
	readonly now?: () => Date;
	readonly monotonicNow?: () => number;
	readonly preflight?: typeof preflightWorkspace;
	readonly onCheckpoint?: (
		checkpoint: DeliveryCheckpoint,
		deliveryId: string,
	) => void | Promise<void>;
}

export type DeliveryCheckpoint =
	| "claim_intent"
	| "claimed"
	| "start_intent"
	| "relay_executing"
	| "host_accepted"
	| "host_terminal"
	| "complete_intent"
	| "acknowledged"
	| "release_intent"
	| "release_recorded";

export class DeliveryProcessor {
	readonly #config: NodeConfig;
	readonly #client: NodeRelayClient;
	readonly #journal: NodeJournal;
	readonly #adapter: AgentHostAdapter;
	readonly #now: () => Date;
	readonly #monotonicNow: () => number;
	readonly #preflight: typeof preflightWorkspace;
	readonly #checkpoint: NonNullable<DeliveryProcessorOptions["onCheckpoint"]>;

	constructor(options: DeliveryProcessorOptions) {
		this.#config = options.config;
		this.#client = options.client;
		this.#journal = options.journal;
		this.#adapter = options.adapter;
		this.#now = options.now ?? (() => new Date());
		this.#monotonicNow = options.monotonicNow ?? (() => performance.now());
		this.#preflight = options.preflight ?? preflightWorkspace;
		this.#checkpoint = options.onCheckpoint ?? (() => undefined);
	}

	async processNext(signal?: AbortSignal, relayAsOf = this.#now()): Promise<string | null> {
		if (signal?.aborted) return null;
		if (!Number.isFinite(relayAsOf.getTime())) throw new Error("Relay as-of time is invalid");
		const entry = Object.values(this.#journal.snapshot().deliveries)
			.filter((candidate) => !isTerminal(candidate) && isAvailable(candidate, relayAsOf))
			.sort((left, right) =>
				compareCursor(left.item.delivery.cursor, right.item.delivery.cursor),
			)[0];
		if (!entry) return null;
		await this.process(entry.item.delivery.delivery_id, signal, relayAsOf);
		return entry.item.delivery.delivery_id;
	}

	async process(deliveryId: string, signal?: AbortSignal, relayAsOf = this.#now()): Promise<void> {
		if (signal?.aborted) return;
		if (!Number.isFinite(relayAsOf.getTime())) throw new Error("Relay as-of time is invalid");
		let entry = requireEntry(this.#journal, deliveryId);
		if (isTerminal(entry)) return;

		if (entry.operation?.kind === "claim") {
			try {
				await this.claim(deliveryId, signal);
			} catch (error) {
				const availableAt = retryAvailableAt(error);
				if (availableAt !== null) {
					await this.deferRetry(deliveryId, availableAt, error);
					return;
				}
				if (!isDefinitiveAuthorityLoss(error)) throw error;
				await this.cancelAndMarkAuthorityLost(deliveryId, error);
				return;
			}
			entry = requireEntry(this.#journal, deliveryId);
			if (isTerminal(entry)) return;
		}
		if (entry.operation?.kind === "start") {
			try {
				await this.start(deliveryId, signal);
			} catch (error) {
				if (!(error instanceof AuthorityLostError)) throw error;
				await this.markLeaseLost(deliveryId, error);
				return;
			}
			entry = requireEntry(this.#journal, deliveryId);
		}
		if (entry.operation?.kind === "renew") {
			try {
				await this.confirmLease(deliveryId, signal);
			} catch (error) {
				if (!(error instanceof AuthorityLostError)) throw error;
				await this.markLeaseLost(deliveryId, error);
				return;
			}
			entry = requireEntry(this.#journal, deliveryId);
		}
		if (entry.operation?.kind === "complete") {
			try {
				await this.publishCompletion(deliveryId, entry.operation, signal);
			} catch (error) {
				if (!(error instanceof AuthorityLostError)) throw error;
				await this.markLeaseLost(deliveryId, error);
			}
			entry = requireEntry(this.#journal, deliveryId);
			if (entry.phase !== "lease_lost") return;
		}
		if (entry.operation?.kind === "release") {
			try {
				await this.publishRelease(deliveryId, entry.operation, signal);
			} catch (error) {
				if (!(error instanceof AuthorityLostError)) throw error;
				await this.markLeaseLost(deliveryId, error);
			}
			return;
		}
		if (entry.phase === "lease_lost") {
			if (!(await this.reclaimLease(deliveryId, signal))) return;
			entry = requireEntry(this.#journal, deliveryId);
		}

		if (entry.item.delivery.status === "stored") {
			if (!isAvailable(entry, relayAsOf)) return;
			try {
				await this.claim(deliveryId, signal);
			} catch (error) {
				const availableAt = retryAvailableAt(error);
				if (availableAt !== null) {
					await this.deferRetry(deliveryId, availableAt, error);
					return;
				}
				if (!isDefinitiveAuthorityLoss(error)) throw error;
				await this.cancelAndMarkAuthorityLost(deliveryId, error);
				return;
			}
			entry = requireEntry(this.#journal, deliveryId);
		}
		if (isTerminal(entry)) return;
		const executionAttempt = entry.execution_attempt;
		let hostTurn = journaledHostTurn(entry);

		let assignment: NodeMissionAssignment;
		try {
			assignment = await this.authorize(entry.item, signal);
		} catch (error) {
			if (error instanceof AuthorityLostError || isDefinitiveAuthorityLoss(error)) {
				await this.cancelAndMarkAuthorityLost(deliveryId, error);
				return;
			}
			if (error instanceof PolicyError || error instanceof WorkspacePreflightError) {
				await this.cancelHostExecutionBounded(deliveryId, executionAttempt, hostTurn);
				await this.releaseOrLoseLease(deliveryId, "policy_denied", safeError(error), signal);
				return;
			}
			throw error;
		}
		if (entry.item.delivery.kind !== "turn") {
			await this.releaseOrLoseLease(
				deliveryId,
				"policy_denied",
				`${entry.item.delivery.kind} execution awaits the artifact and verification handlers`,
				signal,
			);
			return;
		}

		if (entry.result !== null) {
			try {
				await this.prepareExecutableLease(deliveryId, signal);
			} catch (error) {
				if (!(error instanceof AuthorityLostError)) throw error;
				await this.cancelAndMarkAuthorityLost(deliveryId, error);
				return;
			}
			try {
				await this.complete(deliveryId, entry.result, signal);
			} catch (error) {
				if (!(error instanceof AuthorityLostError)) throw error;
				await this.markLeaseLost(deliveryId, error);
			}
			return;
		}
		if (signal?.aborted) {
			await this.cancelHostExecutionBounded(deliveryId, executionAttempt, hostTurn);
			return;
		}
		entry = requireEntry(this.#journal, deliveryId);
		const participant = missionParticipant(assignment, this.#config.node.agent_id);
		const policy = resolvePolicyProfile(
			this.#config.policy_profiles,
			participant.requested_local_policy_profile,
		);

		let leaseWindow: LeaseWindow;
		try {
			leaseWindow = await this.prepareExecutableLease(deliveryId, signal);
		} catch (error) {
			if (!(error instanceof AuthorityLostError)) throw error;
			await this.cancelAndMarkAuthorityLost(deliveryId, error);
			return;
		}
		const cancelActiveTurn = () => this.cancelHostExecution(deliveryId, executionAttempt, hostTurn);
		const leaseKeeper = new LeaseKeeper({
			deliveryId,
			client: this.#client,
			journal: this.#journal,
			now: this.#now,
			monotonicNow: this.#monotonicNow,
			onAuthorityLost: cancelActiveTurn,
			shutdownSignal: signal,
		});
		leaseKeeper.start(leaseWindow);
		const authorityFailure = leaseKeeper.failure();

		try {
			await assertHostOperationAllowed(signal, cancelActiveTurn);
			const adapterInfo = await waitForHostOperation(
				() => this.#adapter.probe(),
				signal,
				cancelActiveTurn,
				authorityFailure,
			);
			leaseKeeper.assertHealthy();
			const existingSession = this.#journal.snapshot().mission_sessions[assignment.mission_id];
			const session = await waitForHostOperation(
				() =>
					this.#adapter.ensureSession({
						missionId: assignment.mission_id,
						participantId: assignment.participant_agent_id,
						workspaceAlias: participant.workspace_alias,
					}),
				signal,
				cancelActiveTurn,
				authorityFailure,
			);
			if (existingSession !== undefined && !isDeepStrictEqual(existingSession, session)) {
				throw new Error("Host session identity changed during durable Mission recovery");
			}
			leaseKeeper.assertHealthy();
			await this.#journal.setMissionSession(session);
			leaseKeeper.assertHealthy();
			await this.#journal.updateDelivery(deliveryId, (current) => {
				current.host_session = structuredClone(session);
				current.updated_at = this.#now().toISOString();
			});
			leaseKeeper.assertHealthy();

			const currentEntry = requireEntry(this.#journal, deliveryId);
			const turnInput =
				currentEntry.start_turn_input ??
				(await this.#journal.checkpointStartTurnInput(
					deliveryId,
					startTurnInput(currentEntry.item, assignment, session, executionAttempt),
					this.#now(),
				));
			hostTurn = await waitForHostOperation(
				() => this.#adapter.lookupTurn(deliveryId, executionAttempt),
				signal,
				cancelActiveTurn,
				authorityFailure,
			);
			leaseKeeper.assertHealthy();
			await assertHostOperationAllowed(signal, cancelActiveTurn);
			const stream =
				hostTurn === null
					? this.#adapter.startTurn(turnInput)
					: this.#adapter.recoverTurn(hostTurn, turnInput);
			const events = await consumeHostEvents({
				deliveryId,
				stream,
				journal: this.#journal,
				expectedInput: turnInput,
				policy: {
					...DEFAULT_HOST_EVENT_STREAM_POLICY,
					maxTokens: policy.profile.max_reported_tokens,
					usage: adapterInfo.capabilities.usage,
				},
				now: this.#now,
				onAccepted: async (turn) => {
					hostTurn = turn;
					await this.#checkpoint("host_accepted", deliveryId);
				},
				onTerminal: () => this.#checkpoint("host_terminal", deliveryId),
				assertAuthority: () => leaseKeeper.assertHealthy(),
				authorityFailure,
				signal,
				onAbort: cancelActiveTurn,
			});
			await leaseKeeper.stop();
			leaseKeeper.assertHealthy();
			const result = terminalResultFromEvents(events);
			await this.#journal.updateDelivery(deliveryId, (current) => {
				current.result = result;
				current.phase = "host_terminal";
				current.updated_at = this.#now().toISOString();
			});
			await this.complete(deliveryId, result, signal);
		} catch (error) {
			await leaseKeeper.stop();
			if (error instanceof NodeShutdownError) {
				await this.#journal.updateDelivery(deliveryId, (current) => {
					current.last_error = error.message;
					current.updated_at = this.#now().toISOString();
				});
				return;
			}
			if (error instanceof AuthorityLostError) {
				await this.markLeaseLost(deliveryId, error);
				return;
			}
			const terminal = requireEntry(this.#journal, deliveryId).host_events.at(-1);
			if (terminal?.kind === "failed") {
				await this.releaseOrLoseLease(
					deliveryId,
					terminal.failure.class,
					terminal.failure.message,
					signal,
				);
				return;
			}
			if (terminal?.kind === "completed" && terminal.disposition.kind === "blocked") {
				await this.releaseOrLoseLease(
					deliveryId,
					"policy_denied",
					terminal.disposition.reason,
					signal,
				);
				return;
			}
			if (terminal?.kind === "completed" && terminal.disposition.kind === "failed") {
				await this.releaseOrLoseLease(
					deliveryId,
					terminal.disposition.class,
					`Host returned ${terminal.disposition.class} failure`,
					signal,
				);
				return;
			}
			if (terminal?.kind === "cancelled") {
				await this.releaseOrLoseLease(
					deliveryId,
					"transient",
					"Host turn was cancelled before producing a publishable result",
					signal,
				);
				return;
			}
			throw error;
		}
	}

	async claim(deliveryId: string, signal?: AbortSignal): Promise<void> {
		signal?.throwIfAborted();
		const entry = requireEntry(this.#journal, deliveryId);
		let intent = entry.operation;
		if (intent?.kind !== "claim") {
			const attempt = entry.claim_attempt + 1;
			intent = { kind: "claim", input: { idempotency_key: `claim:${deliveryId}:${attempt}` } };
			await this.#journal.updateDelivery(deliveryId, (current) => {
				current.claim_attempt = attempt;
				current.operation = intent;
				current.phase = "claim_intent";
				current.updated_at = this.#now().toISOString();
			});
			await this.#checkpoint("claim_intent", deliveryId);
		}
		signal?.throwIfAborted();
		const result = await this.#client.claim(deliveryId, intent.input);
		await this.#journal.updateDelivery(deliveryId, (current) => {
			current.operation = null;
			current.item =
				result.outcome === "claimed"
					? structuredClone(result.item)
					: { ...current.item, delivery: structuredClone(result.delivery) };
			current.phase = result.outcome === "claimed" ? "claimed" : "dead_lettered";
			current.updated_at = this.#now().toISOString();
		});
		await this.#checkpoint(
			result.outcome === "claimed" ? "claimed" : "release_recorded",
			deliveryId,
		);
	}

	async start(deliveryId: string, signal?: AbortSignal): Promise<void> {
		signal?.throwIfAborted();
		const entry = requireEntry(this.#journal, deliveryId);
		const lease = requireLease(entry.item.delivery);
		let intent = entry.operation;
		if (intent?.kind !== "start") {
			intent = {
				kind: "start",
				input: {
					idempotency_key: `start:${deliveryId}:${lease.fencing_token}`,
					lease_id: lease.lease_id,
					fencing_token: lease.fencing_token,
				},
			};
			await this.#journal.updateDelivery(deliveryId, (current) => {
				current.operation = intent;
				current.phase = "start_intent";
				current.updated_at = this.#now().toISOString();
			});
			await this.#checkpoint("start_intent", deliveryId);
		}
		let result: DeliveryStartResult;
		try {
			signal?.throwIfAborted();
			result = await this.#client.start(deliveryId, intent.input);
		} catch (error) {
			if (isDefinitiveAuthorityLoss(error)) throw new AuthorityLostError(safeError(error));
			throw error;
		}
		await this.#journal.updateDelivery(deliveryId, (current) => {
			current.item.delivery = structuredClone(result.delivery);
			current.operation = null;
			current.phase = "relay_executing";
			current.updated_at = this.#now().toISOString();
		});
		await this.#checkpoint("relay_executing", deliveryId);
	}

	async confirmLease(deliveryId: string, signal?: AbortSignal): Promise<LeaseWindow> {
		for (let renewal = 0; renewal < 2; renewal += 1) {
			signal?.throwIfAborted();
			const entry = requireEntry(this.#journal, deliveryId);
			const lease = requireLease(entry.item.delivery);
			let intent = entry.operation;
			if (intent?.kind !== "renew") {
				const count = entry.renew_count + 1;
				intent = {
					kind: "renew",
					input: {
						idempotency_key: `renew:${deliveryId}:${lease.fencing_token}:${count}`,
						lease_id: lease.lease_id,
						fencing_token: lease.fencing_token,
					},
				};
				await this.#journal.updateDelivery(deliveryId, (current) => {
					current.renew_count = count;
					current.operation = intent;
					current.updated_at = this.#now().toISOString();
				});
			}
			const requestStartedAt = this.#monotonicNow();
			try {
				signal?.throwIfAborted();
				const result = await this.#client.renew(deliveryId, intent.input);
				const responseReceivedAt = this.#monotonicNow();
				await this.#journal.updateDelivery(deliveryId, (current) => {
					current.item.delivery = structuredClone(result.delivery);
					current.operation = null;
					current.updated_at = this.#now().toISOString();
				});
				if (result.replayed) continue;
				return leaseWindowFromRenewal(result, requestStartedAt, responseReceivedAt);
			} catch (error) {
				if (isDefinitiveAuthorityLoss(error)) throw new AuthorityLostError(safeError(error));
				throw error;
			}
		}
		throw new Error("Relay returned two historical lease renewals without a fresh window");
	}

	async complete(
		deliveryId: string,
		result: NodeDeliveryResultPayload,
		signal?: AbortSignal,
	): Promise<void> {
		signal?.throwIfAborted();
		const entry = requireEntry(this.#journal, deliveryId);
		const lease = requireLease(entry.item.delivery);
		const intent: OperationIntent = {
			kind: "complete",
			input: {
				idempotency_key: `complete:${deliveryId}:${lease.fencing_token}`,
				lease_id: lease.lease_id,
				fencing_token: lease.fencing_token,
				result,
			},
		};
		await this.#journal.updateDelivery(deliveryId, (current) => {
			current.result = structuredClone(result);
			current.operation = intent;
			current.phase = "complete_intent";
			current.updated_at = this.#now().toISOString();
		});
		await this.#checkpoint("complete_intent", deliveryId);
		await this.publishCompletion(deliveryId, intent, signal);
	}

	async release(
		deliveryId: string,
		classification: "transient" | "permanent" | "policy_denied",
		summary: string,
		signal?: AbortSignal,
	): Promise<void> {
		signal?.throwIfAborted();
		const entry = requireEntry(this.#journal, deliveryId);
		const lease = requireLease(entry.item.delivery);
		const intent: OperationIntent = {
			kind: "release",
			input: {
				idempotency_key: `release:${deliveryId}:${lease.fencing_token}`,
				lease_id: lease.lease_id,
				fencing_token: lease.fencing_token,
				classification,
				summary: summary.slice(0, 2_000),
			},
		};
		await this.#journal.updateDelivery(deliveryId, (current) => {
			current.operation = intent;
			current.phase = "release_intent";
			current.last_error = summary.slice(0, 2_000);
			current.updated_at = this.#now().toISOString();
		});
		await this.#checkpoint("release_intent", deliveryId);
		await this.publishRelease(deliveryId, intent, signal);
	}

	private async reclaimLease(deliveryId: string, signal?: AbortSignal): Promise<boolean> {
		signal?.throwIfAborted();
		await this.#journal.updateDelivery(deliveryId, (current) => {
			current.phase = "lease_lost";
			current.operation = null;
			current.updated_at = this.#now().toISOString();
		});
		try {
			await this.claim(deliveryId, signal);
		} catch (error) {
			if (!isDefinitiveAuthorityLoss(error)) throw error;
			await this.cancelAndMarkAuthorityLost(deliveryId, error);
			return false;
		}
		return !isTerminal(requireEntry(this.#journal, deliveryId));
	}

	private async confirmLeaseWithReclaim(
		deliveryId: string,
		signal?: AbortSignal,
	): Promise<LeaseWindow> {
		try {
			return await this.confirmLease(deliveryId, signal);
		} catch (error) {
			if (!(error instanceof AuthorityLostError)) throw error;
			await this.markLeaseLost(deliveryId, error);
			if (!(await this.reclaimLease(deliveryId, signal))) {
				throw new AuthorityLostError(`Delivery cannot be reclaimed: ${deliveryId}`);
			}
			return this.confirmLease(deliveryId, signal);
		}
	}

	private async prepareExecutableLease(
		deliveryId: string,
		signal?: AbortSignal,
	): Promise<LeaseWindow> {
		for (let attempt = 0; attempt < 4; attempt += 1) {
			signal?.throwIfAborted();
			const window = await this.confirmLeaseWithReclaim(deliveryId, signal);
			const entry = requireEntry(this.#journal, deliveryId);
			if (entry.item.delivery.status === "executing") {
				if (window.expiresAtMonotonic - this.#monotonicNow() <= MIN_SAFE_LEASE_WINDOW_MS) {
					continue;
				}
				return window;
			}
			if (entry.item.delivery.status !== "leased") {
				throw new AuthorityLostError(
					`Delivery is not executable: ${deliveryId} (${entry.item.delivery.status})`,
				);
			}
			try {
				await this.start(deliveryId, signal);
			} catch (error) {
				if (!(error instanceof AuthorityLostError)) throw error;
				await this.markLeaseLost(deliveryId, error);
				if (!(await this.reclaimLease(deliveryId, signal))) {
					throw new AuthorityLostError(`Delivery cannot be reclaimed: ${deliveryId}`);
				}
			}
		}
		throw new AuthorityLostError(`Could not establish an executing lease: ${deliveryId}`);
	}

	private async releaseOrLoseLease(
		deliveryId: string,
		classification: "transient" | "permanent" | "policy_denied",
		summary: string,
		signal?: AbortSignal,
	): Promise<void> {
		try {
			await this.release(deliveryId, classification, summary, signal);
		} catch (error) {
			if (!(error instanceof AuthorityLostError)) throw error;
			await this.markLeaseLost(deliveryId, error);
		}
	}

	private async authorize(
		item: MissionDeliveryItem,
		signal?: AbortSignal,
	): Promise<NodeMissionAssignment> {
		signal?.throwIfAborted();
		const assignment = await this.#client.getAssignment(item.delivery.mission_id);
		signal?.throwIfAborted();
		if (assignment.participant_agent_id !== this.#config.node.agent_id) {
			throw new Error("Delivery Mission belongs to a different local agent");
		}
		if (
			assignment.coordinator_state.status !== "active" &&
			assignment.coordinator_state.status !== "verifying"
		) {
			throw new AuthorityLostError(
				`Mission is not executable: ${assignment.coordinator_state.status}`,
			);
		}
		const participant = missionParticipant(assignment, this.#config.node.agent_id);
		if (!Object.hasOwn(this.#config.workspaces, participant.workspace_alias)) {
			throw new WorkspacePreflightError(
				"invalid_workspace_config",
				`Unconfigured workspace: ${participant.workspace_alias}`,
			);
		}
		const workspace = this.#config.workspaces[participant.workspace_alias]!;
		if (workspace.policy_profile !== participant.requested_local_policy_profile) {
			throw new PolicyError(
				"policy_profile_not_found",
				`Workspace does not grant policy: ${participant.requested_local_policy_profile}`,
			);
		}
		const policy = resolvePolicyProfile(
			this.#config.policy_profiles,
			participant.requested_local_policy_profile,
		);
		const acceptedGrant = assignment.acceptance_receipt?.local_policy_grant;
		if (
			assignment.acceptance_status !== "accepted" ||
			acceptedGrant?.profile_name !== policy.grant.profile_name ||
			acceptedGrant.grant_sha256 !== policy.grant.grant_sha256
		) {
			throw new PolicyError(
				"policy_profile_not_found",
				"Current local policy no longer matches the accepted Mission grant",
			);
		}
		await this.#preflight(workspace, participant);
		return assignment;
	}

	private async cancelHostExecution(
		deliveryId: string,
		executionAttempt: number,
		knownTurn: HostTurnRef | null,
	): Promise<void> {
		const activeTurn = knownTurn ?? (await this.#adapter.lookupTurn(deliveryId, executionAttempt));
		if (activeTurn !== null) await this.#adapter.cancelTurn(activeTurn);
	}

	private async cancelHostExecutionBounded(
		deliveryId: string,
		executionAttempt: number,
		knownTurn: HostTurnRef | null,
	): Promise<void> {
		await runBoundedAbort(() => this.cancelHostExecution(deliveryId, executionAttempt, knownTurn));
	}

	private async publishCompletion(
		deliveryId: string,
		intent: OperationIntent,
		signal?: AbortSignal,
	): Promise<void> {
		if (intent.kind !== "complete") throw new Error("Expected a completion intent");
		try {
			signal?.throwIfAborted();
			const result = await this.#client.complete(deliveryId, intent.input);
			await this.#journal.updateDelivery(deliveryId, (current) => {
				current.item.delivery = structuredClone(result.delivery);
				current.operation = null;
				current.phase = "acknowledged";
				current.last_error = null;
				current.updated_at = this.#now().toISOString();
			});
			await this.#checkpoint("acknowledged", deliveryId);
		} catch (error) {
			if (isDefinitiveAuthorityLoss(error)) throw new AuthorityLostError(safeError(error));
			throw error;
		}
	}

	private async publishRelease(
		deliveryId: string,
		intent: OperationIntent,
		signal?: AbortSignal,
	): Promise<void> {
		if (intent.kind !== "release") throw new Error("Expected a release intent");
		let result: DeliveryReleaseResult;
		try {
			signal?.throwIfAborted();
			result = await this.#client.release(deliveryId, intent.input);
		} catch (error) {
			if (isDefinitiveAuthorityLoss(error)) throw new AuthorityLostError(safeError(error));
			throw error;
		}
		await this.#journal.updateDelivery(deliveryId, (current) => {
			if (result.delivery.status === "stored") archiveHostExecution(current, this.#now());
			current.item.delivery = structuredClone(result.delivery);
			current.operation = null;
			current.phase = result.delivery.status === "dead_lettered" ? "dead_lettered" : "ingested";
			current.updated_at = this.#now().toISOString();
		});
		await this.#checkpoint("release_recorded", deliveryId);
	}

	private async cancelAndMarkAuthorityLost(deliveryId: string, error: unknown): Promise<void> {
		const entry = requireEntry(this.#journal, deliveryId);
		if (entry.phase === "authority_lost") return;
		await this.cancelHostExecutionBounded(
			deliveryId,
			entry.execution_attempt,
			journaledHostTurn(entry),
		);
		await this.markAuthorityLost(deliveryId, error);
	}

	private async markAuthorityLost(deliveryId: string, error: unknown): Promise<void> {
		await this.#journal.updateDelivery(deliveryId, (current) => {
			current.phase = "authority_lost";
			current.operation = null;
			current.last_error = safeError(error);
			current.updated_at = this.#now().toISOString();
		});
	}

	private async markLeaseLost(deliveryId: string, error: unknown): Promise<void> {
		await this.#journal.updateDelivery(deliveryId, (current) => {
			current.phase = "lease_lost";
			current.operation = null;
			current.last_error = safeError(error);
			current.updated_at = this.#now().toISOString();
		});
	}

	private async deferRetry(deliveryId: string, availableAt: string, error: unknown): Promise<void> {
		await this.#journal.updateDelivery(deliveryId, (current) => {
			current.item.delivery.available_at = availableAt;
			current.phase = "ingested";
			current.operation = null;
			current.last_error = safeError(error);
			current.updated_at = this.#now().toISOString();
		});
	}
}

interface ConsumeHostEventsOptions {
	readonly deliveryId: string;
	readonly stream: AsyncIterable<HostEvent>;
	readonly journal: NodeJournal;
	readonly expectedInput: StartTurnInput;
	readonly policy: HostEventStreamPolicy;
	readonly now: () => Date;
	readonly onAccepted: (turn: HostTurnRef) => Promise<void>;
	readonly onTerminal: () => void | Promise<void>;
	readonly assertAuthority: () => void;
	readonly authorityFailure: Promise<never>;
	readonly signal?: AbortSignal;
	readonly onAbort: () => Promise<void>;
}

async function consumeHostEvents(options: ConsumeHostEventsOptions): Promise<readonly HostEvent[]> {
	const events = requireEntry(options.journal, options.deliveryId).host_events;
	const expectedTurn = events[0]?.turn ?? {
		sessionId: options.expectedInput.session.sessionId,
		missionId: options.expectedInput.missionId,
		deliveryId: options.expectedInput.deliveryId,
		executionAttempt: options.expectedInput.executionAttempt,
		contractVersion: options.expectedInput.contractVersion,
	};
	let state = createHostEventStreamState(expectedTurn);
	for (const event of events) state = acceptHostEvent(state, event, options.policy).state;

	const iterator = options.stream[Symbol.asyncIterator]();
	while (true) {
		options.assertAuthority();
		const next = await nextHostEvent(
			iterator,
			options.signal,
			options.onAbort,
			options.authorityFailure,
		);
		if (next.done) break;
		const eventInput = next.value;
		options.assertAuthority();
		const replayed = events[eventInput.sequence - 1];
		if (replayed !== undefined) {
			if (!isDeepStrictEqual(replayed, eventInput)) {
				throw new Error(`host replay changed event sequence ${eventInput.sequence}`);
			}
			continue;
		}
		const accepted = acceptHostEvent(state, eventInput, options.policy);
		state = accepted.state;
		await options.journal.updateDelivery(options.deliveryId, (entry) => {
			entry.host_events.push(structuredClone(accepted.event));
			entry.phase =
				accepted.event.kind === "accepted"
					? "host_accepted"
					: state.phase === "terminal"
						? "host_terminal"
						: entry.phase;
			entry.updated_at = options.now().toISOString();
		});
		events.push(structuredClone(accepted.event));
		if (accepted.event.kind === "accepted") await options.onAccepted(accepted.event.turn);
		if (state.phase === "terminal") await options.onTerminal();
	}
	if (state.phase !== "terminal")
		throw new Error("host event stream ended before a terminal event");
	return requireEntry(options.journal, options.deliveryId).host_events;
}

async function nextHostEvent(
	iterator: AsyncIterator<HostEvent>,
	signal: AbortSignal | undefined,
	onAbort: () => Promise<void>,
	authorityFailure: Promise<never>,
): Promise<IteratorResult<HostEvent>> {
	return waitForHostOperation(() => iterator.next(), signal, onAbort, authorityFailure);
}

async function waitForHostOperation<T>(
	operation: () => Promise<T>,
	signal: AbortSignal | undefined,
	onAbort: () => Promise<void>,
	authorityFailure: Promise<never>,
): Promise<T> {
	if (signal?.aborted) {
		await runBoundedAbort(onAbort);
		throw new NodeShutdownError();
	}
	const started = operation();
	if (signal === undefined) return Promise.race([started, authorityFailure]);

	let abortListener!: () => void;
	let abortStarted = false;
	const aborted = new Promise<never>((_resolve, reject) => {
		abortListener = () => {
			if (abortStarted) return;
			abortStarted = true;
			void runBoundedAbort(onAbort).finally(() => reject(new NodeShutdownError()));
		};
		signal.addEventListener("abort", abortListener, { once: true });
		if (signal.aborted) abortListener();
	});
	try {
		return await Promise.race([started, aborted, authorityFailure]);
	} finally {
		signal.removeEventListener("abort", abortListener);
	}
}

async function assertHostOperationAllowed(
	signal: AbortSignal | undefined,
	onAbort: () => Promise<void>,
): Promise<void> {
	if (!signal?.aborted) return;
	await runBoundedAbort(onAbort);
	throw new NodeShutdownError();
}

async function runBoundedAbort(onAbort: () => Promise<void>): Promise<void> {
	const timeout = new AbortController();
	try {
		await Promise.race([
			onAbort().catch(() => undefined),
			delay(HOST_ABORT_GRACE_MS, undefined, { signal: timeout.signal }).catch(() => undefined),
		]);
	} finally {
		timeout.abort();
	}
}

function startTurnInput(
	item: MissionDeliveryItem,
	assignment: NodeMissionAssignment,
	session: StartTurnInput["session"],
	executionAttempt: number,
): StartTurnInput {
	const missionInputs = deriveHostMissionInputs(
		assignment.coordinator_config.mission_context,
		assignment.participant_agent_id,
	);
	return {
		session,
		missionId: assignment.mission_id,
		deliveryId: item.delivery.delivery_id,
		executionAttempt,
		contractVersion: item.delivery.contract_version,
		missionSequence: assignment.coordinator_state.sequence_no + 1,
		objective: missionInputs.objective,
		assignment: missionInputs.assignment,
		acceptanceCriteria: [...missionInputs.acceptanceCriteria],
		peerMessages: assignment.coordinator_state.messages
			.filter((message) => message.author_agent_id !== assignment.participant_agent_id)
			.slice(-MAX_HOST_PEER_MESSAGES)
			.map((message) => ({
				messageId: message.message_id,
				authorAgentId: message.author_agent_id,
				kind: message.type,
				body: message.body,
			})),
		// Relay artifact payload carriage is deliberately not claimed by this fake-runtime slice.
		artifacts: [],
	};
}

function archiveHostExecution(entry: JournalDelivery, now: Date): void {
	if (entry.start_turn_input !== null || entry.host_events.length > 0 || entry.result !== null) {
		if (entry.start_turn_input === null) {
			throw new Error("Cannot archive host execution without its exact start input");
		}
		entry.host_attempt_history.push({
			execution_attempt: entry.execution_attempt,
			start_input_sha256: startTurnInputDigest(entry.start_turn_input),
			host_events: structuredClone(entry.host_events),
			result: entry.result === null ? null : structuredClone(entry.result),
			archived_at: now.toISOString(),
		});
	}
	entry.execution_attempt += 1;
	entry.start_turn_input = null;
	entry.host_events = [];
	entry.result = null;
}

interface LeaseKeeperOptions {
	readonly deliveryId: string;
	readonly client: NodeRelayClient;
	readonly journal: NodeJournal;
	readonly now: () => Date;
	readonly monotonicNow: () => number;
	readonly onAuthorityLost: () => Promise<void>;
	readonly shutdownSignal?: AbortSignal;
}

interface LeaseWindow {
	readonly lease: DeliveryLease;
	readonly renewAtMonotonic: number;
	readonly expiresAtMonotonic: number;
}

class LeaseKeeper {
	readonly #options: LeaseKeeperOptions;
	readonly #abort = new AbortController();
	readonly #failureNotice: Promise<void>;
	#notifyFailure!: () => void;
	#loop: Promise<void> | null = null;
	#failure: Error | null = null;

	constructor(options: LeaseKeeperOptions) {
		this.#options = options;
		this.#failureNotice = new Promise((resolve) => {
			this.#notifyFailure = resolve;
		});
	}

	start(window: LeaseWindow): void {
		if (this.#loop !== null) throw new Error("lease keeper already started");
		this.#loop = this.run(window);
	}

	async stop(): Promise<void> {
		this.#abort.abort();
		await this.#loop;
	}

	assertHealthy(): void {
		if (this.#failure === null) return;
		if (this.#failure instanceof AuthorityLostError || isDefinitiveAuthorityLoss(this.#failure)) {
			throw new AuthorityLostError(this.#failure.message);
		}
		throw this.#failure;
	}

	failure(): Promise<never> {
		return this.#failureNotice.then(() => {
			this.assertHealthy();
			throw new Error("Lease keeper reported a failure without an error");
		});
	}

	private async run(initialWindow: LeaseWindow): Promise<void> {
		let window = initialWindow;
		while (!this.#abort.signal.aborted) {
			try {
				await delay(
					Math.max(0, window.renewAtMonotonic - this.#options.monotonicNow()),
					undefined,
					{ signal: this.#abort.signal },
				);
			} catch (error) {
				if (this.#abort.signal.aborted) return;
				throw error;
			}
			try {
				this.#options.shutdownSignal?.throwIfAborted();
				const entry = requireEntry(this.#options.journal, this.#options.deliveryId);
				const current = requireLease(entry.item.delivery);
				if (
					current.lease_id !== window.lease.lease_id ||
					current.fencing_token !== window.lease.fencing_token
				) {
					throw new AuthorityLostError("Lease authority changed while host turn was active");
				}
				const count = entry.renew_count + 1;
				const input = {
					idempotency_key: `renew:${this.#options.deliveryId}:${window.lease.fencing_token}:${count}`,
					lease_id: window.lease.lease_id,
					fencing_token: window.lease.fencing_token,
				};
				await this.#options.journal.updateDelivery(this.#options.deliveryId, (candidate) => {
					candidate.renew_count = count;
					candidate.operation = { kind: "renew", input };
					candidate.updated_at = this.#options.now().toISOString();
				});
				this.#options.shutdownSignal?.throwIfAborted();
				const requestStartedAt = this.#options.monotonicNow();
				const renewed = await this.#options.client.renew(this.#options.deliveryId, input);
				const responseReceivedAt = this.#options.monotonicNow();
				window = leaseWindowFromRenewal(renewed, requestStartedAt, responseReceivedAt);
				await this.#options.journal.updateDelivery(this.#options.deliveryId, (candidate) => {
					candidate.item.delivery = structuredClone(renewed.delivery);
					candidate.operation = null;
					candidate.updated_at = this.#options.now().toISOString();
				});
			} catch (error) {
				this.#failure = error instanceof Error ? error : new Error(String(error));
				this.#notifyFailure();
				await runBoundedAbort(this.#options.onAuthorityLost);
				return;
			}
		}
	}
}

class AuthorityLostError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AuthorityLostError";
	}
}

class NodeShutdownError extends Error {
	constructor() {
		super("Node shutdown requested while a host turn was active");
		this.name = "NodeShutdownError";
	}
}

function missionParticipant(assignment: NodeMissionAssignment, agentId: string) {
	const participant = assignment.coordinator_config.mission_context.manifest.participants.find(
		(candidate) => candidate.agent_id === agentId,
	);
	if (!participant) throw new Error(`Agent is not a Mission participant: ${agentId}`);
	return participant;
}

function journaledHostTurn(entry: JournalDelivery): HostTurnRef | null {
	const accepted = entry.host_events.find((event) => event.kind === "accepted");
	return accepted?.turn ?? null;
}

function requireEntry(journal: NodeJournal, deliveryId: string): JournalDelivery {
	const entry = journal.snapshot().deliveries[deliveryId];
	if (!entry) throw new Error(`delivery is not journaled: ${deliveryId}`);
	return entry;
}

function requireLease(delivery: Delivery): DeliveryLease {
	if (
		(delivery.status !== "leased" && delivery.status !== "executing") ||
		delivery.lease === null
	) {
		throw new AuthorityLostError(`delivery has no active lease: ${delivery.delivery_id}`);
	}
	return delivery.lease;
}

function leaseWindowFromRenewal(
	result: {
		readonly delivery: Delivery;
		readonly receipt: {
			readonly recorded_at: string;
			readonly lease_expires_at: string | null;
		};
	},
	requestStartedAt: number,
	responseReceivedAt: number,
): LeaseWindow {
	const lease = requireLease(result.delivery);
	if (result.receipt.lease_expires_at !== lease.expires_at) {
		throw new Error("Relay renewal receipt does not match its delivery lease deadline");
	}
	const grantedMs = Date.parse(lease.expires_at) - Date.parse(result.receipt.recorded_at);
	const elapsedMs = Math.max(0, responseReceivedAt - requestStartedAt);
	const safeRemainingMs = grantedMs - Math.ceil(elapsedMs);
	if (!Number.isFinite(safeRemainingMs) || safeRemainingMs <= MIN_SAFE_LEASE_WINDOW_MS) {
		throw new AuthorityLostError("Relay returned no safe lease window for host execution");
	}
	return {
		lease,
		renewAtMonotonic: responseReceivedAt + Math.floor(safeRemainingMs / 2),
		expiresAtMonotonic: requestStartedAt + grantedMs,
	};
}

function isTerminal(entry: JournalDelivery): boolean {
	return (
		TERMINAL_PHASES.has(entry.phase) ||
		entry.item.delivery.status === "acknowledged" ||
		entry.item.delivery.status === "cancelled" ||
		entry.item.delivery.status === "dead_lettered"
	);
}

function isAvailable(entry: JournalDelivery, now: Date): boolean {
	return (
		entry.item.delivery.status !== "stored" ||
		Date.parse(entry.item.delivery.available_at) <= now.getTime()
	);
}

function isDefinitiveAuthorityLoss(error: unknown): boolean {
	return (
		error instanceof RelayHttpError &&
		(error.status === 401 || error.status === 403 || error.status === 409)
	);
}

function retryAvailableAt(error: unknown): string | null {
	if (
		!(error instanceof RelayHttpError) ||
		error.status !== 409 ||
		error.code !== "state_changed" ||
		typeof error.details.available_at !== "string" ||
		!Number.isFinite(Date.parse(error.details.available_at))
	) {
		return null;
	}
	return error.details.available_at;
}

function safeError(error: unknown): string {
	return (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
}

function compareCursor(left: string, right: string): number {
	if (left.length !== right.length) return left.length < right.length ? -1 : 1;
	return left === right ? 0 : left < right ? -1 : 1;
}
