import { createHash } from "node:crypto";
import {
	access,
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SUPPORTED_CODEX_CLI_VERSION } from "./codex-app-server-protocol.js";
import * as codexArtifact from "./codex-artifact.js";
import { runCodexRuntimeDoctor, runCodexWorkspaceMediatorDoctor } from "./codex-runtime-doctor.js";
import type { PinnedCodexLauncher } from "./codex-sandbox-contract.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	await Promise.all(
		temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
	);
});

describe.runIf(process.platform !== "win32")("Codex runtime doctor", () => {
	it("pins the exact owner-selected Git artifact without probing a PATH candidate", async () => {
		const gitExecutable = "/owner/selected/git";
		const pinned = {
			executable: { path: gitExecutable, identity: { device: "1", inode: "2" } },
			sha256: "a".repeat(64),
		};
		const pinGit = vi.fn(async () => pinned);

		const result = await runCodexWorkspaceMediatorDoctor(
			{ signal: new AbortController().signal, gitExecutable },
			{ pinGit },
		);

		expect(pinGit).toHaveBeenCalledOnce();
		expect(pinGit).toHaveBeenCalledWith(gitExecutable);
		expect(result).toEqual(pinned);
		expect(result).not.toBe(pinned);
		expect(Object.isFrozen(result.executable.identity)).toBe(true);
	});

	it("reports a fixed Git-artifact failure before runtime state is opened", async () => {
		await expect(
			runCodexWorkspaceMediatorDoctor(
				{ signal: new AbortController().signal, gitExecutable: "/owner/selected/git" },
				{ pinGit: async () => Promise.reject(new Error("secret owner path failure")) },
			),
		).rejects.toMatchObject({
			name: "CodexRuntimeDoctorError",
			reason: "git",
			message: "Owner-selected Git executable verification failed",
		});
	});

	it("rejects an unsupported production host before resolution or probe state", async () => {
		const homesBefore = await doctorProbeHomes();
		const resolveLauncher = vi.spyOn(codexArtifact, "resolvePinnedCodexLauncher");
		const restoreHost = replaceProcessHost("darwin", "arm64");
		try {
			await expect(
				runCodexRuntimeDoctor({ signal: new AbortController().signal }),
			).rejects.toMatchObject({
				name: "CodexRuntimeDoctorError",
				reason: "unsupported",
				message: "Codex runtime doctor requires linux/x64",
			});
		} finally {
			restoreHost();
		}

		expect(resolveLauncher).not.toHaveBeenCalled();
		expect(await doctorProbeHomes()).toEqual(homesBefore);
	});

	it("does not resolve artifacts or create probe state when already aborted", async () => {
		const homesBefore = await doctorProbeHomes();
		const resolveLauncher = vi.fn(async () => {
			throw new Error("must not resolve");
		});
		const controller = new AbortController();
		controller.abort("secret abort reason");

		await expect(
			runCodexRuntimeDoctor({ signal: controller.signal }, { resolveLauncher }),
		).rejects.toMatchObject({
			name: "CodexRuntimeDoctorError",
			reason: "cancelled",
			message: "Codex runtime doctor was cancelled",
		});
		expect(resolveLauncher).not.toHaveBeenCalled();
		expect(await doctorProbeHomes()).toEqual(homesBefore);
	});

	it("probes the exact immutable launcher in an empty private home without owner secrets", async () => {
		const fixture = await createLauncherFixture();
		const resolveLauncher = vi.fn(async () => fixture.launcher);
		vi.stubEnv("AGENTRELAY_NODE_TOKEN", "relay-secret-must-not-cross");
		vi.stubEnv("OPENAI_API_KEY", "provider-secret-must-not-cross");
		vi.stubEnv("NODE_OPTIONS", "--no-warnings");

		const launcher = await runCodexRuntimeDoctor(
			{ signal: new AbortController().signal },
			{ resolveLauncher },
		);
		const observation = await readObservation(fixture.observationPath);

		expect(resolveLauncher).toHaveBeenCalledTimes(1);
		expect(launcher).toEqual(fixture.launcher);
		expect(Object.isFrozen(launcher)).toBe(true);
		expect(Object.isFrozen(launcher.sandboxHelper)).toBe(true);
		expect(observation.argv).toEqual(["--version"]);
		expect(observation.homeEntries).toEqual([]);
		expect(observation.homeMode).toBe(0o700);
		expect(observation.env.HOME).toBe(observation.home);
		expect(observation.env.CODEX_HOME).toBe(observation.home);
		expect(observation.env.AGENTRELAY_NODE_TOKEN).toBeUndefined();
		expect(observation.env.OPENAI_API_KEY).toBeUndefined();
		expect(observation.env.NODE_OPTIONS).toBeUndefined();
		await expect(access(observation.home)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("reports a fixed version failure and removes the probe home", async () => {
		const fixture = await createLauncherFixture({ version: "0.147.0" });

		const failure = await runCodexRuntimeDoctor(
			{ signal: new AbortController().signal },
			{ resolveLauncher: async () => fixture.launcher },
		).catch((error: unknown) => error);
		const observation = await readObservation(fixture.observationPath);

		expect(failure).toMatchObject({
			name: "CodexRuntimeDoctorError",
			reason: "version",
			message: "Pinned Codex runtime version probe failed",
		});
		expect(String(failure)).not.toContain("0.147.0");
		await expect(access(observation.home)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it.each(["executable", "sandbox helper"] as const)(
		"rejects a changed %s digest before spawning Codex",
		async (artifact) => {
			const fixture = await createLauncherFixture();
			const changedPath =
				artifact === "executable"
					? fixture.launcher.executable
					: fixture.launcher.sandboxHelper.executable;
			await chmod(changedPath, 0o700);
			await writeFile(changedPath, "changed-after-pinning");

			await expect(
				runCodexRuntimeDoctor(
					{ signal: new AbortController().signal },
					{ resolveLauncher: async () => fixture.launcher },
				),
			).rejects.toMatchObject({
				name: "CodexRuntimeDoctorError",
				reason: "artifact",
				message: "Pinned Codex runtime artifact verification failed",
			});
			await expect(access(fixture.observationPath)).rejects.toMatchObject({ code: "ENOENT" });
		},
	);

	it("kills an aborted probe before removing its private home", async () => {
		const fixture = await createLauncherFixture({ waitForAbort: true });
		const controller = new AbortController();
		let pid: number | null = null;
		try {
			const doctor = runCodexRuntimeDoctor(
				{ signal: controller.signal },
				{ resolveLauncher: async () => fixture.launcher },
			);
			const observation = await waitForObservation(fixture.observationPath);
			pid = observation.pid;

			controller.abort("secret abort reason");

			await expect(doctor).rejects.toMatchObject({
				name: "CodexRuntimeDoctorError",
				reason: "cancelled",
				message: "Codex runtime doctor was cancelled",
			});
			await expect(waitForProcessGroupExit(pid, 1_000)).resolves.toBeUndefined();
			await expect(access(observation.home)).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			controller.abort("test cleanup");
			killProcessGroupIfAlive(pid);
		}
	});

	it("kills an oversized-output probe before reporting a fixed version failure", async () => {
		const fixture = await createLauncherFixture({ oversizedOutput: true });
		const failure = await runCodexRuntimeDoctor(
			{ signal: new AbortController().signal },
			{ resolveLauncher: async () => fixture.launcher },
		).catch((error: unknown) => error);
		const observation = await readObservation(fixture.observationPath);

		expect(failure).toMatchObject({
			name: "CodexRuntimeDoctorError",
			reason: "version",
			message: "Pinned Codex runtime version probe failed",
		});
		await expect(waitForProcessGroupExit(observation.pid, 1_000)).resolves.toBeUndefined();
		await expect(access(observation.home)).rejects.toMatchObject({ code: "ENOENT" });
	});
});

interface LauncherFixtureOptions {
	readonly version?: string;
	readonly waitForAbort?: boolean;
	readonly oversizedOutput?: boolean;
}

interface LauncherFixture {
	readonly launcher: PinnedCodexLauncher;
	readonly observationPath: string;
}

interface ProbeObservation {
	readonly argv: string[];
	readonly env: Record<string, string>;
	readonly home: string;
	readonly homeEntries: string[];
	readonly homeMode: number;
	readonly pid: number;
}

async function createLauncherFixture(
	options: LauncherFixtureOptions = {},
): Promise<LauncherFixture> {
	const root = await temporaryDirectory();
	const readRoot = join(root, "artifact");
	const executable = join(readRoot, "codex");
	const sandboxHelper = join(readRoot, "bwrap");
	const observationPath = join(root, "observation.json");
	await mkdir(readRoot, { mode: 0o700 });
	const executableSource = doctorExecutableSource(
		observationPath,
		options.version ?? SUPPORTED_CODEX_CLI_VERSION,
		options.waitForAbort ?? false,
		options.oversizedOutput ?? false,
	);
	await Promise.all([
		writeFile(executable, executableSource, { mode: 0o500 }),
		writeFile(sandboxHelper, "test-bwrap", { mode: 0o500 }),
	]);
	return {
		launcher: {
			executable,
			readRoot,
			sha256: sha256(executableSource),
			sandboxHelper: {
				executable: sandboxHelper,
				readRoot,
				sha256: sha256("test-bwrap"),
			},
		},
		observationPath,
	};
}

function doctorExecutableSource(
	observationPath: string,
	version: string,
	waitForAbort: boolean,
	oversizedOutput: boolean,
): string {
	return `#!${process.execPath}
import { readdirSync, statSync, writeFileSync } from "node:fs";

const home = process.env.HOME;
writeFileSync(${JSON.stringify(observationPath)}, JSON.stringify({
  argv: process.argv.slice(2),
  env: process.env,
  home,
  homeEntries: readdirSync(home),
  homeMode: statSync(home).mode & 0o777,
  pid: process.pid,
}), { mode: 0o600 });
${
	oversizedOutput
		? 'process.stdout.write("x".repeat(2_048)); setInterval(() => undefined, 1_000);'
		: waitForAbort
			? "setInterval(() => undefined, 1_000);"
			: `process.stdout.write(${JSON.stringify(`codex-cli ${version}\n`)});`
}
`;
}

async function doctorProbeHomes(): Promise<string[]> {
	return (await readdir(tmpdir()))
		.filter((name) => name.startsWith("agentrelay-codex-doctor-"))
		.sort();
}

function replaceProcessHost(platform: NodeJS.Platform, arch: string): () => void {
	const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
	const archDescriptor = Object.getOwnPropertyDescriptor(process, "arch");
	if (platformDescriptor === undefined || archDescriptor === undefined) {
		throw new Error("Process host descriptors are unavailable");
	}
	Object.defineProperty(process, "platform", { ...platformDescriptor, value: platform });
	Object.defineProperty(process, "arch", { ...archDescriptor, value: arch });
	return () => {
		Object.defineProperty(process, "platform", platformDescriptor);
		Object.defineProperty(process, "arch", archDescriptor);
	};
}

async function temporaryDirectory(): Promise<string> {
	const path = await realpath(await mkdtemp(join(tmpdir(), "agentrelay-codex-doctor-test-")));
	temporaryDirectories.push(path);
	return path;
}

async function readObservation(path: string): Promise<ProbeObservation> {
	return JSON.parse(await readFile(path, "utf8")) as ProbeObservation;
}

async function waitForObservation(path: string): Promise<ProbeObservation> {
	const deadline = Date.now() + 2_000;
	while (Date.now() < deadline) {
		const value = await readFile(path, "utf8").catch(() => "");
		if (value !== "") return JSON.parse(value) as ProbeObservation;
		await delay(10);
	}
	throw new Error("Timed out waiting for Codex doctor probe");
}

async function waitForProcessGroupExit(pid: number, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (isProcessGroupAlive(pid)) {
		if (Date.now() >= deadline) throw new Error("Codex doctor process group remained alive");
		await delay(10);
	}
}

function killProcessGroupIfAlive(pid: number | null): void {
	if (pid === null || !isProcessGroupAlive(pid)) return;
	process.kill(-pid, "SIGKILL");
}

function isProcessGroupAlive(pid: number): boolean {
	try {
		process.kill(-pid, 0);
		return true;
	} catch (error) {
		return errorCode(error) !== "ESRCH";
	}
}

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? String(error.code)
		: undefined;
}

function sha256(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}
