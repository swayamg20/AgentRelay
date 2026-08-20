import { createHash } from "node:crypto";
import {
	chmod,
	lstat,
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { digestCanonicalJson } from "./capsule-correlation.js";
import {
	CAPSULE_DESCRIPTOR_FILE,
	capsuleSocketPath,
	fakeCapsuleLaunchDescriptorSchema,
	readCapsuleLaunchDescriptor,
} from "./capsule-launch-descriptor.js";
import {
	type CodexCapsuleProvisionInput,
	CodexCapsuleProvisioner,
	type CodexCapsuleProvisioningAuthority,
	type CodexContainmentProvisioningPort,
} from "./codex-capsule-provisioner.js";
import { codexProviderEgressBinding } from "./codex-provider-egress-policy.js";
import type {
	CodexSandboxContainment,
	CodexSandboxContainmentInput,
	CodexSandboxRecoveryExpectation,
	CodexWorkspaceAccess,
	PinnedCodexLauncher,
} from "./codex-sandbox-contract.js";
import { CodexContainmentTerminationError } from "./codex-sandbox-contract.js";
import { writeDurableJson } from "./durable-file.js";
import type { PreparedMissionWorkspace } from "./mission-workspace.js";
import { authorityGrant } from "./runtime-authority.test-support.js";
import {
	RUNTIME_CONTAINMENT_BACKEND,
	type RuntimeContainmentBinding,
	type RuntimeContainmentManifest,
	boundPath,
	runtimeContainmentBindingSchema,
	runtimeContainmentManifestSchema,
	workspaceBinding,
} from "./runtime-containment-manifest.js";
import { workspaceResourceSha256 } from "./workspace-resource.js";

const IDS = {
	mission: "98000000-0000-4000-8000-000000000001",
	agent: "98000000-0000-4000-8000-000000000002",
	otherAgent: "98000000-0000-4000-8000-000000000003",
	containment: "98000000-0000-4000-8000-000000000004",
} as const;
const POLICY_SHA256 = "b".repeat(64);
const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("CodexCapsuleProvisioner", () => {
	it("pins the artifact at open and publishes a strict passive v2 descriptor", async () => {
		const fixture = await createFixture();
		const activation = activationFor(fixture.input);

		const descriptor = await fixture.provisioner.provision(fixture.input, activation.authority);

		expect(fixture.resolveCalls).toBe(1);
		expect(fixture.port.prepareCalls).toBe(1);
		expect(fixture.port.recoverCalls).toBe(0);
		expect(fixture.port.boundaryPrepareCalls).toBe(0);
		expect(activation.effectCalls).toBe(1);
		expect(fixture.port.prepareInputs[0]).toMatchObject({
			controlDirectory: join(fixture.controlRoot, IDS.mission),
			runtimeDirectory: join(fixture.runtimeRoot, IDS.mission),
			workspaceAccess: "read",
			policyGrantSha256: POLICY_SHA256,
		});
		expect(fixture.port.prepareInputs[0]?.provider).toBe(fixture.port.prepareInputs[0]?.launcher);
		expect(descriptor.schema_version).toBe(2);
		expect(descriptor.runtime.kind).toBe("codex");
		expect(await readCapsuleLaunchDescriptor(join(fixture.controlRoot, IDS.mission))).toEqual(
			descriptor,
		);
		const descriptorStats = await stat(
			join(fixture.controlRoot, IDS.mission, CAPSULE_DESCRIPTOR_FILE),
		);
		expect(descriptorStats.mode & 0o777).toBe(0o600);
		expect(descriptorStats.nlink).toBe(1);

		const replay = await fixture.provisioner.provision(
			fixture.input,
			activationFor(fixture.input).authority,
		);
		expect(replay).toEqual(descriptor);
		expect(fixture.resolveCalls).toBe(1);
		expect(fixture.port.prepareCalls).toBe(1);
		expect(fixture.port.recoverCalls).toBe(1);
	});

	it("recovers only an exact prepublished descriptor without creating containment", async () => {
		const fixture = await createFixture();
		const descriptor = await fixture.provisioner.provision(
			fixture.input,
			activationFor(fixture.input).authority,
		);
		await writeFile(join(fixture.workspace.root, "model-created.txt"), "expected edit\n");
		const prepareCalls = fixture.port.prepareCalls;

		await expect(
			fixture.provisioner.recover(fixture.input, activationFor(fixture.input).authority),
		).resolves.toEqual(descriptor);

		expect(fixture.port.prepareCalls).toBe(prepareCalls);
		expect(fixture.port.recoverCalls).toBe(1);
	});

	it("provisions and recovers explicit write containment only under write authority", async () => {
		const fixture = await createFixture("write");
		const provisionAuthority = activationFor(fixture.input);

		const descriptor = await fixture.provisioner.provision(
			fixture.input,
			provisionAuthority.authority,
		);

		expect(provisionAuthority.readEffectCalls).toBe(0);
		expect(provisionAuthority.writeEffectCalls).toBe(1);
		expect(fixture.port.prepareInputs[0]?.workspaceAccess).toBe("write");
		expect(fixture.port.manifest?.binding.workspace_access).toBe("write");

		const recoveryAuthority = activationFor(fixture.input);
		await expect(
			fixture.provisioner.recover(fixture.input, recoveryAuthority.authority),
		).resolves.toEqual(descriptor);
		expect(recoveryAuthority.readEffectCalls).toBe(0);
		expect(recoveryAuthority.writeEffectCalls).toBe(1);
		expect(fixture.port.recoverCalls).toBe(1);
	});

	it("does not create or repair runtime state when recover-only state is missing", async () => {
		const fixture = await createFixture();
		const missionDirectory = join(fixture.controlRoot, IDS.mission);

		await expect(
			fixture.provisioner.recover(fixture.input, activationFor(fixture.input).authority),
		).rejects.toThrow("launch descriptor is missing");

		expect(fixture.port.prepareCalls).toBe(0);
		expect(fixture.port.recoverCalls).toBe(0);
		await expect(stat(missionDirectory)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("does not promote an orphan manifest during recover-only provisioning", async () => {
		const fixture = await createFixture();
		const descriptorPath = join(fixture.controlRoot, IDS.mission, CAPSULE_DESCRIPTOR_FILE);
		await fixture.port.seed(
			containmentInput(fixture),
			join(fixture.controlRoot, IDS.mission, "containment.json"),
		);

		await expect(
			fixture.provisioner.recover(fixture.input, activationFor(fixture.input).authority),
		).rejects.toThrow("launch descriptor is missing");

		expect(fixture.port.prepareCalls).toBe(0);
		expect(fixture.port.recoverCalls).toBe(0);
		await expect(stat(descriptorPath)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("recovers an exact manifest-before-descriptor crash without creating new containment", async () => {
		const fixture = await createFixture();
		await fixture.port.seed(
			containmentInput(fixture),
			join(fixture.controlRoot, IDS.mission, "containment.json"),
		);

		const descriptor = await fixture.provisioner.provision(
			fixture.input,
			activationFor(fixture.input).authority,
		);

		expect(descriptor.runtime.containment).toEqual(fixture.port.recovery);
		expect(fixture.port.prepareCalls).toBe(0);
		expect(fixture.port.recoverCalls).toBe(1);
	});

	it("coalesces identical concurrent intent before containment creation", async () => {
		const fixture = await createFixture();
		const gate = deferred<void>();
		fixture.port.prepareGate = gate.promise;
		const firstAuthority = activationFor(fixture.input);
		const secondAuthority = activationFor(fixture.input);

		const first = fixture.provisioner.provision(fixture.input, firstAuthority.authority);
		await fixture.port.prepareStarted.promise;
		const second = fixture.provisioner.provision(fixture.input, secondAuthority.authority);
		gate.resolve();

		const [firstDescriptor, secondDescriptor] = await Promise.all([first, second]);
		expect(secondDescriptor).toEqual(firstDescriptor);
		expect(fixture.port.prepareCalls).toBe(1);
		expect(fixture.port.recoverCalls).toBe(0);
		expect(firstAuthority.effectCalls).toBe(1);
		expect(secondAuthority.effectCalls).toBe(1);
	});

	it("serializes different intent for one Mission and validates it against the winner", async () => {
		const fixture = await createFixture();
		const gate = deferred<void>();
		fixture.port.prepareGate = gate.promise;
		const changedInput = { ...fixture.input, policyGrantSha256: "c".repeat(64) };

		const first = fixture.provisioner.provision(
			fixture.input,
			activationFor(fixture.input).authority,
		);
		await fixture.port.prepareStarted.promise;
		const changed = fixture.provisioner.provision(
			changedInput,
			activationFor(changedInput).authority,
		);
		expect(fixture.port.prepareCalls).toBe(1);
		gate.resolve();

		await expect(first).resolves.toMatchObject({ schema_version: 2 });
		await expect(changed).rejects.toThrow("Node-owned provisioning input");
		expect(fixture.port.prepareCalls).toBe(1);
		expect(fixture.port.recoverCalls).toBe(0);
	});

	it("rejects a mismatched orphan manifest before recovery can run", async () => {
		const fixture = await createFixture();
		await fixture.port.seed(
			containmentInput(fixture),
			join(fixture.controlRoot, IDS.mission, "containment.json"),
		);
		fixture.port.mutateBinding((binding) => {
			binding.workspace_access = "write";
		});

		await expect(
			fixture.provisioner.provision(fixture.input, activationFor(fixture.input).authority),
		).rejects.toThrow("Node-owned provisioning input");

		expect(fixture.port.prepareCalls).toBe(0);
		expect(fixture.port.recoverCalls).toBe(0);
		await expect(
			stat(join(fixture.controlRoot, IDS.mission, CAPSULE_DESCRIPTOR_FILE)),
		).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("does not treat an access-less legacy manifest as current write authority", async () => {
		const fixture = await createFixture("write");
		await fixture.port.seed(
			containmentInput(fixture),
			join(fixture.controlRoot, IDS.mission, "containment.json"),
		);
		fixture.port.mutateBinding((binding) => {
			delete binding.workspace_access;
		});

		await expect(
			fixture.provisioner.provision(fixture.input, activationFor(fixture.input).authority),
		).rejects.toThrow("Node-owned provisioning input");

		expect(fixture.port.prepareCalls).toBe(0);
		expect(fixture.port.recoverCalls).toBe(0);
	});

	it("rejects a read manifest for a write grant before containment recovery", async () => {
		const fixture = await createFixture("write");
		await fixture.port.seed(
			containmentInput(fixture),
			join(fixture.controlRoot, IDS.mission, "containment.json"),
		);
		fixture.port.mutateBinding((binding) => {
			binding.workspace_access = "read";
		});

		await expect(
			fixture.provisioner.provision(fixture.input, activationFor(fixture.input).authority),
		).rejects.toThrow("Node-owned provisioning input");

		expect(fixture.port.prepareCalls).toBe(0);
		expect(fixture.port.recoverCalls).toBe(0);
	});

	it.each(["path", "instance", "digest"] as const)(
		"rejects a descriptor containment %s mismatch before alternate recovery",
		async (mismatch) => {
			const fixture = await createFixture();
			const descriptor = await fixture.provisioner.provision(
				fixture.input,
				activationFor(fixture.input).authority,
			);
			const containment = {
				...descriptor.runtime.containment,
				...(mismatch === "path"
					? { manifestPath: join(fixture.root, "alternate", "containment.json") }
					: mismatch === "instance"
						? { instanceId: "98000000-0000-4000-8000-000000000088" }
						: { bindingSha256: "f".repeat(64) }),
			};
			const tampered = {
				...descriptor,
				runtime: { ...descriptor.runtime, containment },
			};
			const directory = join(fixture.controlRoot, IDS.mission);
			await writeDurableJson(join(directory, CAPSULE_DESCRIPTOR_FILE), tampered, {
				fileMode: 0o600,
				directoryMode: 0o700,
			});
			const readsBefore = fixture.port.readManifestCalls;
			const pathsBefore = fixture.port.readPaths.length;

			await expect(
				fixture.provisioner.provision(fixture.input, activationFor(fixture.input).authority),
			).rejects.toThrow();

			expect(fixture.port.recoverCalls).toBe(0);
			const newReadPaths = fixture.port.readPaths.slice(pathsBefore);
			if (mismatch === "path") expect(newReadPaths).not.toContain(containment.manifestPath);
			expect(fixture.port.readManifestCalls - readsBefore).toBe(mismatch === "path" ? 0 : 1);
		},
	);

	it.each(["scope", "workspace", "policy", "artifact", "access", "path"] as const)(
		"rejects a changed %s before recovery and never rewrites launch authority",
		async (mismatch) => {
			const fixture = await createFixture();
			await fixture.provisioner.provision(fixture.input, activationFor(fixture.input).authority);
			const descriptorPath = join(fixture.controlRoot, IDS.mission, CAPSULE_DESCRIPTOR_FILE);
			const before = await readFile(descriptorPath, "utf8");
			let input = fixture.input;
			if (mismatch === "scope") {
				input = { ...input, session: { ...input.session, participantId: IDS.otherAgent } };
			} else if (mismatch === "workspace") {
				input = {
					...input,
					workspace: { ...input.workspace, repositoryUrl: "https://example.com/other.git" },
				};
			} else if (mismatch === "policy") {
				input = { ...input, policyGrantSha256: "c".repeat(64) };
			} else if (mismatch === "artifact") {
				await chmod(fixture.launcher.executable, 0o700);
				await writeFile(fixture.launcher.executable, "tampered", { mode: 0o500 });
				await chmod(fixture.launcher.executable, 0o500);
			} else if (mismatch === "access") {
				fixture.port.mutateBinding((binding) => {
					binding.workspace_access = "write";
				});
			} else {
				fixture.port.mutateBinding((binding) => {
					binding.private_paths.control_root.path = join(fixture.controlRoot, "other-control");
				});
			}

			await expect(
				fixture.provisioner.provision(input, activationFor(input).authority),
			).rejects.toThrow();

			expect(fixture.port.recoverCalls).toBe(0);
			expect(await readFile(descriptorPath, "utf8")).toBe(before);
		},
	);

	it("rejects wrong or expired authority before containment and publication", async () => {
		const fixture = await createFixture();
		const wrongResource = activationFor(fixture.input, {
			workspace_resource_sha256: "d".repeat(64),
		});

		await expect(
			fixture.provisioner.provision(fixture.input, wrongResource.authority),
		).rejects.toMatchObject({ code: "wrong_resource" });
		expect(fixture.port.prepareCalls).toBe(0);

		const expired = activationFor(fixture.input);
		expired.abort.abort("expired");
		await expect(
			fixture.provisioner.provision(fixture.input, expired.authority),
		).rejects.toMatchObject({ code: "expired" });
		expect(fixture.port.prepareCalls).toBe(0);
	});

	it("rejects write provisioning without both workspace capabilities", async () => {
		const fixture = await createFixture("write");
		const missingWrite = activationFor(fixture.input, {
			capabilities: authorityGrant().capabilities,
		});

		await expect(
			fixture.provisioner.provision(fixture.input, missingWrite.authority),
		).rejects.toMatchObject({ code: "capability_missing" });
		expect(fixture.port.prepareCalls).toBe(0);

		const missingRead = activationFor(fixture.input, {
			capabilities: writeCapabilities().filter(
				(capability) => capability.action !== "workspace_read",
			),
		});
		await expect(
			fixture.provisioner.provision(fixture.input, missingRead.authority),
		).rejects.toMatchObject({ code: "capability_missing" });
		expect(fixture.port.prepareCalls).toBe(0);
	});

	it("does not publish when authority expires during containment preparation", async () => {
		const fixture = await createFixture();
		const activation = activationFor(fixture.input);
		fixture.port.afterPrepare = () => activation.abort.abort("expired");

		await expect(
			fixture.provisioner.provision(fixture.input, activation.authority),
		).rejects.toMatchObject({ code: "expired" });

		await expect(
			stat(join(fixture.controlRoot, IDS.mission, CAPSULE_DESCRIPTOR_FILE)),
		).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("interrupts in-flight containment promptly and does not publish", async () => {
		const fixture = await createFixture();
		const activation = activationFor(fixture.input);
		fixture.port.prepareGate = deferred<void>().promise;

		const provisioning = fixture.provisioner.provision(fixture.input, activation.authority);
		await fixture.port.prepareStarted.promise;
		activation.abort.abort("expired");

		await expect(settleWithin(provisioning, 1_000)).rejects.toMatchObject({ code: "expired" });
		expect(fixture.port.prepareSignals).toEqual([activation.authority.signal]);
		expect(fixture.port.manifest).toBeNull();
		await expect(
			stat(join(fixture.controlRoot, IDS.mission, CAPSULE_DESCRIPTOR_FILE)),
		).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("does not mask an unproven containment teardown as an authority denial", async () => {
		const fixture = await createFixture();
		const activation = activationFor(fixture.input);
		const terminationFailure = new CodexContainmentTerminationError();
		fixture.port.afterPrepare = () => activation.abort.abort("expired");
		fixture.port.prepareFailure = terminationFailure;

		await expect(fixture.provisioner.provision(fixture.input, activation.authority)).rejects.toBe(
			terminationFailure,
		);
		await expect(
			stat(join(fixture.controlRoot, IDS.mission, CAPSULE_DESCRIPTOR_FILE)),
		).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("fails closed on a legacy v1 fake descriptor without changing its bytes", async () => {
		const fixture = await createFixture();
		const directory = join(fixture.controlRoot, IDS.mission);
		await mkdir(directory, { recursive: true, mode: 0o700 });
		const capsuleId = "98000000-0000-4000-8000-000000000099";
		const fake = fakeCapsuleLaunchDescriptorSchema.parse({
			schema_version: 1,
			capsule_id: capsuleId,
			capability_token: `ar_capsule_${"e".repeat(64)}`,
			socket_path: capsuleSocketPath(capsuleId),
			session: fixture.input.session,
			runtime: { kind: "fake", outcome: "ready", completion_delay_ms: 0 },
		});
		const path = join(directory, CAPSULE_DESCRIPTOR_FILE);
		await writeDurableJson(path, fake, { fileMode: 0o600, directoryMode: 0o700 });
		const before = await readFile(path, "utf8");

		await expect(
			fixture.provisioner.provision(fixture.input, activationFor(fixture.input).authority),
		).rejects.toThrow("does not select Codex");

		expect(await readFile(path, "utf8")).toBe(before);
		expect(fixture.port.prepareCalls).toBe(0);
		expect(fixture.port.recoverCalls).toBe(0);
	});

	it("rejects tampered installed bytes while opening, before provisioning state is created", async () => {
		const root = await temporaryDirectory();
		const launcher = await createLauncher(root);
		await chmod(launcher.sandboxHelper.executable, 0o700);
		await writeFile(launcher.sandboxHelper.executable, "tampered", { mode: 0o500 });

		await expect(
			CodexCapsuleProvisioner.open(
				{
					controlRootDirectory: join(root, "control"),
					runtimeRootDirectory: join(root, "runtime"),
				},
				{ resolveLauncher: async () => launcher },
			),
		).rejects.toThrow("artifact digest");
		await expect(stat(join(root, "control"))).rejects.toMatchObject({ code: "ENOENT" });
	});
});

interface Fixture {
	readonly root: string;
	readonly controlRoot: string;
	readonly runtimeRoot: string;
	readonly launcher: PinnedCodexLauncher;
	readonly workspace: PreparedMissionWorkspace;
	readonly input: CodexCapsuleProvisionInput;
	readonly port: RecordingContainmentPort;
	readonly provisioner: CodexCapsuleProvisioner;
	readonly resolveCalls: number;
}

async function createFixture(workspaceAccess: CodexWorkspaceAccess = "read"): Promise<Fixture> {
	const root = await temporaryDirectory();
	const controlRoot = join(root, "control");
	const runtimeRoot = join(root, "runtime");
	await Promise.all([mkdir(controlRoot, { mode: 0o700 }), mkdir(runtimeRoot, { mode: 0o700 })]);
	const launcher = await createLauncher(root);
	const workspace = await createWorkspace(root);
	const input: CodexCapsuleProvisionInput = {
		session: {
			missionId: IDS.mission,
			participantId: IDS.agent,
			workspaceAlias: "backend",
		},
		workspace,
		policyGrantSha256: POLICY_SHA256,
		workspaceAccess,
	};
	const port = new RecordingContainmentPort();
	let resolveCalls = 0;
	const provisioner = await CodexCapsuleProvisioner.open(
		{ controlRootDirectory: controlRoot, runtimeRootDirectory: runtimeRoot },
		{
			resolveLauncher: async () => {
				resolveCalls += 1;
				return launcher;
			},
			containment: port,
		},
	);
	return {
		root,
		controlRoot,
		runtimeRoot,
		launcher,
		workspace,
		input,
		port,
		provisioner,
		get resolveCalls() {
			return resolveCalls;
		},
	};
}

class RecordingContainmentPort implements CodexContainmentProvisioningPort {
	manifest: RuntimeContainmentManifest | null = null;
	manifestPath: string | null = null;
	prepareCalls = 0;
	recoverCalls = 0;
	readManifestCalls = 0;
	boundaryPrepareCalls = 0;
	readPaths: string[] = [];
	prepareInputs: CodexSandboxContainmentInput[] = [];
	prepareSignals: AbortSignal[] = [];
	recoverSignals: AbortSignal[] = [];
	prepareGate: Promise<void> | null = null;
	afterPrepare: (() => void) | null = null;
	prepareFailure: Error | null = null;
	readonly prepareStarted = deferred<void>();

	get recovery(): CodexSandboxRecoveryExpectation | null {
		return this.manifest === null || this.manifestPath === null
			? null
			: recovery(this.manifestPath, this.manifest);
	}

	async prepare(
		input: CodexSandboxContainmentInput,
		signal: AbortSignal,
	): Promise<CodexSandboxContainment> {
		this.prepareCalls += 1;
		this.prepareInputs.push(input);
		this.prepareSignals.push(signal);
		this.prepareStarted.resolve();
		await waitForGateOrAbort(this.prepareGate, signal);
		await this.seed(input, join(input.controlDirectory, "containment.json"));
		this.afterPrepare?.();
		if (this.prepareFailure !== null) throw this.prepareFailure;
		return this.containment();
	}

	async recover(
		expectation: CodexSandboxRecoveryExpectation,
		signal: AbortSignal,
	): Promise<CodexSandboxContainment> {
		this.recoverCalls += 1;
		this.recoverSignals.push(signal);
		signal.throwIfAborted();
		if (this.manifest === null || this.manifestPath === null) {
			throw new Error("test containment manifest is missing");
		}
		if (!sameJson(expectation, recovery(this.manifestPath, this.manifest))) {
			throw new Error("test recovery expectation mismatch");
		}
		return this.containment();
	}

	async readManifestIfPresent(path: string): Promise<unknown | null> {
		this.readManifestCalls += 1;
		this.readPaths.push(path);
		if (this.manifest === null) return null;
		if (path !== this.manifestPath) throw new Error("test manifest path mismatch");
		return structuredClone(this.manifest);
	}

	async seed(input: CodexSandboxContainmentInput, manifestPath: string): Promise<void> {
		await prepareFakeLayout(input);
		const binding = await runtimeBinding(input);
		this.manifestPath = manifestPath;
		this.manifest = manifestFor(binding);
	}

	mutateBinding(mutator: (binding: RuntimeContainmentBinding) => void): void {
		if (this.manifest === null) throw new Error("test containment manifest is missing");
		const binding = structuredClone(this.manifest.binding);
		mutator(binding);
		this.manifest = manifestFor(binding, this.manifest.instance_id);
	}

	private containment(): CodexSandboxContainment {
		if (this.manifest === null || this.manifestPath === null) {
			throw new Error("test containment manifest is missing");
		}
		const manifest = this.manifest;
		const runtimeDirectory = manifest.binding.private_paths.runtime_root.path;
		return {
			boundary: {
				prepare: async () => {
					this.boundaryPrepareCalls += 1;
					throw new Error("provider boundary must remain passive during provisioning");
				},
			},
			evidence: {
				instanceId: manifest.instance_id,
				backend: RUNTIME_CONTAINMENT_BACKEND,
				runtimeVersion: "0.146.0",
				baseCommit: manifest.binding.workspace.base_commit,
				bindingSha256: manifest.binding_sha256,
				retention: "retain_for_review",
			},
			authorization: {
				controlDirectory: manifest.binding.private_paths.control_root.path,
				runtimeDirectory,
				providerExecutable: manifest.binding.provider.executable.path,
				runtimeVersion: "0.146.0",
				policyGrantSha256: manifest.binding.policy_grant_sha256,
				workspaceAccess: manifest.binding.workspace_access ?? "write",
				workspace: {
					root: manifest.binding.workspace.root.path,
					repositoryUrl: manifest.binding.workspace.repository_url,
					headCommit: manifest.binding.workspace.base_commit,
					reachableFromRef: manifest.binding.workspace.reachable_from_ref,
				},
			},
			recovery: recovery(this.manifestPath, manifest),
			runtimeHome: manifest.binding.private_paths.runtime_home.path,
			runtimeTmp: manifest.binding.private_paths.runtime_tmp.path,
		};
	}
}

async function runtimeBinding(
	input: CodexSandboxContainmentInput,
): Promise<RuntimeContainmentBinding> {
	const control = input.controlDirectory;
	const runtime = input.runtimeDirectory;
	const launcherHome = join(control, "sandbox-launcher");
	const probeRoot = join(runtime, "probe-runtime");
	const probe = join(probeRoot, "bin", "node");
	const ownerHome = await realpath(homedir());
	return runtimeContainmentBindingSchema.parse({
		backend: RUNTIME_CONTAINMENT_BACKEND,
		runtime_version: "0.146.0",
		workspace_access: input.workspaceAccess,
		workspace: workspaceBinding(input.workspace),
		launcher: {
			executable: await inspectedPath(input.launcher.executable),
			executable_sha256: input.launcher.sha256,
			read_root: await inspectedPath(input.launcher.readRoot),
			sandbox_helper: {
				executable: await inspectedPath(input.launcher.sandboxHelper.executable),
				executable_sha256: input.launcher.sandboxHelper.sha256,
			},
			config_path: join(launcherHome, "config.toml"),
			config_sha256: sha256("test-config"),
		},
		provider: {
			executable: await inspectedPath(input.provider.executable),
			executable_sha256: input.provider.sha256,
			read_root: await inspectedPath(input.provider.readRoot),
		},
		provider_egress: codexProviderEgressBinding(),
		probe: {
			executable: await inspectedPath(probe),
			executable_sha256: sha256("test-probe"),
			read_root: await inspectedPath(probeRoot),
		},
		private_paths: {
			control_root: await inspectedPath(control),
			launcher_home: await inspectedPath(launcherHome),
			runtime_root: await inspectedPath(runtime),
			runtime_home: await inspectedPath(join(runtime, "codex-home")),
			runtime_tmp: await inspectedPath(join(runtime, "tmp")),
		},
		read_only_roots: [],
		denied_roots: await Promise.all([ownerHome, control].sort().map((path) => inspectedPath(path))),
		policy_grant_sha256: input.policyGrantSha256,
	});
}

async function prepareFakeLayout(input: CodexSandboxContainmentInput): Promise<void> {
	const launcherHome = join(input.controlDirectory, "sandbox-launcher");
	const probeRoot = join(input.runtimeDirectory, "probe-runtime");
	await Promise.all([
		mkdir(launcherHome, { recursive: true, mode: 0o700 }),
		mkdir(join(probeRoot, "bin"), { recursive: true, mode: 0o700 }),
		mkdir(join(input.runtimeDirectory, "codex-home"), { recursive: true, mode: 0o700 }),
		mkdir(join(input.runtimeDirectory, "tmp"), { recursive: true, mode: 0o700 }),
	]);
	await Promise.all([
		writeFile(join(launcherHome, "config.toml"), "test-config", { mode: 0o600 }),
		writeFile(join(probeRoot, "bin", "node"), "test-probe", { mode: 0o500 }),
	]);
}

function manifestFor(
	binding: RuntimeContainmentBinding,
	instanceId: string = IDS.containment,
): RuntimeContainmentManifest {
	return runtimeContainmentManifestSchema.parse({
		schema_version: 1,
		instance_id: instanceId,
		created_at: "2026-08-19T00:00:00.000Z",
		retention: "retain_for_review",
		binding_sha256: digestCanonicalJson(binding),
		binding,
	});
}

function recovery(
	manifestPath: string,
	manifest: RuntimeContainmentManifest,
): CodexSandboxRecoveryExpectation {
	return {
		manifestPath,
		instanceId: manifest.instance_id,
		bindingSha256: manifest.binding_sha256,
	};
}

function containmentInput(fixture: Fixture): CodexSandboxContainmentInput {
	return {
		controlDirectory: join(fixture.controlRoot, IDS.mission),
		runtimeDirectory: join(fixture.runtimeRoot, IDS.mission),
		workspace: fixture.workspace,
		launcher: fixture.launcher,
		provider: fixture.launcher,
		policyGrantSha256: POLICY_SHA256,
		workspaceAccess: fixture.input.workspaceAccess,
	};
}

function activationFor(
	input: CodexCapsuleProvisionInput,
	grantOverrides: Parameters<typeof authorityGrant>[0] = {},
) {
	const abort = new AbortController();
	let readEffectCalls = 0;
	let writeEffectCalls = 0;
	const workspaceResource = workspaceResourceSha256({
		workspaceBindingId: "97000000-0000-4000-8000-000000000004",
		workspaceAlias: input.session.workspaceAlias,
		root: input.workspace.root,
		repositoryUrl: input.workspace.repositoryUrl,
		headCommit: input.workspace.baseCommit,
		reachableFromRef: input.workspace.reachableFromRef,
	});
	const capabilities =
		input.workspaceAccess === "write" ? writeCapabilities() : authorityGrant().capabilities;
	const grant = authorityGrant({
		agent_id: input.session.participantId,
		mission_id: input.session.missionId,
		workspace_alias: input.session.workspaceAlias,
		workspace_resource_sha256: workspaceResource,
		policy_grant_sha256: input.policyGrantSha256,
		lease_expires_at: "2099-08-19T00:01:00.000Z",
		hard_expires_at: "2099-08-19T00:05:00.000Z",
		capabilities,
		...grantOverrides,
	});
	const authority: CodexCapsuleProvisioningAuthority = {
		grant,
		signal: abort.signal,
		async performWorkspaceRead<T>(effect: () => T | Promise<T>): Promise<T> {
			readEffectCalls += 1;
			return effect();
		},
		async performWorkspaceWrite<T>(effect: () => T | Promise<T>): Promise<T> {
			writeEffectCalls += 1;
			return effect();
		},
	};
	return {
		authority,
		abort,
		get effectCalls() {
			return readEffectCalls + writeEffectCalls;
		},
		get readEffectCalls() {
			return readEffectCalls;
		},
		get writeEffectCalls() {
			return writeEffectCalls;
		},
	};
}

function writeCapabilities() {
	return [
		...authorityGrant().capabilities,
		{ action: "workspace_write", resource: "workspace" } as const,
	];
}

async function createLauncher(root: string): Promise<PinnedCodexLauncher> {
	const readRoot = join(root, "artifact", "vendor", "x86_64-unknown-linux-musl");
	const executable = join(readRoot, "bin", "codex");
	const helper = join(readRoot, "codex-resources", "bwrap");
	await Promise.all([
		mkdir(join(readRoot, "bin"), { recursive: true, mode: 0o700 }),
		mkdir(join(readRoot, "codex-resources"), { recursive: true, mode: 0o700 }),
	]);
	await Promise.all([
		writeFile(executable, "test-codex", { mode: 0o500 }),
		writeFile(helper, "test-bwrap", { mode: 0o500 }),
	]);
	return {
		executable,
		readRoot,
		sha256: sha256("test-codex"),
		sandboxHelper: { executable: helper, readRoot, sha256: sha256("test-bwrap") },
	};
}

async function createWorkspace(root: string): Promise<PreparedMissionWorkspace> {
	const workspaceRoot = join(root, "workspace");
	const gitDirectory = join(workspaceRoot, ".git");
	await mkdir(gitDirectory, { recursive: true, mode: 0o700 });
	return {
		repositoryUrl: "https://example.com/backend.git",
		baseCommit: "1".repeat(40),
		root: workspaceRoot,
		gitDirectory,
		rootIdentity: await identity(workspaceRoot),
		gitIdentity: await identity(gitDirectory),
		reachableFromRef: "refs/heads/main",
	};
}

async function inspectedPath(path: string) {
	return boundPath(path, await identity(path));
}

async function identity(path: string): Promise<{ device: string; inode: string }> {
	const stats = await lstat(path, { bigint: true });
	return { device: stats.dev.toString(), inode: stats.ino.toString() };
}

function sha256(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

function sameJson(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((accept) => {
		resolve = accept;
	});
	return { promise, resolve };
}

async function waitForGateOrAbort(gate: Promise<void> | null, signal: AbortSignal): Promise<void> {
	signal.throwIfAborted();
	if (gate === null) return;
	let rejectAborted!: (reason?: unknown) => void;
	const aborted = new Promise<never>((_resolve, reject) => {
		rejectAborted = reject;
	});
	const onAbort = () => rejectAborted(signal.reason);
	signal.addEventListener("abort", onAbort, { once: true });
	try {
		if (signal.aborted) onAbort();
		await Promise.race([gate, aborted]);
		signal.throwIfAborted();
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}

function settleWithin<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timeout = setTimeout(
			() => reject(new Error("Provisioning did not stop promptly after authority revocation")),
			milliseconds,
		);
		promise.then(
			(value) => {
				clearTimeout(timeout);
				resolve(value);
			},
			(error: unknown) => {
				clearTimeout(timeout);
				reject(error);
			},
		);
	});
}

async function temporaryDirectory(): Promise<string> {
	const path = await realpath(await mkdtemp(join(tmpdir(), "agentrelay-codex-provisioner-")));
	temporaryDirectories.push(path);
	return path;
}
