import { spawnSync } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join as pathJoin, resolve as pathResolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { request } from "undici";
import { AgentHarness, REPO_ROOT, TestRelay } from "./harness.js";

const JOIN_BIN_PATH = pathResolve(REPO_ROOT, "mcp-server/dist/bin/agentrelay.js");

type CreatedAgent = {
  agent_id: string;
  handle: string;
  api_key: string;
};

type InviteResponse = {
  url: string;
  jti: string;
};

type JoinedConfig = {
  relay_url: string;
  agent_handle: string;
  agent_id: string;
  api_key: string;
  default_session_id: null;
};

describe("invite join e2e", () => {
  let relay: TestRelay;
  let bobAgent: CreatedAgent;
  let bobHome: string;
  let pranjalHome: string;
  let bob: AgentHarness | undefined;
  let pranjal: AgentHarness | undefined;

  beforeAll(async () => {
    relay = await TestRelay.boot();
    bobAgent = await relay.createAgent({
      handle: "bob@acme",
      email: "bob@acme.com",
      name: "Bob",
      role: "lead",
    });

    bobHome = await mkdtemp(pathJoin(tmpdir(), "agentrelay-e2e-bob-invite-"));
    pranjalHome = await mkdtemp(pathJoin(tmpdir(), "agentrelay-e2e-pranjal-"));
  }, 60_000);

  afterAll(async () => {
    await Promise.allSettled([
      bob?.stop() ?? Promise.resolve(),
      pranjal?.stop() ?? Promise.resolve(),
    ]);
    await relay?.stop();
    await Promise.allSettled([
      bobHome && rm(bobHome, { recursive: true, force: true }),
      pranjalHome && rm(pranjalHome, { recursive: true, force: true }),
    ]);
  });

  it("redeems an invite URL into working credentials and sends Bob a handoff", async () => {
    const invite = await mintInvite();
    const joinResult = spawnSync("node", [JOIN_BIN_PATH, "join", invite.url], {
      cwd: REPO_ROOT,
      env: isolatedHomeEnv(pranjalHome),
      stdio: "pipe",
      encoding: "utf8",
    });
    if (joinResult.error !== undefined) {
      throw joinResult.error;
    }
    if (joinResult.status !== 0) {
      throw new Error(
        `join failed with ${joinResult.status}\nstdout:\n${joinResult.stdout}\nstderr:\n${joinResult.stderr}`,
      );
    }
    expect(joinResult.stdout).toContain("joined as pranjal@acme");

    const configPath = pathJoin(pranjalHome, ".agentrelay", "config.json");
    await expect(access(configPath)).resolves.toBeUndefined();
    const config = parseJoinedConfig(await readFile(configPath, "utf8"));
    expect(config).toMatchObject({
      relay_url: relay.baseUrl,
      agent_handle: "pranjal@acme",
      default_session_id: null,
    });
    expect(config.agent_id.length).toBeGreaterThan(0);
    expect(config.api_key.length).toBeGreaterThan(0);

    pranjal = await AgentHarness.start({
      relayUrl: config.relay_url,
      apiKey: config.api_key,
      agentId: config.agent_id,
      handle: config.agent_handle,
      homeDir: pranjalHome,
    });
    bob = await AgentHarness.start({
      relayUrl: relay.baseUrl,
      apiKey: bobAgent.api_key,
      agentId: bobAgent.agent_id,
      handle: bobAgent.handle,
      homeDir: bobHome,
      trustYaml: trustsPranjal(),
    });

    const sent = await pranjal.callTool<{ thread_id: string; recipient: string }>(
      "handoff_to_teammate",
      {
        to: "bob@acme",
        intent: "inform",
        summary: "Joined through invite URL and sending the first handoff",
      },
    );
    expect(typeof sent.thread_id).toBe("string");
    expect(sent.recipient).toBe("bob@acme");

    const inbox = await bob.callTool<{ items: Array<Record<string, unknown>> }>(
      "check_inbox",
      {},
    );
    expect(inbox.items.length).toBeGreaterThan(0);
    expect(JSON.stringify(inbox.items)).toContain(sent.thread_id);

    const accepted = await bob.callTool<Record<string, unknown>>("accept_handoff", {
      thread_id: sent.thread_id,
    });
    expect(JSON.stringify(accepted)).toContain(
      "[INBOUND HANDOFF FROM pranjal@acme via AgentRelay]",
    );
  }, 30_000);

  async function mintInvite(): Promise<InviteResponse> {
    const { statusCode, body } = await request(`${relay.baseUrl}/admin/invites`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${relay.adminToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        handle: "pranjal@acme",
        role: "backend",
        inviter_handle: "bob@acme",
        expires_in_seconds: 3600,
      }),
    });

    const responseBody = await body.text();
    if (statusCode < 200 || statusCode >= 300) {
      throw new Error(`failed to mint invite: HTTP ${statusCode}: ${responseBody}`);
    }

    const parsed = JSON.parse(responseBody) as unknown;
    if (!isInviteResponse(parsed)) {
      throw new Error(`invalid invite response: ${responseBody}`);
    }
    return parsed;
  }
});

function isolatedHomeEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  delete env.AGENTRELAY_HOME;
  delete env.AGENTRELAY_CONFIG_PATH;
  delete env.AGENTRELAY_TRUST_PATH;
  return env;
}

function parseJoinedConfig(raw: string): JoinedConfig {
  const parsed = JSON.parse(raw) as unknown;
  if (!isJoinedConfig(parsed)) {
    throw new Error(`invalid joined config: ${raw}`);
  }
  return parsed;
}

function isInviteResponse(value: unknown): value is InviteResponse {
  return (
    isRecord(value) &&
    typeof value.url === "string" &&
    typeof value.jti === "string"
  );
}

function isJoinedConfig(value: unknown): value is JoinedConfig {
  return (
    isRecord(value) &&
    typeof value.relay_url === "string" &&
    typeof value.agent_handle === "string" &&
    typeof value.agent_id === "string" &&
    typeof value.api_key === "string" &&
    value.default_session_id === null
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function trustsPranjal(): string {
  return `version: 1
teammates:
  pranjal@acme:
    auto_read: true
    auto_test: true
    auto_write_paths: []
    require_approval: ["Edit", "Write", "Bash"]
unknown_teammates:
  policy: allow_with_default_trust
defaults:
  auto_read: true
  auto_test: true
  auto_write_paths: []
  require_approval: ["Edit", "Write", "Bash"]
blocked: []
`;
}
