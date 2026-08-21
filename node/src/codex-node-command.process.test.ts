import { type ChildProcess, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const NODE_ENTRYPOINT = fileURLToPath(new URL("./bin/agentrelay-node.ts", import.meta.url));
const TSX_ENTRYPOINT = createRequire(import.meta.url).resolve("tsx/cli");
const SECRET_CANARY = "owner-secret-must-not-be-read-or-logged";

describe.runIf(process.platform !== "win32")("run-codex CLI boundary", () => {
	it("admits one inherited channel before config loading without reading or logging it", async () => {
		const missingConfig = join(
			process.cwd(),
			`.missing-agentrelay-node-config-${process.pid}-${Date.now()}.json`,
		);
		const child = startRunCodex(["--config", missingConfig, "--owner-credential-fd", "3"]);
		writeCredentialCanary(child);

		const result = await collectExit(child);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain(`Cannot open Node config at ${missingConfig}`);
		expect(result.stderr).not.toContain(SECRET_CANARY);
		expect(result.stdout).not.toContain(SECRET_CANARY);
	});

	it("rejects duplicate inherited-fd options before config or secret access", async () => {
		const child = startRunCodex([
			"--config",
			"/must-not-be-opened/config.json",
			"--owner-credential-fd",
			"3",
			"--owner-credential-fd",
			"3",
		]);
		writeCredentialCanary(child);

		const result = await collectExit(child);

		expect(result.code).toBe(1);
		expect(result.stderr).toBe("--owner-credential-fd must be an integer from 3 to 2147483647\n");
		expect(result.stderr).not.toContain(SECRET_CANARY);
		expect(result.stdout).toBe("");
	});

	it.each([
		{
			label: "duplicate config",
			args: ["--config", "/first/config.json", "--config", "/second/config.json"],
			error: "--config must be supplied at most once as a non-empty path\n",
		},
		{
			label: "invalid poll interval",
			args: ["--config", "/must-not-be-opened/config.json", "--poll-ms", "49"],
			error: "--poll-ms must be an integer of at least 50ms\n",
		},
	])("rejects $label after channel admission but before config or secret access", async (test) => {
		const child = startRunCodex([...test.args, "--owner-credential-fd", "3"]);
		writeCredentialCanary(child);

		const result = await collectExit(child);

		expect(result.code).toBe(1);
		expect(result.stderr).toBe(test.error);
		expect(result.stderr).not.toContain(SECRET_CANARY);
		expect(result.stdout).toBe("");
	});
});

function startRunCodex(args: readonly string[]): ChildProcess {
	return spawn(process.execPath, [TSX_ENTRYPOINT, NODE_ENTRYPOINT, "run-codex", ...args], {
		cwd: process.cwd(),
		env: { ...process.env, AGENTRELAY_NODE_LOG_LEVEL: "error" },
		stdio: ["ignore", "pipe", "pipe", "pipe"],
	});
}

function writeCredentialCanary(child: ChildProcess): void {
	const channel = child.stdio[3];
	if (channel === null || typeof channel === "number" || !("write" in channel)) {
		throw new Error("Inherited credential test channel is unavailable");
	}
	channel.on("error", () => undefined);
	channel.end(`${SECRET_CANARY}\n`);
}

function collectExit(
	child: ChildProcess,
): Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }> {
	return new Promise((resolve, reject) => {
		let stdout = "";
		let stderr = "";
		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr?.on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.once("error", reject);
		child.once("close", (code) => resolve({ code, stdout, stderr }));
	});
}
