import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { directCodexProcessBoundaryForTests } from "../test-support/direct-codex-process-boundary.js";
import {
	createFakeAppServer,
	waitForPid,
	waitForProcessExit,
} from "../test-support/fake-codex-app-server.js";
import {
	readCodexLines,
	startCodexAppServerProcess,
	stopCodexAppServerProcess,
	verifyCodexCliVersion,
} from "./codex-app-server-process.js";
import { MAX_CODEX_APP_SERVER_FRAME_BYTES } from "./codex-app-server-protocol.js";

describe("Codex app-server framing", () => {
	it("rejects an incomplete final frame", async () => {
		await expect(collect(readCodexLines(Readable.from(['{"id":1'])))).rejects.toMatchObject({
			name: "CodexAppServerError",
			reason: "protocol",
		});
	});

	it("rejects a response above the UTF-8 byte limit before parsing", async () => {
		const oversized = "x".repeat(MAX_CODEX_APP_SERVER_FRAME_BYTES + 1);
		await expect(collect(readCodexLines(Readable.from([oversized])))).rejects.toMatchObject({
			name: "CodexAppServerError",
			reason: "protocol",
		});
	});
});

describe.runIf(process.platform !== "win32")("Codex app-server authority teardown", () => {
	it("kills an in-flight version probe before returning the authority denial", async () => {
		const fixture = await createFakeAppServer({ versionDelayMs: 30_000 });
		const authority = new AbortController();
		let processGroupId: number | null = null;
		try {
			const starting = verifyCodexCliVersion(
				fixture.scriptPath,
				fixture.directory,
				fixture.env,
				directCodexProcessBoundaryForTests,
				authority.signal,
			);
			processGroupId = await waitForPid(fixture.versionPidPath);

			authority.abort("expired");

			await expect(settleWithin(starting, 1_000)).rejects.toBe("expired");
			await expect(waitForProcessGroupExit(processGroupId, 1_000)).resolves.toBeUndefined();
		} finally {
			authority.abort("revoked");
			killProcessGroupIfAlive(processGroupId);
			await fixture.remove();
		}
	});

	it("kills a started app-server before publishing the authority denial", async () => {
		const fixture = await createFakeAppServer();
		const authority = new AbortController();
		let processGroupId: number | null = null;
		try {
			const processRef = await startCodexAppServerProcess({
				command: { executable: fixture.scriptPath },
				cwd: fixture.directory,
				env: fixture.env,
				boundary: directCodexProcessBoundaryForTests,
				authoritySignal: authority.signal,
			});
			processGroupId = await waitForPid(fixture.appServerPidPath);
			const nativeKill = process.kill.bind(process);
			const kill = vi
				.spyOn(process, "kill")
				.mockImplementation((pid, signal) => nativeKill(pid, signal));

			authority.abort("expired");
			expect(kill).toHaveBeenCalledWith(-processGroupId, "SIGKILL");

			await expect(
				settleWithin(processRef.authorityTermination ?? Promise.resolve(), 1_000),
			).rejects.toBe("expired");
			const terminalKillCalls = kill.mock.calls.length;
			await stopCodexAppServerProcess(processRef);
			expect(kill.mock.calls).toHaveLength(terminalKillCalls);
			kill.mockRestore();
			await expect(waitForProcessGroupExit(processGroupId, 1_000)).resolves.toBeUndefined();
		} finally {
			vi.restoreAllMocks();
			authority.abort("revoked");
			killProcessGroupIfAlive(processGroupId);
			await fixture.remove();
		}
	});

	it("keeps an unproven process-group teardown ahead of the authority reason", async () => {
		const fixture = await createFakeAppServer();
		const authority = new AbortController();
		const reason = new Error("authority expired");
		const escapedPidPath = join(fixture.directory, "escaped-pipe.pid");
		const wrapper = await escapedPipeWrapper(fixture.scriptPath, escapedPidPath, fixture.directory);
		let processGroupId: number | null = null;
		let escapedPid: number | null = null;
		try {
			const processRef = await startCodexAppServerProcess({
				command: { executable: wrapper },
				cwd: fixture.directory,
				env: fixture.env,
				boundary: directCodexProcessBoundaryForTests,
				authoritySignal: authority.signal,
			});
			processGroupId = processRef.child.pid ?? null;
			escapedPid = await waitForPid(escapedPidPath);

			authority.abort(reason);
			const failure = await settleWithin(
				(processRef.authorityTermination ?? Promise.resolve()).catch((error: unknown) => error),
				3_000,
			);

			expect(failure).toMatchObject({
				name: "CodexAppServerError",
				reason: "transport",
				message: "Codex authority teardown could not be proven",
			});
			expect(failure).not.toBe(reason);
			await expect(stopCodexAppServerProcess(processRef)).rejects.toBe(failure);
		} finally {
			authority.abort("revoked");
			killProcessGroupIfAlive(processGroupId);
			killProcessIfAlive(escapedPid);
			if (escapedPid !== null) await waitForProcessExit(escapedPid).catch(() => undefined);
			await fixture.remove();
		}
	});
});

async function collect(lines: AsyncIterable<string>): Promise<string[]> {
	const values: string[] = [];
	for await (const line of lines) values.push(line);
	return values;
}

function settleWithin<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
	return Promise.race([
		promise,
		delay(milliseconds).then(() => {
			throw new Error("Codex process did not settle promptly after authority revocation");
		}),
	]);
}

async function waitForProcessGroupExit(pid: number, milliseconds: number): Promise<void> {
	const deadline = Date.now() + milliseconds;
	while (isProcessGroupAlive(pid)) {
		if (Date.now() >= deadline) throw new Error("Codex process group remained alive");
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

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? String(error.code)
		: undefined;
}

async function escapedPipeWrapper(
	executable: string,
	escapedPidPath: string,
	directory: string,
): Promise<string> {
	const path = join(directory, "escaped-pipe-wrapper.mjs");
	await writeFile(
		path,
		`#!${process.execPath}\n${escapedPipeWrapperSource(executable, escapedPidPath)}\n`,
		{ mode: 0o700 },
	);
	await chmod(path, 0o700);
	return path;
}

function escapedPipeWrapperSource(executable: string, escapedPidPath: string): string {
	return `
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

if (!process.argv.includes("--version")) {
  const escaped = spawn(process.execPath, ["--eval", "setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: ["ignore", "inherit", "inherit"],
  });
  escaped.unref();
  writeFileSync(${JSON.stringify(escapedPidPath)}, String(escaped.pid), { mode: 0o600 });
}
const child = spawn(${JSON.stringify(executable)}, process.argv.slice(2), {
  cwd: process.cwd(),
  env: process.env,
  stdio: ["inherit", "inherit", "inherit"],
});
child.once("exit", (code) => process.exit(code ?? 1));
`;
}

function killProcessIfAlive(pid: number | null): void {
	if (pid === null) return;
	try {
		process.kill(pid, "SIGKILL");
	} catch (error) {
		if (errorCode(error) !== "ESRCH") throw error;
	}
}
