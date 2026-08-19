import { isDeepStrictEqual } from "node:util";
import type {
	AdapterInfo,
	Delivery,
	DeliveryLease,
	NodeMissionAssignment,
} from "@agentrelay/protocol";
import { JournalCompareAndSwapError, type JournalDelivery, type NodeJournal } from "./journal.js";
import type { ResolvedPolicyProfile } from "./policy.js";
import { createRuntimeAuthorityGrant } from "./runtime-authority-factory.js";
import type { RuntimeAuthorityPort } from "./runtime-authority-port.js";
import {
	NodeRuntimeAuthoritySession,
	RuntimeAuthorityRetirementError,
} from "./runtime-authority-session.js";
import type {
	RuntimeAuthorityEvidenceSink,
	RuntimeAuthorityGrant,
	RuntimeAuthorityRenewal,
} from "./runtime-authority.js";
import type { WorkspaceAuthorityResource } from "./workspace.js";

// Durable decision storage is owned by #99. The Capsule records its own remote
// decisions; this sink keeps the Node-side monitor free of payload logs.
const NOOP_EVIDENCE: RuntimeAuthorityEvidenceSink = { record: () => undefined };

export interface DeliveryRuntimeAuthorityInput {
	readonly assignment: NodeMissionAssignment;
	readonly workspaceAlias: string;
	readonly workspace: WorkspaceAuthorityResource;
	readonly policy: ResolvedPolicyProfile;
	readonly adapter: AdapterInfo;
	readonly entry: JournalDelivery;
}

export interface DeliveryRuntimeAuthorityInstallHooks {
	readonly abortSignal?: AbortSignal;
	readonly beforeRemoteInstall?: (session: NodeRuntimeAuthoritySession) => void | Promise<void>;
	readonly beforeReady?: (session: NodeRuntimeAuthoritySession) => void | Promise<void>;
}

export class RuntimeAuthorityTransitionPendingError extends Error {
	constructor(message: string, options: ErrorOptions = {}) {
		super(message, options);
		this.name = "RuntimeAuthorityTransitionPendingError";
	}
}

/** Reconstructs and installs the exact private authority for one delivery attempt. */
export class DeliveryRuntimeAuthority {
	readonly #nodeId: string;
	readonly #journal: NodeJournal;
	readonly #port: RuntimeAuthorityPort | undefined;
	readonly #now: () => Date;
	readonly #evidenceSink: RuntimeAuthorityEvidenceSink;

	constructor(options: {
		readonly nodeId: string;
		readonly journal: NodeJournal;
		readonly port?: RuntimeAuthorityPort;
		readonly now: () => Date;
		readonly evidenceSink?: RuntimeAuthorityEvidenceSink;
	}) {
		this.#nodeId = options.nodeId;
		this.#journal = options.journal;
		this.#port = options.port;
		this.#now = options.now;
		this.#evidenceSink = options.evidenceSink ?? NOOP_EVIDENCE;
	}

	get enabled(): boolean {
		return this.#port !== undefined;
	}

	/** Retires the exact durable grant before its journal proof may be discarded. */
	async retireJournaled(deliveryId: string): Promise<void> {
		for (let attempt = 0; attempt < 4; attempt += 1) {
			const current = requireJournaledDelivery(this.#journal, deliveryId);
			const active = current.runtime_authority;
			const predecessor = current.runtime_authority_predecessor;
			const grant = predecessor ?? active;
			if (grant === null) return;
			const port = this.#port;
			if (port === undefined) {
				throw new RuntimeAuthorityTransitionPendingError(
					"Journaled runtime authority has no local retirement port",
				);
			}
			try {
				await port.revokeAuthority(grant, "revoked");
			} catch (error) {
				throw new RuntimeAuthorityTransitionPendingError(
					`Capsule retirement is not yet proven: ${safeError(error)}`,
					{ cause: error },
				);
			}
			try {
				await this.#journal.updateDelivery(deliveryId, (entry) => {
					if (
						!isDeepStrictEqual(entry.runtime_authority, active) ||
						!isDeepStrictEqual(entry.runtime_authority_predecessor, predecessor)
					) {
						throw new JournalCompareAndSwapError(
							`Runtime authority changed before retirement checkpoint: ${deliveryId}`,
						);
					}
					entry.runtime_authority = null;
					entry.runtime_authority_predecessor = null;
					entry.updated_at = this.#now().toISOString();
				});
				return;
			} catch (error) {
				if (error instanceof JournalCompareAndSwapError) continue;
				throw error;
			}
		}
		throw new RuntimeAuthorityTransitionPendingError(
			"Runtime authority changed repeatedly during retirement",
		);
	}

	async install(
		input: DeliveryRuntimeAuthorityInput,
		hooks: DeliveryRuntimeAuthorityInstallHooks = {},
	): Promise<NodeRuntimeAuthoritySession | null> {
		const port = this.#port;
		if (port === undefined) return null;
		const grant = await this.resolveGrant(input, port);
		try {
			return await NodeRuntimeAuthoritySession.install({
				port,
				grant,
				currentLease: currentRenewal(
					grant,
					requireJournaledDelivery(this.#journal, grant.delivery_id),
				),
				readCurrentLease: () =>
					currentRenewal(grant, requireJournaledDelivery(this.#journal, grant.delivery_id)),
				...(hooks.abortSignal === undefined ? {} : { abortSignal: hooks.abortSignal }),
				...(hooks.beforeRemoteInstall === undefined
					? {}
					: { beforeRemoteInstall: hooks.beforeRemoteInstall }),
				...(hooks.beforeReady === undefined ? {} : { beforeReady: hooks.beforeReady }),
				evidenceSink: this.#evidenceSink,
				now: this.#now,
			});
		} catch (error) {
			if (error instanceof RuntimeAuthorityRetirementError) {
				throw new RuntimeAuthorityTransitionPendingError(
					"Capsule retirement after runtime authority installation is not yet proven",
					{ cause: error },
				);
			}
			throw error;
		}
	}

	private async resolveGrant(
		input: DeliveryRuntimeAuthorityInput,
		port: RuntimeAuthorityPort,
	): Promise<RuntimeAuthorityGrant> {
		const deliveryId = input.entry.item.delivery.delivery_id;
		for (let attempt = 0; attempt < 4; attempt += 1) {
			let current = requireJournaledDelivery(this.#journal, deliveryId);
			let persisted = current.runtime_authority;
			let predecessor = current.runtime_authority_predecessor;
			let lease = requireActiveLease(current.item.delivery);
			if (
				persisted !== null &&
				(persisted.lease_id !== lease.lease_id || persisted.fencing_token !== lease.fencing_token)
			) {
				throw new Error("Persisted runtime authority does not match the current Relay fence");
			}
			if (predecessor !== null) {
				try {
					await port.revokeAuthority(predecessor, "revoked");
				} catch (error) {
					throw new RuntimeAuthorityTransitionPendingError(
						`Predecessor Capsule retirement is not yet proven: ${safeError(error)}`,
						{ cause: error },
					);
				}
				const expectedPredecessorId = predecessor.grant_id;
				current = requireJournaledDelivery(this.#journal, deliveryId);
				persisted = current.runtime_authority;
				predecessor = current.runtime_authority_predecessor;
				if (persisted !== null || predecessor?.grant_id !== expectedPredecessorId) continue;
				lease = requireActiveLease(current.item.delivery);
			}
			const retained = persisted ?? predecessor;
			const compiled = createRuntimeAuthorityGrant({
				assignment: input.assignment,
				delivery: authoritySeedDelivery(current, persisted),
				executionAttempt: current.execution_attempt,
				nodeId: this.#nodeId,
				workspaceAlias: input.workspaceAlias,
				workspace: input.workspace,
				policy: input.policy,
				adapter: input.adapter,
				now: this.#now(),
				currentLeaseExpiresAt: lease.expires_at,
				...(retained === null ? {} : { retainedHardExpiresAt: retained.hard_expires_at }),
			});
			if (persisted !== null) {
				if (!isDeepStrictEqual(persisted, compiled)) {
					throw new Error("Persisted runtime authority no longer matches trusted local inputs");
				}
				return persisted;
			}
			try {
				return await this.#journal.checkpointRuntimeAuthority(deliveryId, compiled, this.#now(), {
					lease_id: lease.lease_id,
					fencing_token: lease.fencing_token,
					lease_expires_at: lease.expires_at,
					active_grant_id: null,
					predecessor_grant_id: predecessor?.grant_id ?? null,
				});
			} catch (error) {
				if (error instanceof JournalCompareAndSwapError) continue;
				throw error;
			}
		}
		throw new RuntimeAuthorityTransitionPendingError(
			"Runtime authority inputs did not stabilize before checkpoint",
		);
	}
}

function safeError(error: unknown): string {
	return (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
}

function authoritySeedDelivery(
	entry: JournalDelivery,
	persisted: RuntimeAuthorityGrant | null,
): Delivery {
	if (persisted === null) return entry.item.delivery;
	const lease = requireActiveLease(entry.item.delivery);
	return {
		...entry.item.delivery,
		lease: { ...lease, expires_at: persisted.lease_expires_at },
	};
}

function currentRenewal(
	grant: RuntimeAuthorityGrant,
	entry: JournalDelivery,
): RuntimeAuthorityRenewal {
	const lease = requireActiveLease(entry.item.delivery);
	if (lease.lease_id !== grant.lease_id || lease.fencing_token !== grant.fencing_token) {
		throw new Error("Current Relay lease does not match persisted runtime authority");
	}
	if (Date.parse(lease.expires_at) < Date.parse(grant.lease_expires_at)) {
		throw new Error("Current Relay lease is older than persisted runtime authority");
	}
	return {
		grant_id: grant.grant_id,
		lease_id: lease.lease_id,
		fencing_token: lease.fencing_token,
		lease_expires_at: lease.expires_at,
	};
}

function requireActiveLease(delivery: Delivery): DeliveryLease {
	if (
		(delivery.status !== "leased" && delivery.status !== "executing") ||
		delivery.lease === null
	) {
		throw new Error(`Delivery has no active authority lease: ${delivery.delivery_id}`);
	}
	return delivery.lease;
}

function requireJournaledDelivery(journal: NodeJournal, deliveryId: string): JournalDelivery {
	const entry = journal.snapshot().deliveries[deliveryId];
	if (entry === undefined) throw new Error(`Delivery is not journaled: ${deliveryId}`);
	return entry;
}
