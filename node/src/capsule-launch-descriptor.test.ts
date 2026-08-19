import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	CAPSULE_DESCRIPTOR_FILE,
	CODEX_CAPSULE_RUNTIME_CONTRACT,
	capsuleLaunchDescriptorSchema,
	capsuleSocketPath,
	codexCapsuleLaunchDescriptorSchema,
	fakeCapsuleLaunchDescriptorSchema,
	readCapsuleLaunchDescriptor,
	readCodexCapsuleLaunchDescriptor,
	readFakeCapsuleLaunchDescriptor,
} from "./capsule-launch-descriptor.js";
import { writeDurableJson } from "./durable-file.js";

const IDS = {
	capsule: "10000000-0000-4000-8000-000000000001",
	mission: "10000000-0000-4000-8000-000000000002",
	participant: "10000000-0000-4000-8000-000000000003",
	containment: "10000000-0000-4000-8000-000000000004",
} as const;

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("Capsule launch descriptors", () => {
	it("preserves the legacy v1 fake descriptor serialization exactly", () => {
		const descriptor = fakeCapsuleLaunchDescriptorSchema.parse({
			schema_version: 1,
			capsule_id: IDS.capsule,
			capability_token: `ar_capsule_${"a".repeat(64)}`,
			socket_path: "/tmp/ar-capsules-501/legacy.sock",
			session: {
				missionId: IDS.mission,
				participantId: IDS.participant,
				workspaceAlias: "backend-primary",
			},
			runtime: {
				kind: "fake",
				outcome: "reply",
				completion_delay_ms: 20,
			},
		});

		expect(`${JSON.stringify(descriptor, null, 2)}\n`).toBe(`{
  "schema_version": 1,
  "capsule_id": "10000000-0000-4000-8000-000000000001",
  "capability_token": "ar_capsule_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "socket_path": "/tmp/ar-capsules-501/legacy.sock",
  "session": {
    "missionId": "10000000-0000-4000-8000-000000000002",
    "participantId": "10000000-0000-4000-8000-000000000003",
    "workspaceAlias": "backend-primary"
  },
  "runtime": {
    "kind": "fake",
    "outcome": "reply",
    "completion_delay_ms": 20
  }
}
`);
		expect(capsuleLaunchDescriptorSchema.parse(descriptor)).toEqual(descriptor);
	});

	it("accepts only the pinned v2 Codex runtime and exact containment handle", () => {
		const descriptor = codexDescriptor();

		expect(codexCapsuleLaunchDescriptorSchema.parse(descriptor)).toEqual(descriptor);
		expect(capsuleLaunchDescriptorSchema.parse(descriptor)).toEqual(descriptor);
	});

	it.each([
		["unknown runtime contract", { runtime_contract: "agentrelay/codex-capsule/v2" }],
		["unsupported Codex CLI", { codex_cli_version: "0.147.0" }],
		["invented protocol version", { protocolVersion: "1" }],
	])("rejects an %s", (_name, runtimeOverride) => {
		const descriptor = codexDescriptor();

		expect(
			codexCapsuleLaunchDescriptorSchema.safeParse({
				...descriptor,
				runtime: { ...descriptor.runtime, ...runtimeOverride },
			}).success,
		).toBe(false);
	});

	it("rejects runtime and schema-version cross-pairing", () => {
		const codex = codexDescriptor();
		const fake = fakeCapsuleLaunchDescriptorSchema.parse({
			schema_version: 1,
			capsule_id: IDS.capsule,
			capability_token: `ar_capsule_${"d".repeat(64)}`,
			socket_path: "/tmp/ar-capsules-501/fake.sock",
			session: codex.session,
			runtime: { kind: "fake", outcome: "ready", completion_delay_ms: 0 },
		});

		expect(capsuleLaunchDescriptorSchema.safeParse({ ...codex, schema_version: 1 }).success).toBe(
			false,
		);
		expect(capsuleLaunchDescriptorSchema.safeParse({ ...fake, schema_version: 2 }).success).toBe(
			false,
		);
	});

	it.each([
		["relative manifest path", { manifestPath: "containment.json" }],
		["non-normalized manifest path", { manifestPath: "/tmp/runtime/../containment.json" }],
		["invalid instance ID", { instanceId: "not-a-uuid" }],
		["invalid binding digest", { bindingSha256: "A".repeat(64) }],
	])("rejects an %s", (_name, containmentOverride) => {
		const descriptor = codexDescriptor();

		expect(
			codexCapsuleLaunchDescriptorSchema.safeParse({
				...descriptor,
				runtime: {
					...descriptor.runtime,
					containment: { ...descriptor.runtime.containment, ...containmentOverride },
				},
			}).success,
		).toBe(false);
	});

	it("keeps the fake reader narrowed to legacy v1 descriptors", async () => {
		const directory = await temporaryDirectory();
		const descriptor = codexDescriptor({ socket_path: capsuleSocketPath(IDS.capsule) });
		await writeDurableJson(join(directory, CAPSULE_DESCRIPTOR_FILE), descriptor);

		await expect(readCapsuleLaunchDescriptor(directory)).resolves.toEqual(descriptor);
		await expect(readCodexCapsuleLaunchDescriptor(directory)).resolves.toEqual(descriptor);
		await expect(readFakeCapsuleLaunchDescriptor(directory)).rejects.toThrow(
			/Capsule launch descriptor does not select the fake runtime/,
		);
	});

	it("keeps the Codex reader narrowed to provisioned v2 descriptors", async () => {
		const directory = await temporaryDirectory();
		const descriptor = fakeCapsuleLaunchDescriptorSchema.parse({
			schema_version: 1,
			capsule_id: IDS.capsule,
			capability_token: `ar_capsule_${"d".repeat(64)}`,
			socket_path: capsuleSocketPath(IDS.capsule),
			session: codexDescriptor().session,
			runtime: { kind: "fake", outcome: "ready", completion_delay_ms: 0 },
		});
		await writeDurableJson(join(directory, CAPSULE_DESCRIPTOR_FILE), descriptor);

		await expect(readFakeCapsuleLaunchDescriptor(directory)).resolves.toEqual(descriptor);
		await expect(readCodexCapsuleLaunchDescriptor(directory)).rejects.toThrow(
			/Capsule launch descriptor does not select Codex/,
		);
	});
});

function codexDescriptor(overrides: { readonly socket_path?: string } = {}) {
	return {
		schema_version: 2 as const,
		capsule_id: IDS.capsule,
		capability_token: `ar_capsule_${"b".repeat(64)}`,
		socket_path: overrides.socket_path ?? "/tmp/ar-capsules-501/codex.sock",
		session: {
			missionId: IDS.mission,
			participantId: IDS.participant,
			workspaceAlias: "backend-primary",
		},
		runtime: {
			kind: "codex" as const,
			runtime_contract: CODEX_CAPSULE_RUNTIME_CONTRACT,
			codex_cli_version: "0.146.0" as const,
			containment: {
				manifestPath: "/tmp/agentrelay-capsule/containment.json",
				instanceId: IDS.containment,
				bindingSha256: "c".repeat(64),
			},
		},
	};
}

async function temporaryDirectory(): Promise<string> {
	const path = await realpath(await mkdtemp(join(tmpdir(), "agentrelay-descriptor-")));
	temporaryDirectories.push(path);
	return path;
}
