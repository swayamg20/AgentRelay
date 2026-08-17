import { isDeepStrictEqual } from "node:util";
import type {
	AdapterInfo,
	Delivery,
	DeliveryLease,
	NodeMissionAssignment,
} from "@agentrelay/protocol";
import type { JournalDelivery, NodeJournal } from "./journal.js";
import type { ResolvedPolicyProfile } from "./policy.js";
import { createRuntimeAuthorityGrant } from "./runtime-authority-factory.js";
import type { RuntimeAuthorityPort } from "./runtime-authority-port.js";
import { NodeRuntimeAuthoritySession } from "./runtime-authority-session.js";
import type {
	RuntimeAuthorityEvidenceSink,
	RuntimeAuthorityGrant,
	RuntimeAuthorityRenewal,
} from "./runtime-authority.js";
import type { WorkspacePreflightResult } from "./workspace.js";

// Durable decision storage is owned by #99. The Capsule records its own remote
// decisions; this sink keeps the Node-side monitor free of payload logs.
const NOOP_EVIDENCE: RuntimeAuthorityEvidenceSink = { record: () => undefined };

export interface DeliveryRuntimeAuthorityInput {
	readonly assignment: NodeMissionAssignment;
	readonly workspaceAlias: string;
	readonly workspace: WorkspacePreflightResult;
	readonly policy: ResolvedPolicyProfile;
	readonly adapter: AdapterInfo;
	readonly entry: JournalDelivery;
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

	async install(input: DeliveryRuntimeAuthorityInput): Promise<NodeRuntimeAuthoritySession | null> {
		if (this.#port === undefined) return null;
		const grant = await this.resolveGrant(input);
		return NodeRuntimeAuthoritySession.install({
			port: this.#port,
			grant,
			currentLease: currentRenewal(
				grant,
				requireJournaledDelivery(this.#journal, grant.delivery_id),
			),
			evidenceSink: this.#evidenceSink,
			now: this.#now,
		});
	}

	private async resolveGrant(input: DeliveryRuntimeAuthorityInput): Promise<RuntimeAuthorityGrant> {
		const persisted = input.entry.runtime_authority;
		const lease = requireActiveLease(input.entry.item.delivery);
		if (
			persisted !== null &&
			(persisted.lease_id !== lease.lease_id || persisted.fencing_token !== lease.fencing_token)
		) {
			throw new Error("Persisted runtime authority does not match the current Relay fence");
		}
		const compiled = createRuntimeAuthorityGrant({
			assignment: input.assignment,
			delivery: authoritySeedDelivery(input.entry, persisted),
			executionAttempt: input.entry.execution_attempt,
			nodeId: this.#nodeId,
			workspaceAlias: input.workspaceAlias,
			workspace: input.workspace,
			policy: input.policy,
			adapter: input.adapter,
			now: this.#now(),
			currentLeaseExpiresAt: lease.expires_at,
			...(persisted === null ? {} : { retainedHardExpiresAt: persisted.hard_expires_at }),
		});
		if (persisted !== null) {
			if (!isDeepStrictEqual(persisted, compiled)) {
				throw new Error("Persisted runtime authority no longer matches trusted local inputs");
			}
			return persisted;
		}
		return this.#journal.checkpointRuntimeAuthority(
			input.entry.item.delivery.delivery_id,
			compiled,
			this.#now(),
		);
	}
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
