import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { missionCreationResultSchema, nodeEnrollmentResultSchema } from "@agentrelay/protocol";
import { FakeAgentHostAdapter } from "@agentrelay/protocol/testing";
import {
	DeliveryProcessor,
	ForegroundNode,
	NodeJournal,
	createFileJournalStorage,
	createNodeRelayClient,
	nodeConfigSchema,
} from "agentrelay-node";
import { request } from "undici";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestRelay } from "./harness.js";

const execFile = promisify(execFileCallback);

describe("foreground Node delivery", () => {
	let relay: TestRelay;
	let temporaryRoot: string;

	beforeAll(async () => {
		temporaryRoot = await mkdtemp(join(tmpdir(), "agentrelay-node-e2e-"));
		relay = await TestRelay.boot({ port: 18083 });
	}, 30_000);

	afterAll(async () => {
		await relay?.stop();
		await rm(temporaryRoot, { recursive: true, force: true });
	});

	it("acknowledges one real Relay delivery and suppresses duplicates after runner reconstruction", async () => {
		const backend = await relay.createAgent({
			handle: "node-backend@e2e",
			email: "node-backend@example.com",
			name: "Node Backend",
			role: "backend",
		});
		const client = await relay.createAgent({
			handle: "node-client@e2e",
			email: "node-client@example.com",
			name: "Node Client",
			role: "client",
		});
		const backendNode = await enrollNode(relay.baseUrl, backend.api_key, "backend-machine");
		const clientNode = await enrollNode(relay.baseUrl, client.api_key, "client-machine");
		const backendRepo = await createRepository(
			join(temporaryRoot, "backend"),
			"https://github.com/acme/node-backend.git",
		);
		const clientRepo = await createRepository(
			join(temporaryRoot, "client"),
			"https://github.com/acme/node-client.git",
		);

		const backendConfig = nodeConfigSchema.parse(
			localConfig(relay.baseUrl, backend.agent_id, backendNode, "backend", backendRepo),
		);
		const clientConfig = nodeConfigSchema.parse(
			localConfig(relay.baseUrl, client.agent_id, clientNode, "client", clientRepo),
		);
		const backendJournalPath = join(temporaryRoot, "backend-state", "journal.json");
		const clientJournalPath = join(temporaryRoot, "client-state", "journal.json");
		const backendJournal = await NodeJournal.open(createFileJournalStorage(backendJournalPath));
		const clientJournal = await NodeJournal.open(createFileJournalStorage(clientJournalPath));
		const backendAdapter = new FakeAgentHostAdapter();
		backendAdapter.queueOutcome({
			kind: "completed",
			disposition: {
				kind: "reply",
				message_type: "progress",
				message: "Backend fake runtime completed its bounded turn.",
			},
		});
		const clientAdapter = new FakeAgentHostAdapter();
		clientAdapter.queueOutcome({
			kind: "completed",
			disposition: {
				kind: "reply",
				message_type: "progress",
				message: "Client fake runtime recovered its bounded turn.",
			},
		});
		const backendRelayClient = createNodeRelayClient({
			relayUrl: relay.baseUrl,
			credential: backendNode.credential.token,
		});
		const clientRelayClient = createNodeRelayClient({
			relayUrl: relay.baseUrl,
			credential: clientNode.credential.token,
		});
		const backendDaemon = new ForegroundNode({
			config: backendConfig,
			client: backendRelayClient,
			journal: backendJournal,
			adapter: backendAdapter,
		});
		const clientDaemon = new ForegroundNode({
			config: clientConfig,
			client: clientRelayClient,
			journal: clientJournal,
			adapter: clientAdapter,
		});
		await backendDaemon.initialize();
		await clientDaemon.initialize();

		const missionId = randomUUID();
		await createMission(relay.baseUrl, backend.api_key, {
			missionId,
			backendAgentId: backend.agent_id,
			clientAgentId: client.agent_id,
			backendCommit: backendRepo.commit,
			clientCommit: clientRepo.commit,
		});

		expect((await backendDaemon.runCycle()).acceptedMissions).toBe(1);
		expect((await clientDaemon.runCycle()).acceptedMissions).toBe(1);
		const completedCycle = await backendDaemon.runCycle();
		expect(completedCycle.processedDeliveryId).not.toBeNull();
		const completedDeliveryId = completedCycle.processedDeliveryId!;
		expect(backendJournal.snapshot().deliveries[completedDeliveryId]?.phase).toBe("acknowledged");
		expect(backendAdapter.counters.turnsCreated).toBe(1);

		await backendDaemon.runCycle();
		const reopenedJournal = await NodeJournal.open(createFileJournalStorage(backendJournalPath));
		const restartedDaemon = new ForegroundNode({
			config: backendConfig,
			client: backendRelayClient,
			journal: reopenedJournal,
			adapter: backendAdapter,
		});
		await restartedDaemon.runCycle();

		expect(reopenedJournal.snapshot().deliveries[completedDeliveryId]?.phase).toBe("acknowledged");
		expect(backendAdapter.counters.turnsCreated).toBe(1);

		const clientPage = await clientRelayClient.pollDeliveries(clientJournal.snapshot().cursor);
		await clientJournal.ingestCursorPage(clientPage.items, clientPage.next_cursor);
		const clientDeliveryId = clientPage.items[0]?.delivery.delivery_id;
		expect(clientDeliveryId).toBeDefined();
		let crashAfterAcceptance = true;
		const crashingProcessor = new DeliveryProcessor({
			config: clientConfig,
			client: clientRelayClient,
			journal: clientJournal,
			adapter: clientAdapter,
			onCheckpoint(checkpoint) {
				if (crashAfterAcceptance && checkpoint === "host_accepted") {
					crashAfterAcceptance = false;
					throw new Error("injected e2e crash after host acceptance");
				}
			},
		});
		await expect(crashingProcessor.process(clientDeliveryId!)).rejects.toThrow(
			"injected e2e crash",
		);
		await new DeliveryProcessor({
			config: clientConfig,
			client: clientRelayClient,
			journal: clientJournal,
			adapter: clientAdapter,
		}).process(clientDeliveryId!);

		expect(clientAdapter.counters.turnsCreated).toBe(1);
		expect(clientAdapter.counters.recoverTurnCalls).toBe(1);
		expect(clientJournal.snapshot().deliveries[clientDeliveryId!]?.phase).toBe("acknowledged");
		const assignment = await backendRelayClient.getAssignment(missionId);
		expect(assignment.coordinator_state.turn_count).toBe(2);
		expect(assignment.coordinator_state.messages).toHaveLength(2);
	}, 30_000);
});

interface LocalRepository {
	readonly path: string;
	readonly url: string;
	readonly commit: string;
}

async function createRepository(path: string, url: string): Promise<LocalRepository> {
	await mkdir(path, { recursive: true });
	const canonicalPath = await realpath(path);
	await execFile("git", ["init", "--initial-branch=main"], { cwd: canonicalPath });
	await execFile("git", ["config", "user.email", "agentrelay-e2e@example.com"], {
		cwd: canonicalPath,
	});
	await execFile("git", ["config", "user.name", "AgentRelay E2E"], { cwd: canonicalPath });
	await writeFile(join(canonicalPath, "README.md"), "# Node fixture\n", "utf8");
	await execFile("git", ["add", "README.md"], { cwd: canonicalPath });
	await execFile("git", ["commit", "-m", "fixture"], { cwd: canonicalPath });
	await execFile("git", ["remote", "add", "origin", url], { cwd: canonicalPath });
	const { stdout } = await execFile("git", ["rev-parse", "HEAD"], { cwd: canonicalPath });
	return { path: canonicalPath, url, commit: stdout.trim() };
}

function localConfig(
	relayUrl: string,
	agentId: string,
	enrolled: ReturnType<typeof nodeEnrollmentResultSchema.parse>,
	alias: string,
	repository: LocalRepository,
) {
	return {
		schema_version: 1,
		relay_url: relayUrl,
		node: {
			node_id: enrolled.node.node_id,
			agent_id: agentId,
			credential_id: enrolled.credential.id,
			token: enrolled.credential.token,
		},
		workspaces: {
			[alias]: {
				path: repository.path,
				repository_url: repository.url,
				allowed_base_refs: ["refs/heads/main"],
				policy_profile: "bounded-code",
			},
		},
		policy_profiles: {
			"bounded-code": {
				max_turn_seconds: 300,
				max_reported_tokens: 10_000,
				network_access: "denied",
				verification_commands: {
					test: { argv: ["git", "status", "--porcelain"], timeout_seconds: 30, environment: [] },
				},
			},
		},
	};
}

async function enrollNode(baseUrl: string, agentKey: string, name: string) {
	const response = await postJson(`${baseUrl}/agents/me/nodes`, agentKey, {
		name,
		capabilities: ["fake-runtime"],
	});
	return nodeEnrollmentResultSchema.parse(response);
}

async function createMission(
	baseUrl: string,
	agentKey: string,
	input: {
		missionId: string;
		backendAgentId: string;
		clientAgentId: string;
		backendCommit: string;
		clientCommit: string;
	},
) {
	const now = new Date();
	const contract = {
		artifact_id: randomUUID(),
		type: "api_contract",
		version: 1,
		sha256: "a".repeat(64),
		media_type: "application/json",
		byte_size: 2,
	};
	const response = await postJson(`${baseUrl}/agents/me/missions`, agentKey, {
		mission_context: {
			manifest: {
				schema_version: 1,
				mission_id: input.missionId,
				objective: "Prove one durable backend-to-client delivery.",
				public_acceptance_criteria: ["The backend Node publishes one correlated result."],
				participants: [
					{
						agent_id: input.backendAgentId,
						role: "backend",
						workspace_alias: "backend",
						repository_url: "https://github.com/acme/node-backend.git",
						expected_base_commit: input.backendCommit,
						initial_assignment: "Publish one bounded progress result.",
						requested_local_policy_profile: "bounded-code",
					},
					{
						agent_id: input.clientAgentId,
						role: "client",
						workspace_alias: "client",
						repository_url: "https://github.com/acme/node-client.git",
						expected_base_commit: input.clientCommit,
						initial_assignment: "Receive the backend result.",
						requested_local_policy_profile: "bounded-code",
					},
				],
				shared_contract: contract,
				max_turns: 4,
				max_wall_time_seconds: 3_600,
				token_budget: 100_000,
				expires_at: new Date(now.getTime() + 3_600_000).toISOString(),
				allowed_artifact_types: ["api_contract"],
				created_at: now.toISOString(),
			},
			created_by: { principal_id: input.backendAgentId, kind: "agent" },
		},
		required_verification_commands: {
			[input.backendAgentId]: ["test"],
			[input.clientAgentId]: ["test"],
		},
	});
	return missionCreationResultSchema.parse(response);
}

async function postJson(url: string, bearer: string, payload: unknown): Promise<unknown> {
	const { statusCode, body } = await request(url, {
		method: "POST",
		headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
		body: JSON.stringify(payload),
	});
	const text = await body.text();
	if (statusCode < 200 || statusCode >= 300) {
		throw new Error(`HTTP ${statusCode}: ${text}`);
	}
	return JSON.parse(text);
}
