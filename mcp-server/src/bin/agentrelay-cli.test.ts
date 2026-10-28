import { execFile, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { type Server, createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const require = createRequire(import.meta.url);
const pkg = require("../../package.json") as { version: string };
const PACKAGE_ROOT = pathResolve(__dirname, "../..");
const AGENTRELAY_BIN_PATH = pathResolve(PACKAGE_ROOT, "dist/bin/agentrelay.js");

const describeIfBuilt = existsSync(AGENTRELAY_BIN_PATH) ? describe : describe.skip;

describeIfBuilt("agentrelay CLI mcp subcommand", () => {
	beforeAll(async () => {
		await access(AGENTRELAY_BIN_PATH);
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
		expect(result.stdout).toMatch(/watch\s+Keep a live, replayable connection/);
		expect(result.stdout).toContain("live <runtime>");
	});

	it("requires explicit live consent before reading local configuration", () => {
		const result = spawnSync(
			"node",
			[
				AGENTRELAY_BIN_PATH,
				"live",
				"codex",
				"--peer",
				"test@team",
				"--handoff",
				"11111111-1111-4111-8111-111111111111",
			],
			{ cwd: PACKAGE_ROOT, encoding: "utf8", stdio: "pipe" },
		);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("--allow-replies");
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

	it("reports the package version during MCP initialization", async () => {
		const transport = new StdioClientTransport({
			command: "node",
			args: [AGENTRELAY_BIN_PATH, "mcp"],
			cwd: PACKAGE_ROOT,
			stderr: "pipe",
		});
		const client = new Client({ name: "agentrelay-version-test", version: "1.0.0" });

		try {
			await client.connect(transport);
			expect(client.getServerVersion()).toEqual({
				name: "agentrelay-mcp",
				version: pkg.version,
			});
		} finally {
			await client.close();
		}
	});
});

describeIfBuilt("agentrelay watch --stdout CLI", () => {
	const apiKey = "fixture-stdout-watch-key";
	const events = [
		{ cursor: "1", kind: "thread.created" },
		{ cursor: "2", kind: "thread.accepted" },
		{ cursor: "3", kind: "message.appended" },
	].map((reference) => ({
		...reference,
		event_id: `11111111-1111-4111-8111-${reference.cursor.padStart(12, "0")}`,
		thread_id: "22222222-2222-4222-8222-222222222222",
		actor_handle: "alice@team",
		created_at: "2026-10-28T10:00:00.000Z",
	}));
	let directory: string;
	let server: Server;
	let env: NodeJS.ProcessEnv;
	let requests: URL[];
	let mode: "ok" | "replay-auth" | "stream-auth" | "invalid-event";

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "agentrelay-stdout-cli-"));
		requests = [];
		mode = "ok";
		server = createServer((request, response) => {
			const url = new URL(request.url ?? "/", "http://localhost");
			requests.push(url);
			expect(request.method).toBe("GET");
			expect(request.headers.authorization).toBe(`Bearer ${apiKey}`);
			if (mode === "replay-auth" || (mode === "stream-auth" && url.pathname.endsWith("/stream"))) {
				response.writeHead(401);
				response.end(apiKey);
				return;
			}
			if (url.pathname === "/agents/me/mailbox/events/stream") {
				response.writeHead(200, { "content-type": "text/event-stream" });
				response.write('data: {"type":"ready"}\n\n');
				return;
			}
			expect(url.pathname).toBe("/agents/me/mailbox/events");
			expect(url.searchParams.get("limit")).toBe("100");
			const cursor = BigInt(url.searchParams.get("after_cursor") ?? "0");
			const page = events.filter((event) => BigInt(event.cursor) > cursor);
			response.setHeader("content-type", "application/json");
			response.end(
				JSON.stringify({
					events: mode === "invalid-event" ? [{ ...events[0], body: apiKey }] : page,
					next_cursor: page.at(-1)?.cursor ?? null,
				}),
			);
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Expected HTTP fixture port");
		env = {
			...process.env,
			AGENTRELAY_HOME: directory,
			AGENTRELAY_CONFIG_PATH: join(directory, "config.json"),
			AGENTRELAY_TRUST_PATH: join(directory, "trust.yaml"),
			AGENTRELAY_CONNECTOR_STATE_PATH: join(directory, "connector-state.json"),
		};
		await writeFile(
			join(directory, "config.json"),
			JSON.stringify({
				relay_url: `http://127.0.0.1:${address.port}`,
				agent_handle: "receiver@team",
				agent_id: "receiver-id",
				api_key: apiKey,
				default_session_id: null,
			}),
		);
		await writeFile(join(directory, "trust.yaml"), "version: 1\nteammate: {}\n");
		await writeFile(join(directory, "connector-state.json"), "attention checkpoint sentinel\n");
	});

	afterEach(async () => {
		server.closeAllConnections();
		await new Promise<void>((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		);
		await rm(directory, { recursive: true, force: true });
	});

	function runCli(args: string[], stopWhenConnected = false) {
		return new Promise<{ status: number | string | undefined; stdout: string; stderr: string }>(
			(resolve) => {
				const child = execFile(
					process.execPath,
					[AGENTRELAY_BIN_PATH, "watch", ...args],
					{ cwd: directory, env, encoding: "utf8", timeout: 10_000 },
					(error, stdout, stderr) =>
						resolve({ status: error === null ? 0 : error.code, stdout, stderr }),
				);
				if (stopWhenConnected) {
					child.stderr?.on("data", (chunk) => {
						if (String(chunk).includes("mailbox observer connected")) child.kill("SIGTERM");
					});
				}
			},
		);
	}

	it("documents both passive mode and its cursor flag", async () => {
		const result = await runCli(["--help"]);
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("--stdout");
		expect(result.stdout).toContain("--after-cursor");
		expect(requests).toHaveLength(0);
	});

	it("prints only metadata NDJSON without a binding, valid trust, or checkpoint changes", async () => {
		const files = (await readdir(directory)).sort();
		const before = await Promise.all(files.map((file) => readFile(join(directory, file), "utf8")));
		const result = await runCli(["--stdout", "--once"]);
		expect(result.status, result.stderr).toBe(0);
		expect(result.stderr).toBe("");
		expect(
			result.stdout
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line)),
		).toEqual([events[0], events[2]]);
		expect(result.stdout).not.toContain(apiKey);
		expect(result.stdout).not.toContain("replay complete");
		expect((await readdir(directory)).sort()).toEqual(files);
		expect(await Promise.all(files.map((file) => readFile(join(directory, file), "utf8")))).toEqual(
			before,
		);
		expect(requests).toHaveLength(1);
	});

	it("uses an exclusive custom cursor", async () => {
		const result = await runCli(["--stdout", "--once", "--after-cursor", "1"]);
		expect(result.status, result.stderr).toBe(0);
		expect(JSON.parse(result.stdout)).toEqual(events[2]);
		expect(requests[0]?.searchParams.get("after_cursor")).toBe("1");
	});

	it.each(["--after-cursor", "--after-cursor="])(
		"preserves bigint precision with %s",
		async (flag) => {
			const value = "9223372036854775807";
			const args = flag.endsWith("=") ? [`${flag}${value}`] : [flag, value];
			const result = await runCli(["--stdout", "--once", ...args]);
			expect(result.status, result.stderr).toBe(0);
			expect(result.stdout).toBe("");
			expect(requests[0]?.searchParams.get("after_cursor")).toBe(value);
		},
	);

	it.each(["0", "01", "1e2", "0x10", "9223372036854775808"])(
		"rejects lexical cursor %s before I/O",
		async (cursor) => {
			const result = await runCli(["--stdout", "--once", "--after-cursor", cursor]);
			expect(result.status).toBe(1);
			expect(result.stdout).toBe("");
			expect(result.stderr).toContain("Invalid watch options");
			expect(requests).toHaveLength(0);
		},
	);

	it("rejects repeated cursor flags rather than picking a checkpoint", async () => {
		const result = await runCli([
			"--stdout",
			"--once",
			"--after-cursor",
			"1",
			"--after-cursor",
			"3",
		]);
		expect(result.status).toBe(1);
		expect(result.stdout).toBe("");
		expect(requests).toHaveLength(0);
	});

	it("does not interpret arguments after -- as replay options", async () => {
		const result = await runCli(["--stdout", "--once", "--", "--after-cursor", "1"]);
		expect(result.status, result.stderr).toBe(0);
		expect(
			result.stdout
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line)),
		).toEqual([events[0], events[2]]);
		expect(requests[0]?.searchParams.has("after_cursor")).toBe(false);
	});

	it("keeps attention mode binding checks and rejects passive-only cursors", async () => {
		const rejectedCursor = await runCli(["--once", "--after-cursor", "1"]);
		expect(rejectedCursor.status).toBe(1);
		expect(rejectedCursor.stderr).toContain("requires --stdout");
		const attention = await runCli(["--once"]);
		expect(attention.status).toBe(1);
		expect(attention.stderr).toContain("No Codex session is bound");
		expect(requests).toHaveLength(0);
	});

	it("fails replay authentication without printing the error body", async () => {
		mode = "replay-auth";
		const result = await runCli(["--stdout", "--once"]);
		expect(result.status).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("HTTP 401");
		expect(result.stderr).not.toContain(apiKey);
		expect(requests).toHaveLength(1);
	});

	it("fails stream authentication rather than polling after replay", async () => {
		mode = "stream-auth";
		const result = await runCli(["--stdout"]);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("HTTP 401");
		expect(result.stderr).not.toContain(apiKey);
		expect(
			result.stdout
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line)),
		).toEqual([events[0], events[2]]);
		expect(requests.map((url) => url.pathname)).toEqual([
			"/agents/me/mailbox/events",
			"/agents/me/mailbox/events/stream",
		]);
	});

	it("rejects content-bearing event envelopes without exposing schema details", async () => {
		mode = "invalid-event";
		const result = await runCli(["--stdout", "--once"]);
		expect(result.status).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("event compatibility");
		expect(result.stderr).not.toContain(apiKey);
	});

	it("keeps live diagnostics on stderr and exits cleanly on SIGTERM", async () => {
		const result = await runCli(["--stdout"], true);
		expect(result.status, result.stderr).toBe(0);
		expect(result.stderr).toContain("mailbox observer connected");
		expect(
			result.stdout
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line)),
		).toEqual([events[0], events[2]]);
		expect(requests.map((url) => url.pathname)).toEqual([
			"/agents/me/mailbox/events",
			"/agents/me/mailbox/events/stream",
			"/agents/me/mailbox/events",
		]);
	});
});
