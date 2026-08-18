import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { CodexProcessBoundary, CodexProcessRequest } from "./codex-process-boundary.js";
import { buildRuntimeContainmentBinding } from "./codex-sandbox-binding.js";
import {
	CODEX_SANDBOX_MANIFEST_FILE,
	CODEX_SANDBOX_PROFILE_NAME,
	type CodexSandboxAuthorization,
	type CodexSandboxContainment,
	type CodexSandboxContainmentInput,
	type CodexSandboxRecoveryExpectation,
	type ContainmentLayout,
	type ContainmentOpenMode,
	type PinnedExecutable,
} from "./codex-sandbox-contract.js";
import {
	assertAbsoluteNormalizedPath,
	assertCodexSandboxInput,
	assertNoAmbientCodexConfiguration,
	assertPrivateContainmentConfig,
	assertSupportedLinuxContainment,
	buildCodexSandboxConfig,
	createPrivateContainmentConfig,
	prepareContainmentLayout,
	readPrivateContainmentConfig,
} from "./codex-sandbox-policy.js";
import { runCodexSandboxProbe } from "./codex-sandbox-probe.js";
import { prepareStagedContainmentProbe } from "./codex-sandbox-staging.js";
import {
	type PreparedMissionWorkspace,
	assertMissionWorkspaceClean,
	revalidateMissionWorkspaceIsolation,
} from "./mission-workspace.js";
import {
	type RuntimeContainmentBinding,
	type RuntimeContainmentManifest,
	containmentEvidence,
	createRuntimeContainmentManifest,
	openRuntimeContainmentManifest,
	readRuntimeContainmentManifest,
} from "./runtime-containment-manifest.js";

export type {
	CodexSandboxAuthorization,
	CodexSandboxContainment,
	CodexSandboxContainmentInput,
	CodexSandboxRecoveryExpectation,
	PinnedCodexLauncher,
	PinnedExecutable,
} from "./codex-sandbox-contract.js";

export async function prepareCodexSandboxContainment(
	input: CodexSandboxContainmentInput,
	signal: AbortSignal,
): Promise<CodexSandboxContainment> {
	return prepareContainment(
		{ ...input, workspaceAccess: input.workspaceAccess ?? "write" },
		"create",
		signal,
	);
}

/** Reopens a retained binding only when the Node journal names the same instance and digest. */
export async function recoverCodexSandboxContainment(
	expectation: CodexSandboxRecoveryExpectation,
	signal: AbortSignal,
): Promise<CodexSandboxContainment> {
	signal.throwIfAborted();
	assertSupportedLinuxContainment();
	const { manifestPath } = expectation;
	assertAbsoluteNormalizedPath(manifestPath, "containment manifest");
	if ((await realpath(manifestPath)) !== manifestPath) {
		throw new Error("Containment manifest must use its canonical path");
	}
	const manifest = await readRuntimeContainmentManifest(manifestPath);
	if (
		manifest.instance_id !== expectation.instanceId ||
		manifest.binding_sha256 !== expectation.bindingSha256
	) {
		throw new Error("Containment recovery does not match the Node-authorized instance");
	}

	const binding = manifest.binding;
	const controlDirectory = binding.private_paths.control_root.path;
	if (
		manifestPath !== join(controlDirectory, CODEX_SANDBOX_MANIFEST_FILE) ||
		dirname(manifestPath) !== controlDirectory
	) {
		throw new Error("Containment manifest is outside its bound control directory");
	}
	const workspace = workspaceFromBinding(binding);
	await revalidateMissionWorkspaceIsolation(workspace, { signal });
	const ownerHome = await realpath(homedir());
	const deniedRoots = binding.denied_roots.map((root) => root.path);
	if (!deniedRoots.includes(ownerHome) || !deniedRoots.includes(controlDirectory)) {
		throw new Error("Containment recovery is missing its default denied roots");
	}

	return prepareContainment(
		{
			controlDirectory,
			runtimeDirectory: binding.private_paths.runtime_root.path,
			workspaceAccess: binding.workspace_access,
			workspace,
			launcher: {
				executable: binding.launcher.executable.path,
				readRoot: binding.launcher.read_root.path,
				sha256: binding.launcher.executable_sha256,
				sandboxHelper: {
					executable: binding.launcher.sandbox_helper.executable.path,
					readRoot: binding.launcher.read_root.path,
					sha256: binding.launcher.sandbox_helper.executable_sha256,
				},
			},
			provider: {
				executable: binding.provider.executable.path,
				readRoot: binding.provider.read_root.path,
				sha256: binding.provider.executable_sha256,
			},
			readOnlyRoots: binding.read_only_roots.map((root) => root.path),
			forbiddenRoots: deniedRoots.filter((root) => root !== ownerHome && root !== controlDirectory),
			policyGrantSha256: binding.policy_grant_sha256,
		},
		"recover",
		signal,
		expectation,
		{
			executable: binding.probe.executable.path,
			readRoot: binding.probe.read_root.path,
			sha256: binding.probe.executable_sha256,
		},
	);
}

async function prepareContainment(
	input: CodexSandboxContainmentInput,
	mode: ContainmentOpenMode,
	signal: AbortSignal,
	recoveryExpectation?: CodexSandboxRecoveryExpectation,
	recoveryProbe?: PinnedExecutable,
): Promise<CodexSandboxContainment> {
	signal.throwIfAborted();
	assertSupportedLinuxContainment();
	assertCodexSandboxInput(input);
	await assertNoAmbientCodexConfiguration();
	signal.throwIfAborted();
	await revalidateMissionWorkspaceIsolation(input.workspace, { signal });
	signal.throwIfAborted();
	if (mode === "create") {
		await assertMissionWorkspaceClean(input.workspace, { signal });
		signal.throwIfAborted();
	}

	const layout = await prepareContainmentLayout(input, mode);
	signal.throwIfAborted();
	const probe = await prepareStagedContainmentProbe(layout, mode, recoveryProbe);
	signal.throwIfAborted();
	const config = await buildCodexSandboxConfig(input, layout, probe);
	signal.throwIfAborted();
	if (mode === "create") {
		await createPrivateContainmentConfig(layout.launcherPath, config);
	} else {
		await assertPrivateContainmentConfig(layout.launcherPath, config);
	}
	signal.throwIfAborted();
	const binding = await buildRuntimeContainmentBinding(input, layout, config, probe, signal);
	signal.throwIfAborted();
	let manifest =
		mode === "recover"
			? await openRuntimeContainmentManifest(layout.manifestPath, binding)
			: undefined;
	if (mode === "recover") {
		if (recoveryExpectation === undefined || manifest === undefined) {
			throw new Error("Containment recovery requires an exact Node-authorized instance");
		}
		assertExpectedManifest(manifest, recoveryExpectation);
	}

	await runCodexSandboxProbe(
		{
			launcherExecutable: input.launcher.executable,
			launcherHome: layout.launcherHome,
			launcherPath: layout.launcherPath,
			profileName: CODEX_SANDBOX_PROFILE_NAME,
			workspaceRoot: input.workspace.root,
			workspaceAccess: input.workspaceAccess ?? "write",
			gitDirectory: input.workspace.gitDirectory,
			runtimeTmp: layout.runtimeTmp,
			probe,
		},
		signal,
	);
	signal.throwIfAborted();
	if (mode === "create") {
		await assertMissionWorkspaceClean(input.workspace, { signal });
		signal.throwIfAborted();
		manifest = await createRuntimeContainmentManifest(layout.manifestPath, binding);
		signal.throwIfAborted();
	}
	if (manifest === undefined) throw new Error("Containment manifest was not established");

	return Object.freeze({
		boundary: new PinnedCodexSandboxBoundary(
			input,
			layout,
			probe,
			manifest.instance_id,
			manifest.binding_sha256,
		),
		evidence: containmentEvidence(manifest),
		authorization: containmentAuthorization(manifest.binding),
		recovery: Object.freeze({
			manifestPath: layout.manifestPath,
			instanceId: manifest.instance_id,
			bindingSha256: manifest.binding_sha256,
		}),
		runtimeHome: layout.runtimeHome,
		runtimeTmp: layout.runtimeTmp,
	});
}

function containmentAuthorization(binding: RuntimeContainmentBinding): CodexSandboxAuthorization {
	return Object.freeze({
		controlDirectory: binding.private_paths.control_root.path,
		runtimeDirectory: binding.private_paths.runtime_root.path,
		providerExecutable: binding.provider.executable.path,
		runtimeVersion: binding.runtime_version,
		policyGrantSha256: binding.policy_grant_sha256,
		workspaceAccess: binding.workspace_access ?? "write",
		workspace: Object.freeze({
			root: binding.workspace.root.path,
			repositoryUrl: binding.workspace.repository_url,
			headCommit: binding.workspace.base_commit,
			reachableFromRef: binding.workspace.reachable_from_ref,
		}),
	});
}

class PinnedCodexSandboxBoundary implements CodexProcessBoundary {
	constructor(
		private readonly input: CodexSandboxContainmentInput,
		private readonly layout: ContainmentLayout,
		private readonly probe: PinnedExecutable,
		private readonly instanceId: string,
		private readonly bindingSha256: string,
	) {}

	async prepare(request: CodexProcessRequest, signal: AbortSignal) {
		signal.throwIfAborted();
		assertSupportedLinuxContainment();
		assertProcessRequest(request, this.input, this.layout);
		await assertNoAmbientCodexConfiguration();
		signal.throwIfAborted();
		const config = await readPrivateContainmentConfig(this.layout.launcherPath);
		signal.throwIfAborted();
		const binding = await buildRuntimeContainmentBinding(
			this.input,
			this.layout,
			config,
			this.probe,
			signal,
		);
		signal.throwIfAborted();
		const manifest = await openRuntimeContainmentManifest(this.layout.manifestPath, binding);
		signal.throwIfAborted();
		if (
			manifest.instance_id !== this.instanceId ||
			manifest.binding_sha256 !== this.bindingSha256
		) {
			throw new Error("Containment instance changed after the boundary was established");
		}
		return {
			executable: this.input.launcher.executable,
			argv: [
				"sandbox",
				"--disable",
				"use_legacy_landlock",
				"--permission-profile",
				CODEX_SANDBOX_PROFILE_NAME,
				"--cd",
				this.input.workspace.root,
				"--",
				request.executable,
				...request.argv,
			],
			cwd: this.input.workspace.root,
			env: {
				HOME: this.layout.launcherHome,
				CODEX_HOME: this.layout.launcherHome,
				PATH: "/dev/null",
			},
		};
	}
}

function workspaceFromBinding(binding: RuntimeContainmentBinding): PreparedMissionWorkspace {
	return Object.freeze({
		repositoryUrl: binding.workspace.repository_url,
		baseCommit: binding.workspace.base_commit,
		root: binding.workspace.root.path,
		gitDirectory: binding.workspace.git_directory.path,
		rootIdentity: binding.workspace.root.identity,
		gitIdentity: binding.workspace.git_directory.identity,
		reachableFromRef: binding.workspace.reachable_from_ref,
	});
}

function assertExpectedManifest(
	manifest: RuntimeContainmentManifest,
	expectation: CodexSandboxRecoveryExpectation,
): void {
	if (
		manifest.instance_id !== expectation.instanceId ||
		manifest.binding_sha256 !== expectation.bindingSha256
	) {
		throw new Error("Containment recovery does not match the Node-authorized instance");
	}
}

function assertProcessRequest(
	request: CodexProcessRequest,
	input: CodexSandboxContainmentInput,
	layout: ContainmentLayout,
): void {
	if (request.executable !== input.provider.executable || request.cwd !== input.workspace.root) {
		throw new Error("Containment request does not match its pinned provider workspace");
	}
	if (request.env.HOME !== layout.runtimeHome || request.env.CODEX_HOME !== layout.runtimeHome) {
		throw new Error("Containment request does not use the private runtime home");
	}
}
