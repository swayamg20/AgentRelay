import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
	CODEX_APP_SERVER_CLIENT_NAME,
	SUPPORTED_CODEX_CLI_VERSION,
} from "../src/codex-app-server-protocol.js";

export interface FakeAppServerOptions {
	readonly version?: string;
	readonly codexHome?: string;
	readonly mismatchedThreadId?: boolean;
	readonly readErrorCode?: number;
	readonly notificationMode?: "valid" | "malformed";
	readonly initializedFailure?: "invalid_json" | "incomplete_frame" | "stdout_eof";
	readonly ignoreRead?: boolean;
	readonly exitAfterRead?: boolean;
	readonly closeInputAfterRead?: boolean;
	readonly unsafePolicy?: boolean;
	readonly requestApproval?: boolean;
	readonly spawnDescendant?: boolean;
	readonly ignoreSigterm?: boolean;
}

export interface FakeAppServerFixture {
	readonly directory: string;
	readonly scriptPath: string;
	readonly logPath: string;
	readonly childPidPath: string;
	readonly argvPath: string;
	readonly environmentPath: string;
	readonly env: NodeJS.ProcessEnv;
	remove(): Promise<void>;
}

export async function createFakeAppServer(
	options: FakeAppServerOptions = {},
): Promise<FakeAppServerFixture> {
	const directory = await realpath(await mkdtemp(join(tmpdir(), "agentrelay-codex-client-")));
	const scriptPath = join(directory, "fake-app-server.mjs");
	const logPath = join(directory, "requests.jsonl");
	const childPidPath = join(directory, "child.pid");
	const argvPath = join(directory, "argv.json");
	const environmentPath = join(directory, "environment.json");
	const configPath = join(directory, "fake-app-server-config.json");
	await writeFile(scriptPath, `#!${process.execPath}\n${FAKE_APP_SERVER_SOURCE}`, { mode: 0o700 });
	await writeFile(
		configPath,
		JSON.stringify({
			version: options.version ?? SUPPORTED_CODEX_CLI_VERSION,
			codexHome: options.codexHome ?? null,
			threadId: options.mismatchedThreadId ? "thread-other" : "thread-1",
			readErrorCode: options.readErrorCode ?? null,
			notificationMode: options.notificationMode ?? "",
			initializedFailure: options.initializedFailure ?? "",
			ignoreRead: options.ignoreRead ?? false,
			exitAfterRead: options.exitAfterRead ?? false,
			closeInputAfterRead: options.closeInputAfterRead ?? false,
			unsafePolicy: options.unsafePolicy ?? false,
			requestApproval: options.requestApproval ?? false,
			spawnDescendant: options.spawnDescendant ?? false,
			ignoreSigterm: options.ignoreSigterm ?? false,
			logPath,
			childPidPath,
			argvPath,
			environmentPath,
		}),
		{ mode: 0o600 },
	);
	return {
		directory,
		scriptPath,
		logPath,
		childPidPath,
		argvPath,
		environmentPath,
		env: {
			PATH: process.env.PATH,
			TMPDIR: process.env.TMPDIR,
			LANG: process.env.LANG,
			TZ: process.env.TZ,
			AGENTRELAY_NODE_TOKEN: "must-not-cross-the-capsule-boundary",
			OPENAI_API_KEY: "must-not-cross-the-capsule-boundary",
			CODEX_API_KEY: "must-not-cross-the-capsule-boundary",
			NODE_OPTIONS: "--no-warnings",
		},
		remove: () => rm(directory, { recursive: true }),
	};
}

export async function waitForMessages(
	path: string,
	count: number,
): Promise<Array<Record<string, unknown>>> {
	const deadline = Date.now() + 2_000;
	while (Date.now() < deadline) {
		const raw = await readFile(path, "utf8").catch(() => "");
		const messages = raw
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		if (messages.length >= count) return messages;
		await delay(10);
	}
	throw new Error(`Timed out waiting for ${count} fake app-server messages`);
}

export async function waitForPid(path: string): Promise<number> {
	const deadline = Date.now() + 2_000;
	while (Date.now() < deadline) {
		const value = await readFile(path, "utf8").catch(() => "");
		const pid = Number(value);
		if (Number.isInteger(pid) && pid > 0) return pid;
		await delay(10);
	}
	throw new Error("Timed out waiting for fake app-server descendant");
}

export async function waitForArgv(path: string): Promise<string[]> {
	const deadline = Date.now() + 2_000;
	while (Date.now() < deadline) {
		const raw = await readFile(path, "utf8").catch(() => "");
		if (raw !== "") return JSON.parse(raw) as string[];
		await delay(10);
	}
	throw new Error("Timed out waiting for fake app-server argv");
}

export async function waitForEnvironment(path: string): Promise<Record<string, string>> {
	const deadline = Date.now() + 2_000;
	while (Date.now() < deadline) {
		const raw = await readFile(path, "utf8").catch(() => "");
		if (raw !== "") return JSON.parse(raw) as Record<string, string>;
		await delay(10);
	}
	throw new Error("Timed out waiting for fake app-server environment");
}

export async function waitForProcessExit(pid: number, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!isProcessAlive(pid)) return;
		await delay(10);
	}
	throw new Error(`App-server descendant ${pid} remained alive`);
}

export function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return errorCode(error) !== "ESRCH";
	}
}

const FAKE_APP_SERVER_SOURCE = `
import { spawn } from "node:child_process";
import { appendFileSync, closeSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import readline from "node:readline";

const config = JSON.parse(readFileSync(
  join(process.cwd(), "fake-app-server-config.json"),
  "utf8",
));
const version = config.version;
writeFileSync(config.environmentPath, JSON.stringify(process.env), { mode: 0o600 });
if (process.argv.includes("--version")) {
  process.stdout.write("codex-cli " + version + "\\n");
  process.exit(0);
}
writeFileSync(config.argvPath, JSON.stringify(process.argv.slice(2)), { mode: 0o600 });
const logPath = config.logPath;
const cwd = process.cwd();
const codexHome = config.codexHome ?? process.env.CODEX_HOME;
const threadId = config.threadId;
const readErrorCode = config.readErrorCode;
const notificationMode = config.notificationMode;
const initializedFailure = config.initializedFailure;
const ignoreRead = config.ignoreRead;
const exitAfterRead = config.exitAfterRead;
const closeInputAfterRead = config.closeInputAfterRead;
const unsafePolicy = config.unsafePolicy;
const requestApproval = config.requestApproval;
if (config.ignoreSigterm) process.on("SIGTERM", () => undefined);
if (config.spawnDescendant) {
  const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  writeFileSync(config.childPidPath, String(descendant.pid), { mode: 0o600 });
}
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const log = (message) => appendFileSync(logPath, JSON.stringify(message) + "\\n", { mode: 0o600 });
const baseThread = (turns = []) => ({
  id: threadId,
  sessionId: threadId,
  ephemeral: false,
  modelProvider: "openai",
  status: { type: "idle" },
  cwd,
  cliVersion: version,
  turns,
});
const turn = (id, status, items = []) => ({
  id,
  items,
  itemsView: status === "inProgress" ? "notLoaded" : "full",
  status,
  error: null,
  startedAt: 1,
  completedAt: status === "inProgress" ? null : 2,
  durationMs: status === "inProgress" ? null : 1_000,
});
const threadResult = () => ({
  thread: baseThread(),
  model: "fake-model",
  modelProvider: "openai",
  serviceTier: null,
  cwd,
  instructionSources: [],
  approvalPolicy: "never",
  approvalsReviewer: "user",
  sandbox: unsafePolicy ? { type: "dangerFullAccess" } : { type: "readOnly", networkAccess: false },
  reasoningEffort: null,
});

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const message = JSON.parse(line);
  log(message);
  switch (message.method) {
    case "initialize":
      send({ id: message.id, result: {
        userAgent: "${CODEX_APP_SERVER_CLIENT_NAME}/" + version + " (Fake OS; arm64)",
        codexHome,
        platformFamily: "unix",
        platformOs: "fake",
      } });
      return;
    case "initialized":
      if (initializedFailure === "invalid_json") process.stdout.write("{invalid-json}\\n");
      if (initializedFailure === "incomplete_frame") {
        process.stdout.write("{\\\"method\\\"");
        process.stdout.end();
      }
      if (initializedFailure === "stdout_eof") process.stdout.end();
      return;
    case "thread/start":
    case "thread/resume":
      send({ id: message.id, result: threadResult() });
      send({ method: "thread/started", params: { thread: baseThread() } });
      if (notificationMode === "valid") {
        send({
          method: "turn/completed",
          params: { threadId, turn: turn("event-turn", "completed") },
          emittedAtMs: 123,
        });
      } else if (notificationMode === "malformed") {
        send({ method: "turn/completed", params: { threadId }, emittedAtMs: 123 });
      }
      return;
    case "thread/read":
      if (ignoreRead) return;
      if (readErrorCode !== null && Number.isInteger(readErrorCode)) {
        send({ id: message.id, error: {
          code: readErrorCode,
          message: "fake provider busy",
          data: { retryAfterMs: 25 },
        } });
        return;
      }
      const readResponse = { id: message.id, result: { thread: baseThread([
        turn("existing-turn", "completed", [{
          type: "userMessage",
          id: "user-1",
          clientId: "existing-delivery:1",
          content: [{ type: "text", text: "existing", text_elements: [] }],
        }]),
      ]) } };
      if (exitAfterRead) {
        process.stdout.write(JSON.stringify(readResponse) + "\\n", () => process.exit(0));
        return;
      }
      if (closeInputAfterRead) {
        setInterval(() => {}, 1_000);
        closeSync(0);
        send(readResponse);
        return;
      }
      send(readResponse);
      return;
    case "turn/start":
      send({ id: message.id, result: { turn: turn("turn-1", "inProgress") } });
      if (requestApproval) {
        send({
          id: "approval-1",
          method: "item/commandExecution/requestApproval",
          params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1" },
        });
      }
      return;
    case "turn/interrupt":
      send({ id: message.id, result: {} });
      return;
    default:
      if (Object.hasOwn(message, "id") && !Object.hasOwn(message, "result") && !Object.hasOwn(message, "error")) {
        send({ id: message.id, error: { code: -32601, message: "not implemented" } });
      }
  }
});
`;

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? String(error.code)
		: undefined;
}
