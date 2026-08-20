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
	readonly versionDelayMs?: number;
	readonly codexHome?: string;
	readonly mismatchedThreadId?: boolean;
	readonly readErrorCode?: number;
	readonly notificationMode?: "valid" | "malformed";
	readonly initializedFailure?: "invalid_json" | "incomplete_frame" | "stdout_eof";
	readonly loginMode?: "success" | "error" | "echo_error" | "malformed" | "ignore";
	readonly accountMode?: "success" | "error" | "malformed" | "ignore";
	readonly ignoreRead?: boolean;
	readonly exitAfterRead?: boolean;
	readonly closeInputAfterRead?: boolean;
	readonly unsafePolicy?: boolean;
	readonly requestApproval?: boolean;
	readonly spawnDescendant?: boolean;
	readonly ignoreSigterm?: boolean;
	readonly continuousOutput?: boolean;
	readonly gateContinuousOutput?: boolean;
	readonly workspacePath?: string;
	readonly effectiveTrust?: "untrusted" | "trusted" | "missing";
	readonly effectiveMcpServers?: Readonly<Record<string, unknown>>;
	readonly featurePages?: readonly (readonly Readonly<{
		readonly name: string;
		readonly enabled: boolean;
	}>[])[];
	readonly featureError?: boolean;
	readonly maliciousMcpMarkerPath?: string;
}

export interface FakeAppServerFixture {
	readonly directory: string;
	readonly workspacePath: string;
	readonly scriptPath: string;
	readonly logPath: string;
	readonly childPidPath: string;
	readonly argvPath: string;
	readonly environmentPath: string;
	readonly processCwdPath: string;
	readonly versionPidPath: string;
	readonly appServerPidPath: string;
	readonly credentialDigestPath: string;
	readonly continuousOutputGatePath: string;
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
	const processCwdPath = join(directory, "process-cwd.txt");
	const versionPidPath = join(directory, "version.pid");
	const appServerPidPath = join(directory, "app-server.pid");
	const credentialDigestPath = join(directory, "credential.sha256");
	const continuousOutputGatePath = join(directory, "continuous-output-go");
	const configPath = join(directory, "fake-app-server-config.json");
	const workspacePath = options.workspacePath ?? directory;
	await writeFile(scriptPath, `#!${process.execPath}\n${FAKE_APP_SERVER_SOURCE}`, { mode: 0o700 });
	await writeFile(
		configPath,
		JSON.stringify({
			version: options.version ?? SUPPORTED_CODEX_CLI_VERSION,
			versionDelayMs: options.versionDelayMs ?? 0,
			codexHome: options.codexHome ?? null,
			threadId: options.mismatchedThreadId ? "thread-other" : "thread-1",
			readErrorCode: options.readErrorCode ?? null,
			notificationMode: options.notificationMode ?? "",
			initializedFailure: options.initializedFailure ?? "",
			loginMode: options.loginMode ?? "success",
			accountMode: options.accountMode ?? "success",
			ignoreRead: options.ignoreRead ?? false,
			exitAfterRead: options.exitAfterRead ?? false,
			closeInputAfterRead: options.closeInputAfterRead ?? false,
			unsafePolicy: options.unsafePolicy ?? false,
			requestApproval: options.requestApproval ?? false,
			spawnDescendant: options.spawnDescendant ?? false,
			ignoreSigterm: options.ignoreSigterm ?? false,
			continuousOutput: options.continuousOutput ?? false,
			continuousOutputGatePath: options.gateContinuousOutput ? continuousOutputGatePath : null,
			workspacePath,
			effectiveTrust: options.effectiveTrust ?? "untrusted",
			effectiveMcpServers: options.effectiveMcpServers ?? null,
			featurePages: options.featurePages ?? [[{ name: "shell_tool", enabled: false }]],
			featureError: options.featureError ?? false,
			maliciousMcpMarkerPath: options.maliciousMcpMarkerPath ?? null,
			logPath,
			childPidPath,
			argvPath,
			environmentPath,
			processCwdPath,
			versionPidPath,
			appServerPidPath,
			credentialDigestPath,
		}),
		{ mode: 0o600 },
	);
	return {
		directory,
		workspacePath,
		scriptPath,
		logPath,
		childPidPath,
		argvPath,
		environmentPath,
		processCwdPath,
		versionPidPath,
		appServerPidPath,
		credentialDigestPath,
		continuousOutputGatePath,
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
import { createHash } from "node:crypto";
import { appendFileSync, closeSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline";

const config = JSON.parse(readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "fake-app-server-config.json"),
  "utf8",
));
const version = config.version;
writeFileSync(config.environmentPath, JSON.stringify(process.env), { mode: 0o600 });
if (process.argv.includes("--version")) {
  writeFileSync(config.versionPidPath, String(process.pid), { mode: 0o600 });
  setTimeout(() => {
    process.stdout.write("codex-cli " + version + "\\n");
    process.exit(0);
  }, config.versionDelayMs);
} else {
  startAppServer();
}
function startAppServer() {
writeFileSync(config.appServerPidPath, String(process.pid), { mode: 0o600 });
writeFileSync(config.argvPath, JSON.stringify(process.argv.slice(2)), { mode: 0o600 });
writeFileSync(config.processCwdPath, process.cwd(), { mode: 0o600 });
const logPath = config.logPath;
const cwd = config.workspacePath;
const codexHome = config.codexHome ?? process.env.CODEX_HOME;
const threadId = config.threadId;
const readErrorCode = config.readErrorCode;
const notificationMode = config.notificationMode;
const initializedFailure = config.initializedFailure;
const loginMode = config.loginMode;
const accountMode = config.accountMode;
const ignoreRead = config.ignoreRead;
const exitAfterRead = config.exitAfterRead;
const closeInputAfterRead = config.closeInputAfterRead;
const unsafePolicy = config.unsafePolicy;
const requestApproval = config.requestApproval;
const argv = process.argv.slice(2);
const untrustedProjectOverride = "projects={" + JSON.stringify(cwd) + "={trust_level=\\\"untrusted\\\"}}";
if (
  config.maliciousMcpMarkerPath !== null &&
  existsSync(join(cwd, ".codex", "config.toml")) &&
  !argv.includes(untrustedProjectOverride)
) {
  writeFileSync(config.maliciousMcpMarkerPath, "launched\\n", { mode: 0o600 });
}
if (config.ignoreSigterm) process.on("SIGTERM", () => undefined);
let continuousOutputStarted = false;
let threadLoaded = false;
if (config.spawnDescendant) {
  const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  writeFileSync(config.childPidPath, String(descendant.pid), { mode: 0o600 });
}
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const log = (message) => appendFileSync(logPath, JSON.stringify(message) + "\\n", { mode: 0o600 });
const redactForLog = (message) => {
  if (
    message.method !== "account/login/start" ||
    typeof message.params !== "object" ||
    message.params === null
  ) return message;
  return { ...message, params: { ...message.params, apiKey: "[redacted]" } };
};
const baseThread = (turns = [], status = threadLoaded ? { type: "idle" } : { type: "notLoaded" }) => ({
  id: threadId,
  sessionId: threadId,
  ephemeral: false,
  modelProvider: "openai",
  status,
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
  approvalPolicy: "untrusted",
  approvalsReviewer: "user",
  sandbox: unsafePolicy ? { type: "dangerFullAccess" } : { type: "readOnly", networkAccess: false },
  reasoningEffort: null,
});

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const message = JSON.parse(line);
  log(redactForLog(message));
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
    case "account/login/start": {
      const apiKey = message.params?.type === "apiKey" ? message.params.apiKey : null;
      if (typeof apiKey !== "string") {
        send({ id: message.id, error: { code: -32602, message: "invalid API-key login" } });
        return;
      }
      writeFileSync(
        config.credentialDigestPath,
        createHash("sha256").update(apiKey, "utf8").digest("hex") + "\\n",
        { mode: 0o600 },
      );
      if (loginMode === "ignore") return;
      if (loginMode === "error") {
        send({ id: message.id, error: { code: -32001, message: "fake login rejected" } });
        return;
      }
      if (loginMode === "echo_error") {
        send({ id: message.id, error: {
          code: -32001,
          message: "fake login rejected " + apiKey,
          data: { echoedApiKey: apiKey },
        } });
        return;
      }
      if (loginMode === "malformed") {
        send({ id: message.id, result: { type: "chatgpt", echoedApiKey: apiKey } });
        return;
      }
      send({ id: message.id, result: { type: "apiKey" } });
      send({
        method: "account/login/completed",
        params: { loginId: null, success: true, error: null },
      });
      send({ method: "account/updated", params: { authMode: "apikey", planType: null } });
      return;
    }
    case "account/read":
      if (accountMode === "ignore") return;
      if (accountMode === "error") {
        send({ id: message.id, error: { code: -32002, message: "fake account read failed" } });
        return;
      }
      if (accountMode === "malformed") {
        send({ id: message.id, result: { account: null, requiresOpenaiAuth: true } });
        return;
      }
      send({
        id: message.id,
        result: { account: { type: "apiKey" }, requiresOpenaiAuth: true },
      });
      return;
    case "config/read": {
      const project = config.effectiveTrust === "missing"
        ? {}
        : { [cwd]: { trust_level: config.effectiveTrust } };
      const effective = {
        projects: project,
        features: { shell_tool: false },
        ...(config.effectiveMcpServers === null
          ? {}
          : { mcp_servers: config.effectiveMcpServers }),
      };
      send({ id: message.id, result: { config: effective, origins: {} } });
      return;
    }
    case "experimentalFeature/list": {
      if (config.featureError) {
        send({ id: message.id, error: { code: -32003, message: "feature list failed" } });
        return;
      }
      const page = message.params?.cursor === undefined
        ? 0
        : Number(String(message.params.cursor).replace("page-", ""));
      const next = page + 1 < config.featurePages.length ? "page-" + (page + 1) : null;
      send({ id: message.id, result: { data: config.featurePages[page] ?? [], nextCursor: next } });
      return;
    }
    case "thread/loaded/list":
      send({
        id: message.id,
        result: { data: threadLoaded ? [threadId] : [], nextCursor: null },
      });
      return;
    case "thread/start":
    case "thread/resume":
      threadLoaded = true;
      send({ id: message.id, result: threadResult() });
      send({ method: "thread/started", params: { thread: baseThread() } });
      if (config.continuousOutput && !continuousOutputStarted) {
        continuousOutputStarted = true;
        process.stdout.on("error", () => undefined);
        const startContinuousOutput = () =>
          setInterval(() => process.stdout.write("x".repeat(4096)), 1);
        if (config.continuousOutputGatePath === null) {
          setTimeout(startContinuousOutput, 100);
        } else {
          const gate = setInterval(() => {
            if (!existsSync(config.continuousOutputGatePath)) return;
            clearInterval(gate);
            startContinuousOutput();
          }, 10);
        }
      }
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
}
`;

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? String(error.code)
		: undefined;
}
