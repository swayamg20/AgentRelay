import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { capsuleResultValue } from "../test-support/capsule-wire-client.js";
import {
	CAPSULE_DESCRIPTOR_FILE,
	CODEX_CAPSULE_RUNTIME_CONTRACT,
	type CapsuleLaunchDescriptor,
	capsuleLaunchDescriptorSchema,
	capsuleSocketPath,
} from "./capsule-launch-descriptor.js";
import {
	openCapsuleRuntimeController,
	startConfiguredCapsuleServer,
} from "./capsule-runtime-factory.js";
import type { PersistentCapsuleServer } from "./capsule-server.js";
import { CodexCapsuleRuntimeController } from "./codex-capsule-runtime.js";
import { writeDurableJson } from "./durable-file.js";
import { FakeCapsuleRuntimeController } from "./fake-capsule-runtime.js";
import { authorityGrant } from "./runtime-authority.test-support.js";

const IDS = {
	capsule: "10000000-0000-4000-8000-000000000001",
	mission: "10000000-0000-4000-8000-000000000002",
	agent: "10000000-0000-4000-8000-000000000003",
	containment: "10000000-0000-4000-8000-000000000004",
} as const;

const temporaryDirectories: string[] = [];
const servers: PersistentCapsuleServer[] = [];

afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => server.close().catch(() => undefined)));
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("Capsule runtime factory", () => {
	it("dispatches schema v1 only to the legacy fake controller", async () => {
		const directory = await temporaryDirectory();
		const descriptor = fakeDescriptor();
		await writeDescriptor(directory, descriptor);

		const controller = await openCapsuleRuntimeController(
			directory,
			descriptor,
			{ retire: () => undefined },
			{
				codex: {
					recoverContainment: async () => Promise.reject(new Error("v1 must not select Codex")),
				},
			},
		);

		expect(controller).toBeInstanceOf(FakeCapsuleRuntimeController);
		await controller.close();
	});

	it("dispatches schema v2 to a passive Codex controller", async () => {
		const directory = await temporaryDirectory();
		const descriptor = codexDescriptor(directory);
		await writeDescriptor(directory, descriptor);
		let recoveryCalls = 0;

		const controller = await openCapsuleRuntimeController(
			directory,
			descriptor,
			{ retire: () => undefined },
			{
				codex: {
					recoverContainment: async () => {
						recoveryCalls += 1;
						throw new Error("recovery must wait for authority");
					},
				},
			},
		);

		expect(controller).toBeInstanceOf(CodexCapsuleRuntimeController);
		expect(await controller.probe()).toMatchObject({ name: "capsule-codex" });
		expect(recoveryCalls).toBe(0);
		await controller.close();
	});

	it("keeps a configured v2 server passive through probe, lookup, and authority install", async () => {
		const directory = await temporaryDirectory();
		const capsuleId = randomUUID();
		const descriptor = codexDescriptor(directory, capsuleId);
		await writeDescriptor(directory, descriptor);
		let recoveryCalls = 0;
		const server = await startConfiguredCapsuleServer(directory, {
			codex: {
				recoverContainment: async () => {
					recoveryCalls += 1;
					throw new Error("recovery must wait for an authorized runtime operation");
				},
			},
		});
		servers.push(server);
		const identity = {
			capsuleId,
			capabilityToken: descriptor.capability_token,
			socketPath: descriptor.socket_path,
		};
		const grant = authorityGrant({
			agent_id: descriptor.session.participantId,
			mission_id: descriptor.session.missionId,
			workspace_alias: descriptor.session.workspaceAlias,
			lease_expires_at: "2099-08-17T00:01:00.000Z",
			hard_expires_at: "2099-08-17T00:05:00.000Z",
		});

		expect(await capsuleResultValue(identity, "probe", {})).toMatchObject({
			name: "capsule-codex",
		});
		await expect(
			capsuleResultValue(identity, "lookup_turn", {
				delivery_id: grant.delivery_id,
				execution_attempt: grant.execution_attempt,
			}),
		).resolves.toBeNull();
		await expect(
			capsuleResultValue(identity, "install_authority", {
				grant,
				current_lease: {
					grant_id: grant.grant_id,
					lease_id: grant.lease_id,
					fencing_token: grant.fencing_token,
					lease_expires_at: grant.lease_expires_at,
				},
			}),
		).resolves.toEqual({});
		expect(recoveryCalls).toBe(0);
	});
});

function fakeDescriptor(): CapsuleLaunchDescriptor {
	return capsuleLaunchDescriptorSchema.parse({
		schema_version: 1,
		capsule_id: IDS.capsule,
		capability_token: `ar_capsule_${"a".repeat(64)}`,
		socket_path: capsuleSocketPath(IDS.capsule),
		session: session(),
		runtime: { kind: "fake", outcome: "reply", completion_delay_ms: 0 },
	});
}

function codexDescriptor(directory: string, capsuleId = IDS.capsule): CapsuleLaunchDescriptor {
	return capsuleLaunchDescriptorSchema.parse({
		schema_version: 2,
		capsule_id: capsuleId,
		capability_token: `ar_capsule_${"b".repeat(64)}`,
		socket_path: capsuleSocketPath(capsuleId),
		session: session(),
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

function session() {
	return {
		missionId: IDS.mission,
		participantId: IDS.agent,
		workspaceAlias: "backend",
	};
}

async function writeDescriptor(
	directory: string,
	descriptor: CapsuleLaunchDescriptor,
): Promise<void> {
	await writeDurableJson(join(directory, CAPSULE_DESCRIPTOR_FILE), descriptor);
}

async function temporaryDirectory(): Promise<string> {
	const path = await realpath(await mkdtemp("/tmp/agentrelay-runtime-factory-"));
	temporaryDirectories.push(path);
	return path;
}
