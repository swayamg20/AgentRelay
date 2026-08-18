import type { MissionDeliveryItem, WorkspaceRegistrationInput } from "@agentrelay/protocol";
import { FakeAgentHostAdapter } from "@agentrelay/protocol/testing";
import { describe, expect, it, vi } from "vitest";
import type { NodeConfig } from "./config.js";
import { ForegroundNode } from "./daemon.js";
import { DeliveryProcessor } from "./delivery-processor.js";
import { type JournalStorage, NodeJournal, type NodeJournalState } from "./journal.js";
import type { NodeRelayClient } from "./relay-client.js";
import type { RuntimeProvisioner } from "./runtime-provisioner.js";

const IDS = {
	owner: "60000000-0000-4000-8000-000000000001",
	agent: "60000000-0000-4000-8000-000000000002",
	peer: "60000000-0000-4000-8000-000000000003",
	node: "60000000-0000-4000-8000-000000000004",
	credential: "60000000-0000-4000-8000-000000000005",
	mission: "60000000-0000-4000-8000-000000000006",
	event: "60000000-0000-4000-8000-000000000007",
	delivery: "60000000-0000-4000-8000-000000000008",
	artifact: "60000000-0000-4000-8000-000000000009",
} as const;

const NOW = "2026-08-03T00:00:00.000Z";

describe("ForegroundNode cycle ordering and shutdown fencing", () => {
	it("recovers, polls, and processes one delivery before scanning Mission assignments", async () => {
		const processNext = vi
			.spyOn(DeliveryProcessor.prototype, "processNext")
			.mockResolvedValue(IDS.delivery);
		try {
			const harness = await createHarness();

			const cycle = await harness.node.runCycle();

			expect(cycle.processedDeliveryId).toBe(IDS.delivery);
			expect(harness.client.recoverDeliveries.mock.invocationCallOrder[0]!).toBeLessThan(
				harness.client.pollDeliveries.mock.invocationCallOrder[0]!,
			);
			expect(harness.client.pollDeliveries.mock.invocationCallOrder[0]!).toBeLessThan(
				processNext.mock.invocationCallOrder[0]!,
			);
			expect(processNext.mock.invocationCallOrder[0]!).toBeLessThan(
				harness.client.listAssignments.mock.invocationCallOrder[0]!,
			);
		} finally {
			processNext.mockRestore();
		}
	});

	it("starts no identity request when shutdown was already requested", async () => {
		const controller = new AbortController();
		controller.abort();
		const harness = await createHarness();

		await expect(harness.node.runCycle(controller.signal)).rejects.toMatchObject({
			name: "AbortError",
		});

		expect(harness.client.me).not.toHaveBeenCalled();
	});

	it("finishes an in-flight identity response but starts no workspace registration", async () => {
		const controller = new AbortController();
		const harness = await createHarness();
		harness.client.me.mockImplementationOnce(async () => {
			controller.abort();
			return nodeSelf();
		});

		await expect(harness.node.runCycle(controller.signal)).rejects.toMatchObject({
			name: "AbortError",
		});

		expect(harness.client.me).toHaveBeenCalledOnce();
		expect(harness.client.registerWorkspace).not.toHaveBeenCalled();
		expect(harness.client.listAssignments).not.toHaveBeenCalled();
	});

	it("finishes one in-flight workspace registration but starts no later registration", async () => {
		const controller = new AbortController();
		const harness = await createHarness({ config: localConfig(true) });
		harness.client.registerWorkspace.mockImplementation(async (input) => {
			controller.abort();
			return workspaceResult(input);
		});

		await expect(harness.node.runCycle(controller.signal)).rejects.toMatchObject({
			name: "AbortError",
		});

		expect(harness.client.registerWorkspace).toHaveBeenCalledOnce();
		expect(harness.client.listAssignments).not.toHaveBeenCalled();
	});

	it("does not mark initialization complete when shutdown follows the last registration", async () => {
		const controller = new AbortController();
		const harness = await createHarness();
		harness.client.registerWorkspace.mockImplementationOnce(async (input) => {
			controller.abort();
			return workspaceResult(input);
		});

		await expect(harness.node.runCycle(controller.signal)).rejects.toMatchObject({
			name: "AbortError",
		});
		await harness.node.initialize();

		expect(harness.client.me).toHaveBeenCalledTimes(2);
		expect(harness.client.registerWorkspace).toHaveBeenCalledTimes(2);
	});

	it("persists an in-flight recovery response but starts no poll", async () => {
		const controller = new AbortController();
		const harness = await createHarness();
		await harness.node.initialize();
		harness.client.recoverDeliveries.mockImplementationOnce(async () => {
			controller.abort();
			return { items: [storedItem()], as_of: NOW };
		});

		await expect(harness.node.runCycle(controller.signal)).rejects.toMatchObject({
			name: "AbortError",
		});

		expect(harness.journal.snapshot().deliveries[IDS.delivery]?.item).toEqual(storedItem());
		expect(harness.client.pollDeliveries).not.toHaveBeenCalled();
		expect(harness.client.listAssignments).not.toHaveBeenCalled();
	});

	it("persists an in-flight poll response but starts no host work", async () => {
		const controller = new AbortController();
		const harness = await createHarness();
		await harness.node.initialize();
		harness.client.pollDeliveries.mockImplementationOnce(async () => {
			controller.abort();
			return { items: [storedItem()], next_cursor: "1" };
		});

		await expect(harness.node.runCycle(controller.signal)).rejects.toMatchObject({
			name: "AbortError",
		});

		expect(harness.journal.snapshot()).toMatchObject({
			cursor: "1",
			deliveries: { [IDS.delivery]: { item: storedItem() } },
		});
		expect(harness.adapter.counters.startTurnCalls).toBe(0);
		expect(harness.client.listAssignments).not.toHaveBeenCalled();
	});

	it("forwards runtime provisioning configuration to the delivery boundary", async () => {
		const runtimeProvisioner: RuntimeProvisioner = {
			provision: async () => undefined,
		};

		await expect(createHarness({ runtimeProvisioner })).rejects.toThrow(
			"Runtime provisioning requires a runtime authority port",
		);
	});
});

async function createHarness(
	options: {
		readonly config?: NodeConfig;
		readonly runtimeProvisioner?: RuntimeProvisioner;
	} = {},
) {
	const client = relayClient();
	const journal = await NodeJournal.open(new MemoryStorage());
	const adapter = new FakeAgentHostAdapter();
	return {
		client,
		journal,
		adapter,
		node: new ForegroundNode({
			config: options.config ?? localConfig(),
			client: client as unknown as NodeRelayClient,
			journal,
			adapter,
			runtimeProvisioner: options.runtimeProvisioner,
		}),
	};
}

function relayClient() {
	return {
		me: vi.fn(async () => nodeSelf()),
		registerWorkspace: vi.fn(async (input: WorkspaceRegistrationInput) => workspaceResult(input)),
		listAssignments: vi.fn(async () => ({ missions: [], next_cursor: null })),
		recoverDeliveries: vi.fn(async () => ({ items: [], as_of: NOW })),
		pollDeliveries: vi.fn(async () => ({ items: [], next_cursor: null })),
	};
}

function nodeSelf() {
	return { node: { node_id: IDS.node, agent_id: IDS.agent, status: "active" as const } };
}

function workspaceResult(input: WorkspaceRegistrationInput) {
	return {
		workspace: {
			node_id: IDS.node,
			agent_id: IDS.agent,
			alias: input.alias,
			status: "active" as const,
		},
		replayed: false,
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

function localConfig(withSecondWorkspace = false): NodeConfig {
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
			backend: workspaceConfig("backend"),
			...(withSecondWorkspace ? { client: workspaceConfig("client") } : {}),
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

function workspaceConfig(name: string) {
	return {
		path: `/tmp/agentrelay-${name}`,
		repository_url: `https://github.com/acme/${name}.git`,
		allowed_base_refs: ["refs/heads/main"],
		policy_profile: "coding",
	};
}

function storedItem(): MissionDeliveryItem {
	return {
		delivery: {
			delivery_id: IDS.delivery,
			node_id: IDS.node,
			mission_id: IDS.mission,
			mission_event_id: IDS.event,
			kind: "turn",
			cursor: "1",
			status: "stored",
			attempt_count: 0,
			max_attempts: 3,
			last_fencing_token: "0",
			contract_version: 1,
			verification_round: null,
			lease: null,
			logical_settlement: null,
			idempotency_key: "delivery:shutdown-test",
			causal_parent_delivery_id: null,
			available_at: NOW,
			created_at: NOW,
			updated_at: NOW,
			acknowledged_at: null,
			cancelled_at: null,
			cancellation_reason: null,
			dead_lettered_at: null,
		},
		event: {
			type: "participants_accepted",
			event_id: IDS.event,
			idempotency_key: "participants:accepted",
			mission_id: IDS.mission,
			sequence_no: 1,
			created_at: NOW,
			participant_agent_ids: [IDS.agent, IDS.peer],
			contract: {
				artifact_id: IDS.artifact,
				type: "api_contract",
				version: 1,
				sha256: "a".repeat(64),
				media_type: "application/json",
				byte_size: 2,
			},
		},
		actor_agent_id: IDS.owner,
		source_delivery_id: null,
		causal_parent_event_id: null,
	};
}
