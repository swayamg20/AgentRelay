import { describe, expect, it, vi } from "vitest";
import type { AgentRelayConfig } from "../config.js";
import { bindCodex, unbindCodex } from "./binding.js";

const THREAD_A = "019fb4b5-5d71-72c2-b7ed-9d56847a32e6";
const THREAD_B = "01a02abd-9e1f-7991-9ec4-90fae3feb05b";

function config(binding: AgentRelayConfig["connector_binding"] = undefined): AgentRelayConfig {
	return {
		relay_url: "https://relay.test",
		agent_handle: "alice@team",
		agent_id: "agent-1",
		api_key: "secret",
		default_session_id: null,
		...(binding !== undefined ? { connector_binding: binding } : {}),
	};
}

describe("Codex connector binding", () => {
	it("binds the current Codex thread from CODEX_THREAD_ID", async () => {
		const writeConfig = vi.fn(async () => {});
		const binding = await bindCodex(
			{},
			{
				env: { CODEX_THREAD_ID: THREAD_A } as NodeJS.ProcessEnv,
				loadConfig: async () => ({ ok: true, config: config(), path: "/local/config.json" }),
				writeConfig,
			},
		);
		expect(binding).toEqual({ runtime: "codex", thread_id: THREAD_A });
		expect(writeConfig).toHaveBeenCalledWith(
			"/local/config.json",
			expect.objectContaining({ connector_binding: binding }),
		);
	});

	it("lets an explicit UUID select the binding and ignores the environment", async () => {
		const writeConfig = vi.fn(async () => {});
		const binding = await bindCodex(
			{ threadId: THREAD_B },
			{
				env: { CODEX_THREAD_ID: THREAD_A } as NodeJS.ProcessEnv,
				loadConfig: async () => ({ ok: true, config: config(), path: "/local/config.json" }),
				writeConfig,
			},
		);
		expect(binding.thread_id).toBe(THREAD_B);
	});

	it("fails closed when no local thread ID is available", async () => {
		const writeConfig = vi.fn(async () => {});
		await expect(
			bindCodex(
				{},
				{
					env: {} as NodeJS.ProcessEnv,
					loadConfig: async () => ({ ok: true, config: config(), path: "/local/config.json" }),
					writeConfig,
				},
			),
		).rejects.toThrow(/Run this command from the Codex chat/);
		expect(writeConfig).not.toHaveBeenCalled();
	});

	it("rejects a non-UUID binding before writing", async () => {
		const writeConfig = vi.fn(async () => {});
		await expect(
			bindCodex(
				{ threadId: "remote-chosen-name" },
				{
					loadConfig: async () => ({ ok: true, config: config(), path: "/local/config.json" }),
					writeConfig,
				},
			),
		).rejects.toThrow("Codex thread ID must be a UUID");
		expect(writeConfig).not.toHaveBeenCalled();
	});

	it("unbinds only an existing local Codex binding", async () => {
		const writeConfig = vi.fn(async () => {});
		const changed = await unbindCodex({
			loadConfig: async () => ({
				ok: true,
				config: config({ runtime: "codex", thread_id: THREAD_A }),
				path: "/local/config.json",
			}),
			writeConfig,
		});
		expect(changed).toBe(true);
		expect(writeConfig).toHaveBeenCalledWith(
			"/local/config.json",
			expect.objectContaining({ connector_binding: null }),
		);

		const unchanged = await unbindCodex({
			loadConfig: async () => ({ ok: true, config: config(), path: "/local/config.json" }),
			writeConfig,
		});
		expect(unchanged).toBe(false);
		expect(writeConfig).toHaveBeenCalledTimes(1);
	});
});
