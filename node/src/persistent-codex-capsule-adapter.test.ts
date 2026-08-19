import { mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	CAPSULE_DESCRIPTOR_FILE,
	CODEX_CAPSULE_RUNTIME_CONTRACT,
	type CodexCapsuleLaunchDescriptor,
	capsuleSocketPath,
	codexCapsuleLaunchDescriptorSchema,
	fakeCapsuleLaunchDescriptorSchema,
} from "./capsule-launch-descriptor.js";
import { CAPSULE_ADAPTER_INFO } from "./capsule-protocol.js";
import { startConfiguredCapsuleServer } from "./capsule-runtime-factory.js";
import type { CapsuleRuntimeController } from "./capsule-runtime.js";
import { ensurePrivateCapsuleDirectory } from "./capsule-server-io.js";
import type { PersistentCapsuleServer } from "./capsule-server.js";
import { CODEX_CAPSULE_ADAPTER_INFO } from "./codex-capsule-runner-contract.js";
import { CODEX_SANDBOX_MANIFEST_FILE } from "./codex-sandbox-contract.js";
import { writeDurableJson } from "./durable-file.js";
import type { CapsuleLauncher } from "./persistent-capsule-adapter.js";
import { PersistentCodexCapsuleAdapter } from "./persistent-codex-capsule-adapter.js";
import { type RuntimeAuthorityGrant, runtimeAuthorityRequest } from "./runtime-authority.js";
import { authorityGrant } from "./runtime-authority.test-support.js";

const IDS = {
	mission: "10000000-0000-4000-8000-000000000001",
	participant: "10000000-0000-4000-8000-000000000002",
	delivery: "10000000-0000-4000-8000-000000000003",
	containment: "10000000-0000-4000-8000-000000000004",
	otherParticipant: "10000000-0000-4000-8000-000000000005",
	otherMission: "10000000-0000-4000-8000-000000000006",
} as const;

const TEST_AUTHORITY = authorityGrant({
	agent_id: IDS.participant,
	mission_id: IDS.mission,
	delivery_id: IDS.delivery,
	workspace_alias: "backend-primary",
	lease_expires_at: "2099-01-01T00:01:00.000Z",
	hard_expires_at: "2099-01-01T00:05:00.000Z",
});

const temporaryDirectories: string[] = [];
const launchers: TestCapsuleLauncher[] = [];

afterEach(async () => {
	await Promise.all(launchers.splice(0).map((launcher) => launcher.closeAll()));
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("PersistentCodexCapsuleAdapter", () => {
	it("reports static Codex capability without a descriptor, Capsule, or provider", async () => {
		const rootDirectory = await temporaryDirectory();
		const launcher = testLauncher();
		const adapter = await openAdapter(rootDirectory, launcher);

		expect(await adapter.probe()).toEqual(CODEX_CAPSULE_ADAPTER_INFO);
		await expect(adapter.lookupTurn(IDS.delivery, 1)).resolves.toBeNull();
		expect(launcher.startCalls).toBe(0);
		await expect(stat(join(rootDirectory, IDS.mission))).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("does not create a descriptor or Mission directory on failed install or uncached revoke", async () => {
		const rootDirectory = await temporaryDirectory();
		const launcher = testLauncher();
		const adapter = await openAdapter(rootDirectory, launcher);

		await expect(
			adapter.installAuthority(TEST_AUTHORITY, currentLease(TEST_AUTHORITY)),
		).rejects.toThrow(/Cannot open capsule file/);
		await expect(adapter.revokeAuthority(TEST_AUTHORITY, "revoked")).resolves.toBeUndefined();

		expect(launcher.startCalls).toBe(0);
		await expect(stat(join(rootDirectory, IDS.mission))).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("rejects a v1 descriptor without replacing, launching, or silently skipping it", async () => {
		const rootDirectory = await temporaryDirectory();
		const directory = missionDirectory(rootDirectory);
		const descriptor = fakeCapsuleLaunchDescriptorSchema.parse({
			schema_version: 1,
			capsule_id: IDS.containment,
			capability_token: `ar_capsule_${"a".repeat(64)}`,
			socket_path: capsuleSocketPath(IDS.containment),
			session: session(),
			runtime: { kind: "fake", outcome: "ready", completion_delay_ms: 0 },
		});
		const descriptorPath = await writeDescriptor(directory, descriptor);
		const before = await readFile(descriptorPath, "utf8");
		const launcher = testLauncher();
		const adapter = await openAdapter(rootDirectory, launcher);

		await expect(
			adapter.installAuthority(TEST_AUTHORITY, currentLease(TEST_AUTHORITY)),
		).rejects.toThrow(/does not select Codex/);
		await expect(adapter.revokeAuthority(TEST_AUTHORITY, "revoked")).rejects.toThrow(
			/does not select Codex/,
		);
		await expect(adapter.terminateAll()).rejects.toMatchObject({ name: "AggregateError" });

		expect(launcher.startCalls).toBe(0);
		expect(await readFile(descriptorPath, "utf8")).toBe(before);
	});

	it.each([
		["runtime contract", { runtime_contract: "agentrelay/codex-capsule/v1" }],
		["Codex CLI version", { codex_cli_version: "0.147.0" }],
	])("rejects a mismatched %s without repairing the descriptor", async (_name, runtimeOverride) => {
		const rootDirectory = await temporaryDirectory();
		const directory = missionDirectory(rootDirectory);
		const descriptor = codexDescriptor(directory);
		const descriptorPath = await writeDescriptor(directory, {
			...descriptor,
			runtime: { ...descriptor.runtime, ...runtimeOverride },
		});
		const before = await readFile(descriptorPath, "utf8");
		const launcher = testLauncher();
		const adapter = await openAdapter(rootDirectory, launcher);

		await expect(
			adapter.installAuthority(TEST_AUTHORITY, currentLease(TEST_AUTHORITY)),
		).rejects.toThrow();

		expect(launcher.startCalls).toBe(0);
		expect(await readFile(descriptorPath, "utf8")).toBe(before);
	});

	it.each([
		["Mission", { missionId: IDS.otherMission }],
		["participant", { participantId: IDS.otherParticipant }],
		["workspace", { workspaceAlias: "android-primary" }],
	])(
		"rejects a different %s scope before launching the provisioned Capsule",
		async (_name, scope) => {
			const rootDirectory = await temporaryDirectory();
			const directory = missionDirectory(rootDirectory);
			const descriptorPath = await writeDescriptor(
				directory,
				codexDescriptor(directory, {
					session: { ...session(), ...scope },
				}),
			);
			const before = await readFile(descriptorPath, "utf8");
			const launcher = testLauncher();
			const adapter = await openAdapter(rootDirectory, launcher);

			await expect(
				adapter.installAuthority(TEST_AUTHORITY, currentLease(TEST_AUTHORITY)),
			).rejects.toMatchObject({ code: "scope_mismatch" });

			expect(launcher.startCalls).toBe(0);
			expect(await readFile(descriptorPath, "utf8")).toBe(before);
		},
	);

	it("installs authority through a v2 Capsule without activating containment or a provider", async () => {
		const rootDirectory = await temporaryDirectory();
		const directory = missionDirectory(rootDirectory);
		const descriptorPath = await writeDescriptor(directory, codexDescriptor(directory));
		const before = await readFile(descriptorPath, "utf8");
		const activations = { containment: 0, guardian: 0, runner: 0 };
		const launcher = testLauncher((capsuleDirectory) =>
			startConfiguredCapsuleServer(capsuleDirectory, {
				codex: {
					recoverContainment: async () => {
						activations.containment += 1;
						throw new Error("containment activation was not expected");
					},
					createGuardian: () => {
						activations.guardian += 1;
						throw new Error("provider activation was not expected");
					},
					openRunner: async () => {
						activations.runner += 1;
						throw new Error("runner activation was not expected");
					},
				},
			}),
		);
		const adapter = await openAdapter(rootDirectory, launcher);

		await adapter.installAuthority(TEST_AUTHORITY, currentLease(TEST_AUTHORITY));
		await adapter.assertAuthority(
			runtimeAuthorityRequest(TEST_AUTHORITY, {
				action: "runtime_start",
				resource: "runtime",
			}),
		);
		expect(launcher.startCalls).toBe(1);
		expect(activations).toEqual({ containment: 0, guardian: 0, runner: 0 });

		const recovered = await openAdapter(rootDirectory, launcher);
		await recovered.revokeAuthority(TEST_AUTHORITY, "revoked");
		expect(launcher.startCalls).toBe(1);
		expect(await readFile(descriptorPath, "utf8")).toBe(before);
	});

	it("retires a prepublished but never-launched descriptor without launching it", async () => {
		const rootDirectory = await temporaryDirectory();
		const directory = missionDirectory(rootDirectory);
		const descriptorPath = await writeDescriptor(directory, codexDescriptor(directory));
		const before = await readFile(descriptorPath, "utf8");
		const launcher = testLauncher();
		const adapter = await openAdapter(rootDirectory, launcher);

		await expect(adapter.revokeAuthority(TEST_AUTHORITY, "revoked")).resolves.toBeUndefined();

		expect(launcher.startCalls).toBe(0);
		expect(await readFile(descriptorPath, "utf8")).toBe(before);
	});

	it("rejects an authenticated live Capsule with the wrong static adapter identity", async () => {
		const rootDirectory = await temporaryDirectory();
		const directory = missionDirectory(rootDirectory);
		const descriptor = codexDescriptor(directory);
		const descriptorPath = await writeDescriptor(directory, descriptor);
		const before = await readFile(descriptorPath, "utf8");
		const launcher = testLauncher(async () => {
			await ensurePrivateCapsuleDirectory(dirname(descriptor.socket_path));
			return PersistentCapsuleServerForTest.start(descriptor);
		});
		const adapter = await openAdapter(rootDirectory, launcher);

		await expect(
			adapter.installAuthority(TEST_AUTHORITY, currentLease(TEST_AUTHORITY)),
		).rejects.toMatchObject({
			code: "correlation_conflict",
			message: "Mission capsule reports an unsupported adapter identity",
		});

		expect(launcher.startCalls).toBe(1);
		expect((await stat(descriptor.socket_path)).isSocket()).toBe(true);
		expect(await readFile(descriptorPath, "utf8")).toBe(before);
	});
});

class TestCapsuleLauncher implements CapsuleLauncher {
	startCalls = 0;
	readonly #startServer?: (directory: string) => Promise<PersistentCapsuleServer>;
	readonly #servers = new Set<PersistentCapsuleServer>();

	constructor(startServer?: (directory: string) => Promise<PersistentCapsuleServer>) {
		this.#startServer = startServer;
	}

	async start(directory: string): Promise<void> {
		this.startCalls += 1;
		if (this.#startServer === undefined) throw new Error("Capsule launch was not expected");
		this.#servers.add(await this.#startServer(directory));
	}

	async closeAll(): Promise<void> {
		const servers = [...this.#servers];
		this.#servers.clear();
		await Promise.all(servers.map((server) => server.close().catch(() => undefined)));
	}
}

const PersistentCapsuleServerForTest = {
	async start(descriptor: CodexCapsuleLaunchDescriptor): Promise<PersistentCapsuleServer> {
		const { PersistentCapsuleServer } = await import("./capsule-server.js");
		return PersistentCapsuleServer.start({
			identity: {
				capsuleId: descriptor.capsule_id,
				capabilityToken: descriptor.capability_token,
				socketPath: descriptor.socket_path,
			},
			openController: async (): Promise<CapsuleRuntimeController> => ({
				async probe() {
					return structuredClone(CAPSULE_ADAPTER_INFO);
				},
				async ensureSession() {
					throw new Error("runtime session was not expected");
				},
				async lookupTurn() {
					return null;
				},
				async activate() {
					throw new Error("runtime activation was not expected");
				},
				async close() {},
			}),
		});
	},
};

function testLauncher(
	startServer?: (directory: string) => Promise<PersistentCapsuleServer>,
): TestCapsuleLauncher {
	const launcher = new TestCapsuleLauncher(startServer);
	launchers.push(launcher);
	return launcher;
}

function openAdapter(rootDirectory: string, launcher: CapsuleLauncher) {
	return PersistentCodexCapsuleAdapter.open({
		rootDirectory,
		launcher,
		startupTimeoutMs: 1_000,
	});
}

function codexDescriptor(
	directory: string,
	overrides: { readonly session?: ReturnType<typeof session> } = {},
): CodexCapsuleLaunchDescriptor {
	return codexCapsuleLaunchDescriptorSchema.parse({
		schema_version: 2,
		capsule_id: IDS.containment,
		capability_token: `ar_capsule_${"b".repeat(64)}`,
		socket_path: capsuleSocketPath(IDS.containment),
		session: overrides.session ?? session(),
		runtime: {
			kind: "codex",
			runtime_contract: CODEX_CAPSULE_RUNTIME_CONTRACT,
			codex_cli_version: "0.146.0",
			containment: {
				manifestPath: join(directory, CODEX_SANDBOX_MANIFEST_FILE),
				instanceId: IDS.containment,
				bindingSha256: "c".repeat(64),
			},
		},
	});
}

function session() {
	return {
		missionId: IDS.mission,
		participantId: IDS.participant,
		workspaceAlias: "backend-primary",
	};
}

function currentLease(grant: RuntimeAuthorityGrant) {
	return {
		grant_id: grant.grant_id,
		lease_id: grant.lease_id,
		fencing_token: grant.fencing_token,
		lease_expires_at: grant.lease_expires_at,
	};
}

async function writeDescriptor(directory: string, descriptor: unknown): Promise<string> {
	const path = join(directory, CAPSULE_DESCRIPTOR_FILE);
	await writeDurableJson(path, descriptor, { fileMode: 0o600, directoryMode: 0o700 });
	return path;
}

function missionDirectory(rootDirectory: string): string {
	return join(rootDirectory, IDS.mission);
}

async function temporaryDirectory(): Promise<string> {
	const path = await realpath(await mkdtemp(join(tmpdir(), "agentrelay-codex-adapter-")));
	temporaryDirectories.push(path);
	return path;
}
