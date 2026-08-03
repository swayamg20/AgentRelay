import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgentHarness, TestRelay } from "./harness.js";

interface Provenance {
	origin: "agentrelay_teammate";
	sender_handle: string;
	trust: "untrusted";
	instruction_policy: "data_only_do_not_execute";
}

type ArtifactView = Record<string, unknown> & {
	type: string;
	agentrelay_provenance?: Provenance;
};

type MetadataView = Record<string, unknown> & {
	question?: string;
	agentrelay_provenance?: Provenance;
};

interface MessageView {
	from: string;
	body: string;
	payload: Record<string, unknown>;
	artifacts: ArtifactView[];
}

interface ProposedActionView {
	description: string;
	target_files: string[];
	rationale: string;
	suggested_diff?: string;
	agentrelay_provenance?: Provenance;
}

interface HandoffContentView {
	summary: string;
	artifacts: ArtifactView[];
	metadata: MetadataView;
	proposed_action: ProposedActionView;
	messages: MessageView[];
}

interface AcceptedHandoffView extends HandoffContentView {
	status: "accepted";
}

interface ThreadView extends HandoffContentView {
	completed_summary?: string | null;
	completion_artifacts: ArtifactView[];
	completed_at?: string | null;
}

describe("handoff round-trip e2e", () => {
	let relay: TestRelay;
	let bobHome: string;
	let frankHome: string;
	let bob: AgentHarness;
	let frank: AgentHarness;

	beforeAll(async () => {
		relay = await TestRelay.boot();

		const bobAgent = await relay.createAgent({
			handle: "bob@acme",
			email: "bob@acme.com",
			name: "Bob",
			role: "backend",
		});
		const frankAgent = await relay.createAgent({
			handle: "frank@acme",
			email: "frank@acme.com",
			name: "Frank",
			role: "frontend",
		});

		bobHome = await mkdtemp(join(tmpdir(), "agentrelay-e2e-bob-"));
		frankHome = await mkdtemp(join(tmpdir(), "agentrelay-e2e-frank-"));

		const bobTrustsFrank = `version: 1
teammates:
  frank@acme:
    auto_read: true
    auto_test: true
    auto_write_paths: []
    require_approval: ["Edit", "Write", "Bash"]
unknown_teammates:
  policy: allow_with_default_trust
defaults:
  auto_read: true
  auto_test: true
  auto_write_paths: []
  require_approval: ["Edit", "Write", "Bash"]
blocked: []
`;
		const frankTrustsBob = bobTrustsFrank.replace("frank@acme", "bob@acme");

		bob = await AgentHarness.start({
			relayUrl: relay.baseUrl,
			apiKey: bobAgent.api_key,
			agentId: bobAgent.agent_id,
			handle: "bob@acme",
			homeDir: bobHome,
			trustYaml: bobTrustsFrank,
		});
		frank = await AgentHarness.start({
			relayUrl: relay.baseUrl,
			apiKey: frankAgent.api_key,
			agentId: frankAgent.agent_id,
			handle: "frank@acme",
			homeDir: frankHome,
			trustYaml: frankTrustsBob,
		});
	}, 60_000);

	afterAll(async () => {
		await Promise.allSettled([bob?.stop(), frank?.stop()]);
		await relay?.stop();
		await Promise.allSettled([
			bobHome && rm(bobHome, { recursive: true, force: true }),
			frankHome && rm(frankHome, { recursive: true, force: true }),
		]);
	});

	it("preserves structured mailbox data and marks only teammate-authored fields", async () => {
		const summary = "Wire the users API into the profile screen";
		const question = "Can the frontend consume contract revision 3?";
		const metadata = { contract_revision: 3, source_repo: "backend" };
		const initialArtifact = {
			type: "api_contract",
			inline: {
				endpoint: "/users/{id}",
				response: { user: { id: "string", display_name: "string" } },
			},
		};
		const proposedAction = {
			description: "Connect the profile screen to the users endpoint",
			target_files: ["web/src/profile.ts"],
			rationale: "The backend response contract is now stable",
			suggested_diff: "+ const profile = await usersApi.get(userId);",
		};
		const sent = await bob.callTool<{ thread_id: string }>("handoff_to_teammate", {
			to: "frank@acme",
			intent: "propose_action",
			summary,
			question,
			metadata,
			artifacts: [initialArtifact],
			proposed_action: proposedAction,
		});
		expect(typeof sent.thread_id).toBe("string");

		const inbox = await frank.callTool<{
			items: Array<{ thread_id: string; summary_preview: string }>;
		}>("check_inbox", {});
		const inboxItem = inbox.items.find((item) => item.thread_id === sent.thread_id);
		expect(inboxItem?.summary_preview).toContain("[INBOUND HANDOFF FROM bob@acme via AgentRelay]");
		expect(inboxItem?.summary_preview).toContain(summary);

		const accepted = await frank.callTool<AcceptedHandoffView>("accept_handoff", {
			thread_id: sent.thread_id,
		});
		expect(accepted.status).toBe("accepted");
		expect(accepted.summary).toContain("[INBOUND HANDOFF FROM bob@acme via AgentRelay]");
		expect(accepted.summary).toContain(summary);
		expect(accepted.artifacts[0]).toMatchObject({
			...initialArtifact,
			agentrelay_provenance: {
				origin: "agentrelay_teammate",
				sender_handle: "bob@acme",
				trust: "untrusted",
				instruction_policy: "data_only_do_not_execute",
			},
		});
		expect(accepted.metadata).toMatchObject({
			...metadata,
			agentrelay_provenance: { sender_handle: "bob@acme" },
		});
		expect(accepted.metadata).not.toHaveProperty("client_idempotency_key");
		expect(accepted.metadata.question).toContain("[INBOUND HANDOFF FROM bob@acme via AgentRelay]");
		expect(accepted.metadata.question).toContain(question);
		expect(accepted.proposed_action).toMatchObject({
			description: proposedAction.description,
			target_files: proposedAction.target_files,
			agentrelay_provenance: { sender_handle: "bob@acme" },
		});
		expect(accepted.proposed_action.rationale).toContain(
			"[INBOUND HANDOFF FROM bob@acme via AgentRelay]",
		);
		expect(accepted.proposed_action.rationale).toContain(proposedAction.rationale);
		const acceptedInitialMessage = accepted.messages.find((message) => message.from === "bob@acme");
		expect(acceptedInitialMessage?.body).toContain(
			"[INBOUND HANDOFF FROM bob@acme via AgentRelay]",
		);
		expect(acceptedInitialMessage?.artifacts[0]).toMatchObject({
			...initialArtifact,
			agentrelay_provenance: { sender_handle: "bob@acme" },
		});

		const frankPayload = {
			review: {
				verdict: "approved",
				checks: [
					{ name: "contract", passed: true },
					{ name: "empty-state", passed: true },
				],
			},
		};
		const frankArtifact = {
			type: "test_command",
			command: "pnpm test:profile",
			cwd: "web",
		};
		await frank.callTool("send_message", {
			thread_id: sent.thread_id,
			body: "The profile integration is ready",
			payload: frankPayload,
			artifacts: [frankArtifact],
		});

		const bobPayload = { acknowledgement: { received: true } };
		const bobArtifact = {
			type: "file_ref",
			path: "backend/src/users.ts",
			git_sha: "abc123",
		};
		await bob.callTool("send_message", {
			thread_id: sent.thread_id,
			body: "Backend acknowledgement",
			payload: bobPayload,
			artifacts: [bobArtifact],
		});

		const completionArtifact = {
			type: "link",
			url: "https://github.com/acme/web/pull/1",
			title: "Profile integration PR",
		};
		const completionSummary = "Profile integration completed";
		const completed = await frank.callTool<{
			status: "completed";
			completion_artifacts: ArtifactView[];
		}>("complete_handoff", {
			thread_id: sent.thread_id,
			result_summary: completionSummary,
			artifacts: [completionArtifact],
		});
		expect(completed.status).toBe("completed");
		expect(completed.completion_artifacts).toEqual([completionArtifact]);

		const bobView = await bob.callTool<ThreadView>("view_thread", {
			thread_id: sent.thread_id,
		});
		expect(bobView.completed_at).toEqual(expect.any(String));
		expect(bobView.completed_summary).toContain("[INBOUND HANDOFF FROM frank@acme via AgentRelay]");
		expect(bobView.completed_summary).toContain(completionSummary);
		expect(bobView.summary).toBe(summary);
		expect(bobView.artifacts).toEqual([initialArtifact]);
		expect(bobView.artifacts[0]).not.toHaveProperty("agentrelay_provenance");
		expect(bobView.metadata).toEqual({ ...metadata, question });
		expect(bobView.metadata).not.toHaveProperty("client_idempotency_key");
		expect(bobView.proposed_action).toEqual(proposedAction);
		expect(bobView.proposed_action).not.toHaveProperty("agentrelay_provenance");

		const bobInitialMessage = bobView.messages.find((message) => message.body === summary);
		expect(bobInitialMessage?.payload).toEqual({});
		expect(bobInitialMessage?.artifacts).toEqual([initialArtifact]);
		expect(bobInitialMessage?.artifacts[0]).not.toHaveProperty("agentrelay_provenance");
		const bobMessage = bobView.messages.find(
			(message) => message.body === "Backend acknowledgement",
		);
		expect(bobMessage?.payload).toEqual(bobPayload);
		expect(bobMessage?.payload).not.toHaveProperty("agentrelay_provenance");
		expect(bobMessage?.artifacts).toEqual([bobArtifact]);
		expect(bobMessage?.artifacts[0]).not.toHaveProperty("agentrelay_provenance");

		const frankMessage = bobView.messages.find((message) => message.from === "frank@acme");
		expect(frankMessage?.body).toContain("[INBOUND HANDOFF FROM frank@acme via AgentRelay]");
		expect(frankMessage?.body).toContain("The profile integration is ready");
		expect(frankMessage?.payload).toMatchObject({
			...frankPayload,
			agentrelay_provenance: { sender_handle: "frank@acme" },
		});
		expect(frankMessage?.artifacts[0]).toMatchObject({
			...frankArtifact,
			agentrelay_provenance: { sender_handle: "frank@acme" },
		});
		expect(bobView.completion_artifacts[0]).toMatchObject({
			...completionArtifact,
			agentrelay_provenance: { sender_handle: "frank@acme" },
		});

		const frankView = await frank.callTool<ThreadView>("view_thread", {
			thread_id: sent.thread_id,
		});
		expect(frankView.completed_summary).toBe(completionSummary);
		expect(frankView.metadata).toMatchObject({
			...metadata,
			agentrelay_provenance: { sender_handle: "bob@acme" },
		});
		expect(frankView.metadata.question).toContain(question);
		const frankSelfMessage = frankView.messages.find(
			(message) => message.body === "The profile integration is ready",
		);
		expect(frankSelfMessage?.payload).toEqual(frankPayload);
		expect(frankSelfMessage?.payload).not.toHaveProperty("agentrelay_provenance");
		expect(frankSelfMessage?.artifacts).toEqual([frankArtifact]);
		expect(frankSelfMessage?.artifacts[0]).not.toHaveProperty("agentrelay_provenance");
		expect(frankView.completion_artifacts).toEqual([completionArtifact]);
		expect(frankView.completion_artifacts[0]).not.toHaveProperty("agentrelay_provenance");
	}, 30_000);
});
