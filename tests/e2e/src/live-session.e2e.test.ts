import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createA2AClient } from "../../../mcp-server/dist/a2a-client.js";
import { createMailboxEventClient } from "../../../mcp-server/dist/connector/event-client.js";
import { runLiveBridge } from "../../../mcp-server/dist/live/bridge.js";
import type { LiveRuntime, LiveScope } from "../../../mcp-server/dist/live/contracts.js";
import { createLiveMailbox } from "../../../mcp-server/dist/live/mailbox.js";
import { liveStatePath, openLiveStore } from "../../../mcp-server/dist/live/store.js";
import { MCP_BIN_PATH, TestRelay } from "./harness.js";

describe("live session over the real Relay", () => {
	let relay: TestRelay;
	let directory: string;
	let a: Awaited<ReturnType<TestRelay["createAgent"]>>;
	let b: Awaited<ReturnType<TestRelay["createAgent"]>>;
	beforeAll(async () => {
		relay = await TestRelay.boot({ port: 18084 });
		directory = await realpath(await mkdtemp(join(tmpdir(), "ar-live-e2e-")));
		a = await relay.createAgent({
			handle: "live-a@test",
			email: "live-a@example.test",
			name: "A",
			role: "developer",
		});
		b = await relay.createAgent({
			handle: "live-b@test",
			email: "live-b@example.test",
			name: "B",
			role: "developer",
		});
	});
	afterAll(async () => {
		await relay?.stop();
		if (directory) await rm(directory, { recursive: true, force: true });
	});
	function client(agent: typeof a) {
		return createA2AClient({ relayUrl: relay.baseUrl, apiKey: agent.api_key, maxAttempts: 1 });
	}
	function scope(agent: typeof a, peer: typeof a, threadId: string): LiveScope {
		return {
			relayUrl: relay.baseUrl,
			agentId: agent.agent_id,
			localHandle: agent.handle,
			peerHandle: peer.handle,
			threadId,
		};
	}
	async function seed(body: string) {
		return client(a).request<{ task_id: string }>("message/send", {
			recipient: b.handle,
			intent: "inform",
			message: { role: "user", parts: [{ type: "text", text: body }] },
		});
	}
	async function storeFor(selected: LiveScope, maxTurns: number) {
		return openLiveStore({
			path: liveStatePath(selected, directory),
			scope: selected,
			maxTurns,
			expiresAt: Date.now() + 180_000,
		});
	}

	it("performs bidirectional automatic replies with isolated journals and real SSE", async () => {
		const thread = await seed("A starts the conversation");
		const aScope = scope(a, b, thread.task_id);
		const bScope = scope(b, a, thread.task_id);
		const aStore = await storeFor(aScope, 1);
		const bStore = await storeFor(bScope, 2);
		let bTurns = 0;
		const host = (name: string, answer: () => string | null): LiveRuntime => ({
			async runTurn(input) {
				expect(input.content).toContain("untrusted teammate");
				return { reply: answer(), host: { threadId: name, turnId: randomUUID() } };
			},
			async close() {},
		});
		const signal = AbortSignal.timeout(20_000);
		try {
			await Promise.all([
				runLiveBridge({
					store: aStore,
					mailbox: createLiveMailbox(client(a), aScope),
					events: createMailboxEventClient({ relayUrl: relay.baseUrl, apiKey: a.api_key }),
					runtime: host("host-a", () => "A automatically replies"),
					signal,
					assertAuthority: async () => {},
				}),
				runLiveBridge({
					store: bStore,
					mailbox: createLiveMailbox(client(b), bScope),
					events: createMailboxEventClient({ relayUrl: relay.baseUrl, apiKey: b.api_key }),
					runtime: host("host-b", () => (++bTurns === 1 ? "B automatically replies" : null)),
					signal,
					assertAuthority: async () => {},
				}),
			]);
			expect(signal.aborted).toBe(false);
			expect(aStore.read().receipts.map((r) => r.disposition)).toEqual(["replied"]);
			expect(bStore.read().receipts.map((r) => r.disposition)).toEqual(["replied", "no_reply"]);
			const got = await client(a).request<{ messages: { body: string; from: string }[] }>(
				"tasks/get",
				{ task_id: thread.task_id },
			);
			expect(got.messages.map((message) => message.body)).toEqual([
				"A starts the conversation",
				"B automatically replies",
				"A automatically replies",
			]);
		} finally {
			await aStore.close();
			await bStore.close();
		}
	});

	it("replays offline messages after Relay restart without reprocessing an already answered message", async () => {
		const thread = await seed("before restart");
		const bScope = scope(b, a, thread.task_id);
		const store = await storeFor(bScope, 3);
		let turns = 0;
		const run = () =>
			runLiveBridge({
				store,
				mailbox: createLiveMailbox(client(b), bScope),
				events: createMailboxEventClient({ relayUrl: relay.baseUrl, apiKey: b.api_key }),
				runtime: {
					async runTurn() {
						turns++;
						return { reply: `answer ${turns}`, host: { threadId: "host", turnId: randomUUID() } };
					},
					async close() {},
				},
				signal: AbortSignal.timeout(20_000),
				assertAuthority: async () => {},
				once: true,
			});
		try {
			await run();
			await relay.restart();
			await client(a).request("message/send", {
				task_id: thread.task_id,
				message: { role: "user", parts: [{ type: "text", text: "while B is offline" }] },
			});
			await run();
			await run();
			expect(turns).toBe(2);
			expect(store.read().receipts).toHaveLength(2);
		} finally {
			await store.close();
		}
	});

	it.runIf(process.env.AGENTRELAY_LIVE_CODEX === "1")(
		"runs the installed CLI twice with real Codex, automatic return reply and no typed chat input",
		async () => {
			const challenge = randomUUID();
			const thread = await seed(
				`Communication test ${challenge}. Please answer with PONG-${challenge} and ask me to return ACK-${challenge}. Once I send that ACK, the conversation is finished and needs no further reply.`,
			);
			const homes = [join(directory, "cli-a"), join(directory, "cli-b")];
			const children: ReturnType<typeof spawn>[] = [];
			const outputs = ["", ""];
			try {
				const runs = await Promise.all(
					[a, b].map(async (agent, index) => {
						const peer = index === 0 ? b : a;
						const root = homes[index]!;
						await mkdir(root, { mode: 0o700 });
						await writeFile(
							join(root, "config.json"),
							JSON.stringify({
								relay_url: relay.baseUrl,
								agent_id: agent.agent_id,
								agent_handle: agent.handle,
								api_key: agent.api_key,
								default_session_id: null,
							}),
							{ mode: 0o600 },
						);
						await writeFile(
							join(root, "trust.yaml"),
							`version: 1\nteammates:\n  ${peer.handle}:\n    auto_pickup: true\n    auto_read: true\nblocked: []\n`,
							{ mode: 0o600 },
						);
						const child = spawn(
							process.execPath,
							[
								MCP_BIN_PATH,
								"live",
								"codex",
								"--peer",
								peer.handle,
								"--handoff",
								thread.task_id,
								"--allow-replies",
								"--max-turns",
								index === 0 ? "1" : "2",
								"--ttl-seconds",
								"180",
							],
							{
								env: {
									...process.env,
									AGENTRELAY_HOME: root,
									AGENTRELAY_CONFIG_PATH: join(root, "config.json"),
									AGENTRELAY_TRUST_PATH: join(root, "trust.yaml"),
								},
								stdio: ["ignore", "pipe", "pipe"],
							},
						);
						children.push(child);
						child.stdout!.on("data", (data: Buffer) => {
							outputs[index] += data.toString();
						});
						child.stderr!.resume();
						return new Promise<number | null>((resolve, reject) => {
							child.once("error", reject);
							child.once("close", (code) => {
								if (code === 0) resolve(code);
								else
									reject(
										new Error(`Live CLI ${index} exited ${code}; stage log: ${outputs[index]}`),
									);
							});
						});
					}),
				);
				expect(runs).toEqual([0, 0]);
				for (let index = 0; index < 2; index++) {
					expect(outputs[index]).toContain("runtime_accepted");
					expect(outputs[index]).toContain("replied");
					const selected = index === 0 ? scope(a, b, thread.task_id) : scope(b, a, thread.task_id);
					const journal = JSON.parse(await readFile(liveStatePath(selected, homes[index]), "utf8"));
					expect(journal.pending).toBeNull();
					expect(journal.receipts).toHaveLength(index === 0 ? 1 : 2);
				}
				const got = await client(a).request<{ messages: { body: string; from: string }[] }>(
					"tasks/get",
					{ task_id: thread.task_id },
				);
				expect(got.messages).toHaveLength(3);
				expect(got.messages[1]!.body).toContain(`PONG-${challenge}`);
				expect(got.messages[2]!.body).toContain(`ACK-${challenge}`);
			} finally {
				await Promise.all(
					children.map(async (child) => {
						if (child.exitCode !== null || child.signalCode !== null) return;
						const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
						child.kill("SIGTERM");
						const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
						await closed;
						clearTimeout(timer);
					}),
				);
			}
		},
		210_000,
	);
});
