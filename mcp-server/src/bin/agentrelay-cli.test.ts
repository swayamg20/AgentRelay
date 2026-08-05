import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { access } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const require = createRequire(import.meta.url);
const pkg = require("../../package.json") as { version: string };
const PACKAGE_ROOT = pathResolve(__dirname, "../..");
const AGENTRELAY_BIN_PATH = pathResolve(PACKAGE_ROOT, "dist/bin/agentrelay.js");

type ProcessExit = {
	code: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
};

const describeIfBuilt = existsSync(AGENTRELAY_BIN_PATH) ? describe : describe.skip;

describeIfBuilt("agentrelay CLI mcp subcommand", () => {
	beforeAll(async () => {
		await access(AGENTRELAY_BIN_PATH);
	});

	it("boots the MCP server without firing the CLI misuse hint", async () => {
		const child = spawn("node", [AGENTRELAY_BIN_PATH, "mcp"], {
			cwd: PACKAGE_ROOT,
			stdio: ["pipe", "pipe", "pipe"],
		});
		const exitPromise = collectExit(child);

		try {
			await sleep(500);
			if (child.exitCode === null && child.signalCode === null) {
				child.kill("SIGTERM");
			}
			const result = await withTimeout(exitPromise, 5_000, () => {
				child.kill("SIGKILL");
			});

			expect(
				result.code,
				`agentrelay mcp should not exit with the agentrelay-mcp misuse code\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
			).not.toBe(2);
		} finally {
			if (child.exitCode === null && child.signalCode === null) {
				child.kill("SIGKILL");
				await exitPromise.catch(() => undefined);
			}
		}
	});

	it("lists the mcp subcommand in help output", () => {
		const result = spawnSync("node", [AGENTRELAY_BIN_PATH, "--help"], {
			cwd: PACKAGE_ROOT,
			encoding: "utf8",
			stdio: "pipe",
		});

		if (result.error !== undefined) {
			throw result.error;
		}

		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toMatch(/mcp\s+Start the AgentRelay MCP server/);
	});

	it("reports the package version", () => {
		const result = spawnSync("node", [AGENTRELAY_BIN_PATH, "--version"], {
			cwd: PACKAGE_ROOT,
			encoding: "utf8",
			stdio: "pipe",
		});

		if (result.error !== undefined) {
			throw result.error;
		}

		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout.trim()).toContain(`agentrelay/${pkg.version}`);
	});
});

function collectExit(child: ChildProcessWithoutNullStreams): Promise<ProcessExit> {
	let stdout = "";
	let stderr = "";

	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk: string | Buffer) => {
		stdout += String(chunk);
	});
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk: string | Buffer) => {
		stderr += String(chunk);
	});

	return new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", (code, signal) => {
			resolve({ code, signal, stdout, stderr });
		});
	});
}

async function withTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
	onTimeout: () => void,
): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<T>((_, reject) => {
				timer = setTimeout(() => {
					onTimeout();
					reject(new Error(`process did not exit within ${timeoutMs}ms`));
				}, timeoutMs);
			}),
		]);
	} finally {
		if (timer !== undefined) {
			clearTimeout(timer);
		}
	}
}

async function sleep(ms: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms));
}
