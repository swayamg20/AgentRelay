import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MailboxEvent } from "../connector/event-client.js";

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

describeIfBuilt("agentrelay watch --stdout", () => {
	let home: string;
	let relayUrl: string;
	let server: ReturnType<typeof createServer>;
	let events: MailboxEvent[];
	let replayStatus: number;
	let holdReplay: boolean;
	let revokeOnStream: boolean;
	let connections: number;
	let requests: Array<{
		path: string;
		cursor: string | null;
		limit: string | null;
		method?: string;
	}>;
	let originalFiles: Array<[string, string]>;
	const processes: Array<{
		child: ReturnType<typeof spawn>;
		done: Promise<{ code: number | null; stdout: string; stderr: string }>;
	}> = [];

	function event(sequence: number, kind: MailboxEvent["kind"] = "message.appended"): MailboxEvent {
		return {
			event_id: `10000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
			cursor: String(sequence),
			thread_id: "20000000-0000-4000-8000-000000000000",
			actor_handle: "sender@team",
			kind,
			created_at: "2026-10-28T00:00:00.000Z",
		};
	}

	beforeEach(async () => {
		home = await mkdtemp(pathResolve(tmpdir(), "agentrelay-stdout-cli-"));
		events = [event(1, "thread.created"), event(2, "thread.accepted"), event(3)];
		replayStatus = 200;
		holdReplay = false;
		revokeOnStream = false;
		connections = 0;
		requests = [];
		server = createServer((request, response) => {
			const url = new URL(request.url ?? "/", "http://localhost");
			requests.push({
				path: url.pathname,
				cursor: url.searchParams.get("after_cursor"),
				limit: url.searchParams.get("limit"),
				method: request.method,
			});
			if (request.headers.authorization !== "Bearer stdout-fixture-key") {
				response.writeHead(401).end();
				return;
			}
			if (url.pathname === "/agents/me/mailbox/events") {
				if (holdReplay) return;
				response.writeHead(replayStatus, { "content-type": "application/json" });
				if (replayStatus !== 200) {
					response.end(JSON.stringify({ detail: "private fixture response body" }));
					return;
				}
				const page = events
					.filter(
						(item) => BigInt(item.cursor) > BigInt(url.searchParams.get("after_cursor") ?? "0"),
					)
					.slice(0, Number(url.searchParams.get("limit")));
				response.end(
					JSON.stringify({
						events: page,
						next_cursor: page.at(-1)?.cursor ?? url.searchParams.get("after_cursor"),
					}),
				);
				return;
			}
			if (url.pathname === "/agents/me/mailbox/events/stream") {
				connections += 1;
				if (revokeOnStream) replayStatus = 401;
				if (connections === 2) events.push(event(4));
				response.writeHead(200, { "content-type": "text/event-stream" });
				response.write('data: {"type":"ready"}\n\n');
				if (connections === 1 && !revokeOnStream) response.end();
				return;
			}
			response.writeHead(404).end();
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("expected local HTTP server port");
		relayUrl = `http://127.0.0.1:${address.port}`;
		originalFiles = [
			[
				"config.json",
				JSON.stringify({
					relay_url: relayUrl,
					api_key: "stdout-fixture-key",
					agent_handle: "receiver@team",
					agent_id: "receiver-id",
					connector_binding: null,
				}),
			],
			["trust.yaml", "version: 1\nunknown_root_key: true\n"],
			["connector-state.json", "preserve this attention checkpoint without parsing it\n"],
		];
		for (const [name, content] of originalFiles)
			await writeFile(pathResolve(home, name), content, { mode: 0o600 });
	});

	afterEach(async () => {
		for (const { child } of processes) if (child.exitCode === null) child.kill("SIGTERM");
		await Promise.allSettled(processes.map(({ done }) => done));
		processes.length = 0;
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(home, { recursive: true, force: true });
	});

	function start(args: string[]) {
		const child = spawn("node", [AGENTRELAY_BIN_PATH, "watch", ...args], {
			cwd: PACKAGE_ROOT,
			env: {
				...process.env,
				AGENTRELAY_HOME: home,
				AGENTRELAY_CONFIG_PATH: pathResolve(home, "config.json"),
				AGENTRELAY_TRUST_PATH: pathResolve(home, "trust.yaml"),
				AGENTRELAY_CONNECTOR_STATE_PATH: pathResolve(home, "connector-state.json"),
			},
			stdio: "pipe",
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += String(chunk);
		});
		child.stderr.on("data", (chunk) => {
			stderr += String(chunk);
		});
		const done = new Promise<{ code: number | null; stdout: string; stderr: string }>(
			(resolve, reject) => {
				child.once("error", reject);
				child.once("close", (code) => resolve({ code, stdout, stderr }));
			},
		);
		processes.push({ child, done });
		return { child, done, stdout: () => stdout, stderr: () => stderr };
	}

	async function expectLocalStateUnchanged() {
		expect((await readdir(home)).sort()).toEqual(originalFiles.map(([name]) => name).sort());
		for (const [name, content] of originalFiles)
			expect(await readFile(pathResolve(home, name), "utf8")).toBe(content);
		expect(
			requests.every(
				(request) =>
					request.method === "GET" &&
					["/agents/me/mailbox/events", "/agents/me/mailbox/events/stream"].includes(request.path),
			),
		).toBe(true);
	}

	it("prints only NDJSON metadata with no binding, valid trust, body fetch, or attention state write", async () => {
		const result = await start(["--stdout", "--once"]).done;
		expect(result.code, result.stderr).toBe(0);
		expect(
			result.stdout
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line)),
		).toEqual([event(1, "thread.created"), event(3)]);
		expect(result.stderr).toContain("passive mailbox replay complete");
		expect(result.stdout).not.toContain("stdout-fixture-key");
		expect(requests).toEqual([
			{ path: "/agents/me/mailbox/events", cursor: null, limit: "100", method: "GET" },
		]);
		await expectLocalStateUnchanged();
	});

	it("honors exclusive --after-cursor and preserves maximum bigint cursor text", async () => {
		const afterFirst = await start(["--stdout", "--once", "--after-cursor", "1"]).done;
		expect(afterFirst.code, afterFirst.stderr).toBe(0);
		expect(
			afterFirst.stdout
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line)),
		).toEqual([event(3)]);
		const afterMaximum = await start(["--stdout", "--once", "--after-cursor=9223372036854775807"])
			.done;
		expect(afterMaximum.code, afterMaximum.stderr).toBe(0);
		expect(afterMaximum.stdout).toBe("");
		expect(requests.at(-1)?.cursor).toBe("9223372036854775807");
		await expectLocalStateUnchanged();
	});

	it.each(["0", "01", "1.0", "1e3", "9223372036854775808"])(
		"rejects invalid CLI cursor %s before connecting",
		async (cursor) => {
			const result = await start(["--stdout", "--once", "--after-cursor", cursor]).done;
			expect(result.code).toBe(1);
			expect(result.stdout).toBe("");
			expect(result.stderr).toContain("--after-cursor must be");
			expect(requests).toEqual([]);
			await expectLocalStateUnchanged();
		},
	);

	it("refuses duplicate cursors rather than silently selecting one", async () => {
		const result = await start(["--stdout", "--once", "--after-cursor", "1", "--after-cursor=3"])
			.done;
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("--after-cursor may only be specified once");
		expect(result.stdout).toBe("");
		expect(requests).toEqual([]);
		await expectLocalStateUnchanged();
	});

	it("refuses --after-cursor in the existing attention mode", async () => {
		const result = await start(["--once", "--after-cursor", "1"]).done;
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("--after-cursor requires --stdout");
		expect(result.stdout).toBe("");
		expect(requests).toEqual([]);
		await expectLocalStateUnchanged();
	});

	it("keeps the default watch binding requirement", async () => {
		const result = await start(["--once"]).done;
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("No Codex session is bound");
		expect(requests).toEqual([]);
	});

	it("fails authentication without exposing the HTTP response body or printing stdout diagnostics", async () => {
		replayStatus = 401;
		const result = await start(["--stdout"]).done;
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("HTTP 401");
		expect(result.stderr).not.toContain("private fixture response body");
		expect(result.stdout).toBe("");
		expect(requests).toHaveLength(1);
		await expectLocalStateUnchanged();
	});

	it("closes the live stream and exits when authentication fails during ready replay", async () => {
		revokeOnStream = true;
		const result = await start(["--stdout"]).done;
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("HTTP 401");
		expect(result.stderr).not.toContain("private fixture response body");
		expect(connections).toBe(1);
		expect(requests).toHaveLength(3);
		await expectLocalStateUnchanged();
	});

	it("rejects a body-bearing replay response without leaking its content", async () => {
		Object.assign(events[0]!, { body: "private fixture message body" });
		const result = await start(["--stdout", "--once"]).done;
		expect(result.code).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).not.toContain("private fixture message body");
		await expectLocalStateUnchanged();
	});

	it("replays after an SSE reconnection, dedupes old references, and leaves diagnostics on stderr", async () => {
		const running = start(["--stdout"]);
		await vi.waitFor(() => expect(running.stdout()).toContain(event(4).event_id), {
			timeout: 5000,
		});
		running.child.kill("SIGTERM");
		const result = await running.done;
		expect(result.code, result.stderr).toBe(0);
		expect(
			result.stdout
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line)),
		).toEqual([event(1, "thread.created"), event(3), event(4)]);
		expect(result.stderr).toContain("passive mailbox connection ready");
		expect(result.stderr).toContain("retrying in 250ms");
		expect(connections).toBe(2);
		await expectLocalStateUnchanged();
	});

	it("cancels an in-flight --once replay without claiming it completed", async () => {
		holdReplay = true;
		const running = start(["--stdout", "--once"]);
		await vi.waitFor(() => expect(requests).toHaveLength(1));
		running.child.kill("SIGTERM");
		const result = await running.done;
		expect(result.code, result.stderr).toBe(0);
		expect(result.stdout).toBe("");
		expect(result.stderr).not.toContain("replay complete");
		await expectLocalStateUnchanged();
	});

	it("stops cleanly during reconnect sleep", async () => {
		const running = start(["--stdout"]);
		await vi.waitFor(() => expect(running.stderr()).toContain("retrying in 250ms"));
		running.child.kill("SIGTERM");
		const result = await running.done;
		expect(result.code, result.stderr).toBe(0);
		expect(connections).toBe(1);
		await expectLocalStateUnchanged();
	});
});
