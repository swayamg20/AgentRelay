import type { StartTurnInput } from "@agentrelay/protocol";
import { describe, expect, it } from "vitest";
import {
	CODEX_CAPSULE_PROMPT_VERSION,
	buildCodexCapsuleTurnIntent,
} from "./codex-capsule-prompt.js";
import { CODEX_DYNAMIC_PATCH_TOOL_CONTRACT } from "./codex-dynamic-patch-tool-contract.js";

describe("Codex Capsule prompt", () => {
	it("keeps read-only turns on prompt v2 without a dynamic write contract", () => {
		const intent = buildCodexCapsuleTurnIntent(turnInput());

		expect(intent.promptVersion).toBe(CODEX_CAPSULE_PROMPT_VERSION);
		expect(intent.toolContract).toBeNull();
		expect(intent.text).toContain("read-only local participant");
		expect(intent.text).toContain("Do not write files");
		expect(intent.text).not.toContain(CODEX_DYNAMIC_PATCH_TOOL_CONTRACT);
	});

	it("binds logical write to the one mediated patch contract while direct access stays read-only", () => {
		const input = turnInput();
		const first = buildCodexCapsuleTurnIntent(input, CODEX_DYNAMIC_PATCH_TOOL_CONTRACT);
		const replay = buildCodexCapsuleTurnIntent(input, CODEX_DYNAMIC_PATCH_TOOL_CONTRACT);

		expect(first).toEqual(replay);
		expect(first.promptVersion).toBe(2);
		expect(first.toolContract).toBe(CODEX_DYNAMIC_PATCH_TOOL_CONTRACT);
		expect(first.text).toContain("direct provider workspace access is physically read-only");
		expect(first.text).toContain(
			`only permitted write is to request ${CODEX_DYNAMIC_PATCH_TOOL_CONTRACT}`,
		);
		expect(first.text).toContain(
			"Never claim that a patch was applied unless that tool returned success",
		);
		expect(first.text).toContain(
			"Do not request or use any other file write, command execution, network action, approval, credential, or authority",
		);
		expect(first.textSha256).not.toBe(buildCodexCapsuleTurnIntent(input).textSha256);
	});

	it("rejects an unsupported dynamic tool contract", () => {
		expect(() =>
			buildCodexCapsuleTurnIntent(turnInput(), "agentrelay.apply_patch/v2" as never),
		).toThrow("Codex Capsule patch tool contract is unsupported");
	});
});

function turnInput(): StartTurnInput {
	return {
		session: {
			missionId: "72000000-0000-4000-8000-000000000001",
			participantId: "72000000-0000-4000-8000-000000000002",
			workspaceAlias: "backend-primary",
			sessionId: "capsule-session-private-1",
		},
		missionId: "72000000-0000-4000-8000-000000000001",
		deliveryId: "72000000-0000-4000-8000-000000000003",
		executionAttempt: 1,
		contractVersion: 1,
		missionSequence: 2,
		objective: {
			text: "Build the compatible backend changes.",
			authorPrincipalId: "72000000-0000-4000-8000-000000000004",
			provenance: "mission_manifest",
		},
		assignment: {
			text: "Apply one bounded patch.",
			authorPrincipalId: "72000000-0000-4000-8000-000000000004",
			provenance: "mission_manifest",
		},
		acceptanceCriteria: [
			{
				text: "Return one compatible implementation.",
				authorPrincipalId: "72000000-0000-4000-8000-000000000004",
				provenance: "mission_manifest",
			},
		],
		peerMessages: [],
		artifacts: [],
	};
}
