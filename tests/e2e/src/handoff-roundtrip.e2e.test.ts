import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentHarness, TestRelay } from "./harness.js";

describe("handoff round-trip e2e", () => {
  let relay: TestRelay;
  let bobHome: string;
  let frankHome: string;
  let bob: AgentHarness;
  let frank: AgentHarness;

  beforeAll(async () => {
    relay = await TestRelay.boot();

    const bobAgent = await relay.createAgent({
      handle: "bob@acme",
      email: "bob@acme.com",
      name: "Bob",
      role: "backend",
    });
    const frankAgent = await relay.createAgent({
      handle: "frank@acme",
      email: "frank@acme.com",
      name: "Frank",
      role: "frontend",
    });

    bobHome = await mkdtemp(join(tmpdir(), "agentrelay-e2e-bob-"));
    frankHome = await mkdtemp(join(tmpdir(), "agentrelay-e2e-frank-"));

    const bobTrustsFrank = `version: 1
teammates:
  frank@acme:
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
    const frankTrustsBob = bobTrustsFrank.replace("frank@acme", "bob@acme");

    bob = await AgentHarness.start({
      relayUrl: relay.baseUrl,
      apiKey: bobAgent.api_key,
      agentId: bobAgent.agent_id,
      handle: "bob@acme",
      homeDir: bobHome,
      trustYaml: bobTrustsFrank,
    });
    frank = await AgentHarness.start({
      relayUrl: relay.baseUrl,
      apiKey: frankAgent.api_key,
      agentId: frankAgent.agent_id,
      handle: "frank@acme",
      homeDir: frankHome,
      trustYaml: frankTrustsBob,
    });
  }, 60_000);

  afterAll(async () => {
    await Promise.allSettled([bob?.stop(), frank?.stop()]);
    await relay?.stop();
    await Promise.allSettled([
      bobHome && rm(bobHome, { recursive: true, force: true }),
      frankHome && rm(frankHome, { recursive: true, force: true }),
    ]);
  });

  it("Bob sends handoff, Frank accepts with L1 preamble, both message, Frank completes", async () => {
    const sent = await bob.callTool<{ thread_id: string }>("handoff_to_teammate", {
      to: "frank@acme",
      intent: "inform",
      summary: "Refactored /users API - handing off the FE work",
      body: "Contract diff attached. Test command: pnpm test:fe-users",
    });
    expect(typeof sent.thread_id).toBe("string");

    const inbox = await frank.callTool<{ items: Array<Record<string, unknown>> }>(
      "check_inbox",
      {},
    );
    expect(inbox.items.length).toBeGreaterThan(0);

    const accepted = await frank.callTool<Record<string, unknown>>("accept_handoff", {
      thread_id: sent.thread_id,
    });
    const acceptedJson = JSON.stringify(accepted);
    expect(acceptedJson).toContain("[INBOUND HANDOFF FROM bob@acme via AgentRelay]");

    await frank.callTool("send_message", {
      thread_id: sent.thread_id,
      body: "Got it - looking now",
    });
    await bob.callTool("send_message", {
      thread_id: sent.thread_id,
      body: "Thanks",
    });

    await frank.callTool("complete_handoff", {
      thread_id: sent.thread_id,
      result_summary: "FE wired up - see PR #1",
    });

    const final = await bob.callTool<Record<string, unknown>>("view_thread", {
      thread_id: sent.thread_id,
    });
    const finalJson = JSON.stringify(final);
    expect(finalJson).toContain("completed");
  }, 30_000);
});
