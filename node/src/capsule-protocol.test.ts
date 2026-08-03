import { createHash } from "node:crypto";
import { MAX_ARTIFACT_BYTES } from "@agentrelay/protocol";
import { describe, expect, it } from "vitest";
import {
	MAX_CAPSULE_REQUEST_FRAME_BYTES,
	MAX_CAPSULE_RESPONSE_FRAME_BYTES,
	capsuleRequestSchema,
	capsuleResponseSchema,
} from "./capsule-protocol.js";

const IDS = {
	capsule: "70000000-0000-4000-8000-000000000001",
	request: "70000000-0000-4000-8000-000000000002",
	mission: "70000000-0000-4000-8000-000000000003",
	participant: "70000000-0000-4000-8000-000000000004",
	owner: "70000000-0000-4000-8000-000000000005",
	delivery: "70000000-0000-4000-8000-000000000006",
	message: "70000000-0000-4000-8000-000000000007",
	artifact: "70000000-0000-4000-8000-000000000008",
	verification: "70000000-0000-4000-8000-000000000009",
} as const;

describe("capsule wire bounds", () => {
	it("fits a maximum-size recover request after worst-case JSON escaping", () => {
		const text = "\u0001".repeat(16_000);
		const artifactText = "\u0000".repeat(MAX_ARTIFACT_BYTES);
		const missionText = {
			text,
			authorPrincipalId: IDS.owner,
			provenance: "mission_manifest" as const,
		};
		const session = {
			sessionId: "\ud800".repeat(256),
			missionId: IDS.mission,
			participantId: IDS.participant,
			workspaceAlias: "w".repeat(64),
		};
		const input = {
			session,
			missionId: IDS.mission,
			deliveryId: IDS.delivery,
			executionAttempt: Number.MAX_SAFE_INTEGER,
			contractVersion: 1_000_000,
			missionSequence: Number.MAX_SAFE_INTEGER,
			objective: missionText,
			assignment: missionText,
			acceptanceCriteria: Array.from({ length: 32 }, () => missionText),
			peerMessages: Array.from({ length: 64 }, () => ({
				messageId: IDS.message,
				authorAgentId: IDS.participant,
				kind: "progress" as const,
				body: text,
			})),
			artifacts: Array.from({ length: 16 }, () => ({
				artifact: {
					artifact_id: IDS.artifact,
					type: "a".repeat(64),
					version: 1_000_000,
					sha256: createHash("sha256").update(artifactText).digest("hex"),
					media_type: "\u0001".repeat(128),
					byte_size: MAX_ARTIFACT_BYTES,
				},
				source: { principal_id: IDS.participant, kind: "agent" as const },
				payload: { kind: "text" as const, text: artifactText },
			})),
		};
		const request = capsuleRequestSchema.parse({
			version: 1,
			capsule_id: IDS.capsule,
			capability_token: `ar_capsule_${"a".repeat(64)}`,
			request_id: IDS.request,
			method: "recover_turn",
			params: {
				turn: {
					turnId: "\ud800".repeat(256),
					sessionId: session.sessionId,
					missionId: IDS.mission,
					deliveryId: IDS.delivery,
					executionAttempt: Number.MAX_SAFE_INTEGER,
					contractVersion: 1_000_000,
				},
				input,
			},
		});

		const bytes = Buffer.byteLength(`${JSON.stringify(request)}\n`, "utf8");
		expect(bytes).toBeGreaterThan(100 * 1_048_576);
		expect(bytes).toBeLessThanOrEqual(MAX_CAPSULE_REQUEST_FRAME_BYTES);
	}, 30_000);

	it("fits the largest bounded ready event within the response cap", () => {
		const artifact = {
			artifact_id: IDS.artifact,
			type: "a".repeat(64),
			version: 1_000_000,
			sha256: "b".repeat(64),
			media_type: "\u0001".repeat(128),
			byte_size: MAX_ARTIFACT_BYTES,
		};
		const turn = {
			turnId: "\ud800".repeat(256),
			sessionId: "\ud800".repeat(256),
			missionId: IDS.mission,
			deliveryId: IDS.delivery,
			executionAttempt: Number.MAX_SAFE_INTEGER,
			contractVersion: 1_000_000,
		};
		const response = capsuleResponseSchema.parse({
			version: 1,
			capsule_id: IDS.capsule,
			request_id: IDS.request,
			kind: "event",
			event: {
				kind: "completed",
				turn,
				sequence: Number.MAX_SAFE_INTEGER,
				disposition: {
					kind: "ready",
					evidence: Array.from({ length: 16 }, () => ({
						verification_id: IDS.verification,
						command_id: "c".repeat(64),
						outcome: "failed" as const,
						exit_code: 255,
						duration_ms: 604_800_000,
						summary: "\u0001".repeat(16_000),
						output_sha256: "d".repeat(64),
						artifacts: Array.from({ length: 16 }, () => artifact),
						recorded_at: `2026-08-02T10:05:00.${"0".repeat(43)}Z`,
					})),
				},
			},
		});

		const bytes = Buffer.byteLength(`${JSON.stringify(response)}\n`, "utf8");
		expect(bytes).toBeGreaterThan(1_048_576);
		expect(bytes).toBeLessThanOrEqual(MAX_CAPSULE_RESPONSE_FRAME_BYTES);
	});
});
