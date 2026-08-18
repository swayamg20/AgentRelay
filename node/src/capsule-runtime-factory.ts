import { dirname } from "node:path";
import {
	type CapsuleLaunchDescriptor,
	readCapsuleLaunchDescriptor,
} from "./capsule-launch-descriptor.js";
import type { CapsuleRuntimeController, CapsuleRuntimeLifecycle } from "./capsule-runtime.js";
import { ensurePrivateCapsuleDirectory } from "./capsule-server-io.js";
import { PersistentCapsuleServer } from "./capsule-server.js";
import {
	CodexCapsuleRuntimeController,
	type CodexCapsuleRuntimeDependencies,
} from "./codex-capsule-runtime.js";
import { FakeCapsuleRuntimeController } from "./fake-capsule-runtime.js";
import { FakeCapsuleStore } from "./fake-capsule-store.js";

export interface CapsuleRuntimeFactoryOptions {
	readonly codex?: CodexCapsuleRuntimeDependencies;
}

/** Opens only passive state for the runtime explicitly selected by the descriptor. */
export async function openCapsuleRuntimeController(
	directory: string,
	descriptor: CapsuleLaunchDescriptor,
	lifecycle: CapsuleRuntimeLifecycle,
	options: CapsuleRuntimeFactoryOptions = {},
): Promise<CapsuleRuntimeController> {
	if (descriptor.schema_version === 1) {
		return new FakeCapsuleRuntimeController(await FakeCapsuleStore.open(directory));
	}
	return CodexCapsuleRuntimeController.open({
		directory,
		descriptor,
		lifecycle,
		dependencies: options.codex,
	});
}

/** Starts one Capsule using the exact runtime selected in its private launch descriptor. */
export async function startConfiguredCapsuleServer(
	directory: string,
	options: CapsuleRuntimeFactoryOptions = {},
): Promise<PersistentCapsuleServer> {
	await ensurePrivateCapsuleDirectory(directory);
	const descriptor = await readCapsuleLaunchDescriptor(directory);
	await ensurePrivateCapsuleDirectory(dirname(descriptor.socket_path));
	return PersistentCapsuleServer.start({
		identity: {
			capsuleId: descriptor.capsule_id,
			capabilityToken: descriptor.capability_token,
			socketPath: descriptor.socket_path,
		},
		openController: (lifecycle) =>
			openCapsuleRuntimeController(directory, descriptor, lifecycle, options),
	});
}
