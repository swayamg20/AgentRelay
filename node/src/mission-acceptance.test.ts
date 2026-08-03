import {
	type MissionParticipantAcceptanceInput,
	type NodeMissionAssignment,
	type NodeMissionAssignmentList,
	createMissionCoordinatorState,
	missionCoordinatorConfigSchema,
} from "@agentrelay/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NodeConfig } from "./config.js";
import { type JournalStorage, NodeJournal, type NodeJournalState } from "./journal.js";
import { acceptPendingMissions } from "./mission-acceptance.js";
import { resolvePolicyProfile } from "./policy.js";
import { type NodeRelayClient, RelayHttpError } from "./relay-client.js";
import { WorkspacePreflightError, preflightWorkspace } from "./workspace.js";

vi.mock("./workspace.js", async () => {
	const actual = await vi.importActual<typeof import("./workspace.js")>("./workspace.js");
	return { ...actual, preflightWorkspace: vi.fn() };
});

const IDS = {
	owner: "50000000-0000-4000-8000-000000000001",
	agent: "50000000-0000-4000-8000-000000000002",
	peer: "50000000-0000-4000-8000-000000000003",
	node: "50000000-0000-4000-8000-000000000004",
	credential: "50000000-0000-4000-8000-000000000005",
	binding: "50000000-0000-4000-8000-000000000006",
	artifact: "50000000-0000-4000-8000-000000000007",
	expiredMission: "50000000-0000-4000-8000-000000000008",
	policyMission: "50000000-0000-4000-8000-000000000009",
	preflightMission: "50000000-0000-4000-8000-000000000010",
	validMission: "50000000-0000-4000-8000-000000000011",
	secondValidMission: "50000000-0000-4000-8000-000000000012",
} as const;

const NOW = new Date("2026-08-02T12:00:00.000Z");
const mockedPreflight = vi.mocked(preflightWorkspace);

describe("pending Mission acceptance", () => {
	beforeEach(() => {
		mockedPreflight.mockReset();
		mockedPreflight.mockResolvedValue({
			root: "/tmp/agentrelay-backend",
			repository_url: "https://github.com/acme/backend.git",
			head_commit: "1".repeat(40),
			reachable_from_ref: "refs/heads/main",
			clean: true,
		});
	});

	it("isolates local validation and policy failures so a later assignment is accepted", async () => {
		const expired = assignment(IDS.expiredMission, {
			expiresAt: "2026-08-02T11:59:59.000Z",
		});
		const deniedPolicy = assignment(IDS.policyMission, { requestedPolicy: "review" });
		const valid = assignment(IDS.validMission);
		const harness = acceptanceHarness([expired, deniedPolicy, valid]);
		const onLocalFailure = vi.fn();

		await expect(
			acceptPendingMissions(harness.config, harness.client, harness.journal, {
				now: NOW,
				onLocalFailure,
			}),
		).resolves.toBe(1);

		expect(onLocalFailure).toHaveBeenCalledTimes(2);
		expect(onLocalFailure).toHaveBeenNthCalledWith(1, {
			category: "validation",
			code: "mission_expired",
			mission_id: IDS.expiredMission,
			message: `Mission is already expired: ${IDS.expiredMission}`,
		});
		expect(onLocalFailure).toHaveBeenNthCalledWith(2, {
			category: "validation",
			code: "policy_not_approved",
			mission_id: IDS.policyMission,
			message: "Mission policy profile is not approved for workspace backend",
		});
		expect(harness.acceptAssignment).toHaveBeenCalledTimes(1);
		expect(harness.acceptAssignment).toHaveBeenCalledWith(
			IDS.validMission,
			expect.objectContaining({
				local_policy_grant: expect.objectContaining({ profile_name: "coding" }),
			}),
		);
		expect(harness.recordMissionAcceptance).toHaveBeenNthCalledWith(
			1,
			IDS.validMission,
			expect.any(Object),
			"pending",
		);
		expect(harness.recordMissionAcceptance).toHaveBeenNthCalledWith(
			2,
			IDS.validMission,
			expect.any(Object),
			"accepted",
		);
	});

	it("isolates a typed workspace preflight failure and attempts the next assignment", async () => {
		mockedPreflight
			.mockRejectedValueOnce(
				new WorkspacePreflightError("workspace_dirty", "Workspace contains uncommitted changes"),
			)
			.mockResolvedValueOnce({
				root: "/tmp/agentrelay-backend",
				repository_url: "https://github.com/acme/backend.git",
				head_commit: "1".repeat(40),
				reachable_from_ref: "refs/heads/main",
				clean: true,
			});
		const harness = acceptanceHarness([
			assignment(IDS.preflightMission),
			assignment(IDS.validMission),
		]);
		const onLocalFailure = vi.fn();

		await expect(
			acceptPendingMissions(harness.config, harness.client, harness.journal, {
				now: NOW,
				onLocalFailure,
			}),
		).resolves.toBe(1);

		expect(mockedPreflight).toHaveBeenCalledTimes(2);
		expect(onLocalFailure).toHaveBeenCalledWith({
			category: "workspace_preflight",
			code: "workspace_dirty",
			mission_id: IDS.preflightMission,
			message: "Workspace contains uncommitted changes",
		});
		expect(harness.acceptAssignment).toHaveBeenCalledWith(IDS.validMission, expect.any(Object));
	});

	it("reaches a valid assignment after 50 poison entries across bounded cycles", async () => {
		const poisonAssignments = Array.from({ length: 50 }, (_, index) =>
			assignment(paginatedMissionId(index), {
				requestedPolicy: "review",
			}),
		);
		const poisonPages = Array.from({ length: 5 }, (_, index) =>
			poisonAssignments.slice(index * 10, (index + 1) * 10),
		);
		const continuationCursors = poisonPages.map((page) => page.at(-1)!.mission_id);
		const harness = acceptanceHarness([]);
		for (const [index, page] of poisonPages.entries()) {
			harness.listAssignments.mockResolvedValueOnce({
				missions: page,
				next_cursor: continuationCursors[index]!,
			});
		}
		harness.listAssignments.mockResolvedValueOnce({
			missions: [assignment(IDS.validMission)],
			next_cursor: null,
		});
		const onLocalFailure = vi.fn();

		for (const cursor of continuationCursors) {
			await expect(
				acceptPendingMissions(harness.config, harness.client, harness.journal, {
					now: NOW,
					onLocalFailure,
				}),
			).resolves.toBe(0);
			expect(harness.journal.snapshot().mission_assignment_cursor).toBe(cursor);
		}

		await expect(
			acceptPendingMissions(harness.config, harness.client, harness.journal, {
				now: NOW,
				onLocalFailure,
			}),
		).resolves.toBe(1);

		expect(harness.listAssignments.mock.calls).toEqual([
			["awaiting_acceptance", null, 10],
			...continuationCursors.slice(0, -1).map((cursor) => ["awaiting_acceptance", cursor, 10]),
			["awaiting_acceptance", continuationCursors.at(-1), 10],
		]);
		expect(onLocalFailure).toHaveBeenCalledTimes(50);
		expect(mockedPreflight).toHaveBeenCalledOnce();
		expect(harness.acceptAssignment).toHaveBeenCalledOnce();
		expect(harness.acceptAssignment).toHaveBeenCalledWith(IDS.validMission, expect.any(Object));
		expect(harness.setMissionAssignmentCursor.mock.calls).toEqual([
			...continuationCursors.map((cursor) => [cursor]),
			[null],
		]);
		expect(harness.journal.snapshot().mission_assignment_cursor).toBeNull();
	});

	it("rejects an immediate repeated assignment cursor on the next cycle", async () => {
		const harness = acceptanceHarness([]);
		const localPoison = assignment(IDS.policyMission, {
			requestedPolicy: "review",
		});
		harness.listAssignments
			.mockResolvedValueOnce({ missions: [localPoison], next_cursor: IDS.policyMission })
			.mockResolvedValueOnce({ missions: [localPoison], next_cursor: IDS.policyMission });

		await expect(
			acceptPendingMissions(harness.config, harness.client, harness.journal, { now: NOW }),
		).resolves.toBe(0);
		await expect(
			acceptPendingMissions(harness.config, harness.client, harness.journal, { now: NOW }),
		).rejects.toThrow(`Relay repeated Mission assignment cursor: ${IDS.policyMission}`);

		expect(harness.listAssignments).toHaveBeenCalledTimes(2);
		expect(harness.setMissionAssignmentCursor).toHaveBeenCalledOnce();
	});

	it("rejects prototype-named workspace aliases before local preflight", async () => {
		const harness = acceptanceHarness([
			assignment(IDS.validMission, { workspaceAlias: "toString" }),
			assignment(IDS.secondValidMission, { workspaceAlias: "constructor" }),
		]);
		const onLocalFailure = vi.fn();

		await expect(
			acceptPendingMissions(harness.config, harness.client, harness.journal, {
				now: NOW,
				onLocalFailure,
			}),
		).resolves.toBe(0);

		expect(mockedPreflight).not.toHaveBeenCalled();
		expect(harness.acceptAssignment).not.toHaveBeenCalled();
		expect(onLocalFailure).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({
				code: "workspace_not_configured",
				mission_id: IDS.validMission,
			}),
		);
		expect(onLocalFailure).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({
				code: "workspace_not_configured",
				mission_id: IDS.secondValidMission,
			}),
		);
	});

	it("surfaces Relay acceptance failures instead of treating them as local poison", async () => {
		const harness = acceptanceHarness([assignment(IDS.validMission)]);
		const onLocalFailure = vi.fn();
		harness.acceptAssignment.mockRejectedValueOnce(new Error("Relay temporarily unavailable"));

		await expect(
			acceptPendingMissions(harness.config, harness.client, harness.journal, {
				now: NOW,
				onLocalFailure,
			}),
		).rejects.toThrow("Relay temporarily unavailable");

		expect(onLocalFailure).not.toHaveBeenCalled();
		expect(harness.recordMissionAcceptance).toHaveBeenCalledOnce();
		expect(harness.recordMissionAcceptance).toHaveBeenCalledWith(
			IDS.validMission,
			expect.any(Object),
			"pending",
		);
	});

	it("replays a journaled acceptance intent before listing new Missions", async () => {
		const input = acceptanceInput();
		const harness = acceptanceHarness([], { [IDS.validMission]: input });

		await expect(
			acceptPendingMissions(harness.config, harness.client, harness.journal, { now: NOW }),
		).resolves.toBe(1);

		expect(harness.acceptAssignment).toHaveBeenCalledWith(IDS.validMission, input);
		expect(harness.recordMissionAcceptance).toHaveBeenNthCalledWith(
			1,
			IDS.validMission,
			input,
			"pending",
		);
		expect(harness.recordMissionAcceptance).toHaveBeenNthCalledWith(
			2,
			IDS.validMission,
			input,
			"accepted",
		);
		expect(harness.acceptAssignment.mock.invocationCallOrder[0]!).toBeLessThan(
			harness.listAssignments.mock.invocationCallOrder[0]!,
		);
		expect(harness.setMissionAssignmentCursor).not.toHaveBeenCalled();
	});

	it("journals an in-flight acceptance response before shutdown fences the next Relay call", async () => {
		const controller = new AbortController();
		const input = acceptanceInput();
		const harness = acceptanceHarness([], { [IDS.validMission]: input });
		harness.acceptAssignment.mockImplementationOnce(async () => {
			controller.abort();
		});

		await expect(
			acceptPendingMissions(harness.config, harness.client, harness.journal, {
				now: NOW,
				signal: controller.signal,
			}),
		).rejects.toMatchObject({ name: "AbortError" });

		expect(harness.recordMissionAcceptance).toHaveBeenNthCalledWith(
			2,
			IDS.validMission,
			input,
			"accepted",
		);
		expect(harness.listAssignments).not.toHaveBeenCalled();
	});

	it("journals a paged acceptance response before shutdown fences later pages", async () => {
		const controller = new AbortController();
		const harness = acceptanceHarness([]);
		harness.listAssignments.mockResolvedValueOnce({
			missions: [assignment(IDS.validMission)],
			next_cursor: IDS.validMission,
		});
		harness.acceptAssignment.mockImplementationOnce(async () => {
			controller.abort();
		});

		await expect(
			acceptPendingMissions(harness.config, harness.client, harness.journal, {
				now: NOW,
				signal: controller.signal,
			}),
		).rejects.toMatchObject({ name: "AbortError" });

		expect(harness.recordMissionAcceptance).toHaveBeenNthCalledWith(
			2,
			IDS.validMission,
			expect.any(Object),
			"accepted",
		);
		expect(harness.listAssignments).toHaveBeenCalledOnce();
		expect(harness.setMissionAssignmentCursor).not.toHaveBeenCalled();
	});

	it("does not retry a quarantined acceptance or starve later cycles", async () => {
		const firstInput = acceptanceInput(IDS.expiredMission);
		const journal = await NodeJournal.open(new MemoryStorage());
		await journal.recordMissionAcceptance(IDS.expiredMission, firstInput, "pending");
		const terminal = new RelayHttpError(
			409,
			"invalid_transition",
			"Mission has expired",
			"request-terminal",
			{},
		);
		const acceptAssignment = vi.fn(async () => undefined);
		acceptAssignment.mockRejectedValueOnce(terminal);
		const listAssignments = vi
			.fn()
			.mockResolvedValueOnce({ missions: [assignment(IDS.validMission)], next_cursor: null })
			.mockResolvedValueOnce({
				missions: [assignment(IDS.secondValidMission)],
				next_cursor: null,
			});
		const client = { acceptAssignment, listAssignments } as unknown as NodeRelayClient;
		const onLocalFailure = vi.fn();

		await expect(
			acceptPendingMissions(localConfig(), client, journal, {
				now: NOW,
				onLocalFailure,
			}),
		).resolves.toBe(1);
		await expect(
			acceptPendingMissions(localConfig(), client, journal, {
				now: NOW,
				onLocalFailure,
			}),
		).resolves.toBe(1);

		expect(journal.snapshot().mission_acceptances[IDS.expiredMission]).toMatchObject({
			status: "quarantined",
			last_error: terminal.message,
		});
		expect(onLocalFailure).toHaveBeenCalledOnce();
		expect(onLocalFailure).toHaveBeenCalledWith({
			category: "relay_terminal",
			code: "invalid_transition",
			http_status: 409,
			mission_id: IDS.expiredMission,
			message: terminal.message,
		});
		expect(acceptAssignment).toHaveBeenCalledTimes(3);
		expect(acceptAssignment).toHaveBeenNthCalledWith(1, IDS.expiredMission, firstInput);
		expect(acceptAssignment).toHaveBeenNthCalledWith(2, IDS.validMission, expect.any(Object));
		expect(acceptAssignment).toHaveBeenNthCalledWith(3, IDS.secondValidMission, expect.any(Object));
		expect(listAssignments).toHaveBeenCalledTimes(2);
	});

	it("surfaces Node authentication failure without quarantining Mission intent", async () => {
		const harness = acceptanceHarness([], {
			[IDS.validMission]: acceptanceInput(IDS.validMission),
		});
		harness.acceptAssignment.mockRejectedValueOnce(
			new RelayHttpError(401, "unauthenticated", "Node credential revoked", "request-auth", {}),
		);

		await expect(
			acceptPendingMissions(harness.config, harness.client, harness.journal, { now: NOW }),
		).rejects.toMatchObject({ status: 401, code: "unauthenticated" });

		expect(harness.quarantineMissionAcceptance).not.toHaveBeenCalled();
		expect(harness.listAssignments).not.toHaveBeenCalled();
	});

	it("surfaces unexpected preflight errors without attempting later assignments", async () => {
		mockedPreflight.mockRejectedValueOnce(new TypeError("preflight invariant broke"));
		const harness = acceptanceHarness([
			assignment(IDS.validMission),
			assignment(IDS.secondValidMission),
		]);
		const onLocalFailure = vi.fn();

		await expect(
			acceptPendingMissions(harness.config, harness.client, harness.journal, {
				now: NOW,
				onLocalFailure,
			}),
		).rejects.toThrow("preflight invariant broke");

		expect(mockedPreflight).toHaveBeenCalledOnce();
		expect(harness.acceptAssignment).not.toHaveBeenCalled();
		expect(onLocalFailure).not.toHaveBeenCalled();
		expect(harness.setMissionAssignmentCursor).not.toHaveBeenCalled();
	});
});

function acceptanceHarness(
	assignments: readonly NodeMissionAssignment[],
	pendingAcceptances: Readonly<Record<string, MissionParticipantAcceptanceInput>> = {},
) {
	const listAssignments = vi.fn(
		async (): Promise<NodeMissionAssignmentList> => ({
			missions: structuredClone(assignments),
			next_cursor: null,
		}),
	);
	const acceptAssignment = vi.fn(async () => undefined);
	const recordMissionAcceptance = vi.fn(async () => undefined);
	const quarantineMissionAcceptance = vi.fn(async () => undefined);
	let missionAssignmentCursor: string | null = null;
	const setMissionAssignmentCursor = vi.fn(async (cursor: string | null) => {
		missionAssignmentCursor = cursor;
	});
	const snapshot = vi.fn(() => ({
		mission_assignment_cursor: missionAssignmentCursor,
		mission_acceptances: Object.fromEntries(
			Object.entries(pendingAcceptances).map(([missionId, input]) => [
				missionId,
				{ input: structuredClone(input), status: "pending" as const, last_error: null },
			]),
		),
	}));
	return {
		config: localConfig(),
		client: { listAssignments, acceptAssignment } as unknown as NodeRelayClient,
		journal: {
			snapshot,
			recordMissionAcceptance,
			quarantineMissionAcceptance,
			setMissionAssignmentCursor,
		} as unknown as NodeJournal,
		listAssignments,
		acceptAssignment,
		recordMissionAcceptance,
		quarantineMissionAcceptance,
		setMissionAssignmentCursor,
	};
}

function acceptanceInput(missionId = IDS.validMission): MissionParticipantAcceptanceInput {
	const config = localConfig();
	return {
		idempotency_key: `accept:${missionId}`,
		contract: assignment(missionId).coordinator_config.mission_context.manifest.shared_contract,
		local_policy_grant: resolvePolicyProfile(config.policy_profiles, "coding").grant,
	};
}

class MemoryStorage implements JournalStorage {
	state: NodeJournalState | null = null;

	async load(): Promise<unknown | null> {
		return structuredClone(this.state);
	}

	async save(state: NodeJournalState): Promise<void> {
		this.state = structuredClone(state);
	}
}

function localConfig(): NodeConfig {
	return {
		schema_version: 1,
		relay_url: "https://relay.example.com",
		node: {
			node_id: IDS.node,
			agent_id: IDS.agent,
			credential_id: IDS.credential,
			token: `ar_node_test_${"a".repeat(32)}`,
		},
		workspaces: {
			backend: {
				path: "/tmp/agentrelay-backend",
				repository_url: "https://github.com/acme/backend.git",
				allowed_base_refs: ["refs/heads/main"],
				policy_profile: "coding",
			},
		},
		policy_profiles: {
			coding: {
				max_turn_seconds: 300,
				max_reported_tokens: 10_000,
				network_access: "denied",
				verification_commands: {},
			},
		},
	};
}

function assignment(
	missionId: string,
	options: {
		readonly expiresAt?: string;
		readonly requestedPolicy?: string;
		readonly workspaceAlias?: string;
	} = {},
): NodeMissionAssignment {
	const coordinatorConfig = missionCoordinatorConfigSchema.parse({
		mission_context: {
			manifest: {
				schema_version: 1,
				mission_id: missionId,
				objective: "Ship a compatible backend and client.",
				public_acceptance_criteria: ["Both repositories pass."],
				participants: [
					{
						agent_id: IDS.agent,
						role: "backend",
						workspace_alias: options.workspaceAlias ?? "backend",
						repository_url: "https://github.com/acme/backend.git",
						expected_base_commit: "1".repeat(40),
						initial_assignment: "Implement the backend.",
						requested_local_policy_profile: options.requestedPolicy ?? "coding",
					},
					{
						agent_id: IDS.peer,
						role: "client",
						workspace_alias: "client",
						repository_url: "https://github.com/acme/client.git",
						expected_base_commit: "2".repeat(40),
						initial_assignment: "Implement the client.",
						requested_local_policy_profile: "coding",
					},
				],
				shared_contract: {
					artifact_id: IDS.artifact,
					type: "api_contract",
					version: 1,
					sha256: "a".repeat(64),
					media_type: "application/json",
					byte_size: 2,
				},
				max_turns: 10,
				max_wall_time_seconds: 3_600,
				token_budget: 100_000,
				expires_at: options.expiresAt ?? "2026-08-03T12:00:00.000Z",
				allowed_artifact_types: ["api_contract"],
				created_at: "2026-08-02T10:00:00.000Z",
			},
			created_by: { principal_id: IDS.owner, kind: "owner" },
		},
		required_verification_commands: {
			[IDS.agent]: ["test"],
			[IDS.peer]: ["test"],
		},
	});
	return {
		mission_id: missionId,
		coordinator_config: coordinatorConfig,
		coordinator_state: createMissionCoordinatorState(coordinatorConfig),
		participant_agent_id: IDS.agent,
		workspace_binding_id: IDS.binding,
		acceptance_status: "pending",
		acceptance_receipt: null,
	};
}

function paginatedMissionId(index: number): string {
	return `50000000-0000-4000-8001-${String(index + 100).padStart(12, "0")}`;
}
