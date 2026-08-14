import { randomUUID } from "node:crypto";
import type { DeliveryClaimResult, MissionCoordinatorConfig } from "@agentrelay/protocol";
import { eq, sql } from "drizzle-orm";
import { nodeDeliveries } from "../db/schema.js";
import type { TestDb } from "../db/test-utils.js";
import { registerAgentWithInitialKey } from "./agent-registration.js";
import {
	claimDelivery,
	completeDelivery,
	listAvailableDeliveryEvents,
	startDelivery,
} from "./delivery-ledger.js";
import { acceptMissionParticipant, createMissionLedger } from "./mission-ledger.js";
import { type NodeCredentialContext, enrollNode, registerWorkspace } from "./node-enrollment.js";

export const TEST_KEY_PEPPER = "p".repeat(32);

export interface ParticipantFixture {
	readonly agentId: string;
	readonly nodeId: string;
	readonly auth: NodeCredentialContext;
}

export interface DeliveryFixture {
	readonly missionId: string;
	readonly config: MissionCoordinatorConfig;
	readonly contract: MissionCoordinatorConfig["mission_context"]["manifest"]["shared_contract"];
	readonly backend: ParticipantFixture;
	readonly android: ParticipantFixture;
	readonly initialDeliveryId: string;
}

export async function createActivatedFixture(
	handle: TestDb,
	options: {
		readonly backendCommands?: readonly string[];
		readonly missionLifetimeMs?: number;
	} = {},
): Promise<DeliveryFixture> {
	const backend = await registerParticipant(handle, {
		role: "backend",
		nodeName: "backend-mac",
		workspaceAlias: "backend-api",
		repositoryUrl: "https://github.com/acme/backend.git",
	});
	const android = await registerParticipant(handle, {
		role: "android",
		nodeName: "android-mac",
		workspaceAlias: "android-app",
		repositoryUrl: "https://github.com/acme/android.git",
	});
	const now = await databaseNow(handle);
	const missionId = randomUUID();
	const contract: DeliveryFixture["contract"] = {
		artifact_id: randomUUID(),
		type: "api_contract",
		version: 1,
		sha256: "a".repeat(64),
		media_type: "application/json",
		byte_size: 128,
	};
	const config: MissionCoordinatorConfig = {
		mission_context: {
			manifest: {
				schema_version: 1,
				mission_id: missionId,
				objective: "Ship one compatible profile contract across backend and Android",
				public_acceptance_criteria: ["Both repository checks pass"],
				participants: [
					{
						agent_id: backend.agentId,
						role: "backend",
						workspace_alias: "backend-api",
						repository_url: "https://github.com/acme/backend.git",
						expected_base_commit: "1".repeat(40),
						initial_assignment: "Implement the response contract",
						requested_local_policy_profile: "bounded-code",
					},
					{
						agent_id: android.agentId,
						role: "android",
						workspace_alias: "android-app",
						repository_url: "https://github.com/acme/android.git",
						expected_base_commit: "2".repeat(40),
						initial_assignment: "Consume the response contract",
						requested_local_policy_profile: "bounded-code",
					},
				],
				shared_contract: contract,
				max_turns: 20,
				max_wall_time_seconds: 3_600,
				token_budget: 100_000,
				expires_at: new Date(
					now.getTime() + (options.missionLifetimeMs ?? 3_600_000),
				).toISOString(),
				allowed_artifact_types: ["api_contract"],
				created_at: new Date(now.getTime() - 1_000).toISOString(),
			},
			created_by: { principal_id: backend.agentId, kind: "agent" },
		},
		required_verification_commands: {
			[backend.agentId]: [...(options.backendCommands ?? ["backend-test"])],
			[android.agentId]: ["android-test"],
		},
	};

	await createMissionLedger(handle.db, {
		createdByAgentId: backend.agentId,
		coordinatorConfig: config,
	});
	await acceptMissionParticipant(handle.db, {
		missionId,
		participantAgentId: backend.agentId,
		nodeAuth: backend.auth,
		acceptance: participantAcceptance(contract, "accept:backend", "d"),
	});
	await acceptMissionParticipant(handle.db, {
		missionId,
		participantAgentId: android.agentId,
		nodeAuth: android.auth,
		acceptance: participantAcceptance(contract, "accept:android", "e"),
	});

	const initial = await onlyAvailableDelivery(handle, backend.nodeId, "turn");
	return {
		missionId,
		config,
		contract,
		backend,
		android,
		initialDeliveryId: initial.delivery_id,
	};
}

async function registerParticipant(
	handle: TestDb,
	input: {
		readonly role: "backend" | "android";
		readonly nodeName: string;
		readonly workspaceAlias: string;
		readonly repositoryUrl: string;
	},
): Promise<ParticipantFixture> {
	const suffix = randomUUID();
	const registration = await registerAgentWithInitialKey(handle.db, {
		handle: `${input.role}-${suffix}@agentrelay.test`,
		email: `${input.role}-${suffix}@agentrelay.test`,
		displayName: input.role === "backend" ? "Backend" : "Android",
		role: input.role,
		pepper: TEST_KEY_PEPPER,
		keyEnvironment: "test",
	});
	const enrollment = await enrollNode(
		handle.db,
		registration.agent.id,
		{ name: input.nodeName, capabilities: ["missions.execute"] },
		"test",
		TEST_KEY_PEPPER,
	);
	const auth: NodeCredentialContext = {
		nodeId: enrollment.node.node_id,
		agentId: registration.agent.id,
		credentialId: enrollment.credential.id,
		requestId: `test:${suffix}`,
	};
	await registerWorkspace(handle.db, auth, {
		alias: input.workspaceAlias,
		repository_url: input.repositoryUrl,
		allowed_base_refs: ["refs/heads/main"],
	});
	return { agentId: registration.agent.id, nodeId: enrollment.node.node_id, auth };
}

export function participantAcceptance(
	contract: DeliveryFixture["contract"],
	idempotencyKey: string,
	grantCharacter: string,
) {
	return {
		idempotency_key: idempotencyKey,
		contract: { ...contract },
		local_policy_grant: {
			profile_name: "bounded-code",
			grant_sha256: grantCharacter.repeat(64),
		},
	};
}

export function verificationEvidence(
	commandId: string,
	outcome: "passed" | "failed",
	recordedAt: string,
) {
	return {
		verification_id: randomUUID(),
		command_id: commandId,
		outcome,
		exit_code: outcome === "passed" ? 0 : 1,
		duration_ms: 25,
		summary: `${commandId} ${outcome}`,
		output_sha256: "c".repeat(64),
		artifacts: [],
		recorded_at: recordedAt,
	};
}

export function requireClaimed(result: DeliveryClaimResult) {
	if (result.outcome !== "claimed") throw new Error("expected a claimed delivery");
	return result;
}

export function requireLease(result: ReturnType<typeof requireClaimed>) {
	const lease = result.item.delivery.lease;
	if (!lease) throw new Error("expected an active delivery lease");
	return lease;
}

export async function expireActiveLease(handle: TestDb, deliveryId: string): Promise<void> {
	await handle.db
		.update(nodeDeliveries)
		.set({ leaseExpiresAt: sql`clock_timestamp() - interval '1 second'` })
		.where(eq(nodeDeliveries.id, deliveryId));
}

export async function databaseNow(handle: TestDb): Promise<Date> {
	const [row] = await handle.sql<Array<{ now: string | Date }>>`SELECT clock_timestamp() AS now`;
	if (!row) throw new Error("expected the database clock");
	return new Date(row.now);
}

export function deferred<T>(): {
	readonly promise: Promise<T>;
	readonly resolve: (value: T) => void;
} {
	let resolve = (_value: T): void => undefined;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

export async function waitForBlockedBy(
	sqlClient: TestDb["sql"],
	blockerPid: number,
	message: string,
	minimumWaiters = 1,
	timeoutMs = 2_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const [row] = await sqlClient<Array<{ waiters: string }>>`
			SELECT count(*)::text AS waiters
			FROM pg_stat_activity
			WHERE ${blockerPid} = ANY(pg_blocking_pids(pid))
		`;
		if (Number(row?.waiters ?? "0") >= minimumWaiters) return;
	}
	throw new Error(message);
}

export async function onlyAvailableDelivery(
	handle: TestDb,
	nodeId: string,
	kind: "turn" | "verification",
) {
	const page = await listAvailableDeliveryEvents(handle.db, {
		nodeId,
		page: { after_cursor: null, limit: 50 },
	});
	const matching = page.items.filter((item) => item.delivery.kind === kind);
	if (matching.length !== 1) {
		throw new Error(`expected exactly one available ${kind} delivery, got ${matching.length}`);
	}
	return matching[0]!.delivery;
}

export async function claimAndStart(
	handle: TestDb,
	participant: ParticipantFixture,
	deliveryId: string,
	keySuffix: string,
) {
	const claim = requireClaimed(
		await claimDelivery(handle.db, participant.auth, deliveryId, {
			idempotency_key: `claim:${keySuffix}`,
		}),
	);
	const lease = requireLease(claim);
	const start = await startDelivery(handle.db, participant.auth, deliveryId, {
		idempotency_key: `start:${keySuffix}`,
		lease_id: lease.lease_id,
		fencing_token: lease.fencing_token,
	});
	return { claim, lease, start };
}

export async function completeReadyTurn(
	handle: TestDb,
	participant: ParticipantFixture,
	deliveryId: string,
	keySuffix: string,
) {
	const execution = await claimAndStart(handle, participant, deliveryId, keySuffix);
	return completeDelivery(handle.db, participant.auth, deliveryId, {
		idempotency_key: `complete:${keySuffix}`,
		lease_id: execution.lease.lease_id,
		fencing_token: execution.lease.fencing_token,
		result: {
			type: "turn_completed",
			disposition: { kind: "ready", evidence: [] },
		},
	});
}
