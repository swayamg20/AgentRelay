import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FALLBACK_TRUST, type TrustFile } from "../trust.js";
import {
	blockCmd,
	doctor,
	fetchAudit,
	formatDoctor,
	install,
	register,
	renderAudit,
	rotateKey,
	trustResetCmd,
	trustSetCmd,
	unblockCmd,
	type AuditEvent,
} from "./commands.js";
import type { AgentRelayConfig } from "../config.js";

describe("register", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "agentrelay-register-"));
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("posts to /admin/agents and writes config.json", async () => {
		const httpPost = vi.fn(async () => ({
			status: 200,
			// Relay returns `agent_id` (not `id`) per lld §3.3.
			json: { agent_id: "01HXY", handle: "frank@acme", api_key: "ah_test_xxx" },
		}));
		const path = join(dir, "config.json");
		const cfg = await register(
			{
				relay: "https://relay.test",
				adminToken: "tok",
				handle: "frank@acme",
				email: "frank@acme.com",
				name: "Frank",
				role: "frontend",
			},
			{ httpPost, configPath: path },
		);
		expect(cfg.api_key).toBe("ah_test_xxx");
		expect(cfg.relay_url).toBe("https://relay.test");
		expect(httpPost).toHaveBeenCalledOnce();
		expect(httpPost.mock.calls[0]?.[0]).toBe("https://relay.test/admin/agents");
		const auth = (httpPost.mock.calls[0]?.[2] as Record<string, string>).authorization;
		expect(auth).toBe("Bearer tok");
		const fs = await import("node:fs/promises");
		const written = JSON.parse(await fs.readFile(path, "utf8"));
		expect(written.api_key).toBe("ah_test_xxx");
		const stat = await fs.stat(path);
		// Mode 0600 — owner rw, no group/other.
		expect(stat.mode & 0o777).toBe(0o600);
	});

	it("throws on relay error", async () => {
		const httpPost = vi.fn(async () => ({ status: 401, json: { error: "unauthenticated" } }));
		await expect(
			register(
				{ relay: "https://relay.test", handle: "frank@acme", email: "f@x", name: "F", role: "fe" },
				{ httpPost, configPath: join(dir, "config.json") },
			),
		).rejects.toThrow(/401/);
	});
});

describe("install", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "agentrelay-install-"));
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("writes mcp + overlay + creates trust.yaml when all are missing (claude-code dual-write)", async () => {
		const writes: Array<[string, string]> = [];
		const trustWrites: Array<[string, string]> = [];
		const result = await install(
			{ client: "claude-code", overwrite: true },
			{
				readSettings: async () => undefined,
				writeSettings: async (p, c) => void writes.push([p, c]),
				clientPaths: () => ({ settingsPath: join(dir, ".claude", "settings.json"), format: "json" }),
				mcpPath: () => join(dir, ".claude.json"),
				trustPath: join(dir, "trust.yaml"),
				trustExists: async () => false,
				writeTrust: async (p, c) => void trustWrites.push([p, c]),
			},
		);
		expect(result.clients[0]?.report.mcpServerAdded).toBe(true);
		expect(result.clients[0]?.written).toBe(true);
		expect(result.trustCreated).toBe(true);
		// Two writes: ~/.claude.json (mcp) + ~/.claude/settings.json (overlay)
		expect(writes.length).toBe(2);

		const claudeJson = writes.find(([p]) => p.endsWith(".claude.json"));
		const overlayJson = writes.find(([p]) => p.endsWith("settings.json"));
		expect(claudeJson, "expected a write to ~/.claude.json").toBeDefined();
		expect(overlayJson, "expected a write to settings.json").toBeDefined();

		// MCP entry written to .claude.json with the type:'stdio' shape that
		// matches what `claude mcp add` writes.
		const claudeJsonObj = JSON.parse(claudeJson?.[1] ?? "{}");
		expect(claudeJsonObj.mcpServers.agentrelay.type).toBe("stdio");
		expect(claudeJsonObj.mcpServers.agentrelay.command).toBe("npx");
		// And NOT to settings.json — that file only has the permission overlay.
		const overlayObj = JSON.parse(overlayJson?.[1] ?? "{}");
		expect(overlayObj.mcpServers).toBeUndefined();
		expect(overlayObj.permissions.allow).toContain("mcp__agentrelay__*");
		expect(overlayObj.permissions.deny).toContain("Bash(git push*)");

		expect(trustWrites[0]?.[1]).toContain("version: 1");
	});

	it("--client codex writes a TOML config", async () => {
		const writes: Array<[string, string]> = [];
		const result = await install(
			{ client: "codex", overwrite: true },
			{
				readSettings: async () => undefined,
				writeSettings: async (p, c) => void writes.push([p, c]),
				clientPaths: () => ({ settingsPath: join(dir, "config.toml"), format: "toml" }),
				trustPath: join(dir, "trust.yaml"),
				trustExists: async () => true,
				writeTrust: async () => {},
			},
		);
		expect(result.clients[0]?.client).toBe("codex");
		expect(result.clients[0]?.format).toBe("toml");
		expect(result.clients[0]?.written).toBe(true);
		expect(writes[0]?.[1]).toContain("[mcp_servers.agentrelay]");
		expect(writes[0]?.[1]).toContain('command = "npx"');
		expect(writes[0]?.[1]).toContain("[permissions]");
	});

	it("--client all writes claude.json + claude settings.json + codex TOML", async () => {
		const writes: Array<[string, string]> = [];
		const result = await install(
			{ client: "all", overwrite: true },
			{
				readSettings: async () => undefined,
				writeSettings: async (p, c) => void writes.push([p, c]),
				clientPaths: (c) =>
					c === "claude-code"
						? { settingsPath: join(dir, "claude-settings.json"), format: "json" }
						: { settingsPath: join(dir, "codex.toml"), format: "toml" },
				mcpPath: (c) => (c === "claude-code" ? join(dir, ".claude.json") : join(dir, "codex.toml")),
				trustPath: join(dir, "trust.yaml"),
				trustExists: async () => true,
				writeTrust: async () => {},
			},
		);
		expect(result.clients).toHaveLength(2);
		// Three writes: .claude.json (mcp), claude-settings.json (overlay), codex.toml (combined)
		expect(writes).toHaveLength(3);
		expect(writes.find(([p]) => p.endsWith(".claude.json"))?.[1]).toContain('"mcpServers"');
		expect(writes.find(([p]) => p.endsWith("claude-settings.json"))?.[1]).toContain('"permissions"');
		expect(writes.find(([p]) => p.endsWith("codex.toml"))?.[1]).toContain("[mcp_servers.agentrelay]");
	});

	it("does not write when nothing changed", async () => {
		const existing = JSON.stringify({
			mcpServers: { agentrelay: { command: "npx", args: ["-y", "agentrelay-mcp"], env: {} } },
			permissions: {
				allow: [
					"Read",
					"Grep",
					"Glob",
					"Bash(npm test*)",
					"Bash(pytest*)",
					"Bash(cargo test*)",
					"Bash(npm run lint*)",
					"Bash(tsc*)",
					"mcp__agentrelay__*",
				],
				ask: ["Edit", "Write", "Bash(git commit*)", "Bash(git diff*)"],
				deny: [
					"Bash(git push*)",
					"Bash(npm publish*)",
					"Bash(rm -rf*)",
					"Bash(curl*)",
					"Bash(wget*)",
					"Bash(eval*)",
					"Bash(*ssh*)",
					"Bash(*aws*)",
					"Bash(*kubectl*)",
				],
			},
		});
		const writes: string[] = [];
		const result = await install(
			{ client: "claude-code", overwrite: false },
			{
				readSettings: async () => existing,
				writeSettings: async () => void writes.push("x"),
				clientPaths: () => ({ settingsPath: join(dir, "settings.json"), format: "json" }),
				trustPath: join(dir, "trust.yaml"),
				trustExists: async () => true,
				writeTrust: async () => {},
			},
		);
		expect(writes.length).toBe(0);
		expect(result.clients[0]?.written).toBe(false);
		expect(result.trustCreated).toBe(false);
	});
});

describe("doctor", () => {
	it("reports config + trust + overlay status", async () => {
		const settings = JSON.stringify({
			mcpServers: { agentrelay: {} },
			permissions: { allow: ["mcp__agentrelay__*"] },
		});
		// loadConfig + loadTrust use process.env paths; point them at temp files via env override.
		const dir = await mkdtemp(join(tmpdir(), "agentrelay-doctor-"));
		try {
			process.env.AGENTRELAY_CONFIG_PATH = join(dir, "missing.json");
			process.env.AGENTRELAY_TRUST_PATH = join(dir, "missing.yaml");
			const r = await doctor({
				readSettings: async () => settings,
				clientPaths: () => ({ settingsPath: "/x/settings.json", format: "json" }),
				whoami: async () => true,
			});
			expect(r.configPresent).toBe(false);
			expect(r.trustParseable).toBe(true); // fallback counts as parseable
			expect(r.mcpEntryPresent["claude-code"]).toBe(true);
			expect(r.overlayApplied["claude-code"]).toBe(true);
			expect(formatDoctor(r)).toContain("config:");
		} finally {
			delete process.env.AGENTRELAY_CONFIG_PATH;
			delete process.env.AGENTRELAY_TRUST_PATH;
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("formatDoctor appends remediation hints to MISSING / BROKEN lines", async () => {
		const dir = await mkdtemp(join(tmpdir(), "agentrelay-doctor-hint-"));
		try {
			process.env.AGENTRELAY_CONFIG_PATH = join(dir, "missing.json");
			process.env.AGENTRELAY_TRUST_PATH = join(dir, "missing.yaml");
			const r = await doctor({
				readSettings: async () => undefined,
				clientPaths: () => ({ settingsPath: "/x/settings.json", format: "json" }),
				whoami: async () => true,
			});
			const out = formatDoctor(r);
			expect(out).toMatch(/config:\s+MISSING.*→ run: agentrelay register/);
			expect(out).toMatch(
				/mcp\[claude-code\]:\s+MISSING\s+→ run: agentrelay install --client claude-code/,
			);
			expect(out).toMatch(/mcp\[codex\]:\s+MISSING\s+→ run: agentrelay install --client codex/);
			expect(out).toMatch(
				/overlay\[claude-code\]:\s+MISSING\s+→ run: agentrelay install --client claude-code/,
			);
			expect(out).toMatch(
				/overlay\[codex\]:\s+MISSING\s+→ run: agentrelay install --client codex/,
			);
		} finally {
			delete process.env.AGENTRELAY_CONFIG_PATH;
			delete process.env.AGENTRELAY_TRUST_PATH;
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("formatDoctor does not append hints to OK lines", async () => {
		const settings = JSON.stringify({
			mcpServers: { agentrelay: {} },
			permissions: { allow: ["mcp__agentrelay__*"] },
		});
		const dir = await mkdtemp(join(tmpdir(), "agentrelay-doctor-clean-"));
		try {
			process.env.AGENTRELAY_CONFIG_PATH = join(dir, "missing.json");
			process.env.AGENTRELAY_TRUST_PATH = join(dir, "missing.yaml");
			const r = await doctor({
				readSettings: async () => settings,
				clientPaths: () => ({ settingsPath: "/x/settings.json", format: "json" }),
				whoami: async () => true,
			});
			const out = formatDoctor(r);
			expect(out).toMatch(/mcp\[claude-code\]:\s+OK(?!.*→ run)/);
			expect(out).toMatch(/overlay\[claude-code\]:\s+OK(?!.*→ run)/);
		} finally {
			delete process.env.AGENTRELAY_CONFIG_PATH;
			delete process.env.AGENTRELAY_TRUST_PATH;
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("blockCmd / unblockCmd / trustSetCmd / trustResetCmd", () => {
	function makeStore(initial: TrustFile = JSON.parse(JSON.stringify(FALLBACK_TRUST))) {
		let current = initial;
		return {
			readTrust: async () => current,
			writeTrust: async (next: TrustFile) => {
				current = next;
			},
			get: () => current,
		};
	}

	it("blockCmd persists when changed and is idempotent", async () => {
		const store = makeStore();
		const first = await blockCmd("mallory@external", store);
		expect(first).toBe(true);
		expect(store.get().blocked).toContain("mallory@external");
		const second = await blockCmd("mallory@external", store);
		expect(second).toBe(false);
	});

	it("unblockCmd removes the entry", async () => {
		const store = makeStore();
		await blockCmd("mallory@external", store);
		const changed = await unblockCmd("mallory@external", store);
		expect(changed).toBe(true);
		expect(store.get().blocked).not.toContain("mallory@external");
	});

	it("trustSetCmd writes the merged entry", async () => {
		const store = makeStore();
		const next = await trustSetCmd("carol@acme", { auto_write_paths: ["docs/"] }, store);
		expect(next.teammates["carol@acme"]?.auto_write_paths).toEqual(["docs/"]);
	});

	it("trustResetCmd is idempotent", async () => {
		const store = makeStore();
		await trustSetCmd("bob@acme", { auto_read: true }, store);
		expect(await trustResetCmd("bob@acme", store)).toBe(true);
		expect(await trustResetCmd("bob@acme", store)).toBe(false);
	});
});

describe("rotateKey", () => {
	let dir: string;
	const fakeConfig: AgentRelayConfig = {
		relay_url: "https://relay.test",
		agent_handle: "frank@acme",
		agent_id: "01HXYZ",
		api_key: "ah_test_old",
		default_session_id: null,
	};

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "agentrelay-rotate-"));
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("posts to /agents/me/keys/rotate with current bearer and rewrites config", async () => {
		const path = join(dir, "config.json");
		const fs = await import("node:fs/promises");
		await fs.writeFile(path, JSON.stringify(fakeConfig), { mode: 0o600 });
		const httpPost = vi.fn(async () => ({
			status: 200,
			json: { agent_id: "01HXYZ", api_key: "ah_test_NEW", key_id: "k_2" },
		}));
		const r = await rotateKey({
			httpPost,
			configPath: path,
			loadConfig: async () => fakeConfig,
		});
		expect(r.key_id).toBe("k_2");
		expect(httpPost.mock.calls[0]?.[0]).toBe("https://relay.test/agents/me/keys/rotate");
		const headers = httpPost.mock.calls[0]?.[2] as Record<string, string>;
		expect(headers.authorization).toBe("Bearer ah_test_old"); // current bearer, not new
		const written = JSON.parse(await fs.readFile(path, "utf8"));
		expect(written.api_key).toBe("ah_test_NEW");
		expect(written.agent_handle).toBe("frank@acme"); // other fields preserved
		const stat = await fs.stat(path);
		expect(stat.mode & 0o777).toBe(0o600);
	});

	it("leaves config untouched on relay error", async () => {
		const path = join(dir, "config.json");
		const fs = await import("node:fs/promises");
		await fs.writeFile(path, JSON.stringify(fakeConfig), { mode: 0o600 });
		const httpPost = vi.fn(async () => ({ status: 401, json: { error: "unauthenticated" } }));
		await expect(
			rotateKey({ httpPost, configPath: path, loadConfig: async () => fakeConfig }),
		).rejects.toThrow(/401.*config left untouched/);
		const after = JSON.parse(await fs.readFile(path, "utf8"));
		expect(after.api_key).toBe("ah_test_old");
	});

	it("surfaces the new key in the error if write fails after relay accepts", async () => {
		const path = join(dir, "nope", "subdir", "config.json"); // parent dir exists, but...
		const fs = await import("node:fs/promises");
		await fs.mkdir(join(dir, "nope"), { recursive: true });
		// Make subdir a *file* so writeSecretFile's mkdir succeeds (idempotent on existing dir)
		// but the rename target ends up trying to overwrite a directory-like path. Simpler: pass
		// an unwritable path by creating it as a directory.
		await fs.mkdir(path, { recursive: true });
		const httpPost = vi.fn(async () => ({
			status: 200,
			json: { agent_id: "x", api_key: "ah_test_NEW_KEY", key_id: "k" },
		}));
		await expect(
			rotateKey({ httpPost, configPath: path, loadConfig: async () => fakeConfig }),
		).rejects.toThrow(/ah_test_NEW_KEY/);
	});
});

describe("fetchAudit + renderAudit", () => {
	const cfg: AgentRelayConfig = {
		relay_url: "https://relay.test",
		agent_handle: "frank@acme",
		agent_id: "01HXYZ",
		api_key: "ah_test_xxx",
		default_session_id: null,
	};

	const sampleEvent: AuditEvent = {
		timestamp: "2026-04-26T10:01:23Z",
		actor_handle: "bob@acme",
		action: "edit_drafted",
		resource_type: "handoff",
		resource_id: "01HXY",
		request_id: "req_1",
		metadata: { path: "src/api/users.client.ts", added: 12, removed: 4 },
	};

	it("calls /agents/me/audit with bearer and threaded query params", async () => {
		const httpGet = vi.fn(async () => ({ status: 200, json: { events: [sampleEvent] } }));
		const events = await fetchAudit(
			{ since: "2026-04-25T00:00:00Z", from: "bob@acme", action: "edit_drafted", limit: 50 },
			{ httpGet, loadConfig: async () => cfg },
		);
		expect(events).toHaveLength(1);
		const url = httpGet.mock.calls[0]?.[0] as string;
		expect(url.startsWith("https://relay.test/agents/me/audit?")).toBe(true);
		expect(url).toContain("since=2026-04-25T00%3A00%3A00Z");
		expect(url).toContain("from=bob%40acme");
		expect(url).toContain("action=edit_drafted");
		expect(url).toContain("limit=50");
		const headers = httpGet.mock.calls[0]?.[1] as Record<string, string>;
		expect(headers.authorization).toBe("Bearer ah_test_xxx");
	});

	it("clamps limit to 1000", async () => {
		const httpGet = vi.fn(async () => ({ status: 200, json: { events: [] } }));
		await fetchAudit({ limit: 9999 }, { httpGet, loadConfig: async () => cfg });
		const url = httpGet.mock.calls[0]?.[0] as string;
		expect(url).toContain("limit=1000");
	});

	it("uses default limit of 100 when unset", async () => {
		const httpGet = vi.fn(async () => ({ status: 200, json: { events: [] } }));
		await fetchAudit({}, { httpGet, loadConfig: async () => cfg });
		const url = httpGet.mock.calls[0]?.[0] as string;
		expect(url).toContain("limit=100");
	});

	it("throws on relay error with a clear message", async () => {
		const httpGet = vi.fn(async () => ({ status: 500, json: { error: "boom" } }));
		await expect(fetchAudit({}, { httpGet, loadConfig: async () => cfg })).rejects.toThrow(/500/);
	});

	it("renderAudit jsonl emits one JSON object per line", () => {
		const out = renderAudit([sampleEvent, { ...sampleEvent, action: "test_run" }], "jsonl");
		const lines = out.split("\n");
		expect(lines).toHaveLength(2);
		expect(JSON.parse(lines[0]!).action).toBe("edit_drafted");
		expect(JSON.parse(lines[1]!).action).toBe("test_run");
	});

	it("renderAudit tsv emits a header + rows with metadata flattened", () => {
		const out = renderAudit([sampleEvent], "tsv");
		const [header, row] = out.split("\n");
		expect(header).toBe("timestamp\thandoff_id\tfrom\taction\tdetails");
		expect(row).toContain("2026-04-26T10:01:23Z");
		expect(row).toContain("01HXY");
		expect(row).toContain("bob@acme");
		expect(row).toContain("edit_drafted");
		expect(row).toContain("path=src/api/users.client.ts");
	});

	it("renderAudit tsv handles empty event list cleanly", () => {
		expect(renderAudit([], "tsv")).toBe("timestamp\thandoff_id\tfrom\taction\tdetails");
	});
});
