import { type ChildProcess, execFile, execFileSync, spawn } from "node:child_process";
import { appendFileSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import { z } from "zod";
import {
	CODEX_PROBE_CONFIG,
	answerCodexProbeTool,
	assertNoActiveMcpServers,
} from "./codex-probe-policy.js";
import { startCodexSocketHost } from "./codex-socket-host.js";
import { PROBE_INSTRUCTIONS, PROBE_TOOLS } from "./probe-mcp-server.js";
import { ProbeSession } from "./probe-session.js";

const { values } = parseArgs({
	options: { queue: { type: "boolean", default: false } },
	strict: true,
});
const queueMode = values.queue;
if (queueMode && !process.stdin.isTTY) throw new Error("The queue/TUI probe requires a terminal");
const version = execFileSync("codex", ["--version"], { encoding: "utf8", timeout: 10_000 }).trim();
if (version !== "codex-cli 0.154.0") {
	throw new Error("This experimental host probe is pinned to codex-cli 0.154.0");
}
const directory = realpathSync(
	mkdtempSync(join(tmpdir(), queueMode ? "ar-cq-" : "agentrelay-codex-turn-")),
);
const eventsPath = join(directory, "events.jsonl");
const stages: string[] = [];
function record<T extends { stage: string }>(event: T) {
	stages.push(event.stage);
	appendFileSync(eventsPath, `${JSON.stringify({ ...event, at: new Date().toISOString() })}\n`, {
		mode: 0o600,
	});
}
const session = new ProbeSession({ turns: 3, expiresAt: Date.now() + 150_000, onEvent: record });
const env: NodeJS.ProcessEnv = {};
for (const name of [
	"PATH",
	"HOME",
	"USER",
	"LOGNAME",
	"TMPDIR",
	"LANG",
	"LC_ALL",
	"TERM",
	"OPENAI_API_KEY",
]) {
	if (process.env[name] !== undefined) env[name] = process.env[name];
}
const configArgs = Object.entries(CODEX_PROBE_CONFIG).flatMap(([key, value]) => [
	"-c",
	`${key}=${JSON.stringify(value)}`,
]);
const socketHost = queueMode ? await startCodexSocketHost(configArgs, directory, env) : undefined;
const child = spawn(
	socketHost ? process.execPath : "codex",
	socketHost
		? [
				"--import",
				import.meta.resolve("tsx"),
				fileURLToPath(new URL("codex-socket-proxy.ts", import.meta.url)),
				"--socket",
				socketHost.socketPath,
			]
		: ["app-server", "--stdio", ...configArgs],
	{ cwd: directory, env, stdio: ["pipe", "pipe", "pipe"] },
);
// Host diagnostics can contain local configuration; only record that stderr occurred.
let hadStderr = false;
child.stderr.on("data", () => {
	hadStderr = true;
});
const lines = createInterface({ input: child.stdout });
const pending = new Map<
	number,
	{ method: string; resolve: (value: unknown) => void; reject: (e: Error) => void }
>();
const completed = new Map<string, string>();
let threadId: string | undefined;
let turnId: string | undefined;
let nextId = 1;
let failure: Error | undefined;
let turnWaiter: { resolve: () => void; reject: (e: Error) => void } | undefined;
let closing = false;
let tui: ChildProcess | undefined;
let tuiClosed: Promise<void> | undefined;
const childClosed = new Promise<void>((resolve) => child.once("close", () => resolve()));
function fail(message: string) {
	failure ??= new Error(message);
	for (const request of pending.values()) request.reject(failure);
	pending.clear();
	turnWaiter?.reject(failure);
}
function send(value: unknown) {
	child.stdin.write(`${JSON.stringify(value)}\n`, (error) => {
		if (error) fail("Codex probe transport write failed");
	});
}
function request(method: string, params: unknown): Promise<unknown> {
	if (failure) return Promise.reject(failure);
	const id = nextId++;
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			pending.delete(id);
			reject(new Error(`Codex probe timed out: ${method}`));
		}, 30_000);
		pending.set(id, {
			method,
			resolve: (value) => {
				clearTimeout(timer);
				resolve(value);
			},
			reject: (error) => {
				clearTimeout(timer);
				reject(error);
			},
		});
		send({ id, method, params });
	});
}
const packetSchema = z.object({
	id: z.union([z.string(), z.number()]).optional(),
	method: z.string().optional(),
	params: z.unknown(),
	result: z.unknown(),
	error: z.unknown().optional(),
});
const turnEventSchema = z.object({
	threadId: z.string(),
	turn: z.object({ id: z.string(), status: z.string() }),
});
lines.on("line", (line) => {
	try {
		const packet = packetSchema.parse(JSON.parse(line));
		if (packet.method && packet.id !== undefined) {
			if (packet.method !== "item/tool/call" || !threadId || !turnId) {
				send({ id: packet.id, error: { code: -32601, message: "Not permitted by this probe" } });
				fail("Codex requested an operation outside the probe");
				return;
			}
			try {
				const result = answerCodexProbeTool(packet.params, { threadId, turnId }, session);
				send({ id: packet.id, result });
			} catch {
				send({ id: packet.id, result: { success: false, contentItems: [] } });
				fail("Codex tool call failed the fixture boundary");
			}
		} else if (typeof packet.id === "number") {
			const awaiting = pending.get(packet.id);
			if (packet.error !== undefined) {
				const error = z.object({ code: z.number() }).parse(packet.error);
				record({ stage: "rpc_rejected", method: awaiting?.method, code: error.code });
				awaiting?.reject(new Error(`Codex rejected ${awaiting.method} (${error.code})`));
			} else awaiting?.resolve(packet.result);
			pending.delete(packet.id);
		} else if (packet.method === "turn/started" || packet.method === "turn/completed") {
			const event = turnEventSchema.parse(packet.params);
			if (event.threadId !== threadId) throw new Error("Unexpected thread event");
			if (packet.method === "turn/started") {
				if (turnId && !completed.has(turnId)) throw new Error("Unexpected overlapping turn");
				turnId = event.turn.id;
			} else {
				if (event.turn.id !== turnId) throw new Error("Unexpected completed turn");
				completed.set(event.turn.id, event.turn.status);
				turnWaiter?.resolve();
			}
			record({ stage: packet.method, host_thread_id: event.threadId, host_turn_id: event.turn.id });
		} else if (packet.method === "item/completed") {
			const item = z.object({ item: z.object({ type: z.string() }) }).parse(packet.params).item;
			record({ stage: "host_item_completed", item_type: item.type });
		}
	} catch {
		fail("Codex returned an invalid or unexpected probe event");
	}
});
child.on("error", () => fail("Codex probe process failed to start"));
child.stdin.on("error", () => fail("Codex probe input stream failed"));
child.on("exit", () => {
	if (!closing) fail("Codex probe process exited before completion");
});
const onSignal = () => fail("Codex probe stopped locally");
process.once("SIGINT", onSignal);
process.once("SIGTERM", onSignal);

console.log(`Testing ${version}; synthetic receipt log: ${eventsPath}`);
let passed = false;
try {
	await request("initialize", {
		clientInfo: { name: "agentrelay_host_probe", version: "0.0.0" },
		capabilities: { experimentalApi: true },
	});
	send({ method: "initialized", params: {} });
	const config = z
		.object({ config: z.object({ mcp_servers: z.record(z.unknown()).optional() }) })
		.parse(await request("config/read", { includeLayers: false }));
	const disabledServers = Object.fromEntries(
		Object.keys(config.config.mcp_servers ?? {}).map((name) => {
			const key = z
				.string()
				.regex(/^[A-Za-z0-9_-]+$/)
				.parse(name);
			return [`mcp_servers.${key}.enabled`, false];
		}),
	);
	const started = z
		.object({
			thread: z.object({ id: z.string() }),
			approvalPolicy: z.literal("never"),
			sandbox: z.object({ type: z.literal("readOnly") }),
			cwd: z.literal(directory),
		})
		.parse(
			await request("thread/start", {
				cwd: directory,
				ephemeral: !queueMode,
				approvalPolicy: "never",
				approvalsReviewer: "user",
				sandbox: "read-only",
				baseInstructions: PROBE_INSTRUCTIONS,
				developerInstructions:
					"Only run this synthetic communication fixture. Never use other tools.",
				dynamicTools: PROBE_TOOLS.map((tool) => ({ type: "function", ...tool })),
				config: { ...CODEX_PROBE_CONFIG, ...disabledServers },
				environments: [],
			}),
		);
	threadId = started.thread.id;
	record({ stage: "host_session_created", host_thread_id: threadId });
	assertNoActiveMcpServers(await request("mcpServerStatus/list", { threadId, limit: 100 }));
	record({ stage: "inherited_integrations_disabled" });
	if (socketHost) {
		await request("thread/name/set", { threadId, name: "AgentRelay synthetic queue probe" });
		// Remote resume preserves the server's read-only policy and rejects permission overrides.
		const resumeConfigArgs = Object.entries({ ...CODEX_PROBE_CONFIG, ...disabledServers })
			.filter(([key]) => !["approval_policy", "approvals_reviewer", "sandbox_mode"].includes(key))
			.flatMap(([key, value]) => ["-c", `${key}=${JSON.stringify(value)}`]);
		tui = spawn(
			"codex",
			["resume", "--remote", socketHost.endpoint, "--no-alt-screen", ...resumeConfigArgs, threadId],
			{ cwd: directory, env, stdio: "inherit" },
		);
		tuiClosed = new Promise<void>((resolve) => tui!.once("close", () => resolve()));
		tui.on("error", () => fail("Codex probe TUI could not start"));
		tui.on("exit", () => {
			if (!closing) fail("Codex probe TUI closed before completion");
		});
		record({ stage: "tui_launched", host_thread_id: threadId });
		console.log("Leave this synthetic Codex chat empty. The probe will queue three inputs.");
	}
	for (let index = 0; index < 3; index++) {
		const reference = session.nextReference();
		if (reference === null) throw new Error("Missing probe turn");
		const previousTurnId = turnId;
		let acceptedTurnId: string | undefined;
		const text = `Receive this local fixture turn: ${JSON.stringify(reference)}`;
		if (socketHost) {
			try {
				await promisify(execFile)(
					"codex",
					["queue", "--remote", socketHost.endpoint, "--thread", threadId, "--message", text],
					{
						cwd: directory,
						env,
						timeout: 15_000,
						maxBuffer: 256 * 1024,
					},
				);
			} catch {
				throw new Error("The scoped Codex queue command failed");
			}
			record({ stage: "host_queued", host_thread_id: threadId });
		} else {
			const result = z.object({ turn: z.object({ id: z.string() }) }).parse(
				await request("turn/start", {
					threadId,
					clientUserMessageId: reference.message_id,
					input: [{ type: "text", text }],
					effort: "low",
				}),
			);
			acceptedTurnId = result.turn.id;
			record({ stage: "host_accepted", host_turn_id: acceptedTurnId });
		}
		session.markSignalWritten(reference);
		const alreadyCompleted = turnId && turnId !== previousTurnId && completed.has(turnId);
		if (!alreadyCompleted) {
			await new Promise<void>((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error("Codex turn did not complete")), 60_000);
				turnWaiter = {
					resolve: () => {
						clearTimeout(timer);
						resolve();
					},
					reject: (error) => {
						clearTimeout(timer);
						reject(error);
					},
				};
				if (failure) turnWaiter.reject(failure);
			});
			turnWaiter = undefined;
		}
		if (failure) throw failure;
		if (
			!turnId ||
			(acceptedTurnId && turnId !== acceptedTurnId) ||
			completed.get(turnId) !== "completed"
		)
			throw new Error("Codex turn failed");
		if (stages.filter((stage) => stage === "reply_recorded").length !== index + 1) {
			throw new Error("Codex finished without the correlated fixture reply");
		}
	}
	passed = true;
} catch (error) {
	// Do not print upstream errors: they can contain model input or owner config.
	record({ stage: "probe_failed" });
	console.error(
		error instanceof z.ZodError ? "Codex response contract mismatch" : (error as Error).message,
	);
} finally {
	session.stop();
	closing = true;
	if (tui) {
		tui.kill("SIGTERM");
		const timer = setTimeout(() => tui?.kill("SIGKILL"), 3_000);
		await tuiClosed;
		clearTimeout(timer);
	}
	lines.close();
	child.stdin.end();
	child.kill("SIGTERM");
	const killTimer = setTimeout(() => child.kill("SIGKILL"), 3_000);
	await childClosed;
	clearTimeout(killTimer);
	await socketHost?.stop();
	process.removeListener("SIGINT", onSignal);
	process.removeListener("SIGTERM", onSignal);
	console.log(
		JSON.stringify(
			{
				probe: queueMode ? "codex-queue-tui" : "codex-managed-turn",
				version,
				passed,
				hadStderr,
				stages,
				eventsPath,
				claim: queueMode
					? "Synthetic queue input into the probe's own TUI; not Relay delivery"
					: "Synthetic managed-session activation only; not existing-TUI injection or Relay delivery",
			},
			null,
			2,
		),
	);
	process.exitCode = passed ? 0 : 1;
}
