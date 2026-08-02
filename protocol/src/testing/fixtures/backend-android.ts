import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { type HostInputArtifact, hostInputArtifactSchema } from "../../adapter.js";
import type { MissionCoordinatorConfig } from "../../mission-coordinator.js";
import {
	type ArtifactRef,
	type MissionContext,
	artifactRefSchema,
	missionContextSchema,
} from "../../schemas.js";
import {
	type FixedCommand,
	type FrozenRepositoryDefinition,
	type MaterializedFrozenRepository,
	materializeFrozenRepository,
} from "../frozen-repository.js";
import type {
	MissionFixtureEnvironment,
	ScriptedMissionFixture,
} from "../mission-fixture-runner.js";

export const backendAndroidIds = {
	mission: "10000000-0000-4000-8000-000000000001",
	owner: "10000000-0000-4000-8000-000000000002",
	backendAgent: "10000000-0000-4000-8000-000000000003",
	androidAgent: "10000000-0000-4000-8000-000000000004",
	contractArtifact: "10000000-0000-4000-8000-000000000005",
	revision: "10000000-0000-4000-8000-000000000006",
	backendQuestionDelivery: "30000000-0000-4000-8000-000000000001",
	androidAnswerDelivery: "30000000-0000-4000-8000-000000000002",
	backendProposalDelivery: "30000000-0000-4000-8000-000000000003",
	androidProgressDelivery: "30000000-0000-4000-8000-000000000004",
	backendProgressDelivery: "30000000-0000-4000-8000-000000000005",
	androidReadyDelivery: "30000000-0000-4000-8000-000000000006",
	backendReadyDelivery: "30000000-0000-4000-8000-000000000007",
} as const;

export const backendAndroidFixtureRoot = fileURLToPath(
	new URL("../../../fixtures/backend-android/", import.meta.url),
);

const repositoryLockSchema = z
	.object({
		schema_version: z.literal(1),
		repositories: z
			.object({
				backend: repositoryEntrySchema(),
				android: repositoryEntrySchema(),
			})
			.strict(),
	})
	.strict();

function repositoryEntrySchema() {
	return z
		.object({
			repository_url: z.string().url(),
			base_commit: z.string().regex(/^[a-f0-9]{40}$/),
			expected_commit: z.string().regex(/^[a-f0-9]{40}$/),
		})
		.strict();
}

const repositoryLock = repositoryLockSchema.parse(
	JSON.parse(readFileSync(`${backendAndroidFixtureRoot}/repository-lock.json`, "utf8")),
);

const contractLockSchema = z
	.object({
		schema_version: z.literal(1),
		contracts: z
			.object({
				v1: artifactRefSchema,
				v2: artifactRefSchema,
			})
			.strict(),
	})
	.strict()
	.superRefine((lock, ctx) => {
		const { v1, v2 } = lock.contracts;
		if (v1.version !== 1 || v2.version !== 2) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Backend-Android contract locks must contain versions 1 and 2",
				path: ["contracts"],
			});
		}
		if (v1.artifact_id !== v2.artifact_id || v1.type !== v2.type) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Backend-Android contract revisions must preserve artifact identity",
				path: ["contracts", "v2"],
			});
		}
	});

const contractLock = contractLockSchema.parse(
	JSON.parse(readFileSync(`${backendAndroidFixtureRoot}/contract-lock.json`, "utf8")),
);

export const backendAndroidRepositories = {
	backend: repositoryDefinition("backend"),
	android: repositoryDefinition("android"),
} as const satisfies Readonly<Record<string, FrozenRepositoryDefinition>>;

function repositoryDefinition(
	name: keyof typeof repositoryLock.repositories,
): FrozenRepositoryDefinition {
	const entry = repositoryLock.repositories[name];
	return {
		name,
		baseDirectory: `${backendAndroidFixtureRoot}/repositories/${name}/base`,
		expectedDirectory: `${backendAndroidFixtureRoot}/repositories/${name}/expected`,
		baseCommit: entry.base_commit,
		expectedCommit: entry.expected_commit,
	};
}

const contractV1 = inputArtifact(
	contractLock.contracts.v1,
	`${backendAndroidFixtureRoot}/contracts/v1.json`,
	backendAndroidIds.owner,
	"owner",
);
const contractV2 = inputArtifact(
	contractLock.contracts.v2,
	`${backendAndroidFixtureRoot}/contracts/v2.json`,
	backendAndroidIds.backendAgent,
	"agent",
);

export const backendAndroidContracts = {
	v1: contractV1,
	v2: contractV2,
} as const satisfies Readonly<Record<string, HostInputArtifact>>;

export const backendAndroidMissionContext: MissionContext = missionContextSchema.parse({
	manifest: JSON.parse(readFileSync(`${backendAndroidFixtureRoot}/manifest.json`, "utf8")),
	created_by: {
		principal_id: backendAndroidIds.owner,
		kind: "owner",
	},
});

if (
	JSON.stringify(backendAndroidMissionContext.manifest.shared_contract) !==
	JSON.stringify(contractV1.artifact)
) {
	throw new Error("Backend-Android manifest does not match the exact v1 contract payload");
}

for (const participant of backendAndroidMissionContext.manifest.participants) {
	const name = participant.role === "backend" ? "backend" : "android";
	const locked = repositoryLock.repositories[name];
	if (
		participant.repository_url !== locked.repository_url ||
		participant.expected_base_commit !== locked.base_commit
	) {
		throw new Error(`Backend-Android ${name} participant does not match its repository lock`);
	}
}

export const backendAndroidCoordinatorConfig: MissionCoordinatorConfig = {
	mission_context: backendAndroidMissionContext,
	required_verification_commands: {
		[backendAndroidIds.backendAgent]: ["backend-test", "contract-test"],
		[backendAndroidIds.androidAgent]: ["android-test", "public-user-scenario"],
	},
};

export interface BackendAndroidFixtureEnvironment extends MissionFixtureEnvironment {
	readonly temporaryRoot: string;
	readonly backend: MaterializedFrozenRepository;
	readonly android: MaterializedFrozenRepository;
	readonly hiddenUserScenario: FixedCommand;
}

export const backendAndroidMissionFixture: ScriptedMissionFixture<BackendAndroidFixtureEnvironment> =
	{
		coordinatorConfig: backendAndroidCoordinatorConfig,
		artifacts: [contractV1, contractV2],
		turnsByParticipant: {
			[backendAndroidIds.backendAgent]: [
				{
					deliveryId: backendAndroidIds.backendQuestionDelivery,
					disposition: {
						kind: "reply",
						message_type: "question",
						message:
							"Can avatar_url become nullable, and what deterministic fallback should Android render?",
					},
					progress: [{ kind: "output", text: "Comparing the v1 response to Android needs." }],
				},
				{
					deliveryId: backendAndroidIds.backendProposalDelivery,
					disposition: {
						kind: "propose_contract",
						artifact: contractV2.artifact,
					},
					revision: {
						revision_id: backendAndroidIds.revision,
						mission_id: backendAndroidIds.mission,
						previous_version: 1,
						version: 2,
						artifact: contractV2.artifact,
						proposed_by_agent_id: backendAndroidIds.backendAgent,
						acknowledged_by_agent_ids: [],
						idempotency_key: "fixture:revision:2",
						created_at: "2026-08-02T10:00:04.000Z",
					},
					progress: [{ kind: "artifact", artifact: contractV2.artifact }],
				},
				{
					deliveryId: backendAndroidIds.backendProgressDelivery,
					disposition: {
						kind: "reply",
						message_type: "progress",
						message: "Backend now emits the accepted nullable avatar response.",
					},
					progress: [
						{
							kind: "tool",
							activity: {
								toolCallId: "backend-edit-1",
								name: "fixture-edit",
								phase: "completed",
							},
						},
					],
				},
				{
					deliveryId: backendAndroidIds.backendReadyDelivery,
					disposition: { kind: "ready", evidence: [] },
				},
			],
			[backendAndroidIds.androidAgent]: [
				{
					deliveryId: backendAndroidIds.androidAnswerDelivery,
					disposition: {
						kind: "reply",
						message_type: "answer",
						message:
							"Yes. Use null and render uppercase initials from the first and last non-empty display-name segments.",
					},
					progress: [{ kind: "output", text: "Checking decoder and UI fallback constraints." }],
					replayMode: "duplicate_start",
				},
				{
					deliveryId: backendAndroidIds.androidProgressDelivery,
					disposition: {
						kind: "reply",
						message_type: "progress",
						message: "Android now accepts null and renders the agreed initials fallback.",
					},
					progress: [
						{ kind: "output", text: "Updating the profile decoder." },
						{
							kind: "usage",
							usage: {
								available: true,
								scope: "turn_cumulative",
								inputTokens: 320,
								outputTokens: 90,
							},
						},
					],
					replayMode: "recover_after_partial",
				},
				{
					deliveryId: backendAndroidIds.androidReadyDelivery,
					disposition: { kind: "ready", evidence: [] },
				},
			],
		},
		contractAcknowledgements: [
			{
				participantAgentId: backendAndroidIds.backendAgent,
				revisionId: backendAndroidIds.revision,
				contractVersion: 2,
				artifact: contractV2.artifact,
			},
			{
				participantAgentId: backendAndroidIds.androidAgent,
				revisionId: backendAndroidIds.revision,
				contractVersion: 2,
				artifact: contractV2.artifact,
			},
		],
		async prepareEnvironment() {
			const temporaryRoot = await mkdtemp(join(tmpdir(), "agentrelay-backend-android-"));
			try {
				const [backend, android] = await Promise.all([
					materializeFrozenRepository(backendAndroidRepositories.backend, temporaryRoot),
					materializeFrozenRepository(backendAndroidRepositories.android, temporaryRoot),
				]);
				const verificationRoot = `${backendAndroidFixtureRoot}/verification`;
				const contractPath = `${backendAndroidFixtureRoot}/contracts/v2.json`;
				return {
					temporaryRoot,
					backend,
					android,
					verificationCommands: {
						[backendAndroidIds.backendAgent]: {
							"backend-test": verificationCommand(
								backend.expectedPath,
								["verify.mjs"],
								"Backend profile response matches contract v2.",
							),
							"contract-test": verificationCommand(
								verificationRoot,
								["verify-contract.mjs", contractPath],
								"Shared profile contract v2 is executable and valid.",
							),
						},
						[backendAndroidIds.androidAgent]: {
							"android-test": verificationCommand(
								android.expectedPath,
								["verify.mjs"],
								"Android profile fallback matches contract v2.",
							),
							"public-user-scenario": verificationCommand(
								verificationRoot,
								["public-user-scenario.mjs", backend.expectedPath, android.expectedPath],
								"Public cross-repository profile scenario passes.",
							),
						},
					},
					hiddenUserScenario: {
						executable: process.execPath,
						args: ["hidden-user-scenario.mjs", backend.expectedPath, android.expectedPath],
						cwd: verificationRoot,
					},
				};
			} catch (error) {
				await rm(temporaryRoot, { recursive: true, force: true });
				throw error;
			}
		},
		async disposeEnvironment(environment) {
			await rm(environment.temporaryRoot, { recursive: true, force: true });
		},
	};

function verificationCommand(cwd: string, args: readonly string[], summary: string) {
	return {
		command: {
			executable: process.execPath,
			args,
			cwd,
		},
		summary,
		durationMs: 1,
	};
}

function inputArtifact(
	lockedArtifact: ArtifactRef,
	path: string,
	principalId: string,
	kind: "owner" | "agent",
): HostInputArtifact {
	const rawText = readFileSync(path, "utf8");
	const sha256 = createHash("sha256").update(rawText, "utf8").digest("hex");
	const byteSize = Buffer.byteLength(rawText, "utf8");
	if (sha256 !== lockedArtifact.sha256 || byteSize !== lockedArtifact.byte_size) {
		throw new Error(`Backend-Android contract v${lockedArtifact.version} does not match its lock`);
	}
	return hostInputArtifactSchema.parse({
		artifact: lockedArtifact,
		source: {
			principal_id: principalId,
			kind,
		},
		payload: {
			kind: "json",
			rawText,
		},
	});
}
