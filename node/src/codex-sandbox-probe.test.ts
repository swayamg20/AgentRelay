import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import {
	CODEX_SANDBOX_OFFLINE_PROFILE_NAME,
	CodexContainmentTerminationError,
} from "./codex-sandbox-contract.js";
import { type CodexSandboxProbeInput, runCodexSandboxProbe } from "./codex-sandbox-probe.js";

describe.runIf(process.platform === "linux")("Codex sandbox probe lifecycle", () => {
	it("selects the fixed offline profile with managed proxy disabled", async () => {
		const markerPath = join(tmpdir(), `agentrelay-probe-${process.pid}-${Date.now()}.json`);
		const fixture = await createProbeFixture(
			"offline-profile",
			nodeLauncher(`
const { writeFileSync } = require("node:fs");
const paths = JSON.parse(process.argv.at(-1));
writeFileSync(${JSON.stringify(markerPath)}, JSON.stringify(process.argv.slice(2)), { mode: 0o600 });
writeFileSync(paths.resultPath, paths.resultToken, { flag: "wx", mode: 0o600 });
`),
		);

		try {
			await expect(
				runCodexSandboxProbe(fixture.input, new AbortController().signal),
			).resolves.toBeUndefined();
			const argv = JSON.parse(await waitForFile(markerPath)) as string[];
			expect(argv.slice(0, 7)).toEqual([
				"sandbox",
				"--disable",
				"use_legacy_landlock",
				"--disable",
				"network_proxy",
				"--permission-profile",
				CODEX_SANDBOX_OFFLINE_PROFILE_NAME,
			]);
		} finally {
			await Promise.all([rm(markerPath, { force: true }), rm(fixture.root, { recursive: true })]);
		}
	});

	it("kills the detached probe process group promptly when authority is revoked", async () => {
		const markerPath = join(tmpdir(), `agentrelay-probe-${process.pid}-${Date.now()}.pid`);
		const fixture = await createProbeFixture(
			"abort",
			`#!/bin/sh\nprintf '%s\\n' "$$" > ${shellQuote(markerPath)}\n/bin/sleep 30 &\nwait\n`,
		);
		const abort = new AbortController();
		let processGroupId: number | null = null;

		try {
			const probing = runCodexSandboxProbe(fixture.input, abort.signal);
			const rejection = probing.catch((error: unknown) => error);
			processGroupId = Number.parseInt(await waitForFile(markerPath), 10);
			expect(Number.isSafeInteger(processGroupId)).toBe(true);

			abort.abort("expired");

			await expect(settleWithin(rejection, 1_000)).resolves.toBe("expired");
			await expect(waitForProcessGroupExit(processGroupId, 1_000)).resolves.toBeUndefined();
		} finally {
			abort.abort("revoked");
			killProcessGroupIfAlive(processGroupId);
			await Promise.all([rm(markerPath, { force: true }), rm(fixture.root, { recursive: true })]);
		}
	});

	it("kills a same-group descendant after the direct child exits successfully", async () => {
		const markerPath = join(tmpdir(), `agentrelay-probe-${process.pid}-${Date.now()}.json`);
		const fixture = await createProbeFixture(
			"descendant",
			nodeLauncher(`
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const paths = JSON.parse(process.argv.at(-1));
const descendant = spawn("/bin/sleep", ["30"], { stdio: "ignore" });
writeFileSync(${JSON.stringify(markerPath)}, JSON.stringify({ groupId: process.pid, descendantPid: descendant.pid }));
writeFileSync(paths.resultPath, paths.resultToken, { flag: "wx", mode: 0o600 });
descendant.unref();
`),
		);
		let processGroupId: number | null = null;

		try {
			const marker = waitForFile(markerPath).then(parseProcessMarker);
			await expect(
				runCodexSandboxProbe(fixture.input, new AbortController().signal),
			).resolves.toBeUndefined();
			const started = await marker;
			processGroupId = started.groupId;
			expect(started.descendantPid).toBeGreaterThan(0);
			expect(isProcessGroupAlive(processGroupId)).toBe(false);
		} finally {
			killProcessGroupIfAlive(processGroupId);
			await Promise.all([rm(markerPath, { force: true }), rm(fixture.root, { recursive: true })]);
		}
	});

	it("kills the probe group before reporting an output-limit failure", async () => {
		const markerPath = join(tmpdir(), `agentrelay-probe-${process.pid}-${Date.now()}.pid`);
		const fixture = await createProbeFixture(
			"output",
			nodeLauncher(`
const { writeFileSync } = require("node:fs");
writeFileSync(${JSON.stringify(markerPath)}, String(process.pid));
process.stdout.write(Buffer.alloc(70_000));
setInterval(() => {}, 1_000);
`),
		);
		let processGroupId: number | null = null;

		try {
			const probing = runCodexSandboxProbe(fixture.input, new AbortController().signal);
			processGroupId = Number.parseInt(await waitForFile(markerPath), 10);

			await expect(probing).rejects.toThrow("exceeded its output limit");
			expect(isProcessGroupAlive(processGroupId)).toBe(false);
		} finally {
			killProcessGroupIfAlive(processGroupId);
			await Promise.all([rm(markerPath, { force: true }), rm(fixture.root, { recursive: true })]);
		}
	});

	it("reports unproven pipe closure before an authority denial", async () => {
		const markerPath = join(tmpdir(), `agentrelay-probe-${process.pid}-${Date.now()}.json`);
		const fixture = await createProbeFixture(
			"escaped-pipes",
			nodeLauncher(`
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const escaped = spawn("/bin/sleep", ["30"], {
  detached: true,
  stdio: ["ignore", "inherit", "inherit"],
});
writeFileSync(${JSON.stringify(markerPath)}, JSON.stringify({ groupId: process.pid, descendantPid: escaped.pid }));
escaped.unref();
setInterval(() => {}, 1_000);
`),
		);
		const abort = new AbortController();
		let processGroupId: number | null = null;
		let escapedGroupId: number | null = null;

		try {
			const probing = runCodexSandboxProbe(fixture.input, abort.signal);
			const rejection = probing.catch((error: unknown) => error);
			const marker = parseProcessMarker(await waitForFile(markerPath));
			processGroupId = marker.groupId;
			escapedGroupId = marker.descendantPid;

			abort.abort("expired");

			const failure = await settleWithin(rejection, 3_000);
			expect(failure).toBeInstanceOf(CodexContainmentTerminationError);
			expect(failure).not.toBe("expired");
			expect(isProcessGroupAlive(processGroupId)).toBe(false);
			expect(isProcessGroupAlive(escapedGroupId)).toBe(true);
		} finally {
			abort.abort("revoked");
			killProcessGroupIfAlive(processGroupId);
			killProcessGroupIfAlive(escapedGroupId);
			await Promise.all([rm(markerPath, { force: true }), rm(fixture.root, { recursive: true })]);
		}
	});
});

interface ProbeFixture {
	readonly root: string;
	readonly input: CodexSandboxProbeInput;
}

async function createProbeFixture(name: string, launcherSource: string): Promise<ProbeFixture> {
	const root = await realpath(await mkdtemp(join(tmpdir(), `agentrelay-probe-${name}-`)));
	const workspaceRoot = join(root, "workspace");
	const gitDirectory = join(workspaceRoot, ".git");
	const runtimeTmp = join(root, "runtime-tmp");
	const launcherHome = join(root, "launcher-home");
	const launcherPath = join(launcherHome, "config.toml");
	const launcherExecutable = join(root, "probe-launcher");
	await Promise.all([
		mkdir(gitDirectory, { recursive: true, mode: 0o700 }),
		mkdir(runtimeTmp, { recursive: true, mode: 0o700 }),
		mkdir(launcherHome, { recursive: true, mode: 0o700 }),
	]);
	await Promise.all([
		writeFile(join(gitDirectory, "HEAD"), "ref: refs/heads/main\n", { mode: 0o600 }),
		writeFile(launcherPath, "test config\n", { mode: 0o600 }),
		writeFile(launcherExecutable, launcherSource, { mode: 0o700 }),
	]);
	await chmod(launcherExecutable, 0o700);
	return {
		root,
		input: {
			launcherExecutable,
			launcherHome,
			launcherPath,
			workspaceRoot,
			providerWorkspaceAccess: "read",
			gitDirectory,
			runtimeTmp,
			probe: {
				executable: process.execPath,
				readRoot: dirname(process.execPath),
				sha256: "a".repeat(64),
			},
		},
	};
}

function nodeLauncher(source: string): string {
	return `#!${process.execPath}\n${source.trimStart()}`;
}

function parseProcessMarker(contents: string): { groupId: number; descendantPid: number } {
	return JSON.parse(contents) as { groupId: number; descendantPid: number };
}

async function waitForFile(path: string): Promise<string> {
	const deadline = Date.now() + 1_000;
	for (;;) {
		try {
			return await readFile(path, "utf8");
		} catch (error) {
			if (errorCode(error) !== "ENOENT") throw error;
			if (Date.now() >= deadline) throw new Error("Probe process did not start promptly");
			await delay(10);
		}
	}
}

async function waitForProcessGroupExit(pid: number, milliseconds: number): Promise<void> {
	const deadline = Date.now() + milliseconds;
	while (isProcessGroupAlive(pid)) {
		if (Date.now() >= deadline) throw new Error("Probe process group did not terminate promptly");
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
		if (errorCode(error) === "ESRCH") return false;
		throw error;
	}
}

function settleWithin<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timeout = setTimeout(
			() => reject(new Error("Probe lifecycle did not settle promptly")),
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

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? String(error.code)
		: undefined;
}
