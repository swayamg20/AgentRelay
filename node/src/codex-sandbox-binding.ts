import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { SUPPORTED_CODEX_CLI_VERSION } from "./codex-app-server-protocol.js";
import type {
	CodexSandboxContainmentInput,
	ContainmentLayout,
	PinnedCodexLauncher,
	PinnedExecutable,
} from "./codex-sandbox-contract.js";
import { assertAbsoluteNormalizedPath, canonicalContainmentRoots } from "./codex-sandbox-policy.js";
import type { ContainmentProbeExecutable } from "./codex-sandbox-probe.js";
import { assertContainmentReadTreesIsolated } from "./containment-read-tree.js";
import { isPathWithin } from "./filesystem-path.js";
import {
	assertNoLinuxStorageAliases,
	assertNoNestedLinuxMounts,
	readLinuxMounts,
} from "./linux-mounts.js";
import type { LocalFilesystemIdentity, PreparedMissionWorkspace } from "./mission-workspace.js";
import { revalidateMissionWorkspaceIsolation } from "./mission-workspace.js";
import {
	RUNTIME_CONTAINMENT_BACKEND,
	type RuntimeContainmentBinding,
	boundPath,
	workspaceBinding,
} from "./runtime-containment-manifest.js";

export async function buildRuntimeContainmentBinding(
	input: CodexSandboxContainmentInput,
	layout: ContainmentLayout,
	config: string,
	probe: ContainmentProbeExecutable,
	signal: AbortSignal,
): Promise<RuntimeContainmentBinding> {
	signal.throwIfAborted();
	const [workspace, launcher, provider, inspectedProbe, privatePaths, readOnlyRoots, deniedRoots] =
		await Promise.all([
			inspectWorkspace(input.workspace, signal),
			inspectLauncher(input.launcher),
			inspectExecutable(input.provider),
			inspectExecutable(probe),
			inspectPrivatePaths(layout),
			inspectRoots(input.readOnlyRoots ?? []),
			inspectRoots([
				await realpath(homedir()),
				layout.controlRoot,
				...(input.forbiddenRoots ?? []),
			]),
		]);
	signal.throwIfAborted();
	const trustedReadRoots = [
		launcher.readRoot.path,
		provider.readRoot.path,
		inspectedProbe.readRoot.path,
		...readOnlyRoots.map((root) => root.path),
	];
	const workspaceAccess = input.workspaceAccess ?? "write";
	const writableRoots = [
		...(workspaceAccess === "write" ? [workspace.root.path] : []),
		privatePaths.runtime_home.path,
		privatePaths.runtime_tmp.path,
	];
	const classifiedReadRoots = [
		...trustedReadRoots,
		...(workspaceAccess === "read" ? [workspace.root.path] : []),
	];
	const deniedRootPaths = deniedRoots.map((root) => root.path);
	const linuxMounts = await readLinuxMounts();
	assertNoNestedLinuxMounts(writableRoots, linuxMounts);
	await assertContainmentReadTreesIsolated(
		{ roots: trustedReadRoots, deniedRoots: deniedRootPaths, writableRoots },
		linuxMounts,
	);
	assertNoLinuxStorageAliases(
		[
			...classifiedReadRoots.map((path) => ({ path, access: "read" as const })),
			...writableRoots.map((path) => ({ path, access: "write" as const })),
			...deniedRootPaths.map((path) => ({ path, access: "deny" as const })),
		],
		linuxMounts,
	);
	return {
		backend: RUNTIME_CONTAINMENT_BACKEND,
		runtime_version: SUPPORTED_CODEX_CLI_VERSION,
		...(input.workspaceAccess === undefined ? {} : { workspace_access: input.workspaceAccess }),
		workspace,
		launcher: {
			executable: launcher.executable,
			executable_sha256: input.launcher.sha256,
			read_root: launcher.readRoot,
			sandbox_helper: {
				executable: launcher.sandboxHelperExecutable,
				executable_sha256: input.launcher.sandboxHelper.sha256,
			},
			config_path: layout.launcherPath,
			config_sha256: sha256Text(config),
		},
		provider: {
			executable: provider.executable,
			executable_sha256: input.provider.sha256,
			read_root: provider.readRoot,
		},
		probe: {
			executable: inspectedProbe.executable,
			executable_sha256: probe.sha256,
			read_root: inspectedProbe.readRoot,
		},
		private_paths: privatePaths,
		read_only_roots: readOnlyRoots,
		denied_roots: deniedRoots,
		policy_grant_sha256: input.policyGrantSha256,
	};
}

export async function sha256PinnedFile(path: string): Promise<string> {
	const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const hash = createHash("sha256");
		for await (const chunk of handle.createReadStream()) hash.update(chunk);
		return hash.digest("hex");
	} finally {
		await handle.close();
	}
}

async function inspectLauncher(launcher: PinnedCodexLauncher) {
	const [runtime, sandboxHelper] = await Promise.all([
		inspectExecutable(launcher),
		inspectExecutable(launcher.sandboxHelper),
	]);
	if (
		sandboxHelper.readRoot.path !== runtime.readRoot.path ||
		sandboxHelper.executable.path !== join(runtime.readRoot.path, "codex-resources", "bwrap")
	) {
		throw new Error("Pinned Codex sandbox helper must use the exact packaged location");
	}
	return { ...runtime, sandboxHelperExecutable: sandboxHelper.executable };
}

async function inspectWorkspace(workspace: PreparedMissionWorkspace, signal: AbortSignal) {
	await revalidateMissionWorkspaceIsolation(workspace, { signal });
	signal.throwIfAborted();
	const [root, gitDirectory] = await Promise.all([
		inspectPath(workspace.root, "workspace root", "directory"),
		inspectPath(workspace.gitDirectory, "workspace Git directory", "directory"),
	]);
	if (
		root.identity.device !== workspace.rootIdentity.device ||
		root.identity.inode !== workspace.rootIdentity.inode ||
		gitDirectory.identity.device !== workspace.gitIdentity.device ||
		gitDirectory.identity.inode !== workspace.gitIdentity.inode
	) {
		throw new Error("Mission workspace identity changed after preflight");
	}
	return { ...workspaceBinding(workspace), root, git_directory: gitDirectory };
}

async function inspectExecutable(executable: PinnedExecutable) {
	const executablePath = await inspectPath(executable.executable, "executable", "file");
	const readRoot = await inspectPath(executable.readRoot, "executable read root", "directory");
	if (!isPathWithin(executablePath.path, readRoot.path)) {
		throw new Error("Pinned executable must be contained by its approved read root");
	}
	if ((await sha256PinnedFile(executablePath.path)) !== executable.sha256) {
		throw new Error("Pinned executable digest does not match the owner-approved value");
	}
	return { executable: executablePath, readRoot };
}

async function inspectPrivatePaths(layout: ContainmentLayout) {
	const [controlRoot, launcherHome, runtimeRoot, runtimeHome, runtimeTmp] = await Promise.all([
		inspectPath(layout.controlRoot, "control root", "directory"),
		inspectPath(layout.launcherHome, "launcher home", "directory"),
		inspectPath(layout.runtimeRoot, "runtime root", "directory"),
		inspectPath(layout.runtimeHome, "runtime home", "directory"),
		inspectPath(layout.runtimeTmp, "runtime tmp", "directory"),
	]);
	return {
		control_root: controlRoot,
		launcher_home: launcherHome,
		runtime_root: runtimeRoot,
		runtime_home: runtimeHome,
		runtime_tmp: runtimeTmp,
	};
}

async function inspectRoots(paths: readonly string[]) {
	const roots = await canonicalContainmentRoots(paths);
	return Promise.all(roots.map((path) => inspectPath(path, "containment root", "directory")));
}

async function inspectPath(path: string, label: string, kind: "file" | "directory") {
	assertAbsoluteNormalizedPath(path, label);
	const canonical = await realpath(path);
	if (canonical !== path) throw new Error(`${label} must use its canonical path`);
	const stats = await lstat(path, { bigint: true });
	if (stats.isSymbolicLink() || (kind === "file" ? !stats.isFile() : !stats.isDirectory())) {
		throw new Error(`${label} has the wrong filesystem type`);
	}
	if ((stats.mode & 0o22n) !== 0n) throw new Error(`${label} cannot be group- or world-writable`);
	const currentUid = process.getuid?.();
	if (currentUid !== undefined && stats.uid !== 0n && stats.uid !== BigInt(currentUid)) {
		throw new Error(`${label} must be owned by root or the current user`);
	}
	const identity: LocalFilesystemIdentity = {
		device: stats.dev.toString(),
		inode: stats.ino.toString(),
	};
	return boundPath(path, identity);
}

function sha256Text(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}
