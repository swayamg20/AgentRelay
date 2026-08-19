import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, readlink, realpath, unlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
	CODEX_SANDBOX_OFFLINE_PROFILE_NAME,
	CodexContainmentTerminationError,
	type CodexWorkspaceAccess,
	type PinnedExecutable,
} from "./codex-sandbox-contract.js";
import { assertContainmentProbeAttestation } from "./codex-sandbox-probe-attestation.js";
import { killProcessGroupAndProveTerminated } from "./process-group-termination.js";

const PROBE_TIMEOUT_MS = 10_000;
const MAX_PROBE_OUTPUT_BYTES = 64 * 1_024;
const MAX_DIAGNOSTIC_OUTPUT_CHARS = 512;
const PROCESS_GROUP_EXIT_TIMEOUT_MS = 2_000;

export type ContainmentProbeExecutable = PinnedExecutable;

export interface CodexSandboxProbeInput {
	readonly launcherExecutable: string;
	readonly launcherHome: string;
	readonly launcherPath: string;
	readonly workspaceRoot: string;
	readonly workspaceAccess: CodexWorkspaceAccess;
	readonly gitDirectory: string;
	readonly runtimeTmp: string;
	readonly probe: ContainmentProbeExecutable;
}

/** Runs an actual child through the effective profile before any provider is admitted. */
export async function runCodexSandboxProbe(
	input: CodexSandboxProbeInput,
	signal: AbortSignal,
): Promise<void> {
	signal.throwIfAborted();
	const sharedTempCanary = join(await realpath(tmpdir()), `.agentrelay-${randomUUID()}.canary`);
	const ownerHomeCanary = join(await realpath(homedir()), `.agentrelay-${randomUUID()}.canary`);
	const resultPath = join(input.runtimeTmp, `.agentrelay-${randomUUID()}.result`);
	const resultToken = randomUUID();
	const probePaths = {
		workspaceRead: join(input.gitDirectory, "HEAD"),
		workspaceWrite: join(input.workspaceRoot, `.agentrelay-${randomUUID()}.probe`),
		workspaceAccess: input.workspaceAccess,
		gitWrite: join(input.gitDirectory, `.agentrelay-${randomUUID()}.probe`),
		runtimeTmpWrite: join(input.runtimeTmp, `.agentrelay-${randomUUID()}.probe`),
		controlRead: input.launcherPath,
		ownerHomeCanary,
		sharedTempCanary,
		resultPath,
		resultToken,
		parentNetworkNamespace: await readlink("/proc/self/ns/net"),
	};

	try {
		signal.throwIfAborted();
		await Promise.all([
			writeHostCanary(sharedTempCanary, "host-temp-canary"),
			writeHostCanary(ownerHomeCanary, "owner-home-canary"),
		]);
		signal.throwIfAborted();
		const child = spawn(
			input.launcherExecutable,
			[
				"sandbox",
				"--disable",
				"use_legacy_landlock",
				"--disable",
				"network_proxy",
				"--permission-profile",
				CODEX_SANDBOX_OFFLINE_PROFILE_NAME,
				"--cd",
				input.workspaceRoot,
				"--",
				input.probe.executable,
				"--input-type=module",
				"--eval",
				PROBE_SOURCE,
				JSON.stringify(probePaths),
			],
			{
				cwd: input.workspaceRoot,
				detached: true,
				env: {
					HOME: input.launcherHome,
					CODEX_HOME: input.launcherHome,
					PATH: "/dev/null",
					AGENTRELAY_CONTAINMENT_PROBE_SECRET: "must-not-cross",
				},
				stdio: ["ignore", "pipe", "pipe"],
				shell: false,
			},
		);
		const output = await collectProbeOutput(child, signal);
		signal.throwIfAborted();
		assertSilentProbeOutput(output);
		await assertContainmentProbeAttestation(resultPath, resultToken);
		signal.throwIfAborted();
	} finally {
		await Promise.all([
			unlink(sharedTempCanary).catch(() => undefined),
			unlink(ownerHomeCanary).catch(() => undefined),
			unlink(probePaths.workspaceWrite).catch(() => undefined),
			unlink(probePaths.gitWrite).catch(() => undefined),
			unlink(probePaths.runtimeTmpWrite).catch(() => undefined),
			unlink(resultPath).catch(() => undefined),
		]);
	}
}

async function writeHostCanary(path: string, contents: string): Promise<void> {
	const canary = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
	try {
		await canary.writeFile(contents, "utf8");
		await canary.sync();
	} finally {
		await canary.close();
	}
}

async function collectProbeOutput(child: ReturnType<typeof spawn>, signal: AbortSignal) {
	let stdout = "";
	let stderr = "";
	let exceeded = false;
	let timedOut = false;
	let terminationRequested = false;
	let knownPid = child.pid ?? null;
	let signalledPid: number | null = null;
	let resolveTerminationRequested!: () => void;
	const terminationRequestedPromise = new Promise<void>((resolve) => {
		resolveTerminationRequested = resolve;
	});
	const signalKnownProcessGroup = () => {
		const pid = knownPid ?? child.pid ?? null;
		if (pid === null || signalledPid === pid) return;
		knownPid = pid;
		signalledPid = pid;
		killProbeProcessGroupNow(pid, child);
	};
	const requestTermination = () => {
		if (!terminationRequested) {
			terminationRequested = true;
			resolveTerminationRequested();
		}
		signalKnownProcessGroup();
	};
	const onAbort = () => requestTermination();
	let resolveSpawned!: (pid: number | null) => void;
	let spawnResolved = false;
	const spawned = new Promise<number | null>((resolve) => {
		resolveSpawned = resolve;
	});
	const settleSpawn = (pid: number | null) => {
		if (spawnResolved) return;
		spawnResolved = true;
		resolveSpawned(pid);
	};
	const onSpawn = () => {
		knownPid = child.pid ?? null;
		settleSpawn(knownPid);
		if (terminationRequested) signalKnownProcessGroup();
	};
	const onSpawnError = () => settleSpawn(knownPid ?? child.pid ?? null);
	child.once("spawn", onSpawn);
	child.once("error", onSpawnError);
	if (knownPid !== null) settleSpawn(knownPid);
	type ChildOutcome =
		| { readonly kind: "closed"; readonly status: number | null }
		| { readonly kind: "error"; readonly error: unknown };
	let onClose!: (status: number | null) => void;
	const closed = new Promise<ChildOutcome>((resolve) => {
		onClose = (status) => {
			requestTermination();
			resolve({ kind: "closed", status });
		};
		child.once("close", onClose);
	});
	let onChildError!: (error: unknown) => void;
	const failed = new Promise<ChildOutcome>((resolve) => {
		onChildError = (error) => {
			requestTermination();
			resolve({ kind: "error", error });
		};
		child.once("error", onChildError);
	});
	const childOutcome = Promise.race([closed, failed]);
	signal.addEventListener("abort", onAbort, { once: true });
	child.stdout?.setEncoding("utf8");
	child.stderr?.setEncoding("utf8");
	const onStdout = (chunk: string) => {
		stdout += chunk;
		if (Buffer.byteLength(stdout, "utf8") > MAX_PROBE_OUTPUT_BYTES) {
			exceeded = true;
			requestTermination();
		}
	};
	const onStderr = (chunk: string) => {
		stderr += chunk;
		if (Buffer.byteLength(stderr, "utf8") > MAX_PROBE_OUTPUT_BYTES) {
			exceeded = true;
			requestTermination();
		}
	};
	child.stdout?.on("data", onStdout);
	child.stderr?.on("data", onStderr);
	if (signal.aborted) requestTermination();
	const timeout = setTimeout(() => {
		timedOut = true;
		requestTermination();
	}, PROBE_TIMEOUT_MS);
	let outcome: ChildOutcome | undefined;
	try {
		const first = await Promise.race([
			childOutcome.then((value) => ({ kind: "child" as const, value })),
			terminationRequestedPromise.then(() => ({ kind: "termination" as const })),
		]);
		if (first.kind === "child") outcome = first.value;
		await proveProbeTermination(child, spawned, closed);
		outcome ??= await childOutcome;
	} finally {
		clearTimeout(timeout);
		signal.removeEventListener("abort", onAbort);
		child.removeListener("spawn", onSpawn);
		child.removeListener("error", onSpawnError);
		child.removeListener("error", onChildError);
		child.removeListener("close", onClose);
		child.stdout?.removeListener("data", onStdout);
		child.stderr?.removeListener("data", onStderr);
	}
	signal.throwIfAborted();
	if (outcome === undefined) {
		throw new CodexContainmentTerminationError({
			cause: new Error("Codex sandbox probe ended without a child outcome"),
		});
	}
	if (outcome.kind === "error") throw outcome.error;
	if (timedOut) throw new Error("Codex sandbox capability probe timed out");
	if (exceeded) throw new Error("Codex sandbox capability probe exceeded its output limit");
	if (outcome.status !== 0) {
		throw new Error(
			`Codex sandbox capability probe failed (${outcome.status}); ${probeOutputDiagnostic({ stdout, stderr })}`,
		);
	}
	return { stdout, stderr };
}

async function proveProbeTermination(
	child: ReturnType<typeof spawn>,
	spawned: Promise<number | null>,
	closed: Promise<unknown>,
): Promise<void> {
	try {
		const unresolvedSpawn = Symbol("unresolved-spawn");
		const pid = await Promise.race([
			spawned,
			delay(PROCESS_GROUP_EXIT_TIMEOUT_MS, unresolvedSpawn, { ref: false }),
		]);
		if (pid === unresolvedSpawn) {
			child.kill("SIGKILL");
			throw new Error("Codex sandbox probe spawn state could not be resolved");
		}
		if (pid === null) {
			const pipesOpen = Symbol("pipes-open");
			const closeResult = await Promise.race([
				closed,
				delay(PROCESS_GROUP_EXIT_TIMEOUT_MS, pipesOpen, { ref: false }),
			]);
			if (closeResult === pipesOpen) {
				throw new Error("Codex sandbox probe pipes did not close");
			}
			return;
		}
		await killProcessGroupAndProveTerminated(pid, closed, PROCESS_GROUP_EXIT_TIMEOUT_MS, () =>
			child.kill("SIGKILL"),
		);
	} catch (error) {
		throw new CodexContainmentTerminationError({ cause: error });
	}
}

function killProbeProcessGroupNow(pid: number, child: ReturnType<typeof spawn>): void {
	try {
		process.kill(-pid, "SIGKILL");
	} catch (error) {
		if (errorCode(error) === "ESRCH") return;
		try {
			child.kill("SIGKILL");
		} catch {
			// The bounded termination proof below owns the authoritative result.
		}
	}
}

function assertSilentProbeOutput(output: { stdout: string; stderr: string }): void {
	if (output.stdout.length === 0 && output.stderr.length === 0) return;
	throw new Error(
		`Codex sandbox capability probe emitted unexpected output; ${probeOutputDiagnostic(output)}`,
	);
}

function probeOutputDiagnostic(output: { stdout: string; stderr: string }): string {
	const stdoutBytes = Buffer.byteLength(output.stdout, "utf8");
	const stderrBytes = Buffer.byteLength(output.stderr, "utf8");
	const stdout = JSON.stringify(output.stdout.slice(0, MAX_DIAGNOSTIC_OUTPUT_CHARS));
	const stderr = JSON.stringify(output.stderr.slice(0, MAX_DIAGNOSTIC_OUTPUT_CHARS));
	return `stdout (${stdoutBytes} bytes): ${stdout}; stderr (${stderrBytes} bytes): ${stderr}`;
}

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? String(error.code)
		: undefined;
}

const PROBE_SOURCE = String.raw`
import { access, readFile, readlink, unlink, writeFile } from "node:fs/promises";
import { connect } from "node:net";

const paths = JSON.parse(process.argv[1]);
const canRead = async (path) => {
  try { await readFile(path); return true; } catch { return false; }
};
const canWrite = async (path) => {
  try {
    await writeFile(path, "probe", { flag: "wx" });
    await access(path);
    await unlink(path);
    return true;
  } catch { return false; }
};
const canConnect = () => new Promise((resolve) => {
  const socket = connect({ host: "1.1.1.1", port: 53 });
  const timer = setTimeout(() => { socket.destroy(); resolve(false); }, 500);
  socket.once("connect", () => { clearTimeout(timer); socket.destroy(); resolve(true); });
  socket.once("error", () => { clearTimeout(timer); resolve(false); });
});
const managedProxyEnvironmentPresent = Object.keys(process.env).some((name) =>
  name.toUpperCase().includes("PROXY") ||
  name === "NODE_USE_ENV_PROXY" ||
  name === "ELECTRON_GET_USE_PROXY"
);

const checks = {
  workspaceRead: await canRead(paths.workspaceRead),
  workspaceWrite: await canWrite(paths.workspaceWrite),
  gitWrite: await canWrite(paths.gitWrite),
  runtimeTmpWrite: await canWrite(paths.runtimeTmpWrite),
  controlRead: await canRead(paths.controlRead),
  ownerHomeRead: await canRead(paths.ownerHomeCanary),
  sharedTempRead: await canRead(paths.sharedTempCanary),
  environmentSecretPresent: process.env.AGENTRELAY_CONTAINMENT_PROBE_SECRET !== undefined,
  managedProxyEnvironmentPresent,
  networkNamespaceChanged: await readlink("/proc/self/ns/net") !== paths.parentNetworkNamespace,
  networkConnect: await canConnect(),
};
const workspaceAccessOk = paths.workspaceAccess === "read"
  ? !checks.workspaceWrite
  : checks.workspaceWrite;
const ok = checks.workspaceRead && workspaceAccessOk && !checks.gitWrite &&
  checks.runtimeTmpWrite && !checks.controlRead && !checks.ownerHomeRead &&
  !checks.sharedTempRead && !checks.environmentSecretPresent &&
  !checks.managedProxyEnvironmentPresent &&
  checks.networkNamespaceChanged && !checks.networkConnect;
if (!ok) {
  process.stderr.write("Codex sandbox capability probe contradicted the required policy\n");
  process.exitCode = 1;
} else {
  await writeFile(paths.resultPath, paths.resultToken, { flag: "wx", mode: 0o600 });
}
`;
