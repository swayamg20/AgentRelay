import {
	type AgentHostAdapter,
	type Delivery,
	type DeliveryClaimInput,
	type DeliveryClaimResult,
	type DeliveryCompleteInput,
	type DeliveryCompleteResult,
	type DeliveryReleaseInput,
	type DeliveryReleaseResult,
	type DeliveryRenewInput,
	type DeliveryRenewResult,
	type DeliveryStartInput,
	type DeliveryStartResult,
	type HostEvent,
	MAX_HOST_PEER_MESSAGES,
	type MissionDeliveryItem,
	type MissionParticipantAcceptanceInput,
	type MissionParticipantAcceptanceResult,
	type MissionStatus,
	type NodeMissionAssignment,
	type NodeMissionAssignmentList,
	type NodeSelfResult,
	type RecoverableMissionDeliveryPage,
	type StartTurnInput,
	type StoredMissionDeliveryCursorPage,
	type WorkspaceBindingList,
	type WorkspaceRegistrationInput,
	type WorkspaceRegistrationResult,
	createMissionCoordinatorState,
	nodeMissionAssignmentSchema,
	reduceMissionCoordinatorEvent,
} from "@agentrelay/protocol";
import { FakeAgentHostAdapter, type FakeTurnOutcome } from "@agentrelay/protocol/testing";
import { describe, expect, it, vi } from "vitest";
import type { NodeConfig } from "./config.js";
import {
	type DeliveryCheckpoint,
	DeliveryProcessor,
	type DeliveryProcessorOptions,
} from "./delivery-processor.js";
import { type JournalStorage, NodeJournal, type NodeJournalState } from "./journal.js";
import type { PreparedMissionWorkspace } from "./mission-workspace.js";
import { CapsuleRpcError } from "./persistent-capsule-adapter.js";
import { resolvePolicyProfile } from "./policy.js";
import type { NodeRelayClient } from "./relay-client.js";
import { RelayHttpError } from "./relay-client.js";
import type { RuntimeAuthorityPort } from "./runtime-authority-port.js";
import type {
	RuntimeAuthorityDenyCode,
	RuntimeAuthorityGrant,
	RuntimeAuthorityRenewal,
	RuntimeAuthorityRequest,
} from "./runtime-authority.js";
import { authorityGrant } from "./runtime-authority.test-support.js";
import type { RuntimeProvisioner } from "./runtime-provisioner.js";

const IDS = {
	mission: "20000000-0000-4000-8000-000000000001",
	owner: "20000000-0000-4000-8000-000000000002",
	agent: "20000000-0000-4000-8000-000000000003",
	peer: "20000000-0000-4000-8000-000000000004",
	node: "20000000-0000-4000-8000-000000000005",
	credential: "20000000-0000-4000-8000-000000000006",
	binding: "20000000-0000-4000-8000-000000000007",
	delivery: "20000000-0000-4000-8000-000000000008",
	event: "20000000-0000-4000-8000-000000000009",
	artifact: "20000000-0000-4000-8000-000000000010",
	settlement: "20000000-0000-4000-8000-000000000011",
	secondDelivery: "20000000-0000-4000-8000-000000000012",
	secondMission: "20000000-0000-4000-8000-000000000013",
	secondEvent: "20000000-0000-4000-8000-000000000014",
} as const;

const TIMES = {
	created: "2026-08-02T00:00:00.000Z",
	claimed: "2026-08-02T00:01:00.000Z",
	started: "2026-08-02T00:02:00.000Z",
	renewed: "2026-08-02T00:03:00.000Z",
	expires: "2026-08-02T00:20:00.000Z",
	completed: "2026-08-02T00:04:00.000Z",
} as const;

describe("DeliveryProcessor", () => {
	it("claims, starts, invokes one host turn, and acknowledges the result", async () => {
		const harness = await createHarness();
		await harness.processor.process(IDS.delivery);

		const entry = harness.journal.snapshot().deliveries[IDS.delivery]!;
		expect(entry.phase).toBe("acknowledged");
		expect(entry.item.delivery.status).toBe("acknowledged");
		expect(harness.adapter.counters.turnsCreated).toBe(1);
		expect(harness.client.claimInputs).toHaveLength(1);
		expect(harness.client.completeInputs).toHaveLength(1);
		expect(harness.client.completeInputs[0]?.result).toEqual({
			type: "turn_completed",
			disposition: {
				kind: "reply",
				message_type: "progress",
				message: "fake result",
			},
		});
	});

	it("installs an exact locally bounded authority grant before runtime activation", async () => {
		const authorityPort = new FakeRuntimeAuthorityPort();
		const harness = await createHarness({ authorityPort });

		await harness.processor.process(IDS.delivery);

		const grant = authorityPort.installed[0]!;
		expect(authorityPort.installed).toHaveLength(1);
		expect(harness.journal.snapshot().deliveries[IDS.delivery]?.runtime_authority).toBeNull();
		expect(authorityPort.revoked).toContainEqual(grant);
		expect(grant).toMatchObject({
			agent_id: IDS.agent,
			node_id: IDS.node,
			workspace_binding_id: IDS.binding,
			workspace_alias: "backend",
			mission_id: IDS.mission,
			delivery_id: IDS.delivery,
			execution_attempt: 1,
			lease_id: leaseId(1),
			fencing_token: "1",
			policy_profile: "coding",
			lease_expires_at: TIMES.expires,
			hard_expires_at: "2026-08-02T00:08:00.000Z",
		});
		expect(grant.workspace_resource_sha256).toMatch(/^[a-f0-9]{64}$/);
		expect(grant.effective_limits.reported_tokens).toBe(10_000);
		expect(grant.capabilities).toEqual(
			expect.arrayContaining([
				{ action: "runtime_start", resource: "runtime" },
				{ action: "workspace_read", resource: "workspace" },
				{ action: "outbound_publish", resource: "relay" },
			]),
		);
		expect(grant.capabilities).not.toEqual(
			expect.arrayContaining([
				{ action: "workspace_write", resource: "workspace" },
				{ action: "repository_push", resource: "repository" },
			]),
		);
		expect(authorityPort.asserted).toHaveLength(1);
		expect(authorityPort.asserted[0]?.capability).toEqual({
			action: "outbound_publish",
			resource: "relay",
		});
		expect(authorityPort.operations.at(-1)).toBe("revoke:revoked");
	});

	it("provisions the exact owner workspace under local authority before remote install", async () => {
		const authorityPort = new FakeRuntimeAuthorityPort();
		let preparationSignal: AbortSignal | undefined;
		let provisioningSignal: AbortSignal | undefined;
		const prepareRuntimeWorkspace: NonNullable<
			DeliveryProcessorOptions["prepareRuntimeWorkspace"]
		> = vi.fn(async (workspace, expectation, dependencies = {}) => {
			preparationSignal = dependencies.signal;
			expect(authorityPort.installed).toHaveLength(0);
			expect(workspace).toEqual(localConfig().workspaces.backend);
			expect(expectation).toMatchObject({
				agent_id: IDS.agent,
				workspace_alias: "backend",
				repository_url: "https://github.com/acme/backend.git",
				expected_base_commit: "1".repeat(40),
			});
			return preparedWorkspace();
		});
		const provision = vi.fn<RuntimeProvisioner["provision"]>(async (input, authority) => {
			provisioningSignal = authority.signal;
			expect(authorityPort.installed).toHaveLength(0);
			await authority.performWorkspaceRead(() => undefined);
			expect(input).toEqual({
				session: {
					missionId: IDS.mission,
					participantId: IDS.agent,
					workspaceAlias: "backend",
				},
				workspace: preparedWorkspace(),
				policyGrantSha256: resolvePolicyProfile(localConfig().policy_profiles, "coding").grant
					.grant_sha256,
			});
		});
		const harness = await createHarness({
			authorityPort,
			runtimeProvisioner: freshRuntimeProvisioner(provision),
			prepareRuntimeWorkspace,
		});

		await harness.processor.process(IDS.delivery);

		expect(prepareRuntimeWorkspace).toHaveBeenCalledOnce();
		expect(provision).toHaveBeenCalledOnce();
		expect(preparationSignal).toBeDefined();
		expect(provisioningSignal).toBe(preparationSignal);
		expect(authorityPort.installed).toHaveLength(1);
		expect(harness.journal.snapshot().deliveries[IDS.delivery]?.phase).toBe("acknowledged");
	});

	it("does not prepare a runtime workspace when no provisioner is configured", async () => {
		const prepareRuntimeWorkspace = vi.fn(async () => {
			throw new Error("runtime workspace preparation must remain disabled");
		});
		const harness = await createHarness({
			authorityPort: new FakeRuntimeAuthorityPort(),
			prepareRuntimeWorkspace,
		});

		await harness.processor.process(IDS.delivery);

		expect(prepareRuntimeWorkspace).not.toHaveBeenCalled();
		expect(harness.journal.snapshot().deliveries[IDS.delivery]?.phase).toBe("acknowledged");
	});

	it("keeps journaled fake-runtime recovery on the clean preflight path", async () => {
		let crashBeforePublish = true;
		const harness = await createHarness({
			onCheckpoint(checkpoint) {
				if (crashBeforePublish && checkpoint === "complete_intent") {
					crashBeforePublish = false;
					throw new Error("crash before completion request");
				}
			},
		});
		await expect(harness.processor.process(IDS.delivery)).rejects.toThrow(
			"crash before completion request",
		);
		const preflight = vi.fn(successfulPreflight);
		const preflightRecovery = vi.fn(async () => {
			throw new Error("fake runtime must not use dirty recovery admission");
		});
		const processor = new DeliveryProcessor({
			config: harness.config,
			client: harness.client,
			journal: harness.journal,
			adapter: harness.adapter,
			authorityPort: new FakeRuntimeAuthorityPort(),
			now: () => new Date(TIMES.renewed),
			preflight,
			preflightRecovery,
		});

		await processor.process(IDS.delivery);

		expect(preflight).toHaveBeenCalledOnce();
		expect(preflightRecovery).not.toHaveBeenCalled();
		expect(harness.journal.snapshot().deliveries[IDS.delivery]?.phase).toBe("acknowledged");
	});

	it("passes the Node shutdown signal into early workspace preflight", async () => {
		const controller = new AbortController();
		const preflight: NonNullable<DeliveryProcessorOptions["preflight"]> = vi.fn(
			async (_workspace, _expectation, dependencies = {}) => {
				expect(dependencies.signal).toBe(controller.signal);
				return successfulPreflight();
			},
		);
		const harness = await createHarness({ preflight });

		await harness.processor.process(IDS.delivery, controller.signal);

		expect(preflight).toHaveBeenCalledOnce();
	});

	it("aborts gated runtime workspace preparation before remote install on Node shutdown", async () => {
		const controller = new AbortController();
		const authorityPort = new FakeRuntimeAuthorityPort();
		let preparationSignal: AbortSignal | undefined;
		const provision = vi.fn<RuntimeProvisioner["provision"]>();
		const prepareRuntimeWorkspace: NonNullable<
			DeliveryProcessorOptions["prepareRuntimeWorkspace"]
		> = vi.fn(async (_workspace, _expectation, dependencies = {}) => {
			const signal = dependencies.signal;
			if (signal === undefined) throw new Error("authority signal is missing");
			preparationSignal = signal;
			return new Promise<PreparedMissionWorkspace>((_resolve, reject) => {
				signal.addEventListener("abort", () => reject(signal.reason), { once: true });
				controller.abort();
			});
		});
		const harness = await createHarness({
			authorityPort,
			runtimeProvisioner: freshRuntimeProvisioner(provision),
			prepareRuntimeWorkspace,
		});

		await harness.processor.process(IDS.delivery, controller.signal);

		expect(preparationSignal?.aborted).toBe(true);
		expect(provision).not.toHaveBeenCalled();
		expect(authorityPort.installed).toHaveLength(0);
		expect(authorityPort.revoked).toHaveLength(0);
		expect(harness.adapter.counters.turnsCreated).toBe(0);
	});

	it("aborts gated runtime provisioning before remote install on Node shutdown", async () => {
		const controller = new AbortController();
		const authorityPort = new FakeRuntimeAuthorityPort();
		let provisioningSignal: AbortSignal | undefined;
		const provision = vi.fn<RuntimeProvisioner["provision"]>(async (_input, authority) => {
			provisioningSignal = authority.signal;
			return new Promise<never>((_resolve, reject) => {
				authority.signal.addEventListener("abort", () => reject(authority.signal.reason), {
					once: true,
				});
				controller.abort();
			});
		});
		const harness = await createHarness({
			authorityPort,
			runtimeProvisioner: freshRuntimeProvisioner(provision),
			prepareRuntimeWorkspace: async () => preparedWorkspace(),
		});

		await harness.processor.process(IDS.delivery, controller.signal);

		expect(provisioningSignal?.aborted).toBe(true);
		expect(authorityPort.installed).toHaveLength(0);
		expect(authorityPort.revoked).toHaveLength(0);
		expect(harness.adapter.counters.turnsCreated).toBe(0);
	});

	it("loses authority without later effects when authority expires during preparation", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(TIMES.renewed);
		let now = new Date(TIMES.renewed);
		let preparationStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			preparationStarted = resolve;
		});
		try {
			const config = localConfig();
			config.policy_profiles.coding = {
				...config.policy_profiles.coding!,
				max_turn_seconds: 1,
			};
			const authorityPort = new FakeRuntimeAuthorityPort();
			const provision = vi.fn<RuntimeProvisioner["provision"]>();
			const prepareRuntimeWorkspace: NonNullable<
				DeliveryProcessorOptions["prepareRuntimeWorkspace"]
			> = vi.fn(async (_workspace, _expectation, dependencies = {}) => {
				const authoritySignal = dependencies.signal;
				if (authoritySignal === undefined) throw new Error("authority signal is missing");
				preparationStarted();
				return new Promise<PreparedMissionWorkspace>((_resolve, reject) => {
					authoritySignal.addEventListener("abort", () => reject(authoritySignal.reason), {
						once: true,
					});
				});
			});
			const harness = await createHarness({
				config,
				mission: assignment({ config }),
				authorityPort,
				runtimeProvisioner: freshRuntimeProvisioner(provision),
				prepareRuntimeWorkspace,
				now: () => now,
			});

			const processing = harness.processor.process(IDS.delivery);
			await started;
			now = new Date(Date.parse(TIMES.renewed) + 1_000);
			await vi.advanceTimersByTimeAsync(1_000);
			await processing;

			expect(provision).not.toHaveBeenCalled();
			expect(authorityPort.installed).toHaveLength(0);
			expect(authorityPort.revoked).toHaveLength(0);
			expect(harness.adapter.counters.turnsCreated).toBe(0);
			expect(harness.journal.snapshot().deliveries[IDS.delivery]?.phase).toBe("lease_lost");
		} finally {
			vi.useRealTimers();
		}
	});

	it("installs the newest lease after renewal while runtime preparation is gated", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(TIMES.renewed);
		let releasePreparation!: () => void;
		let markPreparationStarted!: () => void;
		const preparationStarted = new Promise<void>((resolve) => {
			markPreparationStarted = resolve;
		});
		const preparationGate = new Promise<void>((resolve) => {
			releasePreparation = resolve;
		});
		try {
			const authorityPort = new FakeRuntimeAuthorityPort();
			const prepareRuntimeWorkspace: NonNullable<
				DeliveryProcessorOptions["prepareRuntimeWorkspace"]
			> = vi.fn(async () => {
				markPreparationStarted();
				await preparationGate;
				return preparedWorkspace();
			});
			const harness = await createHarness({
				authorityPort,
				runtimeProvisioner: freshRuntimeProvisioner(async () => undefined),
				prepareRuntimeWorkspace,
				now: () => new Date(Date.now()),
			});
			harness.client.renewalExpiresAt = "2026-08-02T00:03:00.500Z";

			const processing = harness.processor.process(IDS.delivery);
			await preparationStarted;
			expect(authorityPort.installed).toHaveLength(0);
			harness.client.renewalExpiresAt = "2026-08-02T00:03:01.000Z";
			await vi.waitFor(
				() =>
					expect(
						harness.journal.snapshot().deliveries[IDS.delivery]?.item.delivery.lease?.expires_at,
					).toBe("2026-08-02T00:03:01.000Z"),
				{ timeout: 400 },
			);
			releasePreparation();
			await processing;

			expect(authorityPort.installedLeases[0]?.lease_expires_at).toBe("2026-08-02T00:03:01.000Z");
			expect(harness.journal.snapshot().deliveries[IDS.delivery]?.phase).toBe("acknowledged");
		} finally {
			releasePreparation?.();
			vi.useRealTimers();
		}
	});

	it("surfaces a provisioning failure without mislabeling authority loss and retries it", async () => {
		const failure = new Error("containment probe failed");
		const authorityPort = new FakeRuntimeAuthorityPort();
		let failProvisioning = true;
		const provision = vi.fn<RuntimeProvisioner["provision"]>(async () => {
			if (failProvisioning) {
				failProvisioning = false;
				throw failure;
			}
		});
		const harness = await createHarness({
			authorityPort,
			runtimeProvisioner: freshRuntimeProvisioner(provision),
			prepareRuntimeWorkspace: async () => preparedWorkspace(),
		});

		await expect(harness.processor.process(IDS.delivery)).rejects.toBe(failure);

		const pending = harness.journal.snapshot().deliveries[IDS.delivery]!;
		expect(pending.runtime_authority).not.toBeNull();
		expect(pending.phase).not.toBe("lease_lost");
		expect(authorityPort.installed).toHaveLength(0);
		expect(authorityPort.revoked).toHaveLength(0);
		expect(harness.adapter.counters.turnsCreated).toBe(0);

		await harness.processor.process(IDS.delivery);

		expect(provision).toHaveBeenCalledTimes(2);
		expect(authorityPort.installed).toHaveLength(1);
		expect(harness.journal.snapshot().deliveries[IDS.delivery]?.phase).toBe("acknowledged");
	});

	it("marks the lease lost when a Capsule denies runtime authority installation", async () => {
		const authorityPort = new FakeRuntimeAuthorityPort();
		authorityPort.installErrorFor = () =>
			new CapsuleRpcError("authority_denied", "Runtime authority grant has been revoked");
		const harness = await createHarness({ authorityPort });

		await harness.processor.process(IDS.delivery);

		expect(harness.journal.snapshot().deliveries[IDS.delivery]?.phase).toBe("lease_lost");
		expect(authorityPort.installed).toHaveLength(1);
		expect(harness.adapter.counters.turnsCreated).toBe(0);
		expect(harness.client.completeInputs).toHaveLength(0);
	});

	it("keeps a Capsule install transport failure as a retryable setup error", async () => {
		const failure = new CapsuleRpcError("transport", "Capsule socket is unavailable");
		const authorityPort = new FakeRuntimeAuthorityPort();
		let failInstall = true;
		authorityPort.installErrorFor = () => {
			if (!failInstall) return null;
			failInstall = false;
			return failure;
		};
		const harness = await createHarness({ authorityPort });

		await expect(harness.processor.process(IDS.delivery)).rejects.toBe(failure);

		const pending = harness.journal.snapshot().deliveries[IDS.delivery]!;
		expect(pending.phase).not.toBe("lease_lost");
		expect(pending.runtime_authority).not.toBeNull();
		expect(harness.client.claimInputs).toHaveLength(1);
		expect(harness.adapter.counters.turnsCreated).toBe(0);

		await harness.processor.process(IDS.delivery);

		expect(harness.client.claimInputs).toHaveLength(1);
		expect(authorityPort.installed.map((grant) => grant.grant_id)).toEqual([
			pending.runtime_authority?.grant_id,
			pending.runtime_authority?.grant_id,
		]);
		expect(harness.journal.snapshot().deliveries[IDS.delivery]?.phase).toBe("acknowledged");
	});

	it("reprovisions a pending completion and preserves its intent across setup failure", async () => {
		let crashBeforePublish = true;
		const harness = await createHarness({
			onCheckpoint(checkpoint) {
				if (crashBeforePublish && checkpoint === "complete_intent") {
					crashBeforePublish = false;
					throw new Error("crash before completion request");
				}
			},
		});
		await expect(harness.processor.process(IDS.delivery)).rejects.toThrow(
			"crash before completion request",
		);
		const originalIntent = structuredClone(
			harness.journal.snapshot().deliveries[IDS.delivery]?.operation,
		);
		expect(originalIntent?.kind).toBe("complete");

		const failure = new Error("runtime descriptor unavailable");
		const authorityPort = new FakeRuntimeAuthorityPort();
		let failProvisioning = true;
		let recoverySignal: AbortSignal | undefined;
		let provisioningSignal: AbortSignal | undefined;
		const provision = vi.fn<RuntimeProvisioner["provision"]>(async () => {
			throw new Error("fresh provisioning must not run for a journaled turn");
		});
		const recover = vi.fn<RuntimeProvisioner["recover"]>(async (_input, authority) => {
			provisioningSignal = authority.signal;
			expect(authorityPort.installed).toHaveLength(0);
			expect(authority.signal.aborted).toBe(false);
			if (failProvisioning) {
				failProvisioning = false;
				throw failure;
			}
		});
		const restarted = new DeliveryProcessor({
			config: harness.config,
			client: harness.client,
			journal: harness.journal,
			adapter: harness.adapter,
			authorityPort,
			runtimeProvisioner: { provision, recover },
			now: () => new Date(TIMES.renewed),
			preflight: successfulPreflight,
			preflightRecovery: successfulRecoveryPreflight,
			prepareRuntimeWorkspace: async () => {
				throw new Error("fresh workspace preparation must not run for a journaled turn");
			},
			recoverRuntimeWorkspace: async (_workspace, _expectation, dependencies = {}) => {
				recoverySignal = dependencies.signal;
				return preparedWorkspace();
			},
		});

		await expect(restarted.process(IDS.delivery)).rejects.toBe(failure);
		expect(harness.journal.snapshot().deliveries[IDS.delivery]?.operation).toEqual(originalIntent);
		expect(authorityPort.installed).toHaveLength(0);

		await restarted.process(IDS.delivery);

		expect(provision).not.toHaveBeenCalled();
		expect(recover).toHaveBeenCalledTimes(2);
		expect(provisioningSignal).toBe(recoverySignal);
		expect(authorityPort.installed).toHaveLength(1);
		expect(harness.client.completeInputs).toHaveLength(1);
		expect(harness.journal.snapshot().deliveries[IDS.delivery]?.phase).toBe("acknowledged");
	});

	it("retires authority and retains a pending completion when shutdown meets install settlement", async () => {
		let crashBeforePublish = true;
		const harness = await createHarness({
			onCheckpoint(checkpoint) {
				if (crashBeforePublish && checkpoint === "complete_intent") {
					crashBeforePublish = false;
					throw new Error("crash before completion request");
				}
			},
		});
		await expect(harness.processor.process(IDS.delivery)).rejects.toThrow(
			"crash before completion request",
		);
		const original = structuredClone(harness.journal.snapshot().deliveries[IDS.delivery]!);
		let markInstallStarted!: () => void;
		let releaseInstall!: () => void;
		const installStarted = new Promise<void>((resolve) => {
			markInstallStarted = resolve;
		});
		const installGate = new Promise<void>((resolve) => {
			releaseInstall = resolve;
		});
		const authorityPort = new FakeRuntimeAuthorityPort((operation) => {
			if (operation.startsWith("install:")) markInstallStarted();
		});
		authorityPort.installResult = installGate;
		const restarted = processorFor({ ...harness, authorityPort });
		const controller = new AbortController();

		const processing = restarted.process(IDS.delivery, controller.signal);
		await installStarted;
		controller.abort();
		releaseInstall();
		await processing;

		const pending = harness.journal.snapshot().deliveries[IDS.delivery]!;
		expect(pending.operation).toEqual(original.operation);
		expect(pending.result).toEqual(original.result);
		expect(pending.phase).toBe("complete_intent");
		expect(authorityPort.revoked).toEqual(authorityPort.installed);
		expect(harness.client.completeInputs).toHaveLength(0);
	});

	it("retires authority and retains a durable result when shutdown meets install settlement", async () => {
		let crashBeforePublish = true;
		const harness = await createHarness({
			onCheckpoint(checkpoint) {
				if (crashBeforePublish && checkpoint === "complete_intent") {
					crashBeforePublish = false;
					throw new Error("crash after durable result");
				}
			},
		});
		await expect(harness.processor.process(IDS.delivery)).rejects.toThrow(
			"crash after durable result",
		);
		const result = structuredClone(harness.journal.snapshot().deliveries[IDS.delivery]!.result);
		await harness.journal.updateDelivery(IDS.delivery, (entry) => {
			entry.operation = null;
			entry.phase = "host_terminal";
			entry.updated_at = TIMES.renewed;
		});
		let markInstallStarted!: () => void;
		let releaseInstall!: () => void;
		const installStarted = new Promise<void>((resolve) => {
			markInstallStarted = resolve;
		});
		const installGate = new Promise<void>((resolve) => {
			releaseInstall = resolve;
		});
		const revokedGrantIds = new Set<string>();
		const authorityPort = new FakeRuntimeAuthorityPort((operation) => {
			if (operation.startsWith("install:")) markInstallStarted();
		});
		authorityPort.installErrorFor = (grant) =>
			revokedGrantIds.has(grant.grant_id)
				? new CapsuleRpcError("authority_denied", "Runtime authority grant has been revoked")
				: null;
		authorityPort.revokeErrorFor = (grant) => {
			revokedGrantIds.add(grant.grant_id);
			return null;
		};
		authorityPort.installResult = installGate;
		const restarted = processorFor({ ...harness, authorityPort });
		const controller = new AbortController();

		const processing = restarted.process(IDS.delivery, controller.signal);
		await installStarted;
		controller.abort();
		releaseInstall();
		await processing;

		const pending = harness.journal.snapshot().deliveries[IDS.delivery]!;
		expect(pending.result).toEqual(result);
		expect(pending.operation).toBeNull();
		expect(pending.phase).toBe("host_terminal");
		expect(authorityPort.revoked).toEqual(authorityPort.installed);
		expect(harness.client.completeInputs).toHaveLength(0);
		const revokedGrant = pending.runtime_authority;
		if (revokedGrant === null) throw new Error("expected a durable revoked result grant");
		expect(revokedGrantIds).toContain(revokedGrant.grant_id);
		const turnsBeforeRecovery = harness.adapter.counters.turnsCreated;

		await restarted.process(IDS.delivery);

		const leaseLost = harness.journal.snapshot().deliveries[IDS.delivery]!;
		expect(leaseLost.phase).toBe("lease_lost");
		expect(leaseLost.result).toEqual(result);
		expect(leaseLost.runtime_authority).toEqual(revokedGrant);
		expect(harness.adapter.counters.turnsCreated).toBe(turnsBeforeRecovery);
		expect(harness.client.completeInputs).toHaveLength(0);

		await restarted.process(IDS.delivery);

		expect(authorityPort.installed.map((grant) => grant.fencing_token)).toEqual(["1", "1", "2"]);
		expect(harness.client.completeInputs).toHaveLength(1);
		expect(harness.client.completeInputs[0]?.fencing_token).toBe("2");
		expect(harness.adapter.counters.turnsCreated).toBe(turnsBeforeRecovery);
		expect(harness.journal.snapshot().deliveries[IDS.delivery]?.phase).toBe("acknowledged");
	});

	it("reclaims a new fence when a pending completion grant was already revoked", async () => {
		let crashBeforePublish = true;
		const revokedGrantIds = new Set<string>();
		const authorityPort = new FakeRuntimeAuthorityPort();
		authorityPort.installErrorFor = (grant) =>
			revokedGrantIds.has(grant.grant_id)
				? new CapsuleRpcError("authority_denied", "Runtime authority grant has been revoked")
				: null;
		authorityPort.revokeErrorFor = (grant) => {
			revokedGrantIds.add(grant.grant_id);
			return null;
		};
		const harness = await createHarness({
			authorityPort,
			onCheckpoint(checkpoint) {
				if (crashBeforePublish && checkpoint === "complete_intent") {
					crashBeforePublish = false;
					throw new Error("crash after Capsule revocation before journal clearance");
				}
			},
		});

		await expect(harness.processor.process(IDS.delivery)).rejects.toThrow(
			"crash after Capsule revocation before journal clearance",
		);
		const revokedGrant = harness.journal.snapshot().deliveries[IDS.delivery]?.runtime_authority;
		if (revokedGrant === null || revokedGrant === undefined) {
			throw new Error("expected a durable revoked grant");
		}
		expect(revokedGrantIds).toContain(revokedGrant.grant_id);
		const turnsBeforeDeniedReplay = harness.adapter.counters.turnsCreated;

		await harness.processor.process(IDS.delivery);

		const leaseLost = harness.journal.snapshot().deliveries[IDS.delivery]!;
		expect(leaseLost.phase).toBe("lease_lost");
		expect(leaseLost.operation).toBeNull();
		expect(leaseLost.runtime_authority).toEqual(revokedGrant);
		expect(harness.client.claimInputs).toHaveLength(1);
		expect(harness.adapter.counters.turnsCreated).toBe(turnsBeforeDeniedReplay);

		await harness.processor.process(IDS.delivery);

		expect(harness.client.claimInputs).toHaveLength(2);
		expect(authorityPort.installed.map((grant) => grant.fencing_token)).toEqual(["1", "1", "2"]);
		expect(authorityPort.installed[2]?.grant_id).not.toBe(revokedGrant.grant_id);
		expect(harness.adapter.counters.turnsCreated).toBe(turnsBeforeDeniedReplay);
		expect(harness.journal.snapshot().deliveries[IDS.delivery]?.phase).toBe("acknowledged");
	});

	it("anchors the turn deadline to trusted local time despite a future Relay timestamp", async () => {
		const config = localConfig();
		config.policy_profiles.coding = {
			...config.policy_profiles.coding!,
			max_turn_seconds: 1,
		};
		const authorityPort = new FakeRuntimeAuthorityPort();
		const harness = await createHarness({
			config,
			mission: assignment({ config }),
			authorityPort,
		});
		harness.client.renewalUpdatedAt = "2026-08-02T00:10:00.000Z";

		await harness.processor.process(IDS.delivery);

		expect(authorityPort.installed[0]?.hard_expires_at).toBe("2026-08-02T00:03:01.000Z");
	});

	it("recompiles the exact grant across Node recovery time", async () => {
		let crash = true;
		const firstPort = new FakeRuntimeAuthorityPort();
		const first = await createHarness({
			authorityPort: firstPort,
			now: () => new Date("2026-08-02T00:03:00.000Z"),
			onCheckpoint(checkpoint) {
				if (crash && checkpoint === "host_accepted") {
					crash = false;
					throw new Error("injected crash after authority checkpoint");
				}
			},
		});
		await expect(first.processor.process(IDS.delivery)).rejects.toThrow(
			"injected crash after authority checkpoint",
		);
		const originalGrant = first.journal.snapshot().deliveries[IDS.delivery]?.runtime_authority;
		expect(originalGrant).not.toBeNull();

		const secondPort = new FakeRuntimeAuthorityPort();
		const recovered = new DeliveryProcessor({
			config: first.config,
			client: first.client,
			journal: first.journal,
			adapter: first.adapter,
			authorityPort: secondPort,
			now: () => new Date("2026-08-02T00:04:00.000Z"),
			preflight: successfulPreflight,
		});

		await recovered.process(IDS.delivery);

		expect(secondPort.installed[0]).toEqual(originalGrant);
	});

	it("forwards verified Relay lease renewals to the runtime authority monitor", async () => {
		const authorityPort = new FakeRuntimeAuthorityPort();
		const harness = await createHarness({ authorityPort });
		harness.client.renewalExpiresAt = "2026-08-02T00:03:00.300Z";
		let releaseSession!: () => void;
		const sessionGate = new Promise<void>((resolve) => {
			releaseSession = resolve;
		});
		const adapter: AgentHostAdapter = {
			...adapterDelegates(harness.adapter),
			async ensureSession(input) {
				await sessionGate;
				return harness.adapter.ensureSession(input);
			},
		};
		const processor = processorFor({ ...harness, adapter, authorityPort });

		const processing = processor.process(IDS.delivery);
		await vi.waitFor(() => expect(authorityPort.renewed.length).toBeGreaterThan(0));
		releaseSession();
		await processing;

		expect(authorityPort.renewed.length).toBeGreaterThan(0);
		expect(authorityPort.renewed[0]).toMatchObject({
			lease_id: leaseId(1),
			fencing_token: "1",
		});
	});

	it("mission-blocks an active renewal while exact Capsule retirement is unproven", async () => {
		const authorityPort = new FakeRuntimeAuthorityPort();
		authorityPort.failNextRenew = true;
		authorityPort.revokeError = new Error("active renewal retirement timed out");
		const harness = await createHarness({
			outcome: { kind: "pending" },
			authorityPort,
		});
		harness.client.renewalExpiresAt = "2026-08-02T00:03:00.300Z";
		const processor = processorFor({
			...harness,
			adapter: stallHostStream(harness.adapter),
		});

		await expect(processor.processNext()).resolves.toBeNull();

		const pending = harness.journal.snapshot().deliveries[IDS.delivery]!;
		expect(pending.last_error).toContain(
			"Capsule retirement after runtime authority renewal is not yet proven",
		);
		expect(pending.runtime_authority).not.toBeNull();
		expect(authorityPort.renewed).toHaveLength(1);
		expect(authorityPort.revoked.length).toBeGreaterThan(0);
		expect(harness.adapter.counters.cancelTurnCalls).toBe(1);
	});

	it("converges on a renewal that outlives the lease used to begin installation", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(TIMES.renewed);
		let finishInstall!: () => void;
		try {
			const config = localConfig();
			config.policy_profiles.coding = {
				...config.policy_profiles.coding!,
				max_turn_seconds: 10,
			};
			const authorityPort = new FakeRuntimeAuthorityPort();
			authorityPort.installResult = new Promise<void>((resolve) => {
				finishInstall = resolve;
			});
			const harness = await createHarness({
				config,
				mission: assignment({ config }),
				authorityPort,
				now: () => new Date(Date.now()),
			});
			harness.client.renewalExpiresAt = "2026-08-02T00:03:00.500Z";

			const processing = harness.processor.process(IDS.delivery);
			await vi.waitFor(() => expect(authorityPort.installed).toHaveLength(1));
			harness.client.renewalExpiresAt = "2026-08-02T00:03:01.000Z";
			await vi.waitFor(
				() =>
					expect(
						harness.journal.snapshot().deliveries[IDS.delivery]?.item.delivery.lease?.expires_at,
					).toBe("2026-08-02T00:03:01.000Z"),
				{ timeout: 400 },
			);
			finishInstall();
			await processing;

			expect(authorityPort.installedLeases.map((lease) => lease.lease_expires_at)).toEqual([
				"2026-08-02T00:03:00.500Z",
				"2026-08-02T00:03:01.000Z",
			]);
			expect(authorityPort.renewed).toEqual([]);
			expect(authorityPort.operations).not.toContain("revoke:expired");
			expect(harness.journal.snapshot().deliveries[IDS.delivery]?.phase).toBe("acknowledged");
		} finally {
			finishInstall?.();
			vi.useRealTimers();
		}
	});

	it("recovers an exact grant after Relay renewal commits before Capsule forwarding", async () => {
		const state: { harness?: Awaited<ReturnType<typeof createHarness>> } = {};
		const authorityPort = new FakeRuntimeAuthorityPort((operation) => {
			if (operation === "install:1" && state.harness !== undefined) {
				state.harness.client.renewalExpiresAt = TIMES.expires;
			}
		});
		authorityPort.failNextRenew = true;
		const harness = await createHarness({ authorityPort });
		state.harness = harness;
		harness.client.renewalExpiresAt = "2026-08-02T00:03:00.300Z";
		const interrupted = processorFor({
			...harness,
			adapter: stallHostStream(harness.adapter),
		});

		await expect(interrupted.process(IDS.delivery)).rejects.toThrow(
			"Runtime lease renewal was not confirmed",
		);
		const checkpointed = harness.journal.snapshot().deliveries[IDS.delivery]!;
		const originalGrant = checkpointed.runtime_authority;
		expect(originalGrant).not.toBeNull();
		expect(checkpointed.operation).toBeNull();
		expect(checkpointed.item.delivery.lease?.expires_at).toBe(TIMES.expires);
		const confirmedRenewal = structuredClone(harness.client.renewInputs.at(-1));

		const restarted = new DeliveryProcessor({
			config: harness.config,
			client: harness.client,
			journal: harness.journal,
			adapter: harness.adapter,
			authorityPort,
			now: () => new Date("2026-08-02T00:04:00.000Z"),
			preflight: successfulPreflight,
		});
		await restarted.process(IDS.delivery);

		expect(
			harness.client.renewInputs.filter(
				(input) => input.idempotency_key === confirmedRenewal?.idempotency_key,
			),
		).toHaveLength(1);
		expect(authorityPort.installed).toHaveLength(2);
		expect(authorityPort.installed[1]).toEqual(originalGrant);
		expect(authorityPort.installedLeases[1]?.lease_expires_at).toBe(TIMES.expires);
		expect(harness.client.completeInputs).toHaveLength(1);
		expect(harness.journal.snapshot().deliveries[IDS.delivery]?.phase).toBe("acknowledged");
	});

	it("does not publish when the runtime rejects the fenced outbound request", async () => {
		const authorityPort = new FakeRuntimeAuthorityPort();
		authorityPort.currentFence = "2";
		const harness = await createHarness({ authorityPort });

		await harness.processor.process(IDS.delivery);

		expect(harness.client.completeInputs).toHaveLength(0);
		expect(harness.journal.snapshot().deliveries[IDS.delivery]?.phase).toBe("lease_lost");
		expect(authorityPort.operations).toContain("assert:1");
		expect(authorityPort.operations.at(-1)).toBe("revoke:revoked");
	});

	it("aborts an in-flight completion and retains its intent when local authority expires", async () => {
		vi.useFakeTimers();
		let now = new Date(TIMES.renewed);
		try {
			const authorityPort = new FakeRuntimeAuthorityPort();
			const harness = await createHarness({ authorityPort, now: () => now });
			let completionSignal: AbortSignal | undefined;
			let markCompletionStarted!: () => void;
			const completionStarted = new Promise<void>((resolve) => {
				markCompletionStarted = resolve;
			});
			harness.client.beforeComplete = async (signal) => {
				if (signal === undefined) throw new Error("completion was not authority-bound");
				completionSignal = signal;
				markCompletionStarted();
				await new Promise<void>((_resolve, reject) => {
					signal.addEventListener("abort", () => reject(signal.reason), { once: true });
				});
			};

			const processing = harness.processor.process(IDS.delivery);
			await completionStarted;
			now = new Date(TIMES.expires);
			await vi.advanceTimersByTimeAsync(Date.parse(TIMES.expires) - Date.parse(TIMES.renewed));
			await processing;

			expect(completionSignal?.aborted).toBe(true);
			expect(harness.client.completedCount).toBe(0);
			const pending = harness.journal.snapshot().deliveries[IDS.delivery]!;
			expect(pending.phase).toBe("complete_intent");
			expect(pending.operation?.kind).toBe("complete");
			expect(authorityPort.operations.at(-1)).toBe("revoke:expired");
		} finally {
			vi.useRealTimers();
		}
	});

	it("retains the exact completion intent when authority expires after Relay commits", async () => {
		vi.useFakeTimers();
		let now = new Date(TIMES.renewed);
		try {
			const authorityPort = new FakeRuntimeAuthorityPort();
			const harness = await createHarness({ authorityPort, now: () => now });
			let markCompletionCommitted!: () => void;
			const completionCommitted = new Promise<void>((resolve) => {
				markCompletionCommitted = resolve;
			});
			harness.client.afterComplete = async (signal) => {
				if (signal === undefined) throw new Error("completion was not authority-bound");
				markCompletionCommitted();
				await new Promise<void>((_resolve, reject) => {
					signal.addEventListener("abort", () => reject(signal.reason), { once: true });
				});
			};

			const processing = harness.processor.process(IDS.delivery);
			await completionCommitted;
			const committedInput = structuredClone(harness.client.completeInputs[0]);
			now = new Date(TIMES.expires);
			await vi.advanceTimersByTimeAsync(Date.parse(TIMES.expires) - Date.parse(TIMES.renewed));
			await processing;

			const pending = harness.journal.snapshot().deliveries[IDS.delivery]!;
			expect(harness.client.completedCount).toBe(1);
			expect(pending.phase).toBe("complete_intent");
			expect(pending.operation).toEqual({ kind: "complete", input: committedInput });
			expect(authorityPort.operations.at(-1)).toBe("revoke:expired");

			const restarted = new DeliveryProcessor({
				config: harness.config,
				client: harness.client,
				journal: harness.journal,
				adapter: harness.adapter,
				authorityPort,
				now: () => new Date(TIMES.expires),
				preflight: successfulPreflight,
			});
			await restarted.process(IDS.delivery);

			const stillPending = harness.journal.snapshot().deliveries[IDS.delivery]!;
			expect(stillPending.phase).toBe("complete_intent");
			expect(stillPending.operation).toEqual({ kind: "complete", input: committedInput });
			expect(harness.client.completeInputs).toHaveLength(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("rebuilds a pending completion only after Relay definitively rejects its old fence", async () => {
		let crash = true;
		const harness = await createHarness({
			onCheckpoint(checkpoint) {
				if (crash && checkpoint === "complete_intent") {
					crash = false;
					throw new Error("crash before completion request");
				}
			},
		});
		await expect(harness.processor.process(IDS.delivery)).rejects.toThrow(
			"crash before completion request",
		);
		const originalIntent = harness.journal.snapshot().deliveries[IDS.delivery]?.operation;
		if (originalIntent?.kind !== "complete") throw new Error("expected pending completion");
		harness.client.failNextCompletionWithAuthorityLoss = true;

		await processorFor(harness).process(IDS.delivery);

		expect(harness.client.completeInputs[0]).toEqual(originalIntent.input);
		expect(harness.client.completeInputs[1]?.fencing_token).toBe("2");
		expect(harness.journal.snapshot().deliveries[IDS.delivery]?.phase).toBe("acknowledged");
	});

	it("surfaces a structurally valid but locally inconsistent journaled grant", async () => {
		const authorityPort = new FakeRuntimeAuthorityPort();
		const harness = await createHarness({ authorityPort });
		const interrupted = processorFor({
			...harness,
			adapter: {
				...adapterDelegates(harness.adapter),
				async ensureSession() {
					throw new Error("crash after authority checkpoint");
				},
			},
		});
		await expect(interrupted.process(IDS.delivery)).rejects.toThrow(
			"crash after authority checkpoint",
		);
		await harness.journal.updateDelivery(IDS.delivery, (entry) => {
			if (entry.runtime_authority === null) throw new Error("expected authority checkpoint");
			entry.runtime_authority = {
				...entry.runtime_authority,
				policy_grant_sha256: "f".repeat(64),
			};
		});

		await expect(processorFor(harness).process(IDS.delivery)).rejects.toThrow(
			"Persisted runtime authority no longer matches trusted local inputs",
		);

		expect(authorityPort.installed).toHaveLength(1);
		expect(harness.client.completeInputs).toHaveLength(0);
		expect(harness.journal.snapshot().deliveries[IDS.delivery]?.phase).not.toBe("lease_lost");
	});

	it("renews the executing lease while runtime setup is still in progress", async () => {
		const harness = await createHarness();
		harness.client.renewalExpiresAt = "2026-08-02T00:03:00.300Z";
		let enterProbe!: () => void;
		let releaseProbe!: () => void;
		const probeEntered = new Promise<void>((resolve) => {
			enterProbe = resolve;
		});
		const probeGate = new Promise<void>((resolve) => {
			releaseProbe = resolve;
		});
		const adapter: AgentHostAdapter = {
			...adapterDelegates(harness.adapter),
			async probe() {
				enterProbe();
				await probeGate;
				return harness.adapter.probe();
			},
		};
		const processor = processorFor({ ...harness, adapter });

		const processing = processor.process(IDS.delivery);
		await probeEntered;

		expect(harness.client.startInputs).toHaveLength(1);
		expect(harness.client.renewInputs).toHaveLength(2);
		await vi.waitFor(() => expect(harness.client.renewInputs.length).toBeGreaterThan(2));
		releaseProbe();
		await processing;

		expect(harness.journal.snapshot().deliveries[IDS.delivery]?.phase).toBe("acknowledged");
	});

	it("recovers an accepted host turn after runner reconstruction without duplicating it", async () => {
		let crash = true;
		const provision = vi.fn<RuntimeProvisioner["provision"]>();
		const recover = vi.fn<RuntimeProvisioner["recover"]>();
		const harness = await createHarness({
			authorityPort: new FakeRuntimeAuthorityPort(),
			runtimeProvisioner: { provision, recover },
			prepareRuntimeWorkspace: async () => preparedWorkspace(),
			recoverRuntimeWorkspace: async () => preparedWorkspace(),
			onCheckpoint(checkpoint) {
				if (crash && checkpoint === "host_accepted") {
					crash = false;
					throw new Error("injected crash after host acceptance");
				}
			},
		});

		await expect(harness.processor.process(IDS.delivery)).rejects.toThrow("injected crash");
		expect(harness.journal.snapshot().deliveries[IDS.delivery]?.phase).toBe("host_accepted");

		const restarted = processorFor(harness);
		await restarted.process(IDS.delivery);
		expect(harness.adapter.counters.turnsCreated).toBe(1);
		expect(harness.adapter.counters.startTurnCalls).toBe(1);
		expect(harness.adapter.counters.recoverTurnCalls).toBe(1);
		expect(provision).toHaveBeenCalledOnce();
		expect(recover).toHaveBeenCalledOnce();
		expect(harness.journal.snapshot().deliveries[IDS.delivery]?.phase).toBe("acknowledged");
	});

	it("recovers with the journaled start input after the Relay assignment advances", async () => {
		let crash = true;
		const harness = await createHarness({
			mission: assignment({ peerMessageCount: 1 }),
			onCheckpoint(checkpoint) {
				if (crash && checkpoint === "host_accepted") {
					crash = false;
					throw new Error("injected crash after host acceptance");
				}
			},
		});
		await expect(harness.processor.process(IDS.delivery)).rejects.toThrow("injected crash");
		const originalInput = harness.journal.snapshot().deliveries[IDS.delivery]!.start_turn_input!;
		expect(originalInput.peerMessages.map((message) => message.messageId)).toEqual([
			peerMessageId(1),
		]);

		harness.client.mission = assignment({ peerMessageCount: 2 });
		expect(harness.client.mission.coordinator_state.messages).toHaveLength(2);
		let recoveredInput: StartTurnInput | undefined;
		const adapter: AgentHostAdapter = {
			...adapterDelegates(harness.adapter),
			recoverTurn(ref, expectedInput) {
				recoveredInput = structuredClone(expectedInput);
				return harness.adapter.recoverTurn(ref, expectedInput);
			},
		};
		const restarted = new DeliveryProcessor({
			config: harness.config,
			client: harness.client,
			journal: harness.journal,
			adapter,
			now: () => new Date(TIMES.renewed),
			preflight: successfulPreflight,
		});

		await restarted.process(IDS.delivery);

		expect(recoveredInput).toEqual(originalInput);
		expect(recoveredInput?.peerMessages).toHaveLength(1);
		expect(harness.journal.snapshot().deliveries[IDS.delivery]?.phase).toBe("acknowledged");
	});

	it("fails closed when a recovered Mission session changes host identity", async () => {
		let crash = true;
		const harness = await createHarness({
			onCheckpoint(checkpoint) {
				if (crash && checkpoint === "host_accepted") {
					crash = false;
					throw new Error("injected crash after host acceptance");
				}
			},
		});
		await expect(harness.processor.process(IDS.delivery)).rejects.toThrow("injected crash");
		const changedSessionAdapter: AgentHostAdapter = {
			...adapterDelegates(harness.adapter),
			async ensureSession(input) {
				const session = await harness.adapter.ensureSession(input);
				return { ...session, sessionId: `${session.sessionId}-different` };
			},
		};

		const restarted = new DeliveryProcessor({
			config: harness.config,
			client: harness.client,
			journal: harness.journal,
			adapter: changedSessionAdapter,
			now: () => new Date(TIMES.renewed),
			preflight: successfulPreflight,
		});
		await expect(restarted.process(IDS.delivery)).rejects.toThrow(
			"Host session identity changed during durable Mission recovery",
		);

		expect(harness.adapter.counters.recoverTurnCalls).toBe(0);
		expect(harness.journal.snapshot().deliveries[IDS.delivery]?.phase).toBe("host_accepted");
	});

	it("accepts an identical duplicate event within one live host stream", async () => {
		const harness = await createHarness();
		const processor = new DeliveryProcessor({
			config: harness.config,
			client: harness.client,
			journal: harness.journal,
			adapter: duplicateAcceptedEvent(harness.adapter),
			now: () => new Date(TIMES.renewed),
			preflight: successfulPreflight,
		});

		await processor.process(IDS.delivery);

		expect(harness.adapter.counters.turnsCreated).toBe(1);
		expect(harness.journal.snapshot().deliveries[IDS.delivery]?.phase).toBe("acknowledged");
	});

	it("passes the newest bounded peer-message tail without poisoning delivery retries", async () => {
		const messageCount = MAX_HOST_PEER_MESSAGES + 2;
		const harness = await createHarness({
			mission: assignment({ peerMessageCount: messageCount }),
		});
		const capturedInputs: StartTurnInput[] = [];
		const adapter: AgentHostAdapter = {
			...adapterDelegates(harness.adapter),
			startTurn(input) {
				capturedInputs.push(structuredClone(input));
				return harness.adapter.startTurn(input);
			},
		};
		const processor = new DeliveryProcessor({
			config: harness.config,
			client: harness.client,
			journal: harness.journal,
			adapter,
			now: () => new Date(TIMES.renewed),
			preflight: successfulPreflight,
		});

		await processor.process(IDS.delivery);
		await processor.process(IDS.delivery);

		const selected = capturedInputs[0]?.peerMessages;
		expect(selected).toHaveLength(MAX_HOST_PEER_MESSAGES);
		expect(selected?.map((message) => message.messageId)).toEqual(
			Array.from({ length: MAX_HOST_PEER_MESSAGES }, (_, index) => peerMessageId(index + 3)),
		);
		expect(selected?.[0]).toEqual({
			messageId: peerMessageId(3),
			authorAgentId: IDS.peer,
			kind: "proposal",
			body: "peer message 3",
		});
		expect(selected?.at(-1)).toEqual({
			messageId: peerMessageId(messageCount),
			authorAgentId: IDS.peer,
			kind: "proposal",
			body: `peer message ${messageCount}`,
		});
		expect(harness.adapter.counters.startTurnCalls).toBe(1);
		expect(harness.journal.snapshot().deliveries[IDS.delivery]?.phase).toBe("acknowledged");
	});

	it("replays the exact completion intent after an ambiguous response", async () => {
		const harness = await createHarness();
		harness.client.failFirstCompletion = true;
		await expect(harness.processor.process(IDS.delivery)).rejects.toThrow("response lost");

		const pending = harness.journal.snapshot().deliveries[IDS.delivery]!;
		expect(pending.phase).toBe("complete_intent");
		expect(pending.operation?.kind).toBe("complete");
		await processorFor(harness).process(IDS.delivery);

		expect(harness.client.completeInputs).toHaveLength(2);
		expect(harness.client.completeInputs[1]).toEqual(harness.client.completeInputs[0]);
		expect(harness.client.completedCount).toBe(1);
		expect(harness.adapter.counters.turnsCreated).toBe(1);
		expect(harness.journal.snapshot().deliveries[IDS.delivery]?.phase).toBe("acknowledged");
	});

	it("replays the exact start intent before any later lease mutation", async () => {
		const harness = await createHarness();
		harness.client.loseNextStartResponse = true;

		await expect(harness.processor.process(IDS.delivery)).rejects.toThrow(
			"start committed but response lost",
		);
		const pending = harness.journal.snapshot().deliveries[IDS.delivery]!;
		expect(pending.phase).toBe("start_intent");
		expect(pending.operation?.kind).toBe("start");

		await processorFor(harness).process(IDS.delivery);

		expect(harness.client.startInputs).toHaveLength(2);
		expect(harness.client.startInputs[1]).toEqual(harness.client.startInputs[0]);
		expect(harness.adapter.counters.turnsCreated).toBe(1);
		expect(harness.journal.snapshot().deliveries[IDS.delivery]?.phase).toBe("acknowledged");
	});

	it("replays an ambiguous renewal before a later policy release", async () => {
		const harness = await createHarness();
		harness.client.loseNextRenewResponse = true;

		await expect(harness.processor.process(IDS.delivery)).rejects.toThrow(
			"renew committed but response lost",
		);
		const pending = harness.journal.snapshot().deliveries[IDS.delivery]!;
		expect(pending.operation?.kind).toBe("renew");

		const denyingProcessor = new DeliveryProcessor({
			config: harness.config,
			client: harness.client,
			journal: harness.journal,
			adapter: harness.adapter,
			now: () => new Date(TIMES.renewed),
			preflight: async () => {
				const { WorkspacePreflightError } = await import("./workspace.js");
				throw new WorkspacePreflightError("workspace_dirty", "workspace is dirty");
			},
		});
		await denyingProcessor.process(IDS.delivery);

		expect(harness.client.renewInputs.length).toBeGreaterThanOrEqual(3);
		expect(harness.client.renewInputs[1]).toEqual(harness.client.renewInputs[0]);
		expect(harness.client.releaseInputs.at(-1)?.classification).toBe("policy_denied");
		expect(harness.adapter.counters.startTurnCalls).toBe(0);
	});

	it("fails closed before host invocation when local workspace policy rejects", async () => {
		const harness = await createHarness({
			preflight: async () => {
				const { WorkspacePreflightError } = await import("./workspace.js");
				throw new WorkspacePreflightError("workspace_dirty", "workspace is dirty");
			},
		});
		await harness.processor.process(IDS.delivery);

		expect(harness.adapter.counters.startTurnCalls).toBe(0);
		expect(harness.client.releaseInputs[0]?.classification).toBe("policy_denied");
		expect(harness.journal.snapshot().deliveries[IDS.delivery]?.phase).toBe("dead_lettered");
	});

	it("cancels a recovered host turn before a local preflight release", async () => {
		let crash = true;
		const harness = await createHarness({
			outcome: { kind: "pending" },
			onCheckpoint(checkpoint) {
				if (crash && checkpoint === "host_accepted") {
					crash = false;
					throw new Error("injected crash with a pending host turn");
				}
			},
		});
		await expect(harness.processor.process(IDS.delivery)).rejects.toThrow(
			"injected crash with a pending host turn",
		);

		const denyingProcessor = new DeliveryProcessor({
			config: harness.config,
			client: harness.client,
			journal: harness.journal,
			adapter: harness.adapter,
			now: () => new Date(TIMES.renewed),
			preflight: async () => {
				const { WorkspacePreflightError } = await import("./workspace.js");
				throw new WorkspacePreflightError("workspace_dirty", "workspace is dirty");
			},
		});
		await denyingProcessor.process(IDS.delivery);

		expect(harness.adapter.counters.turnsCancelled).toBe(1);
		expect(harness.adapter.eventsFor(IDS.delivery, 1).at(-1)?.kind).toBe("cancelled");
		expect(harness.client.releaseInputs.at(-1)?.classification).toBe("policy_denied");
	});

	it("does not contact a provisioned runtime when recovery preflight rejects", async () => {
		let crash = true;
		const provision = vi.fn<RuntimeProvisioner["provision"]>();
		const recover = vi.fn<RuntimeProvisioner["recover"]>();
		const harness = await createHarness({
			authorityPort: new FakeRuntimeAuthorityPort(),
			runtimeProvisioner: { provision, recover },
			prepareRuntimeWorkspace: async () => preparedWorkspace(),
			recoverRuntimeWorkspace: async () => preparedWorkspace(),
			outcome: { kind: "pending" },
			onCheckpoint(checkpoint) {
				if (crash && checkpoint === "host_accepted") {
					crash = false;
					throw new Error("injected crash after provisioned host acceptance");
				}
			},
		});
		await expect(harness.processor.process(IDS.delivery)).rejects.toThrow(
			"injected crash after provisioned host acceptance",
		);
		expect(harness.journal.snapshot().deliveries[IDS.delivery]?.start_turn_input).not.toBeNull();
		expect(provision).toHaveBeenCalledOnce();
		const hostCallsBeforeRejection = harness.adapter.counters;

		const preflightRecovery = vi.fn(async () => {
			const { WorkspacePreflightError } = await import("./workspace.js");
			throw new WorkspacePreflightError("base_commit_mismatch", "workspace changed");
		});
		const restarted = new DeliveryProcessor({
			config: harness.config,
			client: harness.client,
			journal: harness.journal,
			adapter: harness.adapter,
			authorityPort: harness.authorityPort,
			runtimeProvisioner: { provision, recover },
			now: () => new Date(TIMES.renewed),
			preflight: successfulPreflight,
			preflightRecovery,
			prepareRuntimeWorkspace: async () => preparedWorkspace(),
			recoverRuntimeWorkspace: async () => preparedWorkspace(),
		});

		await restarted.process(IDS.delivery);

		expect(preflightRecovery).toHaveBeenCalledOnce();
		expect(recover).not.toHaveBeenCalled();
		expect(harness.adapter.counters).toEqual(hostCallsBeforeRejection);
		expect(harness.client.releaseInputs.at(-1)?.classification).toBe("policy_denied");
	});

	it("cancels a recovered host turn when Mission authority is revoked", async () => {
		let crash = true;
		const harness = await createHarness({
			outcome: { kind: "pending" },
			onCheckpoint(checkpoint) {
				if (crash && checkpoint === "host_accepted") {
					crash = false;
					throw new Error("injected crash before Mission revocation");
				}
			},
		});
		await expect(harness.processor.process(IDS.delivery)).rejects.toThrow(
			"injected crash before Mission revocation",
		);
		harness.client.mission = {
			...harness.client.mission,
			coordinator_state: {
				...harness.client.mission.coordinator_state,
				status: "cancelled",
			},
		};

		await processorFor(harness).process(IDS.delivery);

		expect(harness.adapter.counters.turnsCancelled).toBe(1);
		expect(harness.journal.snapshot().deliveries[IDS.delivery]?.phase).toBe("authority_lost");
	});

	it("cancels a recovered host turn when a fresh executable lease cannot be established", async () => {
		let crash = true;
		const harness = await createHarness({
			outcome: { kind: "pending" },
			onCheckpoint(checkpoint) {
				if (crash && checkpoint === "host_accepted") {
					crash = false;
					throw new Error("injected crash before lease rejection");
				}
			},
		});
		await expect(harness.processor.process(IDS.delivery)).rejects.toThrow(
			"injected crash before lease rejection",
		);
		harness.client.failNextRenewWithAuthorityLoss = true;
		harness.client.failNextClaimWithAuthorityLoss = true;

		await processorFor(harness).process(IDS.delivery);

		expect(harness.adapter.counters.turnsCancelled).toBe(1);
		expect(harness.journal.snapshot().deliveries[IDS.delivery]?.phase).toBe("authority_lost");
	});

	it("fails closed before preflight or host invocation when the accepted policy grant drifts", async () => {
		const original = localConfig();
		const changedConfig: NodeConfig = {
			...original,
			policy_profiles: {
				...original.policy_profiles,
				coding: {
					...original.policy_profiles.coding!,
					max_turn_seconds: 301,
				},
			},
		};
		const preflight = vi.fn(successfulPreflight);
		const harness = await createHarness({ config: changedConfig, preflight });

		await harness.processor.process(IDS.delivery);

		expect(preflight).not.toHaveBeenCalled();
		expect(harness.adapter.counters.startTurnCalls).toBe(0);
		expect(harness.client.releaseInputs[0]?.classification).toBe("policy_denied");
		expect(harness.journal.snapshot().deliveries[IDS.delivery]?.phase).toBe("dead_lettered");
	});

	it("rejects prototype-named workspace aliases before preflight or host invocation", async () => {
		for (const workspaceAlias of ["toString", "constructor"]) {
			const preflight = vi.fn(successfulPreflight);
			const harness = await createHarness({
				mission: assignment({ workspaceAlias }),
				preflight,
			});

			await harness.processor.process(IDS.delivery);

			expect(preflight).not.toHaveBeenCalled();
			expect(harness.adapter.counters.startTurnCalls).toBe(0);
			expect(harness.client.releaseInputs[0]?.classification).toBe("policy_denied");
			expect(harness.journal.snapshot().deliveries[IDS.delivery]?.phase).toBe("dead_lettered");
		}
	});

	it("keeps a transient release retryable without claiming before its backoff expires", async () => {
		let localNow = new Date("2026-08-02T00:20:00.000Z");
		const harness = await createHarness({ now: () => localNow });
		await harness.processor.claim(IDS.delivery);
		harness.client.transientRelease = true;

		await harness.processor.release(IDS.delivery, "transient", "dependency unavailable");

		const released = harness.journal.snapshot().deliveries[IDS.delivery]!;
		expect(released.phase).toBe("ingested");
		expect(released.item.delivery.status).toBe("stored");
		await harness.processor.process(IDS.delivery, undefined, new Date("2026-08-02T00:09:00.000Z"));
		expect(harness.client.claimInputs).toHaveLength(1);

		localNow = new Date("2026-08-02T00:03:00.000Z");
		await harness.processor.process(IDS.delivery, undefined, new Date("2026-08-02T00:11:00.000Z"));
		expect(harness.client.claimInputs).toHaveLength(2);
		expect(harness.journal.snapshot().deliveries[IDS.delivery]?.phase).toBe("acknowledged");
	});

	it("keeps a server-deferred retry runnable instead of marking authority lost", async () => {
		const harness = await createHarness();
		harness.client.rejectNextClaimUntil = "2026-08-02T00:10:00.000Z";

		await harness.processor.process(IDS.delivery, undefined, new Date("2026-08-02T00:20:00.000Z"));

		const deferred = harness.journal.snapshot().deliveries[IDS.delivery]!;
		expect(deferred.phase).toBe("ingested");
		expect(deferred.operation).toBeNull();
		expect(deferred.item.delivery.available_at).toBe("2026-08-02T00:10:00.000Z");

		await harness.processor.process(IDS.delivery, undefined, new Date("2026-08-02T00:11:00.000Z"));
		expect(harness.client.claimInputs).toHaveLength(2);
		expect(harness.journal.snapshot().deliveries[IDS.delivery]?.phase).toBe("acknowledged");
	});

	it("reclaims an expired executing lease with a new fence and recovers the same host turn", async () => {
		let crash = true;
		const authorityPort = new FakeRuntimeAuthorityPort();
		const harness = await createHarness({
			authorityPort,
			onCheckpoint(checkpoint) {
				if (crash && checkpoint === "host_accepted") {
					crash = false;
					throw new Error("injected crash before completion");
				}
			},
		});
		await expect(harness.processor.process(IDS.delivery)).rejects.toThrow("injected crash");
		harness.client.failNextRenewWithAuthorityLoss = true;

		await processorFor(harness).process(IDS.delivery);

		expect(harness.client.claimInputs).toHaveLength(2);
		expect(harness.client.completeInputs.at(-1)?.fencing_token).toBe("2");
		expect(harness.adapter.counters.turnsCreated).toBe(1);
		expect(harness.adapter.counters.recoverTurnCalls).toBe(1);
		expect(authorityPort.installed.map((grant) => grant.fencing_token)).toEqual(["1", "2"]);
		expect(authorityPort.installed[1]?.hard_expires_at).toBe(
			authorityPort.installed[0]?.hard_expires_at,
		);
		expect(authorityPort.operations).toContain("revoke:revoked");
		expect(
			harness.journal.snapshot().deliveries[IDS.delivery]?.runtime_authority_predecessor,
		).toBeNull();
		expect(harness.journal.snapshot().deliveries[IDS.delivery]?.phase).toBe("acknowledged");
	});

	it("keeps an unproven predecessor retirement pending without claiming another fence", async () => {
		let crash = true;
		const authorityPort = new FakeRuntimeAuthorityPort();
		const harness = await createHarness({
			authorityPort,
			onCheckpoint(checkpoint) {
				if (crash && checkpoint === "host_accepted") {
					crash = false;
					throw new Error("injected crash before fence replacement");
				}
			},
		});
		await expect(harness.processor.process(IDS.delivery)).rejects.toThrow(
			"injected crash before fence replacement",
		);
		harness.client.failNextRenewWithAuthorityLoss = true;
		authorityPort.revokeError = new Error("retirement timed out");

		await expect(processorFor(harness).process(IDS.delivery)).rejects.toThrow(
			"Predecessor Capsule retirement is not yet proven",
		);
		await expect(processorFor(harness).process(IDS.delivery)).rejects.toThrow(
			"Predecessor Capsule retirement is not yet proven",
		);

		const pending = harness.journal.snapshot().deliveries[IDS.delivery]!;
		expect(harness.client.claimInputs).toHaveLength(2);
		expect(authorityPort.installed.map((grant) => grant.fencing_token)).toEqual(["1"]);
		expect(pending.runtime_authority).toBeNull();
		expect(pending.runtime_authority_predecessor?.fencing_token).toBe("1");
	});

	it("keeps a release retry durable until exact Capsule retirement is proven", async () => {
		const authorityPort = new FakeRuntimeAuthorityPort();
		const harness = await createHarness({
			authorityPort,
			outcome: {
				kind: "failed",
				failure: { class: "transient", message: "host temporarily unavailable" },
			},
		});
		harness.client.transientRelease = true;
		authorityPort.revokeError = new Error("retirement timed out");

		await expect(harness.processor.process(IDS.delivery)).rejects.toThrow(
			"Capsule retirement is not yet proven",
		);

		const pending = harness.journal.snapshot().deliveries[IDS.delivery]!;
		expect(harness.client.releaseInputs).toHaveLength(0);
		expect(pending.phase).toBe("release_intent");
		expect(pending.operation?.kind).toBe("release");
		expect(pending.execution_attempt).toBe(1);
		expect(pending.runtime_authority).not.toBeNull();
		expect(pending.start_turn_input).not.toBeNull();
		expect(pending.host_attempt_history).toHaveLength(0);

		authorityPort.revokeError = null;
		await processorFor(harness).process(IDS.delivery);

		const released = harness.journal.snapshot().deliveries[IDS.delivery]!;
		expect(harness.client.releaseInputs).toHaveLength(1);
		expect(released.phase).toBe("ingested");
		expect(released.execution_attempt).toBe(2);
		expect(released.runtime_authority).toBeNull();
		expect(released.runtime_authority_predecessor).toBeNull();
		expect(released.start_turn_input).toBeNull();
		expect(released.host_attempt_history).toHaveLength(1);
	});

	it("retries terminal completion retirement without publishing twice", async () => {
		const authorityPort = new FakeRuntimeAuthorityPort();
		const harness = await createHarness({ authorityPort });
		authorityPort.revokeError = new Error("retirement timed out");

		await expect(harness.processor.process(IDS.delivery)).rejects.toThrow(
			"Capsule retirement is not yet proven",
		);

		const acknowledged = harness.journal.snapshot().deliveries[IDS.delivery]!;
		expect(acknowledged.phase).toBe("acknowledged");
		expect(acknowledged.runtime_authority).not.toBeNull();
		expect(harness.client.completeInputs).toHaveLength(1);

		await expect(processorFor(harness).processNext()).resolves.toBeNull();
		expect(harness.journal.snapshot().deliveries[IDS.delivery]?.last_error).toContain(
			"Capsule retirement is not yet proven",
		);

		authorityPort.revokeError = null;
		await expect(processorFor(harness).processNext()).resolves.toBe(IDS.delivery);
		expect(harness.client.completeInputs).toHaveLength(1);
		expect(harness.journal.snapshot().deliveries[IDS.delivery]?.runtime_authority).toBeNull();
	});

	it("continues to a later delivery when an earlier retirement remains pending", async () => {
		const authorityPort = new FakeRuntimeAuthorityPort();
		const harness = await createHarness({ authorityPort });
		const firstGrant = await checkpointTerminalAuthority(harness.journal, {
			deliveryId: IDS.delivery,
			missionId: IDS.mission,
			eventId: IDS.event,
			cursor: "1",
			grantId: "50000000-0000-4000-8000-000000000001",
		});
		await checkpointTerminalAuthority(harness.journal, {
			deliveryId: IDS.secondDelivery,
			missionId: IDS.secondMission,
			eventId: IDS.secondEvent,
			cursor: "2",
			grantId: "50000000-0000-4000-8000-000000000002",
		});
		authorityPort.revokeErrorFor = (grant) =>
			grant.delivery_id === IDS.delivery ? new Error("retirement timed out") : null;

		await expect(processorFor(harness).processNext()).resolves.toBe(IDS.secondDelivery);

		const snapshot = harness.journal.snapshot();
		expect(snapshot.deliveries[IDS.delivery]?.runtime_authority).toEqual(firstGrant);
		expect(snapshot.deliveries[IDS.delivery]?.last_error).toContain(
			"Capsule retirement is not yet proven",
		);
		expect(snapshot.deliveries[IDS.secondDelivery]?.runtime_authority).toBeNull();
	});

	it("does not process another delivery while its Mission Capsule transition is pending", async () => {
		const authorityPort = new FakeRuntimeAuthorityPort();
		const harness = await createHarness({ authorityPort });
		const firstGrant = await checkpointTerminalAuthority(harness.journal, {
			deliveryId: IDS.delivery,
			missionId: IDS.mission,
			eventId: IDS.event,
			cursor: "1",
			grantId: "50000000-0000-4000-8000-000000000001",
		});
		const laterGrant = await checkpointTerminalAuthority(harness.journal, {
			deliveryId: IDS.secondDelivery,
			missionId: IDS.mission,
			eventId: IDS.secondEvent,
			cursor: "2",
			grantId: "50000000-0000-4000-8000-000000000002",
		});
		authorityPort.revokeErrorFor = (grant) =>
			grant.delivery_id === IDS.delivery ? new Error("retirement timed out") : null;

		await expect(processorFor(harness).processNext()).resolves.toBeNull();

		const snapshot = harness.journal.snapshot();
		expect(snapshot.deliveries[IDS.delivery]?.runtime_authority).toEqual(firstGrant);
		expect(snapshot.deliveries[IDS.secondDelivery]?.runtime_authority).toEqual(laterGrant);
		expect(snapshot.deliveries[IDS.secondDelivery]?.last_error).toBeNull();
		expect(authorityPort.revoked.map((grant) => grant.delivery_id)).toEqual([IDS.delivery]);
	});

	it("replays a terminal claim only after the prior grant retires", async () => {
		let crash = true;
		const authorityPort = new FakeRuntimeAuthorityPort();
		const harness = await createHarness({
			authorityPort,
			onCheckpoint(checkpoint) {
				if (crash && checkpoint === "host_accepted") {
					crash = false;
					throw new Error("restart before terminal claim");
				}
			},
		});
		await expect(harness.processor.process(IDS.delivery)).rejects.toThrow(
			"restart before terminal claim",
		);
		const priorGrant = harness.journal.snapshot().deliveries[IDS.delivery]?.runtime_authority;
		if (priorGrant === null || priorGrant === undefined)
			throw new Error("expected authority grant");
		authorityPort.revoked.length = 0;
		harness.client.failNextRenewWithAuthorityLoss = true;
		harness.client.deadLetterNextClaim = true;
		authorityPort.revokeError = new Error("retirement timed out");

		await expect(processorFor(harness).process(IDS.delivery)).rejects.toThrow(
			"Capsule retirement is not yet proven",
		);

		const pending = harness.journal.snapshot().deliveries[IDS.delivery]!;
		expect(pending.phase).toBe("claim_intent");
		expect(pending.operation?.kind).toBe("claim");
		expect(pending.runtime_authority).toEqual(priorGrant);
		expect(pending.item.delivery.status).toBe("executing");
		expect(authorityPort.revoked).toContainEqual(priorGrant);
		const terminalClaim = structuredClone(harness.client.claimInputs.at(-1));

		authorityPort.revokeError = null;
		await processorFor(harness).process(IDS.delivery);

		expect(harness.client.claimInputs.at(-1)).toEqual(terminalClaim);
		const terminal = harness.journal.snapshot().deliveries[IDS.delivery]!;
		expect(terminal.phase).toBe("dead_lettered");
		expect(terminal.operation).toBeNull();
		expect(terminal.runtime_authority).toBeNull();
		expect(terminal.runtime_authority_predecessor).toBeNull();
	});

	it("replays an ambiguous re-claim before renewing the replacement lease", async () => {
		let crash = true;
		const harness = await createHarness({
			onCheckpoint(checkpoint) {
				if (crash && checkpoint === "host_accepted") {
					crash = false;
					throw new Error("injected crash before re-claim");
				}
			},
		});
		await expect(harness.processor.process(IDS.delivery)).rejects.toThrow(
			"injected crash before re-claim",
		);
		harness.client.failNextRenewWithAuthorityLoss = true;
		harness.client.loseNextClaimResponse = true;

		await expect(processorFor(harness).process(IDS.delivery)).rejects.toThrow(
			"claim committed but response lost",
		);
		const pending = harness.journal.snapshot().deliveries[IDS.delivery]!;
		expect(pending.phase).toBe("claim_intent");
		expect(pending.operation?.kind).toBe("claim");
		const pendingInput = structuredClone(pending.operation?.input);

		await processorFor(harness).process(IDS.delivery);

		expect(harness.client.claimInputs).toHaveLength(3);
		expect(harness.client.claimInputs[2]).toEqual(pendingInput);
		expect(harness.client.completeInputs.at(-1)?.fencing_token).toBe("2");
		expect(harness.adapter.counters.turnsCreated).toBe(1);
		expect(harness.journal.snapshot().deliveries[IDS.delivery]?.phase).toBe("acknowledged");
	});

	it("preserves a transient host failure as a Relay-backed retry", async () => {
		const authorityPort = new FakeRuntimeAuthorityPort();
		const harness = await createHarness({
			authorityPort,
			outcome: {
				kind: "failed",
				failure: { class: "transient", message: "host temporarily unavailable" },
			},
		});
		harness.client.transientRelease = true;
		harness.adapter.queueOutcome({
			kind: "completed",
			disposition: { kind: "reply", message_type: "progress", message: "retry succeeded" },
		});

		await harness.processor.process(IDS.delivery);

		expect(harness.client.releaseInputs.at(-1)?.classification).toBe("transient");
		const released = harness.journal.snapshot().deliveries[IDS.delivery]!;
		expect(released.phase).toBe("ingested");
		expect(released.execution_attempt).toBe(2);
		expect(released.runtime_authority).toBeNull();
		expect(released.start_turn_input).toBeNull();
		expect(released.host_attempt_history).toHaveLength(1);
		expect(released.host_attempt_history[0]?.start_input_sha256).toMatch(/^[a-f0-9]{64}$/);

		await processorFor(harness).process(
			IDS.delivery,
			undefined,
			new Date("2026-08-02T00:11:00.000Z"),
		);

		expect(harness.adapter.counters.turnsCreated).toBe(2);
		const completed = harness.journal.snapshot().deliveries[IDS.delivery]!;
		expect(completed.phase).toBe("acknowledged");
		expect(completed.start_turn_input?.executionAttempt).toBe(2);
	});

	it("recovers after release authority is lost instead of replaying a poison intent forever", async () => {
		const harness = await createHarness({
			preflight: async () => {
				const { WorkspacePreflightError } = await import("./workspace.js");
				throw new WorkspacePreflightError("workspace_dirty", "workspace is dirty");
			},
		});
		harness.client.failNextReleaseWithAuthorityLoss = true;

		await harness.processor.process(IDS.delivery);
		expect(harness.journal.snapshot().deliveries[IDS.delivery]?.phase).toBe("lease_lost");
		await harness.processor.process(IDS.delivery);

		expect(harness.client.claimInputs).toHaveLength(2);
		expect(harness.client.releaseInputs).toHaveLength(2);
		expect(harness.journal.snapshot().deliveries[IDS.delivery]?.phase).toBe("dead_lettered");
	});

	it("reclaims stale start authority without starving the queue", async () => {
		const harness = await createHarness();
		harness.client.failNextStartWithAuthorityLoss = true;

		await harness.processor.process(IDS.delivery);

		expect(harness.client.claimInputs).toHaveLength(2);
		expect(harness.adapter.counters.turnsCreated).toBe(1);
		expect(harness.journal.snapshot().deliveries[IDS.delivery]?.phase).toBe("acknowledged");
	});

	it("settles a recovered adapter cancellation through transient Relay release", async () => {
		const harness = await createHarness({ outcome: { kind: "pending" } });
		const crashing = new DeliveryProcessor({
			config: harness.config,
			client: harness.client,
			journal: harness.journal,
			adapter: harness.adapter,
			now: () => new Date(TIMES.renewed),
			preflight: successfulPreflight,
			onCheckpoint: async (checkpoint, deliveryId) => {
				if (checkpoint !== "host_accepted") return;
				const executionAttempt =
					harness.journal.snapshot().deliveries[deliveryId]!.execution_attempt;
				const turn = await harness.adapter.lookupTurn(deliveryId, executionAttempt);
				if (turn === null) throw new Error("expected accepted fake turn");
				await harness.adapter.cancelTurn(turn);
				throw new Error("restart after external cancellation");
			},
		});
		await expect(crashing.process(IDS.delivery)).rejects.toThrow(
			"restart after external cancellation",
		);
		harness.client.transientRelease = true;

		await processorFor(harness).process(IDS.delivery);

		expect(harness.client.releaseInputs.at(-1)?.classification).toBe("transient");
		expect(harness.journal.snapshot().deliveries[IDS.delivery]?.phase).toBe("ingested");
	});

	it("cancels a pending host turn and returns when shutdown is requested", async () => {
		const controller = new AbortController();
		const harness = await createHarness({
			outcome: { kind: "pending" },
			onCheckpoint(checkpoint) {
				if (checkpoint === "host_accepted") controller.abort();
			},
		});

		await harness.processor.process(IDS.delivery, controller.signal);

		expect(harness.adapter.counters.cancelTurnCalls).toBe(1);
		expect(harness.adapter.counters.turnsCancelled).toBe(1);
		expect(harness.journal.snapshot().deliveries[IDS.delivery]?.phase).toBe("host_accepted");
	});

	it("does not start a host turn when shutdown arrives during adapter setup", async () => {
		const controller = new AbortController();
		const harness = await createHarness();
		const adapter = abortAfterProbe(harness.adapter, controller);
		const processor = new DeliveryProcessor({
			config: harness.config,
			client: harness.client,
			journal: harness.journal,
			adapter,
			now: () => new Date(TIMES.renewed),
			preflight: successfulPreflight,
		});

		await processor.process(IDS.delivery, controller.signal);

		expect(harness.adapter.counters.startTurnCalls).toBe(0);
	});

	it("records shutdown cleanup as pending while exact Capsule retirement is unproven", async () => {
		const controller = new AbortController();
		const authorityPort = new FakeRuntimeAuthorityPort();
		authorityPort.revokeError = new Error("shutdown retirement timed out");
		const harness = await createHarness({ authorityPort });
		let markSetupStarted!: () => void;
		let releaseSetup!: () => void;
		const setupStarted = new Promise<void>((resolve) => {
			markSetupStarted = resolve;
		});
		const setupGate = new Promise<void>((resolve) => {
			releaseSetup = resolve;
		});
		const adapter: AgentHostAdapter = {
			...adapterDelegates(harness.adapter),
			async ensureSession(input) {
				markSetupStarted();
				await setupGate;
				return harness.adapter.ensureSession(input);
			},
		};
		const processor = processorFor({ ...harness, adapter });

		const processing = processor.processNext(controller.signal);
		await setupStarted;
		controller.abort();
		releaseSetup();
		await expect(processing).resolves.toBeNull();

		const pending = harness.journal.snapshot().deliveries[IDS.delivery]!;
		expect(pending.last_error).toContain("Capsule retirement is not yet proven");
		expect(pending.runtime_authority).not.toBeNull();
		expect(authorityPort.revoked.length).toBeGreaterThan(0);
		expect(harness.adapter.counters.startTurnCalls).toBe(0);
	});

	it("persists an in-flight claim response but starts no later Relay or host request", async () => {
		const controller = new AbortController();
		const harness = await createHarness();
		harness.client.afterClaimResponse = () => controller.abort();

		await expect(harness.processor.process(IDS.delivery, controller.signal)).rejects.toMatchObject({
			name: "AbortError",
		});

		expect(harness.journal.snapshot().deliveries[IDS.delivery]).toMatchObject({
			phase: "claimed",
			item: { delivery: { status: "leased" } },
		});
		expect(harness.client.assignmentCalls).toBe(0);
		expect(harness.client.renewInputs).toHaveLength(0);
		expect(harness.client.startInputs).toHaveLength(0);
		expect(harness.adapter.counters.startTurnCalls).toBe(0);
	});

	it("starts no preflight or lease request after an in-flight assignment lookup finishes", async () => {
		const controller = new AbortController();
		const harness = await createHarness();
		const preflight = vi.fn(successfulPreflight);
		harness.client.afterAssignmentResponse = () => controller.abort();
		const processor = new DeliveryProcessor({
			config: harness.config,
			client: harness.client,
			journal: harness.journal,
			adapter: harness.adapter,
			now: () => new Date(TIMES.renewed),
			preflight,
		});

		await expect(processor.process(IDS.delivery, controller.signal)).rejects.toMatchObject({
			name: "AbortError",
		});

		expect(harness.client.assignmentCalls).toBe(1);
		expect(preflight).not.toHaveBeenCalled();
		expect(harness.client.renewInputs).toHaveLength(0);
		expect(harness.client.startInputs).toHaveLength(0);
		expect(harness.adapter.counters.startTurnCalls).toBe(0);
	});

	it("escapes a stalled host iterator when lease renewal fails", async () => {
		const harness = await createHarness({ outcome: { kind: "pending" } });
		harness.client.renewalExpiresAt = "2026-08-02T00:03:00.300Z";
		harness.client.failRenewAtCall = 3;
		const processor = new DeliveryProcessor({
			config: harness.config,
			client: harness.client,
			journal: harness.journal,
			adapter: stallHostStream(harness.adapter),
			now: () => new Date(TIMES.renewed),
			preflight: successfulPreflight,
		});

		await expect(processor.process(IDS.delivery)).rejects.toThrow("renew transport down");

		expect(harness.adapter.counters.cancelTurnCalls).toBe(1);
		expect(harness.journal.snapshot().deliveries[IDS.delivery]?.phase).toBe("host_accepted");
	});

	it("cancels the active turn before retiring authority after lease renewal failure", async () => {
		const operations: string[] = [];
		const authorityPort = new FakeRuntimeAuthorityPort((operation) => operations.push(operation));
		const harness = await createHarness({ outcome: { kind: "pending" }, authorityPort });
		harness.client.renewalExpiresAt = "2026-08-02T00:03:00.300Z";
		harness.client.failRenewAtCall = 3;
		const stalled = stallHostStream(harness.adapter);
		const adapter: AgentHostAdapter = {
			...stalled,
			async cancelTurn(ref) {
				operations.push("cancel");
				await stalled.cancelTurn(ref);
			},
		};
		const processor = processorFor({ ...harness, adapter });

		await expect(processor.process(IDS.delivery)).rejects.toThrow("renew transport down");

		expect(operations.indexOf("cancel")).toBeGreaterThanOrEqual(0);
		expect(operations.indexOf("cancel")).toBeLessThan(operations.indexOf("revoke:revoked"));
		expect(harness.client.completeInputs).toHaveLength(0);
	});

	it("cancels a stalled host turn when Node-local runtime authority expires", async () => {
		vi.useFakeTimers();
		let now = new Date(TIMES.renewed);
		try {
			const config = localConfig();
			config.policy_profiles.coding = {
				...config.policy_profiles.coding!,
				max_turn_seconds: 1,
			};
			const authorityPort = new FakeRuntimeAuthorityPort();
			const harness = await createHarness({
				config,
				mission: assignment({ config }),
				outcome: { kind: "pending" },
				authorityPort,
				now: () => now,
			});
			const processor = new DeliveryProcessor({
				config,
				client: harness.client,
				journal: harness.journal,
				adapter: stallHostStream(harness.adapter),
				authorityPort,
				now: () => now,
				preflight: successfulPreflight,
			});

			const processing = processor.process(IDS.delivery);
			await vi.waitFor(() =>
				expect(harness.journal.snapshot().deliveries[IDS.delivery]?.phase).toBe("host_accepted"),
			);
			now = new Date(Date.parse(TIMES.renewed) + 1_000);
			await vi.advanceTimersByTimeAsync(1_000);
			await processing;

			expect(harness.adapter.counters.cancelTurnCalls).toBe(1);
			expect(harness.client.completeInputs).toHaveLength(0);
			expect(harness.journal.snapshot().deliveries[IDS.delivery]?.phase).toBe("lease_lost");
			expect(authorityPort.operations.at(-1)).toBe("revoke:expired");
		} finally {
			vi.useRealTimers();
		}
	});
});

interface HarnessOptions {
	readonly onCheckpoint?: (checkpoint: DeliveryCheckpoint) => void | Promise<void>;
	readonly preflight?: DeliveryProcessorOptions["preflight"];
	readonly preflightRecovery?: DeliveryProcessorOptions["preflightRecovery"];
	readonly now?: () => Date;
	readonly outcome?: FakeTurnOutcome;
	readonly config?: NodeConfig;
	readonly mission?: NodeMissionAssignment;
	readonly authorityPort?: RuntimeAuthorityPort;
	readonly runtimeProvisioner?: RuntimeProvisioner;
	readonly prepareRuntimeWorkspace?: DeliveryProcessorOptions["prepareRuntimeWorkspace"];
	readonly recoverRuntimeWorkspace?: DeliveryProcessorOptions["recoverRuntimeWorkspace"];
}

async function createHarness(options: HarnessOptions = {}) {
	const storage = new MemoryStorage();
	const journal = await NodeJournal.open(storage);
	await journal.ingestCursorPage([storedItem()], "1", new Date(TIMES.created));
	const client = new FakeRelayClient(options.mission ?? assignment());
	const adapter = new FakeAgentHostAdapter();
	adapter.queueOutcome(
		options.outcome ?? {
			kind: "completed",
			disposition: { kind: "reply", message_type: "progress", message: "fake result" },
		},
	);
	const harness = {
		config: options.config ?? localConfig(),
		client,
		adapter,
		journal,
		storage,
		authorityPort: options.authorityPort,
		runtimeProvisioner: options.runtimeProvisioner,
		prepareRuntimeWorkspace: options.prepareRuntimeWorkspace,
		recoverRuntimeWorkspace: options.recoverRuntimeWorkspace,
	};
	return {
		...harness,
		processor: new DeliveryProcessor({
			...harness,
			now: options.now ?? (() => new Date(TIMES.renewed)),
			preflight: options.preflight ?? successfulPreflight,
			preflightRecovery: options.preflightRecovery ?? successfulRecoveryPreflight,
			onCheckpoint: options.onCheckpoint
				? (checkpoint) => options.onCheckpoint?.(checkpoint)
				: undefined,
		}),
	};
}

function processorFor(harness: Awaited<ReturnType<typeof createHarness>>): DeliveryProcessor {
	return new DeliveryProcessor({
		config: harness.config,
		client: harness.client,
		journal: harness.journal,
		adapter: harness.adapter,
		authorityPort: harness.authorityPort,
		runtimeProvisioner: harness.runtimeProvisioner,
		prepareRuntimeWorkspace: harness.prepareRuntimeWorkspace,
		recoverRuntimeWorkspace: harness.recoverRuntimeWorkspace,
		now: () => new Date(TIMES.renewed),
		preflight: successfulPreflight,
		preflightRecovery: successfulRecoveryPreflight,
	});
}

async function checkpointTerminalAuthority(
	journal: NodeJournal,
	options: {
		readonly deliveryId: string;
		readonly missionId: string;
		readonly eventId: string;
		readonly cursor: string;
		readonly grantId: string;
	},
): Promise<RuntimeAuthorityGrant> {
	if (journal.snapshot().deliveries[options.deliveryId] === undefined) {
		const item = storedItem();
		item.delivery = {
			...item.delivery,
			delivery_id: options.deliveryId,
			mission_id: options.missionId,
			mission_event_id: options.eventId,
			cursor: options.cursor,
			idempotency_key: `delivery:${options.cursor}`,
		};
		item.event = {
			...item.event,
			event_id: options.eventId,
			mission_id: options.missionId,
			idempotency_key: `participants:${options.cursor}`,
		};
		await journal.ingestCursorPage([item], options.cursor, new Date(TIMES.created));
	}
	const executing = {
		...executingDelivery(1),
		delivery_id: options.deliveryId,
		mission_id: options.missionId,
		mission_event_id: options.eventId,
		cursor: options.cursor,
		idempotency_key: `delivery:${options.cursor}`,
	};
	await journal.replaceDeliveryState(executing);
	const grant = authorityGrant({
		grant_id: options.grantId,
		node_id: IDS.node,
		mission_id: options.missionId,
		delivery_id: options.deliveryId,
		lease_id: leaseId(1),
		fencing_token: "1",
		lease_expires_at: TIMES.expires,
	});
	await journal.checkpointRuntimeAuthority(options.deliveryId, grant);
	await journal.replaceDeliveryState({
		...acknowledgedDelivery(1),
		delivery_id: options.deliveryId,
		mission_id: options.missionId,
		mission_event_id: options.eventId,
		cursor: options.cursor,
		idempotency_key: `delivery:${options.cursor}`,
	});
	return grant;
}

function duplicateAcceptedEvent(delegate: AgentHostAdapter): AgentHostAdapter {
	return {
		probe: () => delegate.probe(),
		ensureSession: (input) => delegate.ensureSession(input),
		lookupTurn: (deliveryId, executionAttempt) => delegate.lookupTurn(deliveryId, executionAttempt),
		startTurn: (input) => duplicateAccepted(delegate.startTurn(input)),
		recoverTurn: (ref, expectedInput) => delegate.recoverTurn(ref, expectedInput),
		cancelTurn: (ref) => delegate.cancelTurn(ref),
	};
}

function abortAfterProbe(
	delegate: AgentHostAdapter,
	controller: AbortController,
): AgentHostAdapter {
	return {
		...adapterDelegates(delegate),
		async probe() {
			const result = await delegate.probe();
			controller.abort();
			return result;
		},
	};
}

function stallHostStream(delegate: AgentHostAdapter): AgentHostAdapter {
	return {
		...adapterDelegates(delegate),
		startTurn: (input) => stallAfterReplay(delegate.startTurn(input)),
		recoverTurn: (ref, expectedInput) => stallAfterReplay(delegate.recoverTurn(ref, expectedInput)),
	};
}

function adapterDelegates(delegate: AgentHostAdapter): AgentHostAdapter {
	return {
		probe: () => delegate.probe(),
		ensureSession: (input) => delegate.ensureSession(input),
		lookupTurn: (deliveryId, executionAttempt) => delegate.lookupTurn(deliveryId, executionAttempt),
		startTurn: (input) => delegate.startTurn(input),
		recoverTurn: (ref, expectedInput) => delegate.recoverTurn(ref, expectedInput),
		cancelTurn: (ref) => delegate.cancelTurn(ref),
	};
}

async function* stallAfterReplay(stream: AsyncIterable<HostEvent>): AsyncIterable<HostEvent> {
	for await (const event of stream) yield event;
	await new Promise<never>(() => undefined);
}

async function* duplicateAccepted(stream: AsyncIterable<HostEvent>): AsyncIterable<HostEvent> {
	for await (const event of stream) {
		yield event;
		if (event.kind === "accepted") yield structuredClone(event);
	}
}

async function successfulPreflight() {
	return {
		root: "/tmp/agentrelay-backend",
		repository_url: "https://github.com/acme/backend.git",
		head_commit: "1".repeat(40),
		reachable_from_ref: "refs/heads/main",
		clean: true as const,
	};
}

async function successfulRecoveryPreflight() {
	return {
		root: "/tmp/agentrelay-backend",
		repository_url: "https://github.com/acme/backend.git",
		head_commit: "1".repeat(40),
		reachable_from_ref: "refs/heads/main",
	};
}

function freshRuntimeProvisioner(provision: RuntimeProvisioner["provision"]): RuntimeProvisioner {
	return {
		provision,
		recover: async () => {
			throw new Error("recover-only provisioning must not run for a fresh turn");
		},
	};
}

function preparedWorkspace(): PreparedMissionWorkspace {
	return {
		repositoryUrl: "https://github.com/acme/backend.git",
		baseCommit: "1".repeat(40),
		root: "/tmp/agentrelay-backend",
		gitDirectory: "/tmp/agentrelay-backend/.git",
		rootIdentity: { device: "1", inode: "2" },
		gitIdentity: { device: "1", inode: "3" },
		reachableFromRef: "refs/heads/main",
	};
}

class FakeRuntimeAuthorityPort implements RuntimeAuthorityPort {
	readonly installed: RuntimeAuthorityGrant[] = [];
	readonly installedLeases: RuntimeAuthorityRenewal[] = [];
	readonly renewed: RuntimeAuthorityRenewal[] = [];
	readonly asserted: RuntimeAuthorityRequest[] = [];
	readonly revoked: RuntimeAuthorityGrant[] = [];
	readonly operations: string[] = [];
	currentFence: string | null = null;
	failNextRenew = false;
	installErrorFor: ((grant: RuntimeAuthorityGrant) => Error | null) | null = null;
	revokeError: Error | null = null;
	revokeErrorFor: ((grant: RuntimeAuthorityGrant) => Error | null) | null = null;
	installResult: Promise<void> = Promise.resolve();

	constructor(readonly onOperation: (operation: string) => void = () => undefined) {}

	private record(operation: string): void {
		this.operations.push(operation);
		this.onOperation(operation);
	}

	async installAuthority(
		grant: RuntimeAuthorityGrant,
		currentLease: RuntimeAuthorityRenewal,
	): Promise<void> {
		this.installed.push(structuredClone(grant));
		this.installedLeases.push(structuredClone(currentLease));
		this.record(`install:${grant.fencing_token}`);
		const error = this.installErrorFor?.(grant) ?? null;
		if (error !== null) throw error;
		await this.installResult;
	}

	async renewAuthority(_missionId: string, renewal: RuntimeAuthorityRenewal): Promise<void> {
		this.renewed.push(structuredClone(renewal));
		this.record(`renew:${renewal.fencing_token}`);
		if (this.failNextRenew) {
			this.failNextRenew = false;
			throw new Error("Capsule renewal response lost");
		}
	}

	async assertAuthority(request: RuntimeAuthorityRequest): Promise<void> {
		this.asserted.push(structuredClone(request));
		this.record(`assert:${request.fencing_token}`);
		if (this.currentFence !== null && request.fencing_token !== this.currentFence) {
			throw new Error("stale_fence");
		}
	}

	async revokeAuthority(
		grant: RuntimeAuthorityGrant,
		reason: RuntimeAuthorityDenyCode,
	): Promise<void> {
		this.revoked.push(structuredClone(grant));
		this.record(`revoke:${reason}`);
		const error = this.revokeErrorFor?.(grant) ?? this.revokeError;
		if (error !== null) throw error;
	}
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

class FakeRelayClient implements NodeRelayClient {
	readonly claimInputs: DeliveryClaimInput[] = [];
	readonly startInputs: DeliveryStartInput[] = [];
	readonly renewInputs: DeliveryRenewInput[] = [];
	readonly completeInputs: DeliveryCompleteInput[] = [];
	readonly releaseInputs: DeliveryReleaseInput[] = [];
	completedCount = 0;
	beforeComplete: ((signal?: AbortSignal) => Promise<void>) | null = null;
	afterComplete: ((signal?: AbortSignal) => Promise<void>) | null = null;
	failFirstCompletion = false;
	transientRelease = false;
	deadLetterNextClaim = false;
	failNextClaimWithAuthorityLoss = false;
	failNextCompletionWithAuthorityLoss = false;
	failNextRenewWithAuthorityLoss = false;
	failNextReleaseWithAuthorityLoss = false;
	failNextStartWithAuthorityLoss = false;
	loseNextClaimResponse = false;
	loseNextStartResponse = false;
	loseNextRenewResponse = false;
	rejectNextClaimUntil: string | null = null;
	renewalExpiresAt: string = TIMES.expires;
	renewalUpdatedAt: string = TIMES.renewed;
	failRenewAtCall: number | null = null;
	afterClaimResponse: (() => void) | null = null;
	afterAssignmentResponse: (() => void) | null = null;
	assignmentCalls = 0;
	activeStatus: "leased" | "executing" = "leased";
	#claimResults = new Map<string, DeliveryClaimResult>();
	#startResults = new Map<string, DeliveryStartResult>();
	#renewResults = new Map<string, DeliveryRenewResult>();
	#completeResults = new Map<string, DeliveryCompleteResult>();

	constructor(public mission: NodeMissionAssignment) {}

	async getAssignment(): Promise<NodeMissionAssignment> {
		this.assignmentCalls += 1;
		const result = structuredClone(this.mission);
		this.afterAssignmentResponse?.();
		return result;
	}

	async claim(_deliveryId: string, input: DeliveryClaimInput): Promise<DeliveryClaimResult> {
		this.claimInputs.push(structuredClone(input));
		if (this.failNextClaimWithAuthorityLoss) {
			this.failNextClaimWithAuthorityLoss = false;
			throw authorityLostError();
		}
		if (this.rejectNextClaimUntil !== null) {
			const availableAt = this.rejectNextClaimUntil;
			this.rejectNextClaimUntil = null;
			throw new RelayHttpError(409, "state_changed", "retry is not available", "req_test", {
				available_at: availableAt,
			});
		}
		const replayed = this.#claimResults.get(input.idempotency_key);
		if (replayed !== undefined) return { ...structuredClone(replayed), replayed: true };
		const attempt = this.#claimResults.size + 1;
		const result: DeliveryClaimResult = this.deadLetterNextClaim
			? {
					outcome: "dead_lettered",
					delivery: deadLetteredDelivery(attempt),
					receipt: {} as DeliveryClaimResult["receipt"],
					replayed: false,
				}
			: {
					outcome: "claimed",
					item: { ...storedItem(), delivery: leasedDelivery(attempt) },
					receipt: {} as DeliveryClaimResult["receipt"],
					replayed: false,
				};
		this.deadLetterNextClaim = false;
		if (result.outcome === "claimed") this.activeStatus = "leased";
		this.#claimResults.set(input.idempotency_key, structuredClone(result));
		if (this.loseNextClaimResponse) {
			this.loseNextClaimResponse = false;
			throw new Error("claim committed but response lost");
		}
		this.afterClaimResponse?.();
		return result;
	}

	async start(_deliveryId: string, input: DeliveryStartInput): Promise<DeliveryStartResult> {
		this.startInputs.push(structuredClone(input));
		if (this.failNextStartWithAuthorityLoss) {
			this.failNextStartWithAuthorityLoss = false;
			throw authorityLostError();
		}
		const replayed = this.#startResults.get(input.idempotency_key);
		if (replayed !== undefined) return { ...structuredClone(replayed), replayed: true };
		this.activeStatus = "executing";
		const result: DeliveryStartResult = {
			delivery: executingDelivery(Number(input.fencing_token)),
			receipt: {} as never,
			replayed: false,
		};
		this.#startResults.set(input.idempotency_key, structuredClone(result));
		if (this.loseNextStartResponse) {
			this.loseNextStartResponse = false;
			throw new Error("start committed but response lost");
		}
		return result;
	}

	async renew(_deliveryId: string, input: DeliveryRenewInput): Promise<DeliveryRenewResult> {
		this.renewInputs.push(structuredClone(input));
		if (this.failRenewAtCall === this.renewInputs.length) {
			throw new Error("renew transport down");
		}
		if (this.failNextRenewWithAuthorityLoss) {
			this.failNextRenewWithAuthorityLoss = false;
			throw authorityLostError();
		}
		const replayed = this.#renewResults.get(input.idempotency_key);
		if (replayed !== undefined) return { ...structuredClone(replayed), replayed: true };
		const result: DeliveryRenewResult = {
			delivery: renewedDelivery(
				Number(input.fencing_token),
				this.activeStatus,
				this.renewalExpiresAt,
				this.renewalUpdatedAt,
			),
			receipt: {
				recorded_at: TIMES.renewed,
				lease_expires_at: this.renewalExpiresAt,
			} as never,
			replayed: false,
		};
		this.#renewResults.set(input.idempotency_key, structuredClone(result));
		if (this.loseNextRenewResponse) {
			this.loseNextRenewResponse = false;
			throw new Error("renew committed but response lost");
		}
		return result;
	}

	async complete(
		_deliveryId: string,
		input: DeliveryCompleteInput,
		signal?: AbortSignal,
	): Promise<DeliveryCompleteResult> {
		this.completeInputs.push(structuredClone(input));
		await this.beforeComplete?.(signal);
		if (this.failNextCompletionWithAuthorityLoss) {
			this.failNextCompletionWithAuthorityLoss = false;
			throw authorityLostError();
		}
		const replayed = this.#completeResults.get(input.idempotency_key);
		if (replayed !== undefined) return { ...structuredClone(replayed), replayed: true };
		const result: DeliveryCompleteResult = {
			delivery: acknowledgedDelivery(Number(input.fencing_token)),
			receipt: {} as never,
			events: [{}] as never,
			derived_delivery_ids: [],
			replayed: false,
		};
		this.completedCount += 1;
		this.#completeResults.set(input.idempotency_key, structuredClone(result));
		if (this.failFirstCompletion && this.completeInputs.length === 1) {
			throw new Error("completion committed but response lost");
		}
		await this.afterComplete?.(signal);
		return result;
	}

	async release(_deliveryId: string, input: DeliveryReleaseInput): Promise<DeliveryReleaseResult> {
		this.releaseInputs.push(structuredClone(input));
		if (this.failNextReleaseWithAuthorityLoss) {
			this.failNextReleaseWithAuthorityLoss = false;
			throw authorityLostError();
		}
		const attempt = Number(input.fencing_token);
		return {
			delivery: this.transientRelease
				? storedAfterTransientRelease(attempt)
				: deadLetteredDelivery(attempt),
			receipt: {} as never,
			replayed: false,
		};
	}

	async me(): Promise<NodeSelfResult> {
		throw new Error("not used");
	}
	async registerWorkspace(
		_input: WorkspaceRegistrationInput,
	): Promise<WorkspaceRegistrationResult> {
		throw new Error("not used");
	}
	async listWorkspaces(): Promise<WorkspaceBindingList> {
		throw new Error("not used");
	}
	async listAssignments(
		_status?: MissionStatus,
		_afterCursor?: string | null,
		_limit?: number,
	): Promise<NodeMissionAssignmentList> {
		throw new Error("not used");
	}
	async acceptAssignment(
		_missionId: string,
		_input: MissionParticipantAcceptanceInput,
	): Promise<MissionParticipantAcceptanceResult> {
		throw new Error("not used");
	}
	async pollDeliveries(): Promise<StoredMissionDeliveryCursorPage> {
		throw new Error("not used");
	}
	async recoverDeliveries(): Promise<RecoverableMissionDeliveryPage> {
		throw new Error("not used");
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
	options: {
		readonly workspaceAlias?: string;
		readonly peerMessageCount?: number;
		readonly config?: NodeConfig;
	} = {},
): NodeMissionAssignment {
	const config = options.config ?? localConfig();
	const acceptedPolicy = resolvePolicyProfile(config.policy_profiles, "coding");
	const contract = {
		artifact_id: IDS.artifact,
		type: "api_contract",
		version: 1 as const,
		sha256: "a".repeat(64),
		media_type: "application/json",
		byte_size: 2,
	};
	const coordinatorConfig = {
		mission_context: {
			manifest: {
				schema_version: 1 as const,
				mission_id: IDS.mission,
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
						requested_local_policy_profile: "coding",
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
				shared_contract: contract,
				max_turns: 10,
				max_wall_time_seconds: 3_600,
				token_budget: 100_000,
				expires_at: "2026-08-03T00:00:00.000Z",
				allowed_artifact_types: ["api_contract"],
				created_at: TIMES.created,
			},
			created_by: { principal_id: IDS.owner, kind: "owner" as const },
		},
		required_verification_commands: {
			[IDS.agent]: ["test"],
			[IDS.peer]: ["test"],
		},
	};
	let state = createMissionCoordinatorState(coordinatorConfig);
	state = reduceMissionCoordinatorEvent(state, storedItem().event);
	state = {
		...state,
		messages: Array.from({ length: options.peerMessageCount ?? 0 }, (_, index) =>
			peerMessage(index + 1),
		),
	};
	return nodeMissionAssignmentSchema.parse({
		mission_id: IDS.mission,
		coordinator_config: coordinatorConfig,
		coordinator_state: state,
		participant_agent_id: IDS.agent,
		workspace_binding_id: IDS.binding,
		acceptance_status: "accepted",
		acceptance_receipt: {
			mission_id: IDS.mission,
			participant_agent_id: IDS.agent,
			idempotency_key: "accept:local",
			contract,
			local_policy_grant: acceptedPolicy.grant,
			accepted_at: TIMES.created,
		},
	});
}

function peerMessage(index: number) {
	return {
		message_id: peerMessageId(index),
		mission_id: IDS.mission,
		sequence_no: index,
		author_agent_id: IDS.peer,
		type: "proposal" as const,
		body: `peer message ${index}`,
		artifacts: [],
		contract_version: 1,
		idempotency_key: `peer:${index}`,
		causal_parent_message_id: index === 1 ? null : peerMessageId(index - 1),
		created_at: new Date(Date.parse(TIMES.created) + index * 1_000).toISOString(),
	};
}

function peerMessageId(index: number): string {
	return `40000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function storedItem(): MissionDeliveryItem {
	return {
		delivery: baseDelivery(),
		event: {
			type: "participants_accepted",
			event_id: IDS.event,
			idempotency_key: "participants:accepted",
			mission_id: IDS.mission,
			sequence_no: 1,
			created_at: TIMES.created,
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

function baseDelivery(): Delivery {
	return {
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
		idempotency_key: "delivery:1",
		causal_parent_delivery_id: null,
		available_at: TIMES.created,
		created_at: TIMES.created,
		updated_at: TIMES.created,
		acknowledged_at: null,
		cancelled_at: null,
		cancellation_reason: null,
		dead_lettered_at: null,
	};
}

function leasedDelivery(attempt = 1): Delivery {
	return {
		...baseDelivery(),
		status: "leased",
		attempt_count: attempt,
		last_fencing_token: String(attempt),
		lease: {
			lease_id: leaseId(attempt),
			fencing_token: String(attempt),
			expires_at: TIMES.expires,
		},
		updated_at: TIMES.claimed,
	};
}

function executingDelivery(attempt = 1): Delivery {
	return { ...leasedDelivery(attempt), status: "executing", updated_at: TIMES.started };
}

function renewedDelivery(
	attempt = 1,
	status: "leased" | "executing" = "executing",
	expiresAt = TIMES.expires,
	updatedAt = TIMES.renewed,
): Delivery {
	return {
		...(status === "leased" ? leasedDelivery(attempt) : executingDelivery(attempt)),
		lease: { ...leasedDelivery(attempt).lease!, expires_at: expiresAt },
		updated_at: updatedAt,
	};
}

function acknowledgedDelivery(attempt = 1): Delivery {
	return {
		...renewedDelivery(attempt),
		status: "acknowledged",
		lease: null,
		logical_settlement: { settled_by_event_id: IDS.settlement, settled_at: TIMES.completed },
		updated_at: TIMES.completed,
		acknowledged_at: TIMES.completed,
	};
}

function deadLetteredDelivery(attempt = 1): Delivery {
	return {
		...renewedDelivery(attempt),
		status: "dead_lettered",
		lease: null,
		updated_at: TIMES.completed,
		dead_lettered_at: TIMES.completed,
	};
}

function storedAfterTransientRelease(attempt = 1): Delivery {
	return {
		...baseDelivery(),
		attempt_count: attempt,
		last_fencing_token: String(attempt),
		available_at: "2026-08-02T00:10:00.000Z",
		updated_at: TIMES.completed,
	};
}

function leaseId(attempt: number): string {
	return `30000000-0000-4000-8000-${String(attempt).padStart(12, "0")}`;
}

function authorityLostError(): RelayHttpError {
	return new RelayHttpError(409, "state_changed", "lease expired", "req_test", {});
}
