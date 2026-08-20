import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { type SessionInput, sessionInputSchema } from "@agentrelay/protocol";
import { z } from "zod";
import type { CodexCapsuleLaunchDescriptor } from "./capsule-launch-descriptor.js";
import { SUPPORTED_CODEX_CLI_VERSION } from "./codex-app-server-protocol.js";
import { codexProviderEgressBinding } from "./codex-provider-egress-policy.js";
import { sha256PinnedFile } from "./codex-sandbox-binding.js";
import {
	CODEX_SANDBOX_CONFIG_FILE,
	CODEX_SANDBOX_MANIFEST_FILE,
	type CodexSandboxContainment,
	type CodexSandboxRecoveryExpectation,
	type CodexWorkspaceAccess,
	type PinnedCodexLauncher,
} from "./codex-sandbox-contract.js";
import type { PreparedMissionWorkspace } from "./mission-workspace.js";
import {
	RuntimeAuthorityDeniedError,
	type RuntimeWorkspaceAuthority,
	parseRuntimeAuthorityGrant,
	runtimeAuthorityDenyCodeSchema,
} from "./runtime-authority.js";
import {
	type RuntimeContainmentManifest,
	parseRuntimeContainmentManifest,
	workspaceBinding,
} from "./runtime-containment-manifest.js";
import { workspaceResourceSha256 } from "./workspace-resource.js";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export interface CodexCapsuleProvisionInput {
	readonly session: SessionInput;
	readonly workspace: PreparedMissionWorkspace;
	readonly policyGrantSha256: string;
	readonly workspaceAccess: CodexWorkspaceAccess;
}

export type CodexCapsuleProvisioningAuthority = RuntimeWorkspaceAuthority;

export interface ParsedCodexCapsuleProvisionInput {
	readonly session: SessionInput;
	readonly workspace: PreparedMissionWorkspace;
	readonly policyGrantSha256: string;
	readonly workspaceAccess: CodexWorkspaceAccess;
}

export interface CodexContainmentProvisioningExpectation {
	readonly workspace: PreparedMissionWorkspace;
	readonly policyGrantSha256: string;
	readonly workspaceAccess: CodexWorkspaceAccess;
}

export function parseCodexCapsuleProvisionInput(
	input: CodexCapsuleProvisionInput,
): ParsedCodexCapsuleProvisionInput {
	const workspace = Object.freeze({
		repositoryUrl: input.workspace.repositoryUrl,
		baseCommit: input.workspace.baseCommit,
		root: input.workspace.root,
		gitDirectory: input.workspace.gitDirectory,
		rootIdentity: Object.freeze({ ...input.workspace.rootIdentity }),
		gitIdentity: Object.freeze({ ...input.workspace.gitIdentity }),
		reachableFromRef: input.workspace.reachableFromRef,
	});
	return Object.freeze({
		session: sessionInputSchema.parse(input.session),
		workspace,
		policyGrantSha256: sha256Schema.parse(input.policyGrantSha256),
		workspaceAccess: z.enum(["read", "write"]).parse(input.workspaceAccess),
	});
}

export function assertCodexProvisioningAuthorityScope(
	authority: CodexCapsuleProvisioningAuthority,
	input: ParsedCodexCapsuleProvisionInput,
): void {
	assertAuthorityAvailable(authority.signal);
	const grant = parseRuntimeAuthorityGrant(authority.grant);
	if (grant.mission_id !== input.session.missionId) {
		throw new RuntimeAuthorityDeniedError("wrong_mission");
	}
	if (grant.agent_id !== input.session.participantId) {
		throw new RuntimeAuthorityDeniedError("wrong_agent");
	}
	if (grant.workspace_alias !== input.session.workspaceAlias) {
		throw new RuntimeAuthorityDeniedError("wrong_workspace");
	}
	if (grant.policy_grant_sha256 !== input.policyGrantSha256) {
		throw new RuntimeAuthorityDeniedError("policy_changed");
	}
	const resourceSha256 = workspaceResourceSha256({
		workspaceBindingId: grant.workspace_binding_id,
		workspaceAlias: grant.workspace_alias,
		root: input.workspace.root,
		repositoryUrl: input.workspace.repositoryUrl,
		headCommit: input.workspace.baseCommit,
		reachableFromRef: input.workspace.reachableFromRef,
	});
	if (grant.workspace_resource_sha256 !== resourceSha256) {
		throw new RuntimeAuthorityDeniedError("wrong_resource");
	}
	if (!hasWorkspaceCapability(grant, "workspace_read")) {
		throw new RuntimeAuthorityDeniedError("capability_missing");
	}
	if (input.workspaceAccess === "write" && !hasWorkspaceCapability(grant, "workspace_write")) {
		throw new RuntimeAuthorityDeniedError("capability_missing");
	}
}

export async function performCodexProvisioningAuthorized<T>(
	authority: CodexCapsuleProvisioningAuthority,
	input: ParsedCodexCapsuleProvisionInput,
	effect: () => Promise<T>,
): Promise<T> {
	assertCodexProvisioningAuthorityScope(authority, input);
	const perform =
		input.workspaceAccess === "write" ? "performWorkspaceWrite" : "performWorkspaceRead";
	return authority[perform](async () => {
		assertCodexProvisioningAuthorityScope(authority, input);
		const result = await effect();
		assertCodexProvisioningAuthorityScope(authority, input);
		return result;
	});
}

export function assertCodexProvisioningAuthorityAvailable(signal: AbortSignal): void {
	assertAuthorityAvailable(signal);
}

export async function assertPinnedCodexArtifact(launcher: PinnedCodexLauncher): Promise<void> {
	const [launcherSha256, helperSha256] = await Promise.all([
		sha256PinnedFile(launcher.executable),
		sha256PinnedFile(launcher.sandboxHelper.executable),
	]);
	if (launcherSha256 !== launcher.sha256 || helperSha256 !== launcher.sandboxHelper.sha256) {
		throw new Error("Pinned Codex artifact digest does not match its owner-approved value");
	}
}

export function parseCodexContainmentManifest(value: unknown): RuntimeContainmentManifest {
	return parseRuntimeContainmentManifest(value);
}

export function codexContainmentRecovery(
	manifestPath: string,
	manifest: RuntimeContainmentManifest,
): CodexSandboxRecoveryExpectation {
	return Object.freeze({
		manifestPath,
		instanceId: manifest.instance_id,
		bindingSha256: manifest.binding_sha256,
	});
}

export async function assertCurrentCodexContainmentManifest(
	manifest: RuntimeContainmentManifest,
	expectation: CodexContainmentProvisioningExpectation,
	controlDirectory: string,
	runtimeDirectory: string,
	launcher: PinnedCodexLauncher,
	ownerHome: string,
): Promise<void> {
	const expectedPrivatePaths = {
		controlRoot: controlDirectory,
		launcherHome: join(controlDirectory, "sandbox-launcher"),
		runtimeRoot: runtimeDirectory,
		runtimeHome: join(runtimeDirectory, "codex-home"),
		runtimeTmp: join(runtimeDirectory, "tmp"),
	};
	const binding = manifest.binding;
	const expectedDeniedRoots = [ownerHome, controlDirectory].sort();
	const actualDeniedRoots = binding.denied_roots.map((root) => root.path).sort();
	const exact =
		binding.workspace_access === expectation.workspaceAccess &&
		isDeepStrictEqual(binding.workspace, workspaceBinding(expectation.workspace)) &&
		binding.policy_grant_sha256 === expectation.policyGrantSha256 &&
		binding.private_paths.control_root.path === expectedPrivatePaths.controlRoot &&
		binding.private_paths.launcher_home.path === expectedPrivatePaths.launcherHome &&
		binding.private_paths.runtime_root.path === expectedPrivatePaths.runtimeRoot &&
		binding.private_paths.runtime_home.path === expectedPrivatePaths.runtimeHome &&
		binding.private_paths.runtime_tmp.path === expectedPrivatePaths.runtimeTmp &&
		binding.launcher.executable.path === launcher.executable &&
		binding.launcher.executable_sha256 === launcher.sha256 &&
		binding.launcher.read_root.path === launcher.readRoot &&
		binding.launcher.sandbox_helper.executable.path === launcher.sandboxHelper.executable &&
		binding.launcher.sandbox_helper.executable_sha256 === launcher.sandboxHelper.sha256 &&
		launcher.sandboxHelper.readRoot === launcher.readRoot &&
		binding.launcher.config_path ===
			join(expectedPrivatePaths.launcherHome, CODEX_SANDBOX_CONFIG_FILE) &&
		binding.provider.executable.path === launcher.executable &&
		binding.provider.executable_sha256 === launcher.sha256 &&
		binding.provider.read_root.path === launcher.readRoot &&
		isDeepStrictEqual(binding.provider_egress, codexProviderEgressBinding()) &&
		binding.probe.read_root.path === join(runtimeDirectory, "probe-runtime") &&
		binding.probe.executable.path === join(runtimeDirectory, "probe-runtime", "bin", "node") &&
		binding.read_only_roots.length === 0 &&
		isDeepStrictEqual(actualDeniedRoots, expectedDeniedRoots);
	if (!exact || !(await currentArtifactMatches(manifest, launcher))) {
		throw new Error("Codex containment does not match the current Node-owned provisioning input");
	}
}

export function assertCodexDescriptorContainment(
	descriptor: CodexCapsuleLaunchDescriptor,
	controlDirectory: string,
	manifest: RuntimeContainmentManifest,
): void {
	const expected = codexContainmentRecovery(
		join(controlDirectory, CODEX_SANDBOX_MANIFEST_FILE),
		manifest,
	);
	if (!isDeepStrictEqual(descriptor.runtime.containment, expected)) {
		throw new Error("Codex Capsule descriptor does not match its exact containment manifest");
	}
}

export function assertRecoveredCodexContainment(
	containment: CodexSandboxContainment,
	manifest: RuntimeContainmentManifest,
	expectation: CodexContainmentProvisioningExpectation,
	controlDirectory: string,
	runtimeDirectory: string,
): void {
	const expectedRecovery = codexContainmentRecovery(
		join(controlDirectory, CODEX_SANDBOX_MANIFEST_FILE),
		manifest,
	);
	const exact =
		isDeepStrictEqual(containment.recovery, expectedRecovery) &&
		containment.evidence.instanceId === manifest.instance_id &&
		containment.evidence.bindingSha256 === manifest.binding_sha256 &&
		containment.evidence.runtimeVersion === SUPPORTED_CODEX_CLI_VERSION &&
		containment.evidence.baseCommit === expectation.workspace.baseCommit &&
		containment.runtimeHome === join(runtimeDirectory, "codex-home") &&
		containment.runtimeTmp === join(runtimeDirectory, "tmp") &&
		containment.authorization.controlDirectory === controlDirectory &&
		containment.authorization.runtimeDirectory === runtimeDirectory &&
		containment.authorization.providerExecutable === manifest.binding.provider.executable.path &&
		containment.authorization.runtimeVersion === SUPPORTED_CODEX_CLI_VERSION &&
		containment.authorization.policyGrantSha256 === expectation.policyGrantSha256 &&
		containment.authorization.workspaceAccess === expectation.workspaceAccess &&
		isDeepStrictEqual(containment.authorization.workspace, {
			root: expectation.workspace.root,
			repositoryUrl: expectation.workspace.repositoryUrl,
			headCommit: expectation.workspace.baseCommit,
			reachableFromRef: expectation.workspace.reachableFromRef,
		});
	if (!exact) {
		throw new Error("Recovered Codex containment changed its Node-owned provisioning authority");
	}
}

function hasWorkspaceCapability(
	grant: ReturnType<typeof parseRuntimeAuthorityGrant>,
	action: "workspace_read" | "workspace_write",
): boolean {
	return grant.capabilities.some(
		(capability) => capability.action === action && capability.resource === "workspace",
	);
}

async function currentArtifactMatches(
	manifest: RuntimeContainmentManifest,
	launcher: PinnedCodexLauncher,
): Promise<boolean> {
	const binding = manifest.binding;
	await assertPinnedCodexArtifact(launcher);
	const [executableIdentity, readRootIdentity, helperIdentity] = await Promise.all([
		filesystemIdentity(launcher.executable),
		filesystemIdentity(launcher.readRoot),
		filesystemIdentity(launcher.sandboxHelper.executable),
	]);
	return (
		isDeepStrictEqual(binding.launcher.executable.identity, executableIdentity) &&
		isDeepStrictEqual(binding.launcher.read_root.identity, readRootIdentity) &&
		isDeepStrictEqual(binding.launcher.sandbox_helper.executable.identity, helperIdentity) &&
		isDeepStrictEqual(binding.provider.executable.identity, executableIdentity) &&
		isDeepStrictEqual(binding.provider.read_root.identity, readRootIdentity)
	);
}

async function filesystemIdentity(path: string): Promise<{ device: string; inode: string }> {
	const stats = await lstat(path, { bigint: true });
	return { device: stats.dev.toString(), inode: stats.ino.toString() };
}

function assertAuthorityAvailable(signal: AbortSignal): void {
	if (!signal.aborted) return;
	const reason = runtimeAuthorityDenyCodeSchema.safeParse(signal.reason);
	throw new RuntimeAuthorityDeniedError(reason.success ? reason.data : "revoked");
}
