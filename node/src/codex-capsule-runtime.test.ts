import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants, type PathLike, close, fstatSync, open } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import type {
	AdapterInfo,
	HostEvent,
	HostSessionRef,
	HostTurnRef,
	SessionInput,
	StartTurnInput,
} from "@agentrelay/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { capsuleResultValue, sendCapsuleRequest } from "../test-support/capsule-wire-client.js";
import { createFakeCodexOwnerCredential } from "../test-support/fake-codex-owner-credential.js";
import { CapsuleAuthority } from "./capsule-authority.js";
import {
	CAPSULE_DESCRIPTOR_FILE,
	CODEX_CAPSULE_RUNTIME_CONTRACT,
	type CapsuleLaunchDescriptor,
	type CodexCapsuleLaunchDescriptor,
	capsuleSocketPath,
	codexCapsuleLaunchDescriptorSchema,
} from "./capsule-launch-descriptor.js";
import {
	openCapsuleRuntimeController,
	startConfiguredCapsuleServer,
} from "./capsule-runtime-factory.js";
import type { CapsuleRuntime } from "./capsule-runtime.js";
import type { CodexCapsuleRunnerOptions } from "./codex-capsule-runner-contract.js";
import {
	CodexCapsuleRuntimeController,
	CodexWorkspaceWriteActivationNotEnabledError,
} from "./codex-capsule-runtime.js";
import type { InheritedCodexOwnerCredentialChannel } from "./codex-owner-credential-channel.js";
import type { CodexProviderGuardianOptions } from "./codex-provider-guardian.js";
import {
	CodexContainmentTerminationError,
	type CodexSandboxContainment,
	type CodexWorkspaceAccess,
} from "./codex-sandbox-contract.js";
import { writeDurableJson } from "./durable-file.js";
import type { RuntimeAuthorityEvidence, RuntimeAuthorityGrant } from "./runtime-authority.js";
import { authorityGrant } from "./runtime-authority.test-support.js";
import { RUNTIME_CONTAINMENT_BACKEND } from "./runtime-containment-manifest.js";
import { workspaceResourceSha256 } from "./workspace-resource.js";

const IDS = {
	capsule: "10000000-0000-4000-8000-000000000001",
	mission: "97000000-0000-4000-8000-000000000005",
	agent: "97000000-0000-4000-8000-000000000002",
	containment: "10000000-0000-4000-8000-000000000004",
} as const;

const temporaryDirectories: string[] = [];
const cleanupFds = new Set<number>();
const run = promisify(execFile);

afterEach(async () => {
	vi.useRealTimers();
	for (const fd of cleanupFds) await closeFd(fd).catch(() => undefined);
	cleanupFds.clear();
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("CodexCapsuleRuntimeController", () => {
	it("opens only passive state before authority activation", async () => {
		const fixture = await createFixture();

		expect(await fixture.controller.probe()).toMatchObject({ name: "capsule-codex" });
		expect(await fixture.controller.ensureSession(fixture.descriptor.session)).toMatchObject({
			...fixture.descriptor.session,
			sessionId: expect.stringMatching(/^capsule-session-/),
		});
		await expect(fixture.controller.lookupTurn(randomUUID(), 1)).resolves.toBeNull();
		expect(fixture.recoveryCalls).toBe(0);
		expect(fixture.guardianOptions).toHaveLength(0);
		expect(fixture.runnerOptions).toHaveLength(0);

		await fixture.controller.close();
	});

	it("retires and destroys an inherited credential when authority is never installed", async () => {
		const channel = await openFifo();
		vi.useFakeTimers();
		const fixture = await createFixture({
			ownerCredentialChannel: {
				fd: channel.reader,
				testOnlyActivationTimeoutMs: 100,
			},
		});

		await vi.advanceTimersByTimeAsync(100);

		expect(fixture.retireCalls).toBe(1);
		expectFdClosed(channel.reader);
		await fixture.controller.close();
		await closeTrackedFd(channel.writer);
	});

	it("expires after server authority install when no runtime operation starts", async () => {
		const channel = await openFifo();
		const directory = await temporaryDirectory();
		const descriptor = codexDescriptor(directory, randomUUID());
		await writeDurableJson(join(directory, CAPSULE_DESCRIPTOR_FILE), descriptor);
		let recoveryCalls = 0;
		const server = await startConfiguredCapsuleServer(directory, {
			codex: {
				ownerCredentialChannel: {
					fd: channel.reader,
					testOnlyActivationTimeoutMs: 1_000,
				},
				recoverContainment: async () => {
					recoveryCalls += 1;
					throw new Error("runtime activation must not start");
				},
			},
		});
		try {
			const grant = authorityGrant({
				agent_id: descriptor.session.participantId,
				mission_id: descriptor.session.missionId,
				workspace_alias: descriptor.session.workspaceAlias,
				lease_expires_at: "2099-08-17T00:01:00.000Z",
				hard_expires_at: "2099-08-17T00:05:00.000Z",
			});
			await expect(
				capsuleResultValue(
					{
						capsuleId: descriptor.capsule_id,
						capabilityToken: descriptor.capability_token,
						socketPath: descriptor.socket_path,
					},
					"install_authority",
					{
						grant,
						current_lease: {
							grant_id: grant.grant_id,
							lease_id: grant.lease_id,
							fencing_token: grant.fencing_token,
							lease_expires_at: grant.lease_expires_at,
						},
					},
				),
			).resolves.toEqual({});

			await server.waitUntilClosed();

			expectFdClosed(channel.reader);
			expect(recoveryCalls).toBe(0);
		} finally {
			await server.close().catch(() => undefined);
			if (cleanupFds.has(channel.writer)) await closeTrackedFd(channel.writer);
		}
	});

	it("retires a schema-v2 write Capsule before credential or provider activation", async () => {
		const channel = await openFifo();
		const directory = await temporaryDirectory();
		const descriptor = codexDescriptor(directory, randomUUID());
		await writeDurableJson(join(directory, CAPSULE_DESCRIPTOR_FILE), descriptor);
		const containment = recoveredContainment(directory, descriptor, "b".repeat(64), "write");
		const workspaceResource = workspaceResourceSha256({
			workspaceBindingId: "97000000-0000-4000-8000-000000000004",
			workspaceAlias: descriptor.session.workspaceAlias,
			root: containment.authorization.workspace.root,
			repositoryUrl: containment.authorization.workspace.repositoryUrl,
			headCommit: containment.authorization.workspace.headCommit,
			reachableFromRef: containment.authorization.workspace.reachableFromRef,
		});
		const grant = authorityGrant({
			agent_id: descriptor.session.participantId,
			mission_id: descriptor.session.missionId,
			workspace_alias: descriptor.session.workspaceAlias,
			workspace_resource_sha256: workspaceResource,
			lease_expires_at: "2099-08-17T00:01:00.000Z",
			hard_expires_at: "2099-08-17T00:05:00.000Z",
			capabilities: fixtureCapabilities("write"),
		});
		let recoveryCalls = 0;
		let guardianCalls = 0;
		let runnerCalls = 0;
		const server = await startConfiguredCapsuleServer(directory, {
			codex: {
				ownerCredentialChannel: {
					fd: channel.reader,
					testOnlyActivationTimeoutMs: 10_000,
				},
				recoverContainment: async (expectation) => {
					recoveryCalls += 1;
					expect(expectation).toEqual(descriptor.runtime.containment);
					return containment;
				},
				createGuardian: () => {
					guardianCalls += 1;
					throw new Error("guardian activation must not start");
				},
				openRunner: async () => {
					runnerCalls += 1;
					throw new Error("provider activation must not start");
				},
			},
		});
		const identity = {
			capsuleId: descriptor.capsule_id,
			capabilityToken: descriptor.capability_token,
			socketPath: descriptor.socket_path,
		};
		try {
			await capsuleResultValue(identity, "install_authority", {
				grant,
				current_lease: {
					grant_id: grant.grant_id,
					lease_id: grant.lease_id,
					fencing_token: grant.fencing_token,
					lease_expires_at: grant.lease_expires_at,
				},
			});
			const session = (await capsuleResultValue(identity, "ensure_session", {
				input: descriptor.session,
			})) as HostSessionRef;

			const frames = await sendCapsuleRequest(identity, "start_turn", {
				input: serverTurnInput(session, grant),
			});

			expect(frames).toEqual([
				expect.objectContaining({
					kind: "error",
					code: "internal",
					message: "Capsule runtime failed",
				}),
			]);
			await server.waitUntilClosed();
			expect(recoveryCalls).toBe(1);
			expect(guardianCalls).toBe(0);
			expect(runnerCalls).toBe(0);
			expectFdClosed(channel.reader);
		} finally {
			await server.close().catch(() => undefined);
			if (cleanupFds.has(channel.writer)) await closeTrackedFd(channel.writer);
		}
	});

	it("rejects simultaneous injected and inherited credential sources", async () => {
		const directory = await temporaryDirectory();
		const descriptor = codexDescriptor(directory);

		await expect(
			CodexCapsuleRuntimeController.open({
				directory,
				descriptor,
				lifecycle: { retire: () => undefined },
				dependencies: {
					claimOwnerCredential: async () => createFakeCodexOwnerCredential("injected-owner"),
					ownerCredentialChannel: { fd: -1 },
				},
			}),
		).rejects.toThrow("multiple configured sources");
	});

	it("preserves an inherited channel close-proof failure during controller shutdown", async () => {
		const channel = await openFifo();
		const fixture = await createFixture({
			ownerCredentialChannel: {
				fd: channel.reader,
				testOnlyActivationTimeoutMs: 1_000,
			},
		});
		await closeTrackedFd(channel.reader);

		await expect(fixture.controller.close()).rejects.toMatchObject({
			name: "CodexOwnerCredentialError",
			reason: "channel",
		});
		expect(fixture.retireCalls).toBe(0);
		await closeTrackedFd(channel.writer);
	});

	it("leaves an inherited channel untouched for a validated schema-v1 fake descriptor", async () => {
		const channel = await openFifo();
		const directory = await temporaryDirectory();
		let retireCalls = 0;
		await writeDurableJson(join(directory, CAPSULE_DESCRIPTOR_FILE), fakeDescriptor());
		vi.useFakeTimers();
		const controller = await openCapsuleRuntimeController(
			directory,
			fakeDescriptor(),
			{
				retire: () => {
					retireCalls += 1;
				},
			},
			{
				codex: {
					ownerCredentialChannel: {
						fd: channel.reader,
						testOnlyActivationTimeoutMs: 100,
					},
				},
			},
		);

		await vi.advanceTimersByTimeAsync(100);
		await controller.close();

		expect(retireCalls).toBe(0);
		expect(() => fstatSync(channel.reader)).not.toThrow();
		await closeTrackedFd(channel.reader);
		await closeTrackedFd(channel.writer);
	});

	it("guards exact recovery and provider activation with workspace-read authority", async () => {
		const evidence: RuntimeAuthorityEvidence[] = [];
		const fixture = await createFixture();
		const grant = fixture.grant;
		const authority = installedAuthority(grant, evidence);
		const activationSignals: AbortSignal[] = [];

		const first = authority.performSession(fixture.descriptor.session, (activation) => {
			activationSignals.push(activation.signal);
			return fixture.controller.activate(activation);
		});
		const second = authority.performSession(fixture.descriptor.session, (activation) => {
			activationSignals.push(activation.signal);
			return fixture.controller.activate(activation);
		});
		const [firstRuntime, secondRuntime] = await Promise.all([first, second]);

		expect(firstRuntime).toBe(secondRuntime);
		expect(fixture.recoveryCalls).toBe(1);
		expect(fixture.recoverySignals).toEqual([activationSignals[0]]);
		expect(fixture.guardianOptions).toHaveLength(1);
		expect(fixture.runnerOptions).toHaveLength(1);
		const guardian = fixture.guardianOptions[0]!;
		expect(guardian.authoritySignal).toBe(activationSignals[0]);
		expect(guardian.claimOwnerCredential).toBe(fixture.claimOwnerCredential);
		expect(guardian.deadlineAtMs).toBe(Date.parse(grant.hard_expires_at));
		expect(guardian.command.executable).toBe(fixture.containment.authorization.providerExecutable);
		expect(guardian.cwd).toBe(fixture.containment.authorization.workspace.root);
		expect(guardian.capsuleDirectory).toBe(fixture.containment.authorization.runtimeDirectory);
		expect(guardian.env).not.toHaveProperty("OPENAI_API_KEY");
		expect(evidence.filter((item) => item.action === "workspace_read")).toHaveLength(1);
		expect(evidence.find((item) => item.action === "workspace_read")).toMatchObject({
			decision: "allow",
			code: "allowed",
		});

		await fixture.controller.close();
		authority.dispose();
		expect(fixture.runtime.closeCalls).toBe(1);
	});

	it("attests granted write containment but stops before every provider activation side effect", async () => {
		const evidence: RuntimeAuthorityEvidence[] = [];
		const fixture = await createFixture({ workspaceAccess: "write" });
		const authority = installedAuthority(fixture.grant, evidence);

		await expect(
			authority.performSession(fixture.descriptor.session, (activation) =>
				fixture.controller.activate(activation),
			),
		).rejects.toMatchObject({
			name: CodexWorkspaceWriteActivationNotEnabledError.name,
			code: "workspace_write_activation_not_enabled",
		});

		expect(fixture.recoveryCalls).toBe(1);
		expect(fixture.guardianOptions).toHaveLength(0);
		expect(fixture.runnerOptions).toHaveLength(0);
		expect(fixture.ownerCredentialClaimCalls).toBe(0);
		expect(fixture.guardianOpenCalls).toBe(0);
		expect(fixture.providerLaunchCalls).toBe(0);
		expect(evidence.filter((item) => item.decision === "allow")).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ action: "workspace_read" }),
				expect.objectContaining({ action: "workspace_write" }),
			]),
		);

		await fixture.controller.close();
		authority.dispose();
	});

	it("rejects read containment recovered for a write grant before guardian construction", async () => {
		const fixture = await createFixture({
			workspaceAccess: "write",
			containmentMismatch: "workspace_access",
		});
		const authority = installedAuthority(fixture.grant);

		await expect(
			authority.performSession(fixture.descriptor.session, (activation) =>
				fixture.controller.activate(activation),
			),
		).rejects.toThrow("granted workspace access");

		expect(fixture.recoveryCalls).toBe(1);
		expect(fixture.guardianOptions).toHaveLength(0);
		expect(fixture.runnerOptions).toHaveLength(0);
		expect(fixture.ownerCredentialClaimCalls).toBe(0);

		await fixture.controller.close();
		authority.dispose();
	});

	it("fails closed with the unavailable default credential before provider launch", async () => {
		const fixture = await createFixture({
			exerciseGuardianClaim: true,
			useDefaultOwnerCredential: true,
		});
		const authority = installedAuthority(fixture.grant);

		await expect(
			authority.performSession(fixture.descriptor.session, (activation) =>
				fixture.controller.activate(activation),
			),
		).rejects.toMatchObject({
			name: "CodexOwnerCredentialError",
			reason: "unavailable",
		});
		expect(fixture.guardianOpenCalls).toBe(1);
		expect(fixture.providerLaunchCalls).toBe(0);
		expect(fixture.runtime.closeCalls).toBe(0);

		await fixture.controller.close();
		authority.dispose();
	});

	it("aborts and awaits an inherited credential read before waiting on activation", async () => {
		const channel = await openFifo();
		const fixture = await createFixture({
			exerciseGuardianClaim: true,
			ownerCredentialChannel: {
				fd: channel.reader,
				testOnlyActivationTimeoutMs: 1_000,
			},
		});
		const authority = installedAuthority(fixture.grant);
		const activation = authority.performSession(fixture.descriptor.session, (runtimeAuthority) =>
			fixture.controller.activate(runtimeAuthority),
		);
		await vi.waitFor(() => expect(fixture.guardianOpenCalls).toBe(1));
		const activationFailure = expect(activation).rejects.toMatchObject({ reason: "cancelled" });

		const closing = fixture.controller.close();
		await closeTrackedFd(channel.writer);

		await activationFailure;
		await expect(closing).resolves.toBeUndefined();
		expectFdClosed(channel.reader);
		expect(fixture.retireCalls).toBe(1);
		expect(fixture.providerLaunchCalls).toBe(0);
		authority.dispose();
	});

	it("denies a missing workspace-read capability before containment recovery", async () => {
		const evidence: RuntimeAuthorityEvidence[] = [];
		const fixture = await createFixture({
			grantOverrides: {
				capabilities: fixtureCapabilities().filter(
					(capability) => capability.action !== "workspace_read",
				),
			},
		});
		const authority = installedAuthority(fixture.grant, evidence);

		await expect(
			authority.performSession(fixture.descriptor.session, (activation) =>
				fixture.controller.activate(activation),
			),
		).rejects.toMatchObject({ code: "capability_missing" });
		expect(fixture.recoveryCalls).toBe(0);
		expect(fixture.guardianOptions).toHaveLength(0);
		expect(evidence.find((item) => item.action === "workspace_read")).toMatchObject({
			decision: "deny",
			code: "capability_missing",
		});

		await fixture.controller.close();
		authority.dispose();
	});

	it("preserves the authority abort reason before recovery", async () => {
		const fixture = await createFixture();
		const abort = new AbortController();
		abort.abort("expired");

		await expect(
			fixture.controller.activate({
				grant: fixture.grant,
				signal: abort.signal,
				performWorkspaceRead: async (effect) => effect(),
				performWorkspaceWrite: async (effect) => effect(),
			}),
		).rejects.toMatchObject({ code: "expired" });
		expect(fixture.recoveryCalls).toBe(0);

		await fixture.controller.close();
	});

	it("rejects a recovered binding mismatch before guardian construction", async () => {
		const fixture = await createFixture({ containmentPolicySha256: "d".repeat(64) });
		const authority = installedAuthority(fixture.grant);

		await expect(
			authority.performSession(fixture.descriptor.session, (activation) =>
				fixture.controller.activate(activation),
			),
		).rejects.toMatchObject({ code: "policy_changed" });
		expect(fixture.recoveryCalls).toBe(1);
		expect(fixture.guardianOptions).toHaveLength(0);

		await fixture.controller.close();
		authority.dispose();
	});

	it("rejects a descriptor session mismatch before containment recovery", async () => {
		const fixture = await createFixture({
			grantOverrides: { mission_id: "97000000-0000-4000-8000-000000000099" },
		});
		const authority = installedAuthority(fixture.grant);

		await expect(
			authority.performSession(
				{ ...fixture.descriptor.session, missionId: fixture.grant.mission_id },
				(activation) => fixture.controller.activate(activation),
			),
		).rejects.toMatchObject({ code: "wrong_mission" });
		expect(fixture.recoveryCalls).toBe(0);
		expect(fixture.guardianOptions).toHaveLength(0);

		await fixture.controller.close();
		authority.dispose();
	});

	it("rejects a workspace resource mismatch before guardian construction", async () => {
		const fixture = await createFixture({
			grantOverrides: { workspace_resource_sha256: "e".repeat(64) },
		});
		const authority = installedAuthority(fixture.grant);

		await expect(
			authority.performSession(fixture.descriptor.session, (activation) =>
				fixture.controller.activate(activation),
			),
		).rejects.toMatchObject({ code: "wrong_resource" });
		expect(fixture.guardianOptions).toHaveLength(0);

		await fixture.controller.close();
		authority.dispose();
	});

	it.each([
		["runtime version", "runtime_version", /unsupported Codex runtime/],
		["control directory", "control_directory", /Capsule control directory/],
		["workspace access", "workspace_access", /granted workspace access/],
	] as const)(
		"rejects a recovered %s mismatch before guardian construction",
		async (_name, mismatch, expected) => {
			const fixture = await createFixture({ containmentMismatch: mismatch });
			const authority = installedAuthority(fixture.grant);

			await expect(
				authority.performSession(fixture.descriptor.session, (activation) =>
					fixture.controller.activate(activation),
				),
			).rejects.toThrow(expected);
			expect(fixture.guardianOptions).toHaveLength(0);

			await fixture.controller.close();
			authority.dispose();
		},
	);

	it("does not construct a guardian when authority is revoked during recovery", async () => {
		const recoveryGate = deferred<void>();
		const fixture = await createFixture({ recoveryGate });
		const authority = installedAuthority(fixture.grant);
		let activationSignal: AbortSignal | null = null;
		const activation = authority.performSession(fixture.descriptor.session, (runtimeAuthority) => {
			activationSignal = runtimeAuthority.signal;
			return fixture.controller.activate(runtimeAuthority);
		});
		await fixture.recoveryStarted.promise;

		authority.dispose();
		recoveryGate.resolve();
		await expect(activation).rejects.toMatchObject({ code: "revoked" });
		expect(activationSignal?.aborted).toBe(true);
		expect(fixture.guardianOptions).toHaveLength(0);

		await fixture.controller.close();
	});

	it("does not mask an unproven recovery teardown as an authority denial", async () => {
		const terminationFailure = new CodexContainmentTerminationError();
		let revoke = () => undefined;
		const fixture = await createFixture({
			recoveryFailure: terminationFailure,
			beforeRecoveryFailure: () => revoke(),
		});
		const authority = installedAuthority(fixture.grant);
		revoke = () => authority.dispose();

		await expect(
			authority.performSession(fixture.descriptor.session, (activation) =>
				fixture.controller.activate(activation),
			),
		).rejects.toBe(terminationFailure);
		expect(fixture.guardianOptions).toHaveLength(0);

		await fixture.controller.close();
	});

	it("fences an in-flight recovery when the controller closes", async () => {
		const recoveryGate = deferred<void>();
		const fixture = await createFixture({ recoveryGate });
		const authority = installedAuthority(fixture.grant);
		const activation = authority.performSession(fixture.descriptor.session, (runtimeAuthority) =>
			fixture.controller.activate(runtimeAuthority),
		);
		await fixture.recoveryStarted.promise;

		const closing = fixture.controller.close();
		recoveryGate.resolve();
		await expect(activation).rejects.toThrow("Codex Capsule controller is closed");
		await closing;
		expect(fixture.guardianOptions).toHaveLength(0);
		expect(fixture.runtime.closeCalls).toBe(0);

		authority.dispose();
	});

	it("does not hide an activation rollback whose runtime teardown failed", async () => {
		const runnerGate = deferred<void>();
		const fixture = await createFixture({ runnerGate });
		fixture.runtime.closeFailure = new Error("runtime close failed");
		const authority = installedAuthority(fixture.grant);
		const activation = authority.performSession(fixture.descriptor.session, (runtimeAuthority) =>
			fixture.controller.activate(runtimeAuthority),
		);
		await fixture.runnerStarted.promise;

		authority.dispose();
		runnerGate.resolve();
		await expect(activation).rejects.toThrow(
			"Codex runtime activation teardown could not be proven",
		);
		await expect(fixture.controller.close()).rejects.toThrow(
			"Codex runtime activation teardown could not be proven",
		);
		expect(fixture.runtime.closeCalls).toBe(1);
	});
});

interface FixtureOptions {
	readonly workspaceAccess?: CodexWorkspaceAccess;
	readonly containmentPolicySha256?: string;
	readonly containmentMismatch?: "runtime_version" | "control_directory" | "workspace_access";
	readonly grantOverrides?: Parameters<typeof authorityGrant>[0];
	readonly beforeRecoveryFailure?: () => void;
	readonly recoveryFailure?: Error;
	readonly recoveryGate?: Deferred<void>;
	readonly runnerGate?: Deferred<void>;
	readonly exerciseGuardianClaim?: boolean;
	readonly useDefaultOwnerCredential?: boolean;
	readonly ownerCredentialChannel?: InheritedCodexOwnerCredentialChannel;
}

async function createFixture(options: FixtureOptions = {}) {
	const directory = await temporaryDirectory();
	const descriptor = codexDescriptor(directory);
	const workspaceAccess = options.workspaceAccess ?? "read";
	const baseContainment = recoveredContainment(
		directory,
		descriptor,
		options.containmentPolicySha256 ?? "b".repeat(64),
		workspaceAccess,
	);
	const containment = containmentWithMismatch(
		baseContainment,
		directory,
		options.containmentMismatch,
	);
	const workspaceResource = workspaceResourceSha256({
		workspaceBindingId: "97000000-0000-4000-8000-000000000004",
		workspaceAlias: descriptor.session.workspaceAlias,
		root: containment.authorization.workspace.root,
		repositoryUrl: containment.authorization.workspace.repositoryUrl,
		headCommit: containment.authorization.workspace.headCommit,
		reachableFromRef: containment.authorization.workspace.reachableFromRef,
	});
	const grant = authorityGrant({
		agent_id: descriptor.session.participantId,
		mission_id: descriptor.session.missionId,
		workspace_alias: descriptor.session.workspaceAlias,
		workspace_resource_sha256: workspaceResource,
		lease_expires_at: "2099-08-17T00:01:00.000Z",
		hard_expires_at: "2099-08-17T00:05:00.000Z",
		capabilities: fixtureCapabilities(workspaceAccess),
		...options.grantOverrides,
	});
	const guardianOptions: CodexProviderGuardianOptions[] = [];
	const runnerOptions: CodexCapsuleRunnerOptions[] = [];
	const runtime = new RecordingRuntime();
	const recoveryStarted = deferred<void>();
	const runnerStarted = deferred<void>();
	const recoverySignals: AbortSignal[] = [];
	let ownerCredentialClaimCalls = 0;
	const claimOwnerCredential = async (_signal: AbortSignal) => {
		ownerCredentialClaimCalls += 1;
		return createFakeCodexOwnerCredential("capsule-runtime-owner");
	};
	let recoveryCalls = 0;
	let guardianOpenCalls = 0;
	let providerLaunchCalls = 0;
	let retireCalls = 0;
	const controller = await CodexCapsuleRuntimeController.open({
		directory,
		descriptor,
		lifecycle: {
			retire: () => {
				retireCalls += 1;
			},
		},
		dependencies: {
			...(options.ownerCredentialChannel === undefined
				? options.useDefaultOwnerCredential
					? {}
					: { claimOwnerCredential }
				: { ownerCredentialChannel: options.ownerCredentialChannel }),
			environment: {
				PATH: "/usr/bin",
				OPENAI_API_KEY: "must-not-cross",
				AGENTRELAY_NODE_TOKEN: "must-not-cross",
			},
			recoverContainment: async (expectation, signal) => {
				recoveryCalls += 1;
				recoverySignals.push(signal);
				recoveryStarted.resolve();
				expect(expectation).toEqual(descriptor.runtime.containment);
				await waitForGateOrAbort(options.recoveryGate?.promise ?? null, signal);
				options.beforeRecoveryFailure?.();
				if (options.recoveryFailure !== undefined) throw options.recoveryFailure;
				return containment;
			},
			createGuardian: (guardian) => {
				guardianOptions.push(guardian);
				return {
					openGeneration: async () => {
						guardianOpenCalls += 1;
						if (!options.exerciseGuardianClaim) throw new Error("runner is injected");
						await guardian.claimOwnerCredential(guardian.authoritySignal);
						providerLaunchCalls += 1;
						throw new Error("provider launch was reached");
					},
				};
			},
			openRunner: async (runner) => {
				runnerOptions.push(runner);
				runnerStarted.resolve();
				if (options.exerciseGuardianClaim) await runner.guardian.openGeneration();
				await options.runnerGate?.promise;
				return runtime;
			},
		},
	});
	return {
		controller,
		descriptor,
		containment,
		grant,
		guardianOptions,
		runnerOptions,
		claimOwnerCredential,
		runtime,
		recoveryStarted,
		recoverySignals,
		runnerStarted,
		get recoveryCalls() {
			return recoveryCalls;
		},
		get guardianOpenCalls() {
			return guardianOpenCalls;
		},
		get providerLaunchCalls() {
			return providerLaunchCalls;
		},
		get ownerCredentialClaimCalls() {
			return ownerCredentialClaimCalls;
		},
		get retireCalls() {
			return retireCalls;
		},
	};
}

function installedAuthority(
	grant: RuntimeAuthorityGrant,
	evidence: RuntimeAuthorityEvidence[] = [],
): CapsuleAuthority {
	const authority = new CapsuleAuthority({
		evidenceSink: { record: (item) => evidence.push(item) },
		retire: () => undefined,
	});
	authority.install(grant, {
		grant_id: grant.grant_id,
		lease_id: grant.lease_id,
		fencing_token: grant.fencing_token,
		lease_expires_at: grant.lease_expires_at,
	});
	return authority;
}

function serverTurnInput(session: HostSessionRef, grant: RuntimeAuthorityGrant): StartTurnInput {
	return {
		session,
		missionId: grant.mission_id,
		deliveryId: grant.delivery_id,
		executionAttempt: grant.execution_attempt,
		contractVersion: 1,
		missionSequence: 2,
		objective: {
			text: "Build compatible backend and client changes.",
			authorPrincipalId: grant.agent_id,
			provenance: "mission_manifest",
		},
		assignment: {
			text: "Analyze the backend contract.",
			authorPrincipalId: grant.agent_id,
			provenance: "mission_manifest",
		},
		acceptanceCriteria: [
			{
				text: "Return one compatible recommendation.",
				authorPrincipalId: grant.agent_id,
				provenance: "mission_manifest",
			},
		],
		peerMessages: [],
		artifacts: [],
	};
}

function codexDescriptor(directory: string, capsuleId = IDS.capsule): CodexCapsuleLaunchDescriptor {
	return codexCapsuleLaunchDescriptorSchema.parse({
		schema_version: 2,
		capsule_id: capsuleId,
		capability_token: `ar_capsule_${"a".repeat(64)}`,
		socket_path: capsuleSocketPath(capsuleId),
		session: {
			missionId: IDS.mission,
			participantId: IDS.agent,
			workspaceAlias: "backend",
		},
		runtime: {
			kind: "codex",
			runtime_contract: CODEX_CAPSULE_RUNTIME_CONTRACT,
			codex_cli_version: "0.146.0",
			containment: {
				manifestPath: join(directory, "containment.json"),
				instanceId: IDS.containment,
				bindingSha256: "c".repeat(64),
			},
		},
	});
}

function fakeDescriptor(): CapsuleLaunchDescriptor {
	return {
		schema_version: 1,
		capsule_id: IDS.capsule,
		capability_token: `ar_capsule_${"a".repeat(64)}`,
		socket_path: capsuleSocketPath(IDS.capsule),
		session: {
			missionId: IDS.mission,
			participantId: IDS.agent,
			workspaceAlias: "backend",
		},
		runtime: { kind: "fake", outcome: "ready", completion_delay_ms: 0 },
	};
}

function recoveredContainment(
	directory: string,
	descriptor: CodexCapsuleLaunchDescriptor,
	policyGrantSha256: string,
	workspaceAccess: CodexWorkspaceAccess = "read",
): CodexSandboxContainment {
	const runtimeDirectory = join(dirname(directory), `${basename(directory)}-runtime`);
	return {
		boundary: {
			prepare: async () => Promise.reject(new Error("provider must remain injected")),
		},
		evidence: {
			instanceId: descriptor.runtime.containment.instanceId,
			backend: RUNTIME_CONTAINMENT_BACKEND,
			runtimeVersion: "0.146.0",
			baseCommit: "1".repeat(40),
			bindingSha256: descriptor.runtime.containment.bindingSha256,
			retention: "retain_for_review",
		},
		authorization: {
			controlDirectory: directory,
			runtimeDirectory,
			providerExecutable: "/opt/agentrelay/codex",
			runtimeVersion: "0.146.0",
			policyGrantSha256,
			workspaceAccess,
			workspace: {
				root: "/work/backend",
				repositoryUrl: "https://example.com/backend.git",
				headCommit: "1".repeat(40),
				reachableFromRef: "refs/heads/main",
			},
		},
		recovery: descriptor.runtime.containment,
		runtimeHome: join(runtimeDirectory, "codex-home"),
		runtimeTmp: join(runtimeDirectory, "tmp"),
	};
}

function containmentWithMismatch(
	containment: CodexSandboxContainment,
	directory: string,
	mismatch: FixtureOptions["containmentMismatch"],
): CodexSandboxContainment {
	if (mismatch === undefined) return containment;
	if (mismatch === "control_directory") {
		return {
			...containment,
			authorization: {
				...containment.authorization,
				controlDirectory: join(directory, "other-control"),
			},
		};
	}
	if (mismatch === "workspace_access") {
		return {
			...containment,
			authorization: {
				...containment.authorization,
				workspaceAccess: containment.authorization.workspaceAccess === "read" ? "write" : "read",
			},
		};
	}
	return {
		...containment,
		authorization: {
			...containment.authorization,
			runtimeVersion: "0.147.0",
		},
	} as unknown as CodexSandboxContainment;
}

function fixtureCapabilities(workspaceAccess: CodexWorkspaceAccess = "read") {
	return [
		{ action: "runtime_start", resource: "runtime" },
		{ action: "runtime_recover", resource: "runtime" },
		{ action: "runtime_cancel", resource: "runtime" },
		{ action: "workspace_read", resource: "workspace" },
		...(workspaceAccess === "write"
			? ([{ action: "workspace_write", resource: "workspace" }] as const)
			: []),
		{ action: "usage_report", resource: "usage" },
		{ action: "artifact_publish", resource: "artifact" },
		{ action: "outbound_publish", resource: "relay" },
	] as const;
}

class RecordingRuntime implements CapsuleRuntime {
	closeCalls = 0;
	closeFailure: Error | null = null;

	async probe(): Promise<AdapterInfo> {
		return { name: "recording", version: "1", capabilities: {} } as AdapterInfo;
	}

	async ensureSession(input: SessionInput): Promise<HostSessionRef> {
		return { ...input, sessionId: "session" };
	}

	async lookupTurn(): Promise<HostTurnRef | null> {
		return null;
	}

	async *startTurn(_input: StartTurnInput): AsyncIterable<HostEvent> {}

	async *recoverTurn(_ref: HostTurnRef, _input: StartTurnInput): AsyncIterable<HostEvent> {}

	async cancelTurn(): Promise<void> {}

	async close(): Promise<void> {
		this.closeCalls += 1;
		if (this.closeFailure !== null) throw this.closeFailure;
	}
}

interface Deferred<T> {
	readonly promise: Promise<T>;
	resolve(value: T): void;
}

function deferred<T = void>(): Deferred<T> {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

async function waitForGateOrAbort(gate: Promise<void> | null, signal: AbortSignal): Promise<void> {
	signal.throwIfAborted();
	if (gate === null) return;
	let rejectAborted!: (reason?: unknown) => void;
	const aborted = new Promise<never>((_resolve, reject) => {
		rejectAborted = reject;
	});
	const onAbort = () => rejectAborted(signal.reason);
	signal.addEventListener("abort", onAbort, { once: true });
	try {
		if (signal.aborted) onAbort();
		await Promise.race([gate, aborted]);
		signal.throwIfAborted();
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}

async function temporaryDirectory(): Promise<string> {
	const path = await realpath(await mkdtemp("/tmp/agentrelay-codex-controller-"));
	temporaryDirectories.push(path);
	return path;
}

async function openFifo(): Promise<{ reader: number; writer: number }> {
	const directory = await temporaryDirectory();
	const path = join(directory, "credential.pipe");
	await run("mkfifo", [path]);
	const [reader, writer] = await Promise.all([
		openFd(path, constants.O_RDONLY),
		openFd(path, constants.O_WRONLY),
	]);
	cleanupFds.add(reader);
	cleanupFds.add(writer);
	return { reader, writer };
}

function openFd(path: PathLike, flags: number): Promise<number> {
	return new Promise((resolve, reject) => {
		open(path, flags, (error, fd) => (error ? reject(error) : resolve(fd)));
	});
}

function closeFd(fd: number): Promise<void> {
	return new Promise((resolve, reject) => {
		close(fd, (error) => (error ? reject(error) : resolve()));
	});
}

async function closeTrackedFd(fd: number): Promise<void> {
	await closeFd(fd);
	cleanupFds.delete(fd);
}

function expectFdClosed(fd: number): void {
	let error: unknown;
	try {
		fstatSync(fd);
	} catch (caught) {
		error = caught;
	}
	expect(error).toMatchObject({ code: "EBADF" });
	cleanupFds.delete(fd);
}
