import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, resolveConfigPath, unavailableMessage } from "./config.js";

describe("config.resolveConfigPath", () => {
	it("respects AGENTRELAY_CONFIG_PATH override", () => {
		expect(resolveConfigPath({ AGENTRELAY_CONFIG_PATH: "/tmp/x.json" } as NodeJS.ProcessEnv)).toBe(
			"/tmp/x.json",
		);
	});

	it("falls back to ~/.agentrelay/config.json", () => {
		const out = resolveConfigPath({} as NodeJS.ProcessEnv);
		expect(out.endsWith("/.agentrelay/config.json")).toBe(true);
	});
});

describe("config.loadConfig", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "agentrelay-test-"));
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("returns missing when the file does not exist", async () => {
		const path = join(dir, "config.json");
		const out = await loadConfig({ AGENTRELAY_CONFIG_PATH: path } as NodeJS.ProcessEnv);
		expect(out).toEqual({ ok: false, reason: "missing", path });
	});

	it("returns malformed for non-JSON content", async () => {
		const path = join(dir, "config.json");
		await writeFile(path, "{ not json", "utf8");
		const out = await loadConfig({ AGENTRELAY_CONFIG_PATH: path } as NodeJS.ProcessEnv);
		expect(out.ok).toBe(false);
		if (!out.ok) expect(out.reason).toBe("malformed");
	});

	it("returns invalid for JSON missing required fields", async () => {
		const path = join(dir, "config.json");
		await writeFile(path, JSON.stringify({ relay_url: "https://r.x" }), "utf8");
		const out = await loadConfig({ AGENTRELAY_CONFIG_PATH: path } as NodeJS.ProcessEnv);
		expect(out.ok).toBe(false);
		if (!out.ok) expect(out.reason).toBe("invalid");
	});

	it("loads a valid config", async () => {
		const path = join(dir, "config.json");
		await writeFile(
			path,
			JSON.stringify({
				relay_url: "https://relay.acme.dev",
				agent_handle: "frank@acme",
				agent_id: "01HXYZ",
				api_key: "ah_test_abc",
				default_session_id: null,
			}),
			"utf8",
		);
		const out = await loadConfig({ AGENTRELAY_CONFIG_PATH: path } as NodeJS.ProcessEnv);
		expect(out.ok).toBe(true);
		if (out.ok) {
			expect(out.config.agent_handle).toBe("frank@acme");
			expect(out.config.default_session_id).toBeNull();
		}
	});

	it("unavailableMessage produces an actionable error string", () => {
		const msg = unavailableMessage({ ok: false, reason: "missing", path: "/tmp/x.json" });
		expect(msg).toContain("agentrelay register");
		expect(msg).toContain("/tmp/x.json");
	});
});
