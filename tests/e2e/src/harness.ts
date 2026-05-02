import {
  spawn,
  type ChildProcessByStdio,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile, chmod } from "node:fs/promises";
import { dirname, resolve as pathResolve } from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { request } from "undici";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
export const REPO_ROOT = pathResolve(__dirname, "../../..");
const RELAY_PACKAGE_ROOT = pathResolve(REPO_ROOT, "relay");
const RELAY_TEST_UTILS_PATH = pathResolve(REPO_ROOT, "relay/dist/db/test-utils.js");

// Single source of truth for the MCP server binary path. Issue #5 moved
// internal callers to `agentrelay mcp`; the deprecated `agentrelay-mcp`
// bin is still preserved for one minor version for external compatibility.
export const MCP_BIN_PATH = pathResolve(REPO_ROOT, "mcp-server/dist/bin/agentrelay.js");
export const RELAY_BIN_PATH = pathResolve(REPO_ROOT, "relay/dist/main.js");

type RelayChild =
  | ChildProcessWithoutNullStreams
  | ChildProcessByStdio<null, Readable, Readable>;

type RelayExit = {
  code: number | null;
  signal: NodeJS.Signals | null;
};

type TestDbUtils = {
  tryConnect: () => Promise<{
    available: boolean;
    reason?: string;
    handle?: {
      sql: unknown;
      close: () => Promise<void>;
    };
  }>;
  truncateAll: (sql: unknown) => Promise<void>;
};

type CreatedAgent = {
  agent_id: string;
  handle: string;
  api_key: string;
};

export class TestRelay {
  readonly baseUrl: string;
  readonly adminToken: string;
  readonly port: number;

  private readonly child: RelayChild;
  private stderrBuffer = "";
  private exit: RelayExit | undefined;
  private stopPromise: Promise<void> | undefined;

  private constructor(input: {
    child: RelayChild;
    baseUrl: string;
    adminToken: string;
    port: number;
  }) {
    this.child = input.child;
    this.baseUrl = input.baseUrl;
    this.adminToken = input.adminToken;
    this.port = input.port;

    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => {
      this.stderrBuffer += chunk;
    });
    this.child.once("exit", (code, signal) => {
      this.exit = { code, signal };
    });
  }

  static async boot(opts?: { databaseUrl?: string; port?: number }): Promise<TestRelay> {
    const port = opts?.port ?? 18080;
    const baseUrl = `http://localhost:${port}`;
    const adminToken = randomBytes(32).toString("hex");
    const databaseUrl =
      opts?.databaseUrl ??
      process.env.RELAY_TEST_DATABASE_URL ??
      "postgres://agentrelay:agentrelay-dev@localhost:5433/agentrelay";

    await resetTestDatabase(databaseUrl);

    const env = envWith({
      RELAY_DATABASE_URL: databaseUrl,
      RELAY_PEPPER: randomBytes(32).toString("hex"),
      RELAY_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
      RELAY_INVITE_SECRET: randomBytes(32).toString("hex"),
      RELAY_ADMIN_TOKEN: adminToken,
      RELAY_METRICS_TOKEN: randomBytes(32).toString("hex"),
      RELAY_PUBLIC_URL: baseUrl,
      RELAY_PORT: String(port),
      RELAY_LOG_LEVEL: "fatal",
    });

    const child = spawn("node", [RELAY_BIN_PATH], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const relay = new TestRelay({ child, baseUrl, adminToken, port });

    try {
      await relay.waitForHealth(15_000);
      return relay;
    } catch (error) {
      await relay.stop();
      throw new Error(
        `Relay failed to boot: ${errorMessage(error)}${relay.stderrForError()}`,
      );
    }
  }

  async createAgent(input: {
    handle: string;
    email: string;
    name: string;
    role: string;
  }): Promise<CreatedAgent> {
    const { statusCode, body } = await request(`${this.baseUrl}/admin/agents`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.adminToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        handle: input.handle,
        email: input.email,
        display_name: input.name,
        role: input.role,
      }),
    });

    const responseBody = await body.text();
    if (statusCode < 200 || statusCode >= 300) {
      throw new Error(`Failed to create agent: HTTP ${statusCode}: ${responseBody}`);
    }

    const parsed = JSON.parse(responseBody) as unknown;
    if (!isCreatedAgent(parsed)) {
      throw new Error(`Invalid create agent response: ${responseBody}`);
    }

    return parsed;
  }

  async waitForHealth(timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastError = "health check did not complete";

    while (Date.now() < deadline) {
      if (this.exit !== undefined) {
        throw new Error(
          `relay exited before health check passed (${formatExit(this.exit)})`,
        );
      }

      try {
        const { statusCode, body } = await request(`${this.baseUrl}/healthz`, {
          method: "GET",
          bodyTimeout: 1_000,
          headersTimeout: 1_000,
        });
        const responseBody = await body.text();
        if (statusCode === 200 && isHealthy(responseBody)) {
          return;
        }
        lastError = `HTTP ${statusCode}: ${responseBody}`;
      } catch (error) {
        lastError = errorMessage(error);
      }

      await sleep(100);
    }

    throw new Error(`timed out waiting for relay healthz: ${lastError}`);
  }

  async stop(): Promise<void> {
    if (this.stopPromise !== undefined) {
      return this.stopPromise;
    }

    this.stopPromise = new Promise((resolve) => {
      if (this.exit !== undefined || this.child.exitCode !== null || this.child.signalCode !== null) {
        resolve();
        return;
      }

      let settled = false;
      const finish = () => {
        settled = true;
        clearTimeout(killTimer);
        resolve();
      };
      const killTimer = setTimeout(() => {
        if (!settled) {
          this.child.kill("SIGKILL");
        }
      }, 5_000);

      this.child.once("exit", finish);
      const signaled = this.child.kill("SIGTERM");
      if (!signaled) {
        finish();
      }
    });

    return this.stopPromise;
  }

  private stderrForError(): string {
    return this.stderrBuffer.length > 0
      ? `\nstderr:\n${this.stderrBuffer}`
      : "\nstderr: <empty>";
  }
}

export class AgentHarness {
  readonly handle: string;

  private readonly client: Client;
  private readonly transport: StdioClientTransport;

  private constructor(input: {
    handle: string;
    client: Client;
    transport: StdioClientTransport;
  }) {
    this.handle = input.handle;
    this.client = input.client;
    this.transport = input.transport;
  }

  static async start(opts: {
    relayUrl: string;
    apiKey: string;
    agentId: string;
    handle: string;
    homeDir: string;
    trustYaml?: string;
  }): Promise<AgentHarness> {
    const agentRelayHome = pathResolve(opts.homeDir, ".agentrelay");
    const configPath = pathResolve(agentRelayHome, "config.json");
    const trustPath = pathResolve(agentRelayHome, "trust.yaml");

    await mkdir(agentRelayHome, { recursive: true });
    await writeFile(
      configPath,
      `${JSON.stringify(
        {
          relay_url: opts.relayUrl,
          agent_handle: opts.handle,
          agent_id: opts.agentId,
          api_key: opts.apiKey,
          default_session_id: null,
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
    await chmod(configPath, 0o600);

    if (opts.trustYaml !== undefined) {
      await writeFile(trustPath, opts.trustYaml, { mode: 0o600 });
      await chmod(trustPath, 0o600);
    }

    const transport = new StdioClientTransport({
      command: "node",
      args: [MCP_BIN_PATH, "mcp"],
      env: envWith({
        HOME: opts.homeDir,
        AGENTRELAY_CONFIG_PATH: configPath,
        AGENTRELAY_TRUST_PATH: trustPath,
        AGENTRELAY_HOME: agentRelayHome,
      }),
      cwd: REPO_ROOT,
    });
    const client = new Client({ name: "e2e", version: "0" }, { capabilities: {} });

    try {
      await client.connect(transport);
    } catch (error) {
      await transport.close();
      throw error;
    }

    return new AgentHarness({ handle: opts.handle, client, transport });
  }

  async callTool<T = unknown>(name: string, args: Record<string, unknown>): Promise<T> {
    const result = await this.client.callTool({ name, arguments: args });
    if (hasStructuredContent(result)) {
      return result.structuredContent as T;
    }

    if (hasContent(result)) {
      const text = textContent(result.content[0]);
      return (JSON.parse(text ?? "{}") ?? result) as T;
    }

    return result as T;
  }

  async stop(): Promise<void> {
    await this.transport.close();
  }
}

function envWith(overrides: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return { ...env, ...overrides };
}

async function resetTestDatabase(databaseUrl: string): Promise<void> {
  const previousCwd = process.cwd();
  const previousTestUrl = process.env.RELAY_TEST_DATABASE_URL;
  const previousDatabaseUrl = process.env.RELAY_DATABASE_URL;
  process.env.RELAY_TEST_DATABASE_URL = databaseUrl;
  process.env.RELAY_DATABASE_URL = databaseUrl;

  try {
    process.chdir(RELAY_PACKAGE_ROOT);
    const module = (await import(pathToFileURL(RELAY_TEST_UTILS_PATH).href)) as unknown;
    if (!isTestDbUtils(module)) {
      throw new Error("relay test-utils module does not expose tryConnect/truncateAll");
    }

    const conn = await module.tryConnect();
    if (!conn.available || conn.handle === undefined) {
      throw new Error(`test database unavailable: ${conn.reason ?? "unknown reason"}`);
    }

    try {
      await module.truncateAll(conn.handle.sql);
    } finally {
      await conn.handle.close();
    }
  } finally {
    process.chdir(previousCwd);
    restoreEnv("RELAY_TEST_DATABASE_URL", previousTestUrl);
    restoreEnv("RELAY_DATABASE_URL", previousDatabaseUrl);
  }
}

function isTestDbUtils(value: unknown): value is TestDbUtils {
  return (
    isRecord(value) &&
    typeof value.tryConnect === "function" &&
    typeof value.truncateAll === "function"
  );
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}

function isHealthy(responseBody: string): boolean {
  try {
    const parsed = JSON.parse(responseBody) as unknown;
    return isRecord(parsed) && parsed.status === "ok";
  } catch {
    return false;
  }
}

function isCreatedAgent(value: unknown): value is CreatedAgent {
  return (
    isRecord(value) &&
    typeof value.agent_id === "string" &&
    typeof value.handle === "string" &&
    typeof value.api_key === "string"
  );
}

function hasStructuredContent(value: unknown): value is { structuredContent: unknown } {
  return isRecord(value) && value.structuredContent !== undefined;
}

function hasContent(value: unknown): value is { content: Array<Record<string, unknown>> } {
  return isRecord(value) && Array.isArray(value.content);
}

function textContent(value: unknown): string | undefined {
  return isRecord(value) && typeof value.text === "string" ? value.text : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function formatExit(exit: RelayExit): string {
  if (exit.code !== null) {
    return `exit code ${exit.code}`;
  }
  return `signal ${exit.signal ?? "unknown"}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
