import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, readlink, realpath, unlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { PinnedExecutable } from "./codex-sandbox-contract.js";

const PROBE_TIMEOUT_MS = 10_000;
const MAX_PROBE_OUTPUT_BYTES = 64 * 1_024;

export type ContainmentProbeExecutable = PinnedExecutable;

export interface CodexSandboxProbeInput {
	readonly launcherExecutable: string;
	readonly launcherHome: string;
	readonly launcherPath: string;
	readonly profileName: string;
	readonly workspaceRoot: string;
	readonly gitDirectory: string;
	readonly runtimeTmp: string;
	readonly probe: ContainmentProbeExecutable;
}

export async function resolveContainmentProbe(
	sha256File: (path: string) => Promise<string>,
): Promise<ContainmentProbeExecutable> {
	const executable = await realpath(process.execPath);
	return {
		executable,
		readRoot: await realpath(dirname(executable)),
		sha256: await sha256File(executable),
	};
}

/** Runs an actual child through the effective profile before any provider is admitted. */
export async function runCodexSandboxProbe(input: CodexSandboxProbeInput): Promise<void> {
	const sharedTempCanary = join(await realpath(tmpdir()), `.agentrelay-${randomUUID()}.canary`);
	const canary = await open(
		sharedTempCanary,
		constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
		0o600,
	);
	try {
		await canary.writeFile("host-temp-canary", "utf8");
		await canary.sync();
	} finally {
		await canary.close();
	}

	const probePaths = {
		workspaceRead: join(input.gitDirectory, "HEAD"),
		workspaceWrite: join(input.workspaceRoot, `.agentrelay-${randomUUID()}.probe`),
		gitWrite: join(input.gitDirectory, `.agentrelay-${randomUUID()}.probe`),
		runtimeTmpWrite: join(input.runtimeTmp, `.agentrelay-${randomUUID()}.probe`),
		controlRead: input.launcherPath,
		ownerHome: await realpath(homedir()),
		sharedTempCanary,
		parentNetworkNamespace: await readlink("/proc/self/ns/net"),
	};

	try {
		const child = spawn(
			input.launcherExecutable,
			[
				"sandbox",
				"--disable",
				"use_legacy_landlock",
				"--permission-profile",
				input.profileName,
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
		const output = await collectProbeOutput(child);
		if (output.stdout.trim() !== '{"ok":true}') {
			throw new Error("Codex sandbox capability probe returned an invalid result");
		}
	} finally {
		await Promise.all([
			unlink(sharedTempCanary).catch(() => undefined),
			unlink(probePaths.workspaceWrite).catch(() => undefined),
			unlink(probePaths.gitWrite).catch(() => undefined),
			unlink(probePaths.runtimeTmpWrite).catch(() => undefined),
		]);
	}
}

async function collectProbeOutput(child: ReturnType<typeof spawn>) {
	let stdout = "";
	let stderr = "";
	let exceeded = false;
	let timedOut = false;
	child.stdout?.setEncoding("utf8");
	child.stderr?.setEncoding("utf8");
	child.stdout?.on("data", (chunk: string) => {
		stdout += chunk;
		if (Buffer.byteLength(stdout, "utf8") > MAX_PROBE_OUTPUT_BYTES) {
			exceeded = true;
			killProcessGroup(child.pid);
		}
	});
	child.stderr?.on("data", (chunk: string) => {
		stderr += chunk;
		if (Buffer.byteLength(stderr, "utf8") > MAX_PROBE_OUTPUT_BYTES) {
			exceeded = true;
			killProcessGroup(child.pid);
		}
	});
	const timeout = setTimeout(() => {
		timedOut = true;
		killProcessGroup(child.pid);
	}, PROBE_TIMEOUT_MS);
	const status = await new Promise<number | null>((resolve, reject) => {
		child.once("error", reject);
		child.once("close", resolve);
	}).finally(() => clearTimeout(timeout));
	if (timedOut) throw new Error("Codex sandbox capability probe timed out");
	if (exceeded) throw new Error("Codex sandbox capability probe exceeded its output limit");
	if (status !== 0) {
		throw new Error(`Codex sandbox capability probe failed (${status}): ${stderr}`);
	}
	return { stdout, stderr };
}

function killProcessGroup(pid: number | undefined): void {
	if (pid === undefined) return;
	try {
		process.kill(-pid, "SIGKILL");
	} catch {
		// The process may have exited between the bound check and cleanup.
	}
}

const PROBE_SOURCE = String.raw`
import { access, readFile, readdir, readlink, unlink, writeFile } from "node:fs/promises";
import { connect } from "node:net";

const paths = JSON.parse(process.argv[1]);
const canRead = async (path) => {
  try { await readFile(path); return true; } catch { return false; }
};
const canList = async (path) => {
  try { await readdir(path); return true; } catch { return false; }
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

const checks = {
  workspaceRead: await canRead(paths.workspaceRead),
  workspaceWrite: await canWrite(paths.workspaceWrite),
  gitWrite: await canWrite(paths.gitWrite),
  runtimeTmpWrite: await canWrite(paths.runtimeTmpWrite),
  controlRead: await canRead(paths.controlRead),
  ownerHomeRead: await canList(paths.ownerHome),
  sharedTempRead: await canRead(paths.sharedTempCanary),
  environmentSecretPresent: process.env.AGENTRELAY_CONTAINMENT_PROBE_SECRET !== undefined,
  networkNamespaceChanged: await readlink("/proc/self/ns/net") !== paths.parentNetworkNamespace,
  networkConnect: await canConnect(),
};
const ok = checks.workspaceRead && checks.workspaceWrite && !checks.gitWrite &&
  checks.runtimeTmpWrite && !checks.controlRead && !checks.ownerHomeRead &&
  !checks.sharedTempRead && !checks.environmentSecretPresent &&
  checks.networkNamespaceChanged && !checks.networkConnect;
if (!ok) {
  process.stderr.write("Codex sandbox capability probe contradicted the required policy\n");
  process.exitCode = 1;
} else {
  process.stdout.write('{"ok":true}\n');
}
`;
