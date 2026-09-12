import { type ChildProcess, execFile, spawn } from "node:child_process";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import {
	COMMUNICATION_CODEX_CONFIG,
	assertCommunicationMcpInventory,
	codexChildEnvironment,
} from "./codex-policy.js";
import { CodexLiveRpc } from "./codex-rpc.js";
import { startCodexSocketHost } from "./codex-socket.js";
import { LIVE_CODEX_INSTRUCTIONS, LIVE_CODEX_TOOLS, LiveCodexTurn } from "./codex-tools.js";
import { type LiveRuntime, LiveSessionError } from "./contracts.js";

/** A new, owned communication-only host; never attaches to a pre-existing chat. */
export function createCodexLiveRuntime(
	options: {
		show?: boolean;
		onSession?: (threadId: string) => void;
		onAccepted?: (messageId: string) => void;
	} = {},
): LiveRuntime {
	let opened: Promise<Awaited<ReturnType<typeof openHost>>> | undefined;
	let closed = false;
	return {
		async runTurn(input, signal) {
			if (closed) throw new LiveSessionError("closed", "Codex live session is closed");
			signal.throwIfAborted();
			opened ??= openHost(options);
			const host = await opened;
			signal.throwIfAborted();
			return host.runTurn(input, signal);
		},
		async close() {
			closed = true;
			if (opened) await (await opened.catch(() => undefined))?.close();
		},
	};
}

async function openHost(options: {
	show?: boolean;
	onSession?: (threadId: string) => void;
	onAccepted?: (messageId: string) => void;
}) {
	if (options.show && !process.stdin.isTTY)
		throw new LiveSessionError("terminal_required", "--show requires an interactive terminal");
	const env = codexChildEnvironment();
	let version: string;
	try {
		version = (
			await promisify(execFile)("codex", ["--version"], { env, timeout: 10_000 })
		).stdout.trim();
	} catch {
		throw new LiveSessionError(
			"codex_missing",
			"Install and sign in to Codex CLI 0.154.0 before starting a live session",
		);
	}
	if (version !== "codex-cli 0.154.0")
		throw new LiveSessionError(
			"codex_version",
			"This live preview requires the tested Codex CLI 0.154.0",
		);
	const directory = await realpath(await mkdtemp(join(tmpdir(), "ar-live-")));
	const configArgs = Object.entries(COMMUNICATION_CODEX_CONFIG).flatMap(([key, value]) => [
		"-c",
		`${key}=${JSON.stringify(value)}`,
	]);
	const processHost = await startCodexSocketHost(configArgs, directory, env);
	const rpc = new CodexLiveRpc(processHost.socketPath);
	let tui: ChildProcess | undefined;
	let tuiClosed: Promise<void> | undefined;
	let active:
		| {
				turn: LiveCodexTurn;
				resolve(result: Awaited<ReturnType<LiveRuntime["runTurn"]>>): void;
				reject(error: Error): void;
		  }
		| undefined;
	let threadId: string | undefined;
	let closing: Promise<void> | undefined;
	const close = () => {
		closing ??= (async () => {
			if (tui) {
				tui.kill("SIGTERM");
				const timer = setTimeout(() => tui?.kill("SIGKILL"), 3_000);
				await tuiClosed;
				clearTimeout(timer);
			}
			await rpc.close();
			await processHost.stop();
		})();
		return closing;
	};
	rpc.onFailure = (error) => {
		active?.reject(error);
	};
	rpc.onRequest = (method, params) => {
		if (method !== "item/tool/call" || !active) throw new Error("No approved live tool call");
		return active.turn.answer(params);
	};
	rpc.onNotification = (method, params) => {
		if (method === "turn/started" || method === "turn/completed") {
			const event = z
				.object({ threadId: z.string(), turn: z.object({ id: z.string(), status: z.string() }) })
				.parse(params);
			if (!active || event.threadId !== threadId) throw new Error("Unowned turn");
			if (method === "turn/started") {
				if (active.turn.turnId) throw new Error("Overlapping turn");
				active.turn.turnId = event.turn.id;
				options.onAccepted?.(active.turn.input.messageId);
			} else {
				if (event.turn.id !== active.turn.turnId) throw new Error("Wrong completion");
				active.resolve(active.turn.completed(event.turn.status));
			}
		} else if (method === "item/started") {
			const item = z.object({ item: z.object({ type: z.string() }) }).parse(params).item;
			if (!["userMessage", "agentMessage", "reasoning", "dynamicToolCall"].includes(item.type))
				throw new Error("Unexpected host capability");
		}
	};
	try {
		await rpc.request("initialize", {
			clientInfo: { name: "agentrelay_live", version: "0.1.0" },
			capabilities: { experimentalApi: true },
		});
		rpc.notify("initialized", {});
		const config = z
			.object({ config: z.object({ mcp_servers: z.record(z.unknown()).optional() }) })
			.parse(await rpc.request("config/read", { includeLayers: false }));
		const disabledServers = Object.fromEntries(
			Object.keys(config.config.mcp_servers ?? {}).map((name) => [
				`mcp_servers.${z
					.string()
					.regex(/^[A-Za-z0-9_-]+$/)
					.parse(name)}.enabled`,
				false,
			]),
		);
		const started = z
			.object({
				thread: z.object({ id: z.string() }),
				approvalPolicy: z.literal("never"),
				sandbox: z.object({ type: z.literal("readOnly") }),
				cwd: z.literal(directory),
			})
			.parse(
				await rpc.request("thread/start", {
					cwd: directory,
					ephemeral: false,
					approvalPolicy: "never",
					approvalsReviewer: "user",
					sandbox: "read-only",
					baseInstructions: LIVE_CODEX_INSTRUCTIONS,
					developerInstructions:
						"The local owner permits bounded communication only. Never use other tools.",
					dynamicTools: LIVE_CODEX_TOOLS,
					config: { ...COMMUNICATION_CODEX_CONFIG, ...disabledServers },
					environments: [],
				}),
			);
		threadId = started.thread.id;
		assertCommunicationMcpInventory(
			await rpc.request("mcpServerStatus/list", { threadId, limit: 100 }),
		);
		await rpc.request("thread/name/set", {
			threadId,
			name: "AgentRelay communication-only live session",
		});
		options.onSession?.(threadId);
		if (options.show) {
			const args = Object.entries({ ...COMMUNICATION_CODEX_CONFIG, ...disabledServers })
				.filter(([key]) => !["approval_policy", "approvals_reviewer", "sandbox_mode"].includes(key))
				.flatMap(([key, value]) => ["-c", `${key}=${JSON.stringify(value)}`]);
			tui = spawn(
				"codex",
				["resume", "--remote", processHost.endpoint, "--no-alt-screen", ...args, threadId],
				{ env, cwd: directory, stdio: "inherit" },
			);
			tuiClosed = new Promise<void>((resolve) => tui!.once("close", () => resolve()));
			tui.on("error", () => rpc.fail("tui_failed"));
			tui.on("exit", () => {
				if (!closing) rpc.fail("tui_closed");
			});
		}
	} catch (error) {
		await close();
		throw error;
	}
	return {
		async runTurn(input: { messageId: string; content: string }, signal: AbortSignal) {
			if (active || closing || !threadId)
				throw new LiveSessionError(
					"host_busy",
					"Codex session is not available for a new live turn",
				);
			const turn = new LiveCodexTurn(input, threadId);
			const completed = new Promise<Awaited<ReturnType<LiveRuntime["runTurn"]>>>(
				(resolve, reject) => {
					active = { turn, resolve, reject };
				},
			);
			void completed.catch(() => {});
			const abort = () => {
				rpc.fail("stopped");
				void close();
			};
			const timeout = setTimeout(() => {
				rpc.fail("turn_timeout");
				void close();
			}, 90_000);
			signal.addEventListener("abort", abort, { once: true });
			try {
				signal.throwIfAborted();
				const accepted = z.object({ turn: z.object({ id: z.string() }) }).parse(
					await rpc.request("turn/start", {
						threadId,
						clientUserMessageId: input.messageId,
						effort: "low",
						input: [
							{
								type: "text",
								text: `Receive and respond to the locally approved message: ${JSON.stringify({ message_id: input.messageId })}`,
							},
						],
					}),
				);
				const result = await completed;
				if (result.host.turnId !== accepted.turn.id)
					throw new LiveSessionError(
						"wrong_completion",
						"Codex completion did not match the started turn",
					);
				return result;
			} finally {
				clearTimeout(timeout);
				signal.removeEventListener("abort", abort);
				active = undefined;
			}
		},
		close,
	};
}
