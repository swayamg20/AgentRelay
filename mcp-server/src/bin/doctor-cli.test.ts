import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { type Server, createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DoctorFixResult, DoctorReport } from "../cli/commands.js";

const PACKAGE_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const AGENTRELAY_BIN_PATH = join(PACKAGE_ROOT, "dist/bin/agentrelay.js");
const describeIfBuilt = existsSync(AGENTRELAY_BIN_PATH) ? describe : describe.skip;

describeIfBuilt.each([false, true])("agentrelay doctor CLI (json: %s)", (json) => {
	let home: string;
	let env: NodeJS.ProcessEnv;
	let server: Server;
	let responseStatus: number;
	let requests: {
		method: string | undefined;
		url: string | undefined;
		bearer: string | undefined;
	}[];

	function runCli(args: string[]) {
		return new Promise<{
			status: number | string | undefined;
			stdout: string;
			stderr: string;
		}>((resolve) => {
			execFile(
				process.execPath,
				[AGENTRELAY_BIN_PATH, ...args],
				{ cwd: PACKAGE_ROOT, env, encoding: "utf8", timeout: 10_000 },
				(error, stdout, stderr) => {
					resolve({ status: error === null ? 0 : error.code, stdout, stderr });
				},
			);
		});
	}

	function runDoctor(fix = false) {
		return runCli(["doctor", ...(fix ? ["--fix"] : []), ...(json ? ["--json"] : [])]);
	}

	function reportFrom(stdout: string, fix = false): DoctorReport | undefined {
		if (!json) {
			expect(stdout).toContain("config:");
			expect(stdout).toContain("trust.yaml:");
			return undefined;
		}
		if (fix) {
			const result: DoctorFixResult = JSON.parse(stdout);
			expect(Object.keys(result).sort()).toEqual(["after", "before", "fixed", "skippedManual"]);
			return result.after;
		}
		const report: DoctorReport = JSON.parse(stdout);
		expect(Object.keys(report).sort()).toEqual([
			"apiKeyValid",
			"configPath",
			"configPresent",
			"mcpEntryPresent",
			"notes",
			"overlayApplied",
			"relayReachable",
			"trustParseable",
			"trustPath",
		]);
		return report;
	}

	beforeEach(async () => {
		home = await mkdtemp(join(tmpdir(), "agentrelay-doctor-cli-"));
		env = {
			...process.env,
			HOME: home,
			AGENTRELAY_HOME: home,
			AGENTRELAY_CONFIG_PATH: join(home, "config.json"),
			AGENTRELAY_TRUST_PATH: join(home, "trust.yaml"),
		};
		responseStatus = 200;
		requests = [];
		server = createServer((request, response) => {
			requests.push({
				method: request.method,
				url: request.url,
				bearer: request.headers.authorization,
			});
			response.writeHead(responseStatus, { "content-type": "application/json" });
			response.end(JSON.stringify({ id: "doctor-test-agent", handle: "doctor@team" }));
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (address === null || typeof address === "string") throw new Error("Missing fixture port");
		await writeFile(
			join(home, "config.json"),
			JSON.stringify({
				relay_url: `http://127.0.0.1:${address.port}`,
				agent_handle: "doctor@team",
				agent_id: "doctor-test-agent",
				api_key: "doctor-test-key",
				default_session_id: null,
			}),
		);
		await writeFile(join(home, "trust.yaml"), "version: 1\n");
		const installed = await runCli(["install", "--client", "all", "--overwrite"]);
		expect(installed.status, installed.stderr).toBe(0);
	});

	afterEach(async () => {
		if (server?.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
		if (home) await rm(home, { recursive: true, force: true });
	});

	it("prints a failed report and exits 1 when config is missing", async () => {
		await rm(join(home, "config.json"));
		const result = await runDoctor();
		expect(result.status, result.stderr).toBe(1);
		const report = reportFrom(result.stdout);
		if (json) {
			expect(report).toMatchObject({
				configPresent: false,
				relayReachable: "skipped",
				apiKeyValid: "skipped",
			});
		} else {
			expect(result.stdout).toContain("MISSING");
		}
		expect(requests).toEqual([]);
	});

	it("prints a failed report and exits 1 when the Relay is unreachable", async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		const result = await runDoctor();
		expect(result.status, result.stderr).toBe(1);
		const report = reportFrom(result.stdout);
		if (json) expect(report).toMatchObject({ relayReachable: false, apiKeyValid: false });
		expect(result.stdout).toContain("relay unreachable:");
	});

	it("prints a failed report and exits 1 when the API key is rejected", async () => {
		responseStatus = 401;
		const result = await runDoctor();
		expect(result.status, result.stderr).toBe(1);
		const report = reportFrom(result.stdout);
		if (json) expect(report).toMatchObject({ relayReachable: true, apiKeyValid: false });
		expect(result.stdout).toContain("API key rejected by relay.");
	});

	it("prints a healthy report and exits 0", async () => {
		const result = await runDoctor();
		expect(result.status, result.stderr).toBe(0);
		const report = reportFrom(result.stdout);
		if (json) {
			expect(report).toEqual({
				configPresent: true,
				configPath: join(home, "config.json"),
				relayReachable: true,
				apiKeyValid: true,
				mcpEntryPresent: { "claude-code": true, codex: true },
				overlayApplied: { "claude-code": true, codex: true },
				trustParseable: true,
				trustPath: join(home, "trust.yaml"),
				notes: [],
			});
		} else {
			expect(result.stdout).not.toContain("MISSING");
			expect(result.stdout).not.toContain("BROKEN");
		}
		expect(requests).toEqual([
			{ method: "GET", url: "/agents/me", bearer: "Bearer doctor-test-key" },
		]);
	});

	it("exits 1 for missing client configuration despite healthy Relay credentials", async () => {
		await rm(join(home, ".claude.json"));
		const result = await runDoctor();
		expect(result.status, result.stderr).toBe(1);
		const report = reportFrom(result.stdout);
		if (json) {
			expect(report).toMatchObject({
				relayReachable: true,
				apiKeyValid: true,
				mcpEntryPresent: { "claude-code": false },
			});
		} else {
			expect(result.stdout).toContain("MISSING");
		}
	});

	it("preserves fix success after repairing missing client configuration", async () => {
		await rm(join(home, ".claude.json"));
		const result = await runDoctor(true);
		expect(result.status, result.stderr).toBe(0);
		reportFrom(result.stdout, true);
		if (json) {
			const fixed: DoctorFixResult = JSON.parse(result.stdout);
			expect(fixed.before.mcpEntryPresent["claude-code"]).toBe(false);
			expect(fixed.after.mcpEntryPresent["claude-code"]).toBe(true);
			expect(fixed.fixed).toHaveLength(1);
		} else {
			expect(result.stdout).toContain("doctor --fix: applied:");
			expect(result.stdout).not.toContain("MISSING");
		}
	});

	it("preserves fix failure when missing credentials require manual remediation", async () => {
		await rm(join(home, "config.json"));
		const result = await runDoctor(true);
		expect(result.status, result.stderr).toBe(1);
		const report = reportFrom(result.stdout, true);
		if (json) {
			expect(report?.configPresent).toBe(false);
			const fixed: DoctorFixResult = JSON.parse(result.stdout);
			expect(fixed.fixed).toEqual([]);
			expect(fixed.skippedManual).toHaveLength(1);
		} else {
			expect(result.stdout).toContain("Manual remediations required:");
			expect(result.stdout).toContain("MISSING");
		}
	});
});
