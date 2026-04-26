/**
 * Loads `~/.agentrelay/config.json` (overridable via AGENTRELAY_CONFIG_PATH).
 *
 * Schema: see `docs/lld.md` §6.1.
 *
 * If the file is missing or malformed, `loadConfig()` returns a structured
 * result rather than throwing — the MCP server still boots, but tool calls
 * surface an instructive error telling the user to run `agentrelay register`.
 */

import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

const configSchema = z
	.object({
		relay_url: z.string().url(),
		agent_handle: z.string().min(1),
		agent_id: z.string().min(1),
		api_key: z.string().min(1),
		default_session_id: z.string().nullable().optional().default(null),
	})
	.strict();

export type AgentRelayConfig = z.infer<typeof configSchema>;

export type LoadConfigResult =
	| { ok: true; config: AgentRelayConfig; path: string }
	| { ok: false; reason: "missing" | "unreadable" | "malformed" | "invalid"; path: string; detail?: string };

export function resolveConfigPath(env: NodeJS.ProcessEnv = process.env): string {
	const override = env.AGENTRELAY_CONFIG_PATH;
	if (override && override.length > 0) return override;
	return join(homedir(), ".agentrelay", "config.json");
}

export async function loadConfig(env: NodeJS.ProcessEnv = process.env): Promise<LoadConfigResult> {
	const path = resolveConfigPath(env);

	let exists: boolean;
	try {
		await stat(path);
		exists = true;
	} catch {
		exists = false;
	}
	if (!exists) {
		return { ok: false, reason: "missing", path };
	}

	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (err) {
		return { ok: false, reason: "unreadable", path, detail: errMsg(err) };
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		return { ok: false, reason: "malformed", path, detail: errMsg(err) };
	}

	const result = configSchema.safeParse(parsed);
	if (!result.success) {
		return { ok: false, reason: "invalid", path, detail: result.error.message };
	}

	return { ok: true, config: result.data, path };
}

/**
 * Human-readable explanation when config is unavailable. Returned to the
 * agent as the body of any tool call until the user runs `agentrelay register`.
 */
export function unavailableMessage(result: Extract<LoadConfigResult, { ok: false }>): string {
	const base = `AgentRelay is not configured. Expected config file at ${result.path}.`;
	switch (result.reason) {
		case "missing":
			return `${base} Run \`agentrelay register --relay <url> --handle <you@team>\` to create it.`;
		case "unreadable":
			return `${base} The file exists but could not be read (${result.detail ?? "unknown error"}). Check permissions — the file should be mode 0600 owned by you.`;
		case "malformed":
			return `${base} The file is not valid JSON (${result.detail ?? "unknown error"}). Fix it or re-run \`agentrelay register\`.`;
		case "invalid":
			return `${base} The file is missing required fields or has wrong types (${result.detail ?? "schema mismatch"}). Re-run \`agentrelay register\`.`;
	}
}

function errMsg(err: unknown): string {
	if (err instanceof Error) return err.message;
	return String(err);
}
