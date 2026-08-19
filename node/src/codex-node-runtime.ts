import { join } from "node:path";
import {
	CodexCapsuleProvisioner,
	type CodexContainmentProvisioningPort,
} from "./codex-capsule-provisioner.js";
import {
	type CodexRuntimeDoctorDependencies,
	runCodexRuntimeDoctor,
} from "./codex-runtime-doctor.js";
import type { CapsuleLauncher } from "./persistent-capsule-adapter.js";
import { PersistentCodexCapsuleAdapter } from "./persistent-codex-capsule-adapter.js";

export interface CodexNodeRuntimeOptions {
	readonly stateDirectory: string;
	readonly launcher: CapsuleLauncher;
	readonly signal?: AbortSignal;
}

export interface CodexNodeRuntimeDependencies {
	readonly doctor?: CodexRuntimeDoctorDependencies;
	readonly containment?: CodexContainmentProvisioningPort;
}

export interface CodexNodeRuntime {
	readonly adapter: PersistentCodexCapsuleAdapter;
	readonly authorityPort: PersistentCodexCapsuleAdapter;
	readonly runtimeProvisioner: CodexCapsuleProvisioner;
}

/** Opens the matched Node-side Codex control plane without launching a Capsule. */
export async function openCodexNodeRuntime(
	options: CodexNodeRuntimeOptions,
	dependencies: CodexNodeRuntimeDependencies = {},
): Promise<CodexNodeRuntime> {
	const signal = options.signal ?? new AbortController().signal;
	const verifiedLauncher = await runCodexRuntimeDoctor({ signal }, dependencies.doctor);
	signal.throwIfAborted();
	const controlRootDirectory = join(options.stateDirectory, "codex-control");
	const runtimeRootDirectory = join(options.stateDirectory, "codex-runtime");
	const provisioner = await CodexCapsuleProvisioner.open(
		{ controlRootDirectory, runtimeRootDirectory },
		{
			resolveLauncher: async () => verifiedLauncher,
			containment: dependencies.containment,
		},
	);
	signal.throwIfAborted();
	const adapter = await PersistentCodexCapsuleAdapter.open({
		rootDirectory: controlRootDirectory,
		launcher: options.launcher,
	});
	signal.throwIfAborted();

	return { adapter, authorityPort: adapter, runtimeProvisioner: provisioner };
}
