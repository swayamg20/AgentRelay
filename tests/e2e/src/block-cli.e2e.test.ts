import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { request } from "undici";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REPO_ROOT, TestRelay } from "./harness.js";

const CLI_BIN_PATH = resolve(REPO_ROOT, "mcp-server/dist/bin/agentrelay.js");

interface AgentCredentials {
	agent_id: string;
	handle: string;
	api_key: string;
}

describe("block CLI convergence e2e", () => {
	let relay: TestRelay;
	let bob: AgentCredentials;
	const homes: string[] = [];

	beforeAll(async () => {
		relay = await TestRelay.boot();
		bob = await relay.createAgent({
			handle: "bob@acme",
			email: "bob@acme.com",
			name: "Bob",
			role: "backend",
		});
		for (const input of [
			{
				handle: "frank.dev@acme-team",
				email: "frank.dev@acme.com",
				name: "Frank",
			},
			{
				handle: "retry.target@acme-team",
				email: "retry.target@acme.com",
				name: "Retry Target",
			},
		]) {
			await relay.createAgent({ ...input, role: "frontend" });
		}
	}, 60_000);

	afterAll(async () => {
		await relay?.stop();
		await Promise.allSettled(homes.map((home) => rm(home, { recursive: true, force: true })));
	});

	it("uses configured bearer transport and URL-safe handles for block and unblock", async () => {
		const home = await makeHome(bob);
		const target = "frank.dev@acme-team";
		const blocked = runCli(home, ["block", target]);
		expect(blocked.status, diagnostics(blocked)).toBe(0);
		expect(blocked.stdout).toContain(`blocked ${target}`);
		expect(await readFile(join(home, ".agentrelay", "trust.yaml"), "utf8")).toContain(target);
		expect(await remoteBlocks(bob.api_key)).toEqual([target]);

		const unblocked = runCli(home, ["unblock", target]);
		expect(unblocked.status, diagnostics(unblocked)).toBe(0);
		expect(unblocked.stdout).toContain(`unblocked ${target}`);
		expect(await remoteBlocks(bob.api_key)).toEqual([]);
	});

	it("keeps the local kill switch active and reports an unauthorized relay sync", async () => {
		const home = await makeHome({ ...bob, api_key: "invalid-test-key" });
		const target = "frank.dev@acme-team";
		const result = runCli(home, ["block", target]);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("local block is active, but relay synchronization failed");
		expect(result.stderr).toContain("relay returned 401");
		expect(await readFile(join(home, ".agentrelay", "trust.yaml"), "utf8")).toContain(target);
		expect(await remoteBlocks(bob.api_key)).toEqual([]);
	});

	it("reports fail-safe partial unblock and converges when retried", async () => {
		const home = await makeHome(bob);
		const target = "retry.target@acme-team";
		const first = runCli(home, ["block", target]);
		expect(first.status, diagnostics(first)).toBe(0);
		expect(await remoteBlocks(bob.api_key)).toEqual([target]);

		const agentRelayHome = join(home, ".agentrelay");
		await chmod(agentRelayHome, 0o500);
		try {
			const partial = runCli(home, ["unblock", target]);
			expect(partial.status).toBe(1);
			expect(partial.stderr).toContain(
				"relay unblock succeeded, but the local block remains active; retry the command",
			);
			expect(await readFile(join(agentRelayHome, "trust.yaml"), "utf8")).toContain(target);
			expect(await remoteBlocks(bob.api_key)).toEqual([]);
		} finally {
			await chmod(agentRelayHome, 0o700);
		}

		const repaired = runCli(home, ["unblock", target]);
		expect(repaired.status, diagnostics(repaired)).toBe(0);
		expect(await remoteBlocks(bob.api_key)).toEqual([]);
		expect(await readFile(join(agentRelayHome, "trust.yaml"), "utf8")).not.toContain(target);
	});

	async function makeHome(credentials: AgentCredentials): Promise<string> {
		const home = await mkdtemp(join(tmpdir(), "agentrelay-e2e-block-"));
		homes.push(home);
		const agentRelayHome = join(home, ".agentrelay");
		await mkdir(agentRelayHome, { recursive: true });
		await writeFile(
			join(agentRelayHome, "config.json"),
			`${JSON.stringify({
				relay_url: relay.baseUrl,
				agent_handle: credentials.handle,
				agent_id: credentials.agent_id,
				api_key: credentials.api_key,
				default_session_id: null,
			})}\n`,
			{ mode: 0o600 },
		);
		return home;
	}

	function runCli(home: string, args: string[]) {
		const agentRelayHome = join(home, ".agentrelay");
		return spawnSync("node", [CLI_BIN_PATH, ...args], {
			cwd: REPO_ROOT,
			env: {
				...process.env,
				HOME: home,
				AGENTRELAY_HOME: agentRelayHome,
				AGENTRELAY_CONFIG_PATH: join(agentRelayHome, "config.json"),
				AGENTRELAY_TRUST_PATH: join(agentRelayHome, "trust.yaml"),
				AGENTRELAY_LOG_LEVEL: "fatal",
			},
			encoding: "utf8",
			stdio: "pipe",
		});
	}

	async function remoteBlocks(apiKey: string): Promise<string[]> {
		const response = await request(`${relay.baseUrl}/agents/me/block`, {
			headers: { authorization: `Bearer ${apiKey}` },
		});
		const raw = await response.body.text();
		if (response.statusCode !== 200) {
			throw new Error(`block list failed: HTTP ${response.statusCode}: ${raw}`);
		}
		const body = JSON.parse(raw) as { blocked: Array<{ handle: string }> };
		return body.blocked.map((entry) => entry.handle).sort();
	}
});

function diagnostics(result: { stdout: string | Buffer; stderr: string | Buffer }): string {
	return `stdout:\n${String(result.stdout)}\nstderr:\n${String(result.stderr)}`;
}
