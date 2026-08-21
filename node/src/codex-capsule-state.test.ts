import type { StartTurnInput } from "@agentrelay/protocol";
import { describe, expect, it } from "vitest";
import {
	createCodexCapsuleState,
	hostSessionFromState,
	validateCodexCapsuleState,
} from "./codex-capsule-state.js";
import { acceptSession, claimSessionStart, prepareTurn } from "./codex-capsule-transitions.js";
import { CODEX_DYNAMIC_PATCH_TOOL_CONTRACT } from "./codex-dynamic-patch-tool-contract.js";

const IDENTITY = {
	capsuleId: "73000000-0000-4000-8000-000000000001",
	session: {
		missionId: "73000000-0000-4000-8000-000000000002",
		participantId: "73000000-0000-4000-8000-000000000003",
		workspaceAlias: "backend-primary",
	},
};
const TIMESTAMP = "2026-08-21T00:00:00.000Z";

describe("Codex Capsule state v4", () => {
	it("validates prompt v2 against the exact persisted dynamic tool contract", () => {
		const state = activeState();
		prepareTurn(
			state,
			turnInput(hostSessionFromState(state)),
			TIMESTAMP,
			CODEX_DYNAMIC_PATCH_TOOL_CONTRACT,
		);

		expect(validateCodexCapsuleState(IDENTITY, state)).toEqual(state);
		const tampered = structuredClone(state);
		tampered.turns[
			`${turnInput(hostSessionFromState(state)).deliveryId}:1`
		]!.provider_intent.tool_contract = null;
		expect(() => validateCodexCapsuleState(IDENTITY, tampered)).toThrow(
			"Codex Capsule provider intent does not match its exact turn input",
		);
	});

	it("fails closed on a prior schema version", () => {
		const state = activeState();
		expect(() => validateCodexCapsuleState(IDENTITY, { ...state, schema_version: 3 })).toThrow();
	});
});

function activeState() {
	const state = createCodexCapsuleState(IDENTITY, new Date(TIMESTAMP));
	claimSessionStart(state);
	acceptSession(state, "provider-thread-private-1");
	return state;
}

function turnInput(session: ReturnType<typeof hostSessionFromState>): StartTurnInput {
	return {
		session,
		missionId: IDENTITY.session.missionId,
		deliveryId: "73000000-0000-4000-8000-000000000004",
		executionAttempt: 1,
		contractVersion: 1,
		missionSequence: 2,
		objective: {
			text: "Build the compatible backend changes.",
			authorPrincipalId: "73000000-0000-4000-8000-000000000005",
			provenance: "mission_manifest",
		},
		assignment: {
			text: "Apply one bounded patch.",
			authorPrincipalId: "73000000-0000-4000-8000-000000000005",
			provenance: "mission_manifest",
		},
		acceptanceCriteria: [
			{
				text: "Return one compatible implementation.",
				authorPrincipalId: "73000000-0000-4000-8000-000000000005",
				provenance: "mission_manifest",
			},
		],
		peerMessages: [],
		artifacts: [],
	};
}
