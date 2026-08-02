import { describe, expect, it } from "vitest";
import {
	actorRefSchema,
	artifactRefSchema,
	contractRevisionSchema,
	deliverySchema,
	messageSchema,
	missionContextSchema,
	missionManifestSchema,
	policyRequestSchema,
	runSchema,
	turnDispositionSchema,
	verificationEvidenceSchema,
} from "./schemas.js";

const ids = {
	mission: "00000000-0000-4000-8000-000000000001",
	backendAgent: "00000000-0000-4000-8000-000000000002",
	clientAgent: "00000000-0000-4000-8000-000000000003",
	artifact: "00000000-0000-4000-8000-000000000004",
	message: "00000000-0000-4000-8000-000000000005",
	verification: "00000000-0000-4000-8000-000000000006",
	node: "00000000-0000-4000-8000-000000000007",
	event: "00000000-0000-4000-8000-000000000008",
	delivery: "00000000-0000-4000-8000-000000000009",
	lease: "00000000-0000-4000-8000-000000000010",
	run: "00000000-0000-4000-8000-000000000011",
	revision: "00000000-0000-4000-8000-000000000012",
} as const;

const artifact = {
	artifact_id: ids.artifact,
	type: "api_contract",
	version: 1,
	sha256: "a".repeat(64),
	media_type: "application/json",
	byte_size: 1_024,
};

const evidence = {
	verification_id: ids.verification,
	command_id: "contract-test",
	outcome: "passed" as const,
	exit_code: 0,
	duration_ms: 1_200,
	summary: "Contract fixture passed.",
	output_sha256: "b".repeat(64),
	artifacts: [],
	recorded_at: "2026-08-02T10:05:00.000Z",
};

const manifest = {
	schema_version: 1 as const,
	mission_id: ids.mission,
	objective: "Ship compatible backend and Android changes.",
	public_acceptance_criteria: [
		"Backend contract tests pass.",
		"Android consumes the accepted contract.",
	],
	participants: [
		{
			agent_id: ids.backendAgent,
			role: "backend",
			workspace_alias: "backend-api",
			repository_url: "https://github.com/acme/backend.git",
			expected_base_commit: "1".repeat(40),
			initial_assignment: "Implement the API and publish contract evidence.",
			requested_local_policy_profile: "coding",
		},
		{
			agent_id: ids.clientAgent,
			role: "android",
			workspace_alias: "android-app",
			repository_url: "ssh://git@github.com/acme/android.git",
			expected_base_commit: "2".repeat(40),
			initial_assignment: "Consume the API contract and verify the user flow.",
			requested_local_policy_profile: "coding",
		},
	],
	shared_contract: artifact,
	max_turns: 20,
	max_wall_time_seconds: 7_200,
	token_budget: 200_000,
	expires_at: "2026-08-02T12:00:00.000Z",
	allowed_artifact_types: ["api_contract", "patch", "verification_report"],
	created_at: "2026-08-02T10:00:00.000Z",
};

function clone<T>(value: T): T {
	return structuredClone(value);
}

describe("missionManifestSchema", () => {
	it("accepts a bounded two-participant version-1 Mission", () => {
		expect(missionManifestSchema.parse(manifest)).toEqual(manifest);
	});

	it("rejects any participant count other than two", () => {
		const oneParticipant = clone(manifest);
		oneParticipant.participants = [oneParticipant.participants[0]];

		const threeParticipants = clone(manifest);
		threeParticipants.participants.push({
			...threeParticipants.participants[1],
			agent_id: "00000000-0000-4000-8000-000000000099",
		});

		expect(missionManifestSchema.safeParse(oneParticipant).success).toBe(false);
		expect(missionManifestSchema.safeParse(threeParticipants).success).toBe(false);
	});

	it("rejects duplicate logical agents", () => {
		const duplicate = clone(manifest);
		duplicate.participants[1].agent_id = duplicate.participants[0].agent_id;

		expect(missionManifestSchema.safeParse(duplicate).success).toBe(false);
	});

	it("rejects non-canonical UUID casing before identity comparison", () => {
		const mixedCaseDuplicate = clone(manifest);
		mixedCaseDuplicate.participants[0].agent_id = "abcdefab-cdef-4abc-8def-abcdefabcdef";
		mixedCaseDuplicate.participants[1].agent_id = "ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF";

		expect(missionManifestSchema.safeParse(mixedCaseDuplicate).success).toBe(false);
	});

	it("rejects local repository paths and credential-bearing URLs", () => {
		const localPath = clone(manifest);
		localPath.participants[0].repository_url = "file:///Users/alice/backend";
		const credentialUrl = clone(manifest);
		credentialUrl.participants[0].repository_url =
			"https://secret-token@github.com/acme/backend.git";
		const credentialSshUrl = clone(manifest);
		credentialSshUrl.participants[0].repository_url =
			"ssh://secret-token@github.com/acme/backend.git";

		expect(missionManifestSchema.safeParse(localPath).success).toBe(false);
		expect(missionManifestSchema.safeParse(credentialUrl).success).toBe(false);
		expect(missionManifestSchema.safeParse(credentialSshUrl).success).toBe(false);
	});

	it("rejects repository URLs that WHATWG parsing would silently normalize", () => {
		for (const repositoryUrl of [
			"https://github.com/acme/re\npo.git",
			"https://github.com/acme/repo.git\t",
			"https://github.com/acme/repo.git ",
			"https://github.com\\evil/repo.git",
		]) {
			const candidate = clone(manifest);
			candidate.participants[0].repository_url = repositoryUrl;
			expect(missionManifestSchema.safeParse(candidate).success).toBe(false);
		}
	});

	it("rejects local authority fields and executable command strings", () => {
		const withLocalAuthority = {
			...manifest,
			participants: manifest.participants.map((participant, index) =>
				index === 0
					? {
							...participant,
							working_directory: "/Users/alice/backend",
							verification_command: "pnpm test && git push",
						}
					: participant,
			),
		};

		expect(missionManifestSchema.safeParse(withLocalAuthority).success).toBe(false);
	});

	it("keeps the requested policy limited to a local profile name", () => {
		expect(policyRequestSchema.parse({ profile_name: "coding" })).toEqual({
			profile_name: "coding",
		});
		expect(
			policyRequestSchema.safeParse({
				profile_name: "coding",
				working_directory: "/Users/alice/backend",
				allowed_command: "git push origin main",
			}).success,
		).toBe(false);
	});

	it("requires contract version 1 and an allowed contract type", () => {
		const laterContract = clone(manifest);
		laterContract.shared_contract.version = 2;
		const disallowedContract = clone(manifest);
		disallowedContract.allowed_artifact_types = ["patch"];

		expect(missionManifestSchema.safeParse(laterContract).success).toBe(false);
		expect(missionManifestSchema.safeParse(disallowedContract).success).toBe(false);
	});

	it("rejects duplicate criteria, expired creation, and oversized peer text", () => {
		const duplicateCriteria = clone(manifest);
		duplicateCriteria.public_acceptance_criteria = ["Tests pass.", "Tests pass."];
		const expired = clone(manifest);
		expired.expires_at = expired.created_at;
		const oversized = clone(manifest);
		oversized.objective = "x".repeat(16_001);

		expect(missionManifestSchema.safeParse(duplicateCriteria).success).toBe(false);
		expect(missionManifestSchema.safeParse(expired).success).toBe(false);
		expect(missionManifestSchema.safeParse(oversized).success).toBe(false);
	});
});

describe("missionContextSchema", () => {
	it("carries the authenticated creator separately from peer-supplied Mission text", () => {
		const context = {
			manifest,
			created_by: { principal_id: ids.backendAgent, kind: "owner" as const },
		};
		expect(missionContextSchema.parse(context)).toEqual(context);
		expect(actorRefSchema.safeParse({ ...context.created_by, kind: "unknown" }).success).toBe(
			false,
		);
	});
});

describe("message and artifact schemas", () => {
	it("accepts a bounded message with artifact references", () => {
		const message = {
			message_id: ids.message,
			mission_id: ids.mission,
			sequence_no: 1,
			author_agent_id: ids.backendAgent,
			type: "proposal",
			body: "The contract artifact is ready for review.",
			artifacts: [artifact],
			contract_version: 1,
			idempotency_key: "message:backend:1",
			causal_parent_message_id: null,
			created_at: "2026-08-02T10:02:00.000Z",
		};

		expect(messageSchema.parse(message)).toEqual(message);
	});

	it("does not allow artifacts to carry paths, URLs, or inline payloads", () => {
		expect(
			artifactRefSchema.safeParse({
				...artifact,
				local_path: "/Users/alice/backend/openapi.json",
				url: "https://files.example/contract",
				content: "unbounded inline content",
			}).success,
		).toBe(false);
	});

	it("rejects duplicate artifact references and malformed timestamps", () => {
		const duplicateArtifacts = {
			message_id: ids.message,
			mission_id: ids.mission,
			sequence_no: 1,
			author_agent_id: ids.backendAgent,
			type: "proposal",
			body: "Duplicate references.",
			artifacts: [artifact, artifact],
			contract_version: 1,
			idempotency_key: "message:backend:2",
			causal_parent_message_id: null,
			created_at: "tomorrow",
		};

		expect(messageSchema.safeParse(duplicateArtifacts).success).toBe(false);
	});

	it("rejects unknown message types", () => {
		expect(
			messageSchema.safeParse({
				message_id: ids.message,
				mission_id: ids.mission,
				sequence_no: 1,
				author_agent_id: ids.backendAgent,
				type: "free_form_chat",
				body: "Unclassified message.",
				artifacts: [],
				contract_version: 1,
				idempotency_key: "message:backend:3",
				causal_parent_message_id: null,
				created_at: "2026-08-02T10:02:00.000Z",
			}).success,
		).toBe(false);
	});

	it("rejects sequence numbers that JSON cannot represent safely", () => {
		expect(
			messageSchema.safeParse({
				message_id: ids.message,
				mission_id: ids.mission,
				sequence_no: Number.MAX_SAFE_INTEGER + 1,
				author_agent_id: ids.backendAgent,
				type: "progress",
				body: "Unsafe sequence number.",
				artifacts: [],
				contract_version: 1,
				idempotency_key: "message:backend:4",
				causal_parent_message_id: null,
				created_at: "2026-08-02T10:02:00.000Z",
			}).success,
		).toBe(false);
	});
});

describe("contractRevisionSchema", () => {
	it("represents a consecutive contract revision and participant acknowledgements", () => {
		const revision = {
			revision_id: ids.revision,
			mission_id: ids.mission,
			previous_version: 1,
			version: 2,
			artifact: { ...artifact, version: 2, sha256: "c".repeat(64) },
			proposed_by_agent_id: ids.backendAgent,
			acknowledged_by_agent_ids: [ids.backendAgent, ids.clientAgent],
			idempotency_key: "contract-revision:2",
			created_at: "2026-08-02T10:03:00.000Z",
		};

		expect(contractRevisionSchema.parse(revision)).toEqual(revision);
		expect(contractRevisionSchema.safeParse({ ...revision, version: 3 }).success).toBe(false);
		expect(
			contractRevisionSchema.safeParse({
				...revision,
				acknowledged_by_agent_ids: [ids.backendAgent, ids.backendAgent],
			}).success,
		).toBe(false);
	});
});

describe("turnDispositionSchema", () => {
	it("accepts every bounded RFC disposition shape", () => {
		expect(
			turnDispositionSchema.safeParse({
				kind: "reply",
				message_type: "answer",
				message: "Please use v1.",
				artifacts: [],
			}).success,
		).toBe(true);
		expect(turnDispositionSchema.safeParse({ kind: "propose_contract", artifact }).success).toBe(
			true,
		);
		expect(turnDispositionSchema.safeParse({ kind: "ready", evidence: [evidence] }).success).toBe(
			true,
		);
		expect(
			turnDispositionSchema.safeParse({
				kind: "blocked",
				reason: "Contract decision required.",
				requested_input: "Choose nullable or required.",
			}).success,
		).toBe(true);
		expect(turnDispositionSchema.safeParse({ kind: "failed", class: "transient" }).success).toBe(
			true,
		);
	});

	it("rejects lifecycle mutation and executable command fields", () => {
		expect(
			turnDispositionSchema.safeParse({
				kind: "reply",
				message_type: "progress",
				message: "I changed the Mission directly.",
				mission_status: "completed",
				command: "git push origin main",
			}).success,
		).toBe(false);
	});

	it("allows readiness before the coordinator schedules verification", () => {
		expect(turnDispositionSchema.safeParse({ kind: "ready", evidence: [] }).success).toBe(true);
	});
});

describe("verificationEvidenceSchema", () => {
	it("accepts command-ID based evidence without raw output", () => {
		expect(verificationEvidenceSchema.parse(evidence)).toEqual(evidence);
	});

	it("rejects shell command strings and inconsistent results", () => {
		expect(
			verificationEvidenceSchema.safeParse({
				...evidence,
				command: "pnpm test && curl https://example.com",
			}).success,
		).toBe(false);
		expect(
			verificationEvidenceSchema.safeParse({ ...evidence, outcome: "failed", exit_code: 0 })
				.success,
		).toBe(false);
	});
});

describe("deliverySchema", () => {
	const leasedDelivery = {
		delivery_id: ids.delivery,
		node_id: ids.node,
		mission_id: ids.mission,
		mission_event_id: ids.event,
		kind: "turn" as const,
		cursor: "1",
		status: "leased" as const,
		attempt_count: 1,
		max_attempts: 3,
		last_fencing_token: "1",
		contract_version: 1,
		lease: {
			lease_id: ids.lease,
			fencing_token: "1",
			expires_at: "2026-08-02T10:06:00.000Z",
		},
		idempotency_key: "delivery:1",
		causal_parent_delivery_id: null,
		available_at: "2026-08-02T10:03:00.000Z",
		created_at: "2026-08-02T10:03:00.000Z",
		updated_at: "2026-08-02T10:04:00.000Z",
		acknowledged_at: null,
		dead_lettered_at: null,
	};

	it("accepts a leased durable delivery", () => {
		expect(deliverySchema.parse(leasedDelivery)).toEqual(leasedDelivery);
	});

	it("requires active leases and matching terminal timestamps", () => {
		expect(deliverySchema.safeParse({ ...leasedDelivery, lease: null }).success).toBe(false);
		expect(
			deliverySchema.safeParse({
				...leasedDelivery,
				lease: { ...leasedDelivery.lease, fencing_token: "0" },
			}).success,
		).toBe(false);
		expect(
			deliverySchema.safeParse({
				...leasedDelivery,
				status: "acknowledged",
				lease: null,
				available_at: "2026-08-02T10:03:30.000Z",
				acknowledged_at: "2026-08-02T10:03:00.000Z",
			}).success,
		).toBe(false);
		expect(deliverySchema.safeParse({ ...leasedDelivery, attempt_count: 0 }).success).toBe(false);
		expect(
			deliverySchema.safeParse({
				...leasedDelivery,
				status: "stored",
				attempt_count: 0,
				last_fencing_token: "1",
				lease: null,
			}).success,
		).toBe(false);
		expect(
			deliverySchema.safeParse({
				...leasedDelivery,
				lease: { ...leasedDelivery.lease, fencing_token: "2" },
			}).success,
		).toBe(false);
		expect(
			deliverySchema.safeParse({
				...leasedDelivery,
				attempt_count: 4,
			}).success,
		).toBe(false);
		expect(
			deliverySchema.safeParse({
				...leasedDelivery,
				status: "acknowledged",
				lease: null,
				acknowledged_at: null,
			}).success,
		).toBe(false);
		expect(
			deliverySchema.safeParse({
				...leasedDelivery,
				status: "acknowledged",
				attempt_count: 0,
				last_fencing_token: "0",
				lease: null,
				acknowledged_at: leasedDelivery.updated_at,
			}).success,
		).toBe(false);
		expect(
			deliverySchema.safeParse({
				...leasedDelivery,
				status: "stored",
				attempt_count: 3,
				lease: null,
			}).success,
		).toBe(false);
	});

	it("rejects local paths and unexpected work payloads", () => {
		expect(
			deliverySchema.safeParse({
				...leasedDelivery,
				local_path: "/Users/alice/backend",
				shell_command: "pnpm test",
			}).success,
		).toBe(false);
		expect(
			deliverySchema.safeParse({
				...leasedDelivery,
				lease: {
					...leasedDelivery.lease,
					expires_at: leasedDelivery.updated_at,
				},
			}).success,
		).toBe(false);
	});

	it("rejects impossible delivery chronology", () => {
		expect(
			deliverySchema.safeParse({
				...leasedDelivery,
				updated_at: "2026-08-02T10:02:59.000Z",
			}).success,
		).toBe(false);
		expect(
			deliverySchema.safeParse({
				...leasedDelivery,
				status: "acknowledged",
				lease: null,
				available_at: "2026-08-02T10:05:00.000Z",
				acknowledged_at: leasedDelivery.updated_at,
			}).success,
		).toBe(false);
		expect(
			deliverySchema.safeParse({
				...leasedDelivery,
				available_at: "2026-08-02T10:02:59.000Z",
			}).success,
		).toBe(false);
		expect(
			deliverySchema.safeParse({
				...leasedDelivery,
				lease: {
					...leasedDelivery.lease,
					expires_at: "2026-08-02T10:02:59.000Z",
				},
			}).success,
		).toBe(false);
		expect(
			deliverySchema.safeParse({
				...leasedDelivery,
				status: "acknowledged",
				lease: null,
				acknowledged_at: "2026-08-02T10:05:00.000Z",
			}).success,
		).toBe(false);
	});
});

describe("runSchema", () => {
	const completedRun = {
		run_id: ids.run,
		mission_id: ids.mission,
		participant_agent_id: ids.backendAgent,
		node_id: ids.node,
		delivery_id: ids.delivery,
		lease_id: ids.lease,
		fencing_token: "1",
		contract_version: 1,
		runtime: { name: "openai/codex-app-server", version: "preview/0.146.0" },
		turn_ref: "thread/123",
		status: "completed" as const,
		usage: { available: true as const, input_tokens: 1_500, output_tokens: 300 },
		disposition: { kind: "ready" as const, evidence: [evidence] },
		artifact_hashes: [artifact.sha256],
		verification_evidence: [evidence],
		started_at: "2026-08-02T10:04:00.000Z",
		completed_at: "2026-08-02T10:05:00.000Z",
	};

	it("accepts relay-visible execution evidence", () => {
		expect(runSchema.parse(completedRun)).toEqual(completedRun);
		expect(
			runSchema.safeParse({
				...completedRun,
				usage: { available: false, reason: "unsupported" },
			}).success,
		).toBe(true);
	});

	it("rejects local recovery metadata, raw output, and missing completion state", () => {
		expect(
			runSchema.safeParse({
				...completedRun,
				checkout_path: "/Users/alice/backend",
				raw_tool_output: "secret output",
			}).success,
		).toBe(false);
		expect(runSchema.safeParse({ ...completedRun, completed_at: null }).success).toBe(false);
		expect(
			runSchema.safeParse({
				...completedRun,
				status: "running",
				completed_at: null,
			}).success,
		).toBe(false);
		expect(
			runSchema.safeParse({
				...completedRun,
				disposition: { kind: "failed", class: "permanent" },
			}).success,
		).toBe(false);
		expect(
			runSchema.safeParse({
				...completedRun,
				status: "cancelled",
			}).success,
		).toBe(false);
		expect(
			runSchema.safeParse({
				...completedRun,
				completed_at: "2026-08-02T10:03:00.000Z",
			}).success,
		).toBe(false);
	});
});
