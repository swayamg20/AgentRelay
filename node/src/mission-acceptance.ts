import {
	type MissionParticipantAcceptanceInput,
	type NodeMissionAssignment,
	missionParticipantAcceptanceInputSchema,
} from "@agentrelay/protocol";
import type { NodeConfig } from "./config.js";
import type { NodeJournal } from "./journal.js";
import { PolicyError, type PolicyErrorCode, resolvePolicyProfile } from "./policy.js";
import { type NodeRelayClient, RelayHttpError } from "./relay-client.js";
import {
	WorkspacePreflightError,
	type WorkspacePreflightErrorCode,
	preflightWorkspace,
} from "./workspace.js";

export type MissionAcceptanceValidationErrorCode =
	| "wrong_participant"
	| "mission_expired"
	| "participant_missing"
	| "workspace_not_configured"
	| "policy_not_approved";

export class MissionAcceptanceValidationError extends Error {
	constructor(
		readonly code: MissionAcceptanceValidationErrorCode,
		readonly missionId: string,
		message: string,
	) {
		super(message);
		this.name = "MissionAcceptanceValidationError";
	}
}

export type LocalMissionAcceptanceFailure =
	| {
			readonly category: "validation";
			readonly code: MissionAcceptanceValidationErrorCode;
			readonly mission_id: string;
			readonly message: string;
	  }
	| {
			readonly category: "policy";
			readonly code: PolicyErrorCode;
			readonly mission_id: string;
			readonly message: string;
	  }
	| {
			readonly category: "workspace_preflight";
			readonly code: WorkspacePreflightErrorCode;
			readonly mission_id: string;
			readonly message: string;
	  }
	| {
			readonly category: "relay_terminal";
			readonly code: string;
			readonly http_status: number;
			readonly mission_id: string;
			readonly message: string;
	  };

export interface AcceptPendingMissionsOptions {
	readonly now?: Date;
	readonly onLocalFailure?: (failure: LocalMissionAcceptanceFailure) => void | Promise<void>;
	readonly signal?: AbortSignal;
}

// Each candidate can run Git preflight. Bound the scan so delivery lease work wins every cycle.
const ASSIGNMENT_PAGE_LIMIT = 10;

export async function verifyNodeIdentityAndWorkspaces(
	config: NodeConfig,
	client: NodeRelayClient,
	signal?: AbortSignal,
): Promise<void> {
	signal?.throwIfAborted();
	const self = await client.me();
	if (
		self.node.node_id !== config.node.node_id ||
		self.node.agent_id !== config.node.agent_id ||
		self.node.status !== "active"
	) {
		throw new Error("Relay Node identity does not match the local device configuration");
	}

	for (const [alias, workspace] of Object.entries(config.workspaces)) {
		signal?.throwIfAborted();
		const registered = await client.registerWorkspace({
			alias,
			repository_url: workspace.repository_url,
			allowed_base_refs: [...workspace.allowed_base_refs],
		});
		if (
			registered.workspace.node_id !== config.node.node_id ||
			registered.workspace.agent_id !== config.node.agent_id ||
			registered.workspace.alias !== alias ||
			registered.workspace.status !== "active"
		) {
			throw new Error(`Relay workspace binding does not match local configuration: ${alias}`);
		}
	}
}

export async function acceptPendingMissions(
	config: NodeConfig,
	client: NodeRelayClient,
	journal: NodeJournal,
	options: AcceptPendingMissionsOptions | Date = {},
): Promise<number> {
	const now = options instanceof Date ? options : (options.now ?? new Date());
	const onLocalFailure = options instanceof Date ? undefined : options.onLocalFailure;
	const signal = options instanceof Date ? undefined : options.signal;
	let accepted = 0;
	for (const [missionId, intent] of Object.entries(journal.snapshot().mission_acceptances)) {
		if (intent.status !== "pending") continue;
		signal?.throwIfAborted();
		if (
			await submitOrQuarantineMissionAcceptance(
				client,
				journal,
				missionId,
				intent.input,
				onLocalFailure,
				signal,
			)
		) {
			accepted += 1;
		}
	}

	const afterCursor = journal.snapshot().mission_assignment_cursor;
	signal?.throwIfAborted();
	const page = await client.listAssignments(
		"awaiting_acceptance",
		afterCursor,
		ASSIGNMENT_PAGE_LIMIT,
	);
	signal?.throwIfAborted();
	if (page.next_cursor !== null && page.next_cursor === afterCursor) {
		throw new Error(`Relay repeated Mission assignment cursor: ${page.next_cursor}`);
	}

	for (const assignment of page.missions) {
		signal?.throwIfAborted();
		if (assignment.acceptance_status === "accepted") continue;
		if (journal.snapshot().mission_acceptances[assignment.mission_id] !== undefined) continue;

		let input: MissionParticipantAcceptanceInput;
		try {
			input = await prepareMissionAcceptance(config, assignment, now);
		} catch (error) {
			const failure = localAcceptanceFailure(assignment.mission_id, error);
			if (failure === null) throw error;
			await onLocalFailure?.(failure);
			continue;
		}

		if (
			await submitOrQuarantineMissionAcceptance(
				client,
				journal,
				assignment.mission_id,
				input,
				onLocalFailure,
				signal,
			)
		) {
			accepted += 1;
		}
	}

	signal?.throwIfAborted();
	if (page.next_cursor !== afterCursor) {
		await journal.setMissionAssignmentCursor(page.next_cursor);
	}
	signal?.throwIfAborted();
	return accepted;
}

export async function acceptMission(
	config: NodeConfig,
	client: NodeRelayClient,
	journal: NodeJournal,
	assignment: NodeMissionAssignment,
	now = new Date(),
): Promise<void> {
	const input = await prepareMissionAcceptance(config, assignment, now);
	await submitMissionAcceptance(client, journal, assignment.mission_id, input);
}

async function prepareMissionAcceptance(
	config: NodeConfig,
	assignment: NodeMissionAssignment,
	now: Date,
): Promise<MissionParticipantAcceptanceInput> {
	if (assignment.participant_agent_id !== config.node.agent_id) {
		throw new MissionAcceptanceValidationError(
			"wrong_participant",
			assignment.mission_id,
			`Mission assignment targets a different agent: ${assignment.mission_id}`,
		);
	}
	const manifest = assignment.coordinator_config.mission_context.manifest;
	if (Date.parse(manifest.expires_at) <= now.getTime()) {
		throw new MissionAcceptanceValidationError(
			"mission_expired",
			assignment.mission_id,
			`Mission is already expired: ${assignment.mission_id}`,
		);
	}
	const participant = manifest.participants.find(
		(candidate) => candidate.agent_id === config.node.agent_id,
	);
	if (!participant) {
		throw new MissionAcceptanceValidationError(
			"participant_missing",
			assignment.mission_id,
			`Local agent is absent from Mission: ${assignment.mission_id}`,
		);
	}
	if (!Object.hasOwn(config.workspaces, participant.workspace_alias)) {
		throw new MissionAcceptanceValidationError(
			"workspace_not_configured",
			assignment.mission_id,
			`Mission requests an unconfigured workspace: ${participant.workspace_alias}`,
		);
	}
	const workspace = config.workspaces[participant.workspace_alias]!;
	if (workspace.policy_profile !== participant.requested_local_policy_profile) {
		throw new MissionAcceptanceValidationError(
			"policy_not_approved",
			assignment.mission_id,
			`Mission policy profile is not approved for workspace ${participant.workspace_alias}`,
		);
	}
	const policy = resolvePolicyProfile(
		config.policy_profiles,
		participant.requested_local_policy_profile,
	);
	await preflightWorkspace(workspace, participant);

	return missionParticipantAcceptanceInputSchema.parse({
		idempotency_key: acceptanceKey(
			assignment.mission_id,
			assignment.participant_agent_id,
			policy.grant.grant_sha256,
		),
		contract: manifest.shared_contract,
		local_policy_grant: policy.grant,
	});
}

async function submitMissionAcceptance(
	client: NodeRelayClient,
	journal: NodeJournal,
	missionId: string,
	input: MissionParticipantAcceptanceInput,
	signal?: AbortSignal,
): Promise<void> {
	signal?.throwIfAborted();
	await journal.recordMissionAcceptance(missionId, input, "pending");
	signal?.throwIfAborted();
	await client.acceptAssignment(missionId, input);
	await journal.recordMissionAcceptance(missionId, input, "accepted");
}

async function submitOrQuarantineMissionAcceptance(
	client: NodeRelayClient,
	journal: NodeJournal,
	missionId: string,
	input: MissionParticipantAcceptanceInput,
	onFailure: AcceptPendingMissionsOptions["onLocalFailure"],
	signal?: AbortSignal,
): Promise<boolean> {
	try {
		await submitMissionAcceptance(client, journal, missionId, input, signal);
		return true;
	} catch (error) {
		const failure = terminalRelayAcceptanceFailure(missionId, error);
		if (failure === null) throw error;
		await journal.quarantineMissionAcceptance(missionId, failure.message);
		await onFailure?.(failure);
		return false;
	}
}

function localAcceptanceFailure(
	missionId: string,
	error: unknown,
): LocalMissionAcceptanceFailure | null {
	if (error instanceof MissionAcceptanceValidationError) {
		return {
			category: "validation",
			code: error.code,
			mission_id: missionId,
			message: error.message,
		};
	}
	if (error instanceof PolicyError) {
		return {
			category: "policy",
			code: error.code,
			mission_id: missionId,
			message: error.message,
		};
	}
	if (error instanceof WorkspacePreflightError) {
		return {
			category: "workspace_preflight",
			code: error.code,
			mission_id: missionId,
			message: error.message,
		};
	}
	return null;
}

const TERMINAL_MISSION_ACCEPTANCE_CODES = new Set([
	"invalid_params",
	"not_a_participant",
	"invalid_transition",
	"not_authorized_transition",
	"state_changed",
	"duplicate_idempotency_key",
	"invalid_intent_payload",
	"teammate_blocked",
	"mission_not_found",
	"workspace_not_found",
]);

function terminalRelayAcceptanceFailure(
	missionId: string,
	error: unknown,
): LocalMissionAcceptanceFailure | null {
	if (
		!(error instanceof RelayHttpError) ||
		error.status < 400 ||
		error.status >= 500 ||
		!TERMINAL_MISSION_ACCEPTANCE_CODES.has(error.code)
	) {
		return null;
	}
	return {
		category: "relay_terminal",
		code: error.code,
		http_status: error.status,
		mission_id: missionId,
		message: error.message.slice(0, 2_000),
	};
}

function acceptanceKey(missionId: string, participantAgentId: string, grantSha256: string): string {
	return `accept:${missionId}:${participantAgentId}:${grantSha256.slice(0, 16)}`;
}
