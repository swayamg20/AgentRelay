import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SUPPORTED_CODEX_CLI_VERSION } from "./codex-app-server-protocol.js";
import { CodexCapsuleProvisioner } from "./codex-capsule-provisioner.js";
import { pinOwnerGitExecutable } from "./codex-git-artifact.js";
import { openCodexNodeRuntime } from "./codex-node-runtime.js";
import * as codexRuntimeDoctor from "./codex-runtime-doctor.js";
import type { PinnedCodexLauncher } from "./codex-sandbox-contract.js";
import { PersistentCodexCapsuleAdapter } from "./persistent-codex-capsule-adapter.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("openCodexNodeRuntime", () => {
	it("pins one Node-wide mediator root and exact owner-selected Git artifact", async () => {
		const stateDirectory = await temporaryDirectory();
		const pinnedLauncher = await createPinnedLauncher(stateDirectory);
		const git = await pinOwnerGitExecutable(pinnedLauncher.executable);
		const launcher = capsuleLauncher();
		const pinGit = vi.fn(async () => git);
		const provisionerOpen = vi.spyOn(CodexCapsuleProvisioner, "open");

		await openCodexNodeRuntime(
			{ stateDirectory, launcher, gitExecutable: git.executable.path },
			{ doctor: { resolveLauncher: async () => pinnedLauncher, pinGit } },
		);

		expect(pinGit).toHaveBeenCalledOnce();
		expect(provisionerOpen).toHaveBeenCalledWith(
			{
				controlRootDirectory: join(stateDirectory, "codex-control"),
				runtimeRootDirectory: join(stateDirectory, "codex-runtime"),
				workspaceGlobalControlRoot: join(stateDirectory, "workspace-patches"),
				gitExecutable: git.executable.path,
			},
			expect.objectContaining({
				resolveLauncher: expect.any(Function),
				resolveGit: expect.any(Function),
			}),
		);
		const provisionerDependencies = provisionerOpen.mock.calls[0]![1]!;
		expect(await provisionerDependencies.resolveGit?.(git.executable.path)).toEqual(git);
		expect(launcher.start).not.toHaveBeenCalled();
	});

	it("opens a matched passive adapter and provisioner beneath the owner state directory", async () => {
		const stateDirectory = await temporaryDirectory();
		const pinnedLauncher = await createPinnedLauncher(stateDirectory);
		const launcher = capsuleLauncher();
		const signal = new AbortController().signal;
		const resolveLauncher = vi.fn(async () => pinnedLauncher);
		const containment = {
			prepare: vi.fn(async () => {
				throw new Error("containment preparation was not expected");
			}),
			recover: vi.fn(async () => {
				throw new Error("containment recovery was not expected");
			}),
			readManifestIfPresent: vi.fn(async () => null),
		};
		const doctorRun = vi.spyOn(codexRuntimeDoctor, "runCodexRuntimeDoctor");
		const provisionerOpen = vi.spyOn(CodexCapsuleProvisioner, "open");
		const adapterOpen = vi.spyOn(PersistentCodexCapsuleAdapter, "open");

		const runtime = await openCodexNodeRuntime(
			{ stateDirectory, launcher, signal },
			{ doctor: { resolveLauncher }, containment },
		);

		const controlRootDirectory = join(stateDirectory, "codex-control");
		const runtimeRootDirectory = join(stateDirectory, "codex-runtime");
		expect(doctorRun).toHaveBeenCalledWith({ signal }, { resolveLauncher });
		expect(provisionerOpen).toHaveBeenCalledWith(
			{ controlRootDirectory, runtimeRootDirectory },
			expect.objectContaining({ resolveLauncher: expect.any(Function), containment }),
		);
		expect(adapterOpen).toHaveBeenCalledWith({
			rootDirectory: controlRootDirectory,
			launcher,
		});
		expect(doctorRun.mock.invocationCallOrder[0]).toBeLessThan(
			provisionerOpen.mock.invocationCallOrder[0]!,
		);
		expect(provisionerOpen.mock.invocationCallOrder[0]!).toBeLessThan(
			adapterOpen.mock.invocationCallOrder[0]!,
		);
		const verifiedLauncher = await doctorRun.mock.results[0]!.value;
		const provisionerDependencies = provisionerOpen.mock.calls[0]![1]!;
		expect(provisionerDependencies.resolveLauncher).not.toBe(resolveLauncher);
		expect(await provisionerDependencies.resolveLauncher?.()).toBe(verifiedLauncher);
		expect(verifiedLauncher).not.toBe(pinnedLauncher);
		expect(runtime.runtimeProvisioner).toBeInstanceOf(CodexCapsuleProvisioner);
		expect(runtime.adapter).toBeInstanceOf(PersistentCodexCapsuleAdapter);
		expect(runtime.authorityPort).toBe(runtime.adapter);
		expect(launcher.start).not.toHaveBeenCalled();
	});

	it("stops before runtime state construction when the doctor fails", async () => {
		const stateDirectory = await temporaryDirectory();
		const pinnedLauncher = await createPinnedLauncher(stateDirectory);
		const launcher = capsuleLauncher();
		const provisionerOpen = vi.spyOn(CodexCapsuleProvisioner, "open");
		const adapterOpen = vi.spyOn(PersistentCodexCapsuleAdapter, "open");

		await expect(
			openCodexNodeRuntime(
				{ stateDirectory, launcher },
				{
					doctor: {
						resolveLauncher: async () => ({
							...pinnedLauncher,
							sha256: "0".repeat(64),
						}),
					},
				},
			),
		).rejects.toMatchObject({ reason: "artifact" });
		expect(provisionerOpen).not.toHaveBeenCalled();
		expect(adapterOpen).not.toHaveBeenCalled();
		expect(launcher.start).not.toHaveBeenCalled();
	});

	it("does not open runtime state when shutdown follows doctor completion", async () => {
		const stateDirectory = await temporaryDirectory();
		const pinnedLauncher = await createPinnedLauncher(stateDirectory);
		const launcher = capsuleLauncher();
		const controller = new AbortController();
		const stopped = new Error("operator stopped the Node");
		const runDoctor = codexRuntimeDoctor.runCodexRuntimeDoctor;
		vi.spyOn(codexRuntimeDoctor, "runCodexRuntimeDoctor").mockImplementation(
			async (options, dependencies) => {
				const verifiedLauncher = await runDoctor(options, dependencies);
				controller.abort(stopped);
				return verifiedLauncher;
			},
		);
		const provisionerOpen = vi.spyOn(CodexCapsuleProvisioner, "open");
		const adapterOpen = vi.spyOn(PersistentCodexCapsuleAdapter, "open");

		await expect(
			openCodexNodeRuntime(
				{ stateDirectory, launcher, signal: controller.signal },
				{ doctor: { resolveLauncher: async () => pinnedLauncher } },
			),
		).rejects.toBe(stopped);
		expect(provisionerOpen).not.toHaveBeenCalled();
		expect(adapterOpen).not.toHaveBeenCalled();
		expect(launcher.start).not.toHaveBeenCalled();
	});

	it("does not open an adapter when shutdown follows provisioner creation", async () => {
		const stateDirectory = await temporaryDirectory();
		const pinnedLauncher = await createPinnedLauncher(stateDirectory);
		const launcher = capsuleLauncher();
		const controller = new AbortController();
		const stopped = new Error("operator stopped the Node");
		const openProvisioner = CodexCapsuleProvisioner.open.bind(CodexCapsuleProvisioner);
		vi.spyOn(CodexCapsuleProvisioner, "open").mockImplementation(async (options, dependencies) => {
			const provisioner = await openProvisioner(options, dependencies);
			controller.abort(stopped);
			return provisioner;
		});
		const adapterOpen = vi.spyOn(PersistentCodexCapsuleAdapter, "open");

		await expect(
			openCodexNodeRuntime(
				{ stateDirectory, launcher, signal: controller.signal },
				{ doctor: { resolveLauncher: async () => pinnedLauncher } },
			),
		).rejects.toBe(stopped);
		expect(adapterOpen).not.toHaveBeenCalled();
		expect(launcher.start).not.toHaveBeenCalled();
	});
});

function capsuleLauncher() {
	return { start: vi.fn(async (_capsuleDirectory: string) => undefined) };
}

async function temporaryDirectory(): Promise<string> {
	const directory = await realpath(await mkdtemp(join(tmpdir(), "agentrelay-codex-node-runtime-")));
	temporaryDirectories.push(directory);
	return directory;
}

async function createPinnedLauncher(root: string): Promise<PinnedCodexLauncher> {
	const readRoot = join(root, "artifact");
	const executable = join(readRoot, "codex");
	const sandboxHelper = join(readRoot, "bwrap");
	const executableSource = `#!${process.execPath}\nprocess.stdout.write("codex-cli ${SUPPORTED_CODEX_CLI_VERSION}\\n");\n`;
	await mkdir(readRoot, { mode: 0o700 });
	await Promise.all([
		writeFile(executable, executableSource, { mode: 0o500 }),
		writeFile(sandboxHelper, "test-bwrap", { mode: 0o500 }),
	]);
	return {
		executable,
		readRoot,
		sha256: sha256(executableSource),
		sandboxHelper: {
			executable: sandboxHelper,
			readRoot,
			sha256: sha256("test-bwrap"),
		},
	};
}

function sha256(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}
