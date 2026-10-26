import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { type Server, createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const PACKAGE_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const AGENTRELAY_BIN_PATH = join(PACKAGE_ROOT, "dist/bin/agentrelay.js");
const describeIfBuilt = existsSync(AGENTRELAY_BIN_PATH) ? describe : describe.skip;
const THREAD_ID = "11111111-1111-4111-8111-111111111111";
const KEYS = {
	"alice@team": "fixture-alice-key",
	"bob@team": "fixture-bob-key",
	"eve@team": "fixture-eve-key",
};

describeIfBuilt("agentrelay export-thread CLI", () => {
	let directory: string;
	let server: Server;
	let env: NodeJS.ProcessEnv;
	let relayUrl: string;
	let responseMode: "thread" | "http-error" | "rpc-error" | "malformed" | "invalid";
	let requests: {
		method: string | undefined;
		url: string | undefined;
		bearer: string | undefined;
		body: unknown;
	}[];

	function runCli(args: string[], restrictiveUmask = false) {
		return new Promise<{ status: number | string | undefined; stdout: string; stderr: string }>(
			(resolve) => {
				const nodeArgs = restrictiveUmask
					? [
							"--input-type=module",
							"--eval",
							`process.umask(0o777); process.argv = [process.execPath, ${JSON.stringify(AGENTRELAY_BIN_PATH)}, ...process.argv.slice(1)]; await import(${JSON.stringify(AGENTRELAY_BIN_PATH)});`,
							...args,
						]
					: [AGENTRELAY_BIN_PATH, ...args];
				execFile(
					process.execPath,
					nodeArgs,
					{ cwd: directory, env, encoding: "utf8", timeout: 10_000 },
					(error, stdout, stderr) => {
						resolve({ status: error === null ? 0 : error.code, stdout, stderr });
					},
				);
			},
		);
	}

	async function configure(caller = "alice@team") {
		await writeFile(
			join(directory, "config.json"),
			JSON.stringify({
				relay_url: relayUrl,
				agent_handle: caller,
				agent_id: `id-${caller}`,
				api_key: KEYS[caller as keyof typeof KEYS],
				default_session_id: null,
			}),
		);
	}

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "agentrelay-export-cli-"));
		env = {
			...process.env,
			AGENTRELAY_HOME: directory,
			AGENTRELAY_CONFIG_PATH: join(directory, "config.json"),
		};
		requests = [];
		responseMode = "thread";
		server = createServer(async (request, response) => {
			let body = "";
			for await (const chunk of request) body += chunk;
			const rpc = JSON.parse(body);
			requests.push({
				method: request.method,
				url: request.url,
				bearer: request.headers.authorization,
				body: rpc,
			});
			response.setHeader("content-type", "application/json");
			if (responseMode === "http-error") {
				response.writeHead(401);
				response.end(KEYS["alice@team"]);
				return;
			}
			if (
				request.headers.authorization === `Bearer ${KEYS["eve@team"]}` ||
				responseMode === "rpc-error"
			) {
				response.end(
					JSON.stringify({
						jsonrpc: "2.0",
						id: rpc.id,
						error: {
							code: -32005,
							message: KEYS["alice@team"],
							data: { code: "not_a_participant" },
						},
					}),
				);
				return;
			}
			if (responseMode === "malformed") {
				response.end(`not JSON ${KEYS["alice@team"]}`);
				return;
			}
			response.end(
				JSON.stringify({
					jsonrpc: "2.0",
					id: rpc.id,
					result:
						responseMode === "invalid"
							? { secret: KEYS["alice@team"] }
							: {
									thread_id: THREAD_ID,
									intent: "inform",
									sender: { handle: "alice@team", name: "Alice", role: "frontend" },
									recipient: { handle: "bob@team", name: "Bob", role: "backend" },
									created_at: "2026-10-26T09:00:00Z",
									accepted_at: null,
									completed_at: null,
									completed_summary: null,
									cancelled_at: null,
									summary: "initial summary",
									metadata: { client_idempotency_key: "excluded-transport-key" },
									artifacts: [],
									completion_artifacts: [],
									messages: [
										{
											id: "reply",
											sequence_no: 1,
											from: "bob@team",
											body: "peer reply",
											created_at: "2026-10-26T09:01:00Z",
											artifacts: [],
										},
									],
								},
				}),
			);
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (address === null || typeof address === "string") throw new Error("Missing fixture port");
		relayUrl = `http://127.0.0.1:${address.port}`;
		await configure();
	});

	afterEach(async () => {
		if (server?.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
		if (directory) await rm(directory, { recursive: true, force: true });
	});

	it("lists the command and output option in help", async () => {
		const result = await runCli(["export-thread", "--help"]);
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toContain("export-thread <thread-id>");
		expect(result.stdout).toContain("--output <path>");
		expect(requests).toEqual([]);
	});

	it.each(["alice@team", "bob@team"])(
		"exports using %s's configured identity and prints the default path",
		async (caller) => {
			await configure(caller);
			const result = await runCli(["export-thread", THREAD_ID]);
			expect(result.status, result.stderr).toBe(0);
			expect(result.stderr).toBe("");
			const output = `agentrelay-thread-${THREAD_ID}.md`;
			expect(result.stdout).toBe(`${output}\n`);
			expect((await stat(join(directory, output))).mode & 0o777).toBe(0o600);
			const archive = await readFile(join(directory, output), "utf8");
			expect(archive).toContain(
				caller === "alice@team"
					? "INBOUND HANDOFF FROM bob@team"
					: "INBOUND HANDOFF FROM alice@team",
			);
			expect(archive).toContain("initial summary");
			expect(archive).toContain("peer reply");
			for (const excluded of [
				...Object.values(KEYS),
				"excluded-transport-key",
				"client_idempotency_key",
				directory,
				relayUrl,
			])
				expect(archive).not.toContain(excluded);
			expect(requests).toHaveLength(1);
			expect(requests[0]).toMatchObject({
				method: "POST",
				url: "/a2a",
				bearer: `Bearer ${KEYS[caller as keyof typeof KEYS]}`,
				body: { method: "tasks/get", params: { task_id: THREAD_ID } },
			});
		},
	);

	it("writes an explicit path privately even under a restrictive umask", async () => {
		const output = join(directory, "chosen.md");
		const result = await runCli(["export-thread", THREAD_ID, "--output", output], true);
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toBe(`${output}\n`);
		expect((await stat(output)).mode & 0o777).toBe(0o600);
	});

	it("refuses overwrite and leaves the existing archive unchanged", async () => {
		const output = join(directory, "chosen.md");
		await writeFile(output, "original");
		const result = await runCli(["export-thread", THREAD_ID, "--output", output]);
		expect(result.status).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("Nothing was overwritten");
		expect(await readFile(output, "utf8")).toBe("original");
	});

	it("rejects a non-participant with no archive", async () => {
		await configure("eve@team");
		const result = await runCli(["export-thread", THREAD_ID]);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("not_a_participant");
		expect(result.stderr).not.toContain(KEYS["alice@team"]);
		expect(result.stdout).toBe("");
		expect(await readdir(directory)).toEqual(["config.json"]);
	});

	it.each(["http-error", "rpc-error", "malformed", "invalid"] as const)(
		"reports %s without exposing response content or writing",
		async (mode) => {
			responseMode = mode;
			const result = await runCli(["export-thread", THREAD_ID]);
			expect(result.status).toBe(1);
			expect(result.stdout).toBe("");
			expect(result.stderr).toContain("export-thread:");
			expect(result.stderr).not.toContain(KEYS["alice@team"]);
			expect(await readdir(directory)).toEqual(["config.json"]);
		},
	);

	it("reports network failure without an archive", async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		const result = await runCli(["export-thread", THREAD_ID]);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("network connectivity");
		expect(result.stderr).not.toContain(KEYS["alice@team"]);
		expect(result.stdout).toBe("");
		expect(await readdir(directory)).toEqual(["config.json"]);
	});

	it.each(["missing", "malformed", "invalid"])(
		"reports %s config before contacting Relay",
		async (kind) => {
			if (kind === "missing") await rm(join(directory, "config.json"));
			else
				await writeFile(
					join(directory, "config.json"),
					kind === "malformed"
						? KEYS["alice@team"]
						: JSON.stringify({ api_key: KEYS["alice@team"] }),
				);
			const result = await runCli(["export-thread", THREAD_ID]);
			expect(result.status).toBe(1);
			expect(result.stderr).toContain("config unavailable");
			expect(result.stderr).toContain("agentrelay register");
			expect(result.stderr).not.toContain(KEYS["alice@team"]);
			expect(result.stdout).toBe("");
			expect(requests).toEqual([]);
		},
	);

	it("rejects an invalid thread ID before loading config", async () => {
		await rm(join(directory, "config.json"));
		const result = await runCli(["export-thread", "../unsafe"]);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("thread UUID");
		expect(result.stdout).toBe("");
		expect(requests).toEqual([]);
		expect(await readdir(directory)).toEqual([]);
	});

	it("reports a missing output directory without creating it", async () => {
		const output = join(directory, "absent", "chosen.md");
		const result = await runCli(["export-thread", THREAD_ID, "--output", output]);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("output directory does not exist");
		expect(result.stdout).toBe("");
		expect(await readdir(directory)).toEqual(["config.json"]);
	});

	it("refuses a directory as the output path", async () => {
		const output = join(directory, "existing");
		await mkdir(output);
		const result = await runCli(["export-thread", THREAD_ID, "--output", output]);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("output already exists");
		expect(result.stdout).toBe("");
		expect(await readdir(output)).toEqual([]);
	});
});
