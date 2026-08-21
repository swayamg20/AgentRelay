import { join } from "node:path";
import {
	CodexCapsuleProvisioner,
	type CodexContainmentProvisioningPort,
} from "./codex-capsule-provisioner.js";
import {
	type CodexRuntimeDoctorDependencies,
	runCodexRuntimeDoctor,
	runCodexWorkspaceMediatorDoctor,
} from "./codex-runtime-doctor.js";
import type { CapsuleLauncher } from "./persistent-capsule-adapter.js";
import { PersistentCodexCapsuleAdapter } from "./persistent-codex-capsule-adapter.js";

export interface CodexNodeRuntimeOptions {
	readonly stateDirectory: string;
	readonly gitExecutable?: string;
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
	const [verifiedLauncher, verifiedGit] = await Promise.all([
		runCodexRuntimeDoctor({ signal }, dependencies.doctor),
		options.gitExecutable === undefined
			? Promise.resolve(null)
			: runCodexWorkspaceMediatorDoctor(
					{ signal, gitExecutable: options.gitExecutable },
					dependencies.doctor,
				),
	]);
	signal.throwIfAborted();
	const controlRootDirectory = join(options.stateDirectory, "codex-control");
	const runtimeRootDirectory = join(options.stateDirectory, "codex-runtime");
	const workspaceGlobalControlRoot =
		options.gitExecutable === undefined
			? undefined
			: join(options.stateDirectory, "workspace-patches");
	const provisioner = await CodexCapsuleProvisioner.open(
		{
			controlRootDirectory,
			runtimeRootDirectory,
			...(workspaceGlobalControlRoot === undefined
				? {}
				: { workspaceGlobalControlRoot, gitExecutable: options.gitExecutable }),
		},
		{
			resolveLauncher: async () => verifiedLauncher,
			resolveGit: async (executable) => {
				if (verifiedGit === null || executable !== options.gitExecutable) {
					throw new Error("Codex provisioner changed the owner-selected Git executable");
				}
				return verifiedGit;
			},
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
