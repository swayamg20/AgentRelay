import { randomBytes, randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { digestCanonicalJson } from "./capsule-correlation.js";
import {
	CAPSULE_DESCRIPTOR_FILE,
	CODEX_CAPSULE_RUNTIME_CONTRACT,
	type CodexCapsuleLaunchDescriptor,
	capsuleSocketPath,
	codexCapsuleLaunchDescriptorSchema,
	readCapsuleLaunchDescriptor,
} from "./capsule-launch-descriptor.js";
import { SUPPORTED_CODEX_CLI_VERSION } from "./codex-app-server-protocol.js";
import { resolvePinnedCodexLauncher } from "./codex-artifact.js";
import {
	type CodexCapsuleProvisionInput,
	type CodexCapsuleProvisioningAuthority,
	type ParsedCodexCapsuleProvisionInput,
	assertCodexDescriptorContainment,
	assertCodexProvisioningAuthorityAvailable,
	assertCodexProvisioningAuthorityScope,
	assertCurrentCodexContainmentManifest,
	assertPinnedCodexArtifact,
	assertRecoveredCodexContainment,
	codexContainmentRecovery,
	parseCodexCapsuleProvisionInput,
	parseCodexContainmentManifest,
	performCodexProvisioningAuthorized,
} from "./codex-capsule-provisioning-validation.js";
import {
	prepareCodexSandboxContainment,
	recoverCodexSandboxContainment,
} from "./codex-sandbox-containment.js";
import {
	CODEX_SANDBOX_MANIFEST_FILE,
	CodexContainmentTerminationError,
	type CodexSandboxContainment,
	type CodexSandboxContainmentInput,
	type CodexSandboxRecoveryExpectation,
	type PinnedCodexLauncher,
} from "./codex-sandbox-contract.js";
import { publishDurableJsonExclusive } from "./durable-file.js";
import { isPathWithin } from "./filesystem-path.js";
import { ensurePrivateStateDirectory, readPrivateJsonIfPresent } from "./private-state-file.js";
import type { RuntimeContainmentManifest } from "./runtime-containment-manifest.js";
export type {
	CodexCapsuleProvisionInput,
	CodexCapsuleProvisioningAuthority,
} from "./codex-capsule-provisioning-validation.js";

export interface CodexCapsuleProvisionerOptions {
	readonly controlRootDirectory: string;
	readonly runtimeRootDirectory: string;
}

export interface CodexContainmentProvisioningPort {
	readonly prepare: (
		input: CodexSandboxContainmentInput,
		signal: AbortSignal,
	) => Promise<CodexSandboxContainment>;
	readonly recover: (
		expectation: CodexSandboxRecoveryExpectation,
		signal: AbortSignal,
	) => Promise<CodexSandboxContainment>;
	readonly readManifestIfPresent: (path: string) => Promise<unknown | null>;
}

export interface CodexCapsuleProvisionerDependencies {
	readonly resolveLauncher?: () => Promise<PinnedCodexLauncher>;
	readonly containment?: CodexContainmentProvisioningPort;
}

const productionContainment: CodexContainmentProvisioningPort = {
	prepare: prepareCodexSandboxContainment,
	recover: recoverCodexSandboxContainment,
	readManifestIfPresent: readPrivateJsonIfPresent,
};

/** Establishes durable Codex launch authority without starting a Capsule or provider. */
export class CodexCapsuleProvisioner {
	readonly #controlRootDirectory: string;
	readonly #runtimeRootDirectory: string;
	readonly #ownerHome: string;
	readonly #launcher: PinnedCodexLauncher;
	readonly #containment: CodexContainmentProvisioningPort;
	readonly #inflight = new Map<string, Promise<CodexCapsuleLaunchDescriptor>>();
	readonly #missionTails = new Map<string, Promise<void>>();

	private constructor(
		options: CodexCapsuleProvisionerOptions,
		ownerHome: string,
		launcher: PinnedCodexLauncher,
		dependencies: CodexCapsuleProvisionerDependencies,
	) {
		this.#controlRootDirectory = options.controlRootDirectory;
		this.#runtimeRootDirectory = options.runtimeRootDirectory;
		this.#ownerHome = ownerHome;
		this.#launcher = launcher;
		this.#containment = dependencies.containment ?? productionContainment;
	}

	static async open(
		options: CodexCapsuleProvisionerOptions,
		dependencies: CodexCapsuleProvisionerDependencies = {},
	): Promise<CodexCapsuleProvisioner> {
		const launcher = await (dependencies.resolveLauncher ?? resolvePinnedCodexLauncher)();
		await assertPinnedCodexArtifact(launcher);
		await Promise.all([
			ensurePrivateStateDirectory(options.controlRootDirectory),
			ensurePrivateStateDirectory(options.runtimeRootDirectory),
		]);
		if (
			isPathWithin(options.controlRootDirectory, options.runtimeRootDirectory) ||
			isPathWithin(options.runtimeRootDirectory, options.controlRootDirectory)
		) {
			throw new Error("Codex Capsule control and runtime roots must be disjoint");
		}
		const pinnedLauncher = Object.freeze({
			executable: launcher.executable,
			readRoot: launcher.readRoot,
			sha256: launcher.sha256,
			sandboxHelper: Object.freeze({ ...launcher.sandboxHelper }),
		});
		return new CodexCapsuleProvisioner(
			options,
			await realpath(homedir()),
			pinnedLauncher,
			dependencies,
		);
	}

	async provision(
		inputValue: CodexCapsuleProvisionInput,
		authority: CodexCapsuleProvisioningAuthority,
	): Promise<CodexCapsuleLaunchDescriptor> {
		const input = parseCodexCapsuleProvisionInput(inputValue);
		assertCodexProvisioningAuthorityScope(authority, input);
		const key = `${input.session.missionId}:${digestCanonicalJson(input)}`;
		const existing = this.#inflight.get(key);
		if (existing !== undefined) {
			return performCodexProvisioningAuthorized(authority, input, () => existing);
		}

		const missionId = input.session.missionId;
		const predecessor = this.#missionTails.get(missionId) ?? Promise.resolve();
		const provision = predecessor
			.catch(() => undefined)
			.then(() =>
				performCodexProvisioningAuthorized(authority, input, () =>
					this.provisionAuthorized(input, authority.signal),
				),
			);
		const tail = provision.then(
			() => undefined,
			() => undefined,
		);
		this.#inflight.set(key, provision);
		this.#missionTails.set(missionId, tail);
		void tail.finally(() => {
			if (this.#inflight.get(key) === provision) this.#inflight.delete(key);
			if (this.#missionTails.get(missionId) === tail) this.#missionTails.delete(missionId);
		});
		return provision;
	}

	private async provisionAuthorized(
		input: ParsedCodexCapsuleProvisionInput,
		signal: AbortSignal,
	): Promise<CodexCapsuleLaunchDescriptor> {
		assertCodexProvisioningAuthorityAvailable(signal);
		const controlDirectory = join(this.#controlRootDirectory, input.session.missionId);
		const runtimeDirectory = join(this.#runtimeRootDirectory, input.session.missionId);
		await ensurePrivateStateDirectory(controlDirectory);

		const existingDescriptor = await readDescriptorIfPresent(controlDirectory);
		if (existingDescriptor !== null) {
			return this.recoverExistingDescriptor(
				existingDescriptor,
				input,
				controlDirectory,
				runtimeDirectory,
				this.#launcher,
				signal,
			);
		}

		const containment = await this.establishContainment(
			input,
			controlDirectory,
			runtimeDirectory,
			this.#launcher,
			signal,
		);
		const capsuleId = randomUUID();
		const publishable = codexCapsuleLaunchDescriptorSchema.parse({
			schema_version: 2,
			capsule_id: capsuleId,
			capability_token: `ar_capsule_${randomBytes(32).toString("hex")}`,
			socket_path: capsuleSocketPath(capsuleId),
			session: input.session,
			runtime: {
				kind: "codex",
				runtime_contract: CODEX_CAPSULE_RUNTIME_CONTRACT,
				codex_cli_version: SUPPORTED_CODEX_CLI_VERSION,
				containment: containment.recovery,
			},
		});
		const descriptorPath = join(controlDirectory, CAPSULE_DESCRIPTOR_FILE);
		assertCodexProvisioningAuthorityAvailable(signal);
		const publication = await publishDurableJsonExclusive(descriptorPath, publishable, {
			fileMode: 0o600,
			directoryMode: 0o700,
		});
		assertCodexProvisioningAuthorityAvailable(signal);
		const readback = await requireCodexDescriptor(controlDirectory);
		if (publication === "exists") {
			return this.recoverExistingDescriptor(
				readback,
				input,
				controlDirectory,
				runtimeDirectory,
				this.#launcher,
				signal,
			);
		}
		const manifest = await this.requireManifest(
			join(controlDirectory, CODEX_SANDBOX_MANIFEST_FILE),
		);
		await assertCurrentCodexContainmentManifest(
			manifest,
			input,
			controlDirectory,
			runtimeDirectory,
			this.#launcher,
			this.#ownerHome,
		);
		assertCodexDescriptorContainment(readback, controlDirectory, manifest);
		if (!isDeepStrictEqual(readback, publishable)) {
			throw new Error("Codex Capsule launch descriptor changed during publication");
		}
		assertCodexProvisioningAuthorityAvailable(signal);
		return readback;
	}

	private async establishContainment(
		input: ParsedCodexCapsuleProvisionInput,
		controlDirectory: string,
		runtimeDirectory: string,
		launcher: PinnedCodexLauncher,
		signal: AbortSignal,
	): Promise<CodexSandboxContainment> {
		const manifestPath = join(controlDirectory, CODEX_SANDBOX_MANIFEST_FILE);
		const existingManifest = await this.readManifestIfPresent(manifestPath);
		if (existingManifest !== null) {
			await assertCurrentCodexContainmentManifest(
				existingManifest,
				input,
				controlDirectory,
				runtimeDirectory,
				launcher,
				this.#ownerHome,
			);
		}
		assertCodexProvisioningAuthorityAvailable(signal);
		let containment: CodexSandboxContainment;
		try {
			containment =
				existingManifest === null
					? await this.#containment.prepare(
							containmentInput(input, controlDirectory, runtimeDirectory, launcher),
							signal,
						)
					: await this.#containment.recover(
							codexContainmentRecovery(manifestPath, existingManifest),
							signal,
						);
		} catch (error) {
			if (error instanceof CodexContainmentTerminationError) throw error;
			assertCodexProvisioningAuthorityAvailable(signal);
			throw error;
		}
		assertCodexProvisioningAuthorityAvailable(signal);
		const durableManifest = await this.requireManifest(manifestPath);
		await assertCurrentCodexContainmentManifest(
			durableManifest,
			input,
			controlDirectory,
			runtimeDirectory,
			launcher,
			this.#ownerHome,
		);
		assertRecoveredCodexContainment(
			containment,
			durableManifest,
			input,
			controlDirectory,
			runtimeDirectory,
		);
		return containment;
	}

	private async recoverExistingDescriptor(
		descriptor: CodexCapsuleLaunchDescriptor,
		input: ParsedCodexCapsuleProvisionInput,
		controlDirectory: string,
		runtimeDirectory: string,
		launcher: PinnedCodexLauncher,
		signal: AbortSignal,
	): Promise<CodexCapsuleLaunchDescriptor> {
		if (!isDeepStrictEqual(descriptor.session, input.session)) {
			throw new Error("Existing Codex Capsule descriptor has a different session scope");
		}
		const manifestPath = join(controlDirectory, CODEX_SANDBOX_MANIFEST_FILE);
		if (descriptor.runtime.containment.manifestPath !== manifestPath) {
			throw new Error("Existing Codex Capsule descriptor points outside its control directory");
		}
		const manifest = await this.requireManifest(manifestPath);
		await assertCurrentCodexContainmentManifest(
			manifest,
			input,
			controlDirectory,
			runtimeDirectory,
			launcher,
			this.#ownerHome,
		);
		assertCodexDescriptorContainment(descriptor, controlDirectory, manifest);
		assertCodexProvisioningAuthorityAvailable(signal);
		let containment: CodexSandboxContainment;
		try {
			containment = await this.#containment.recover(descriptor.runtime.containment, signal);
		} catch (error) {
			if (error instanceof CodexContainmentTerminationError) throw error;
			assertCodexProvisioningAuthorityAvailable(signal);
			throw error;
		}
		assertCodexProvisioningAuthorityAvailable(signal);
		assertRecoveredCodexContainment(
			containment,
			manifest,
			input,
			controlDirectory,
			runtimeDirectory,
		);
		return descriptor;
	}

	private async readManifestIfPresent(path: string): Promise<RuntimeContainmentManifest | null> {
		const value = await this.#containment.readManifestIfPresent(path);
		return value === null ? null : parseCodexContainmentManifest(value);
	}

	private async requireManifest(path: string): Promise<RuntimeContainmentManifest> {
		const manifest = await this.readManifestIfPresent(path);
		if (manifest === null) throw new Error("Codex containment manifest is missing");
		return manifest;
	}
}

function containmentInput(
	input: ParsedCodexCapsuleProvisionInput,
	controlDirectory: string,
	runtimeDirectory: string,
	launcher: PinnedCodexLauncher,
): CodexSandboxContainmentInput {
	return Object.freeze({
		controlDirectory,
		runtimeDirectory,
		workspace: input.workspace,
		launcher,
		provider: launcher,
		policyGrantSha256: input.policyGrantSha256,
		workspaceAccess: "read",
	});
}

async function readDescriptorIfPresent(
	controlDirectory: string,
): Promise<CodexCapsuleLaunchDescriptor | null> {
	const path = join(controlDirectory, CAPSULE_DESCRIPTOR_FILE);
	if ((await readPrivateJsonIfPresent(path)) === null) return null;
	return requireCodexDescriptor(controlDirectory);
}

async function requireCodexDescriptor(
	controlDirectory: string,
): Promise<CodexCapsuleLaunchDescriptor> {
	const descriptor = await readCapsuleLaunchDescriptor(controlDirectory);
	if (descriptor.schema_version !== 2) {
		throw new Error("Existing Mission Capsule descriptor does not select Codex");
	}
	return descriptor;
}
