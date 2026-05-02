import { homedir } from "node:os";
import { join } from "node:path";

export type SupportedClient = "claude-code" | "codex";

export interface ClientPaths {
	settingsPath: string;
	format: "json" | "toml";
}

export function configDir(env: NodeJS.ProcessEnv = process.env): string {
	return env.AGENTRELAY_HOME ?? join(homedir(), ".agentrelay");
}

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
	return env.AGENTRELAY_CONFIG_PATH ?? join(configDir(env), "config.json");
}

export function trustPath(env: NodeJS.ProcessEnv = process.env): string {
	return env.AGENTRELAY_TRUST_PATH ?? join(configDir(env), "trust.yaml");
}

/**
 * Path to the file where the recommended *permission overlay* lives. For
 * Claude Code this is `~/.claude/settings.json` (the "user settings" file);
 * Claude Code's permission engine reads `permissions.{allow,ask,deny}` from
 * here. For Codex it's the single `~/.codex/config.toml` that holds both
 * permission overlay and MCP server registrations.
 */
export function clientPaths(client: SupportedClient, env: NodeJS.ProcessEnv = process.env): ClientPaths {
	const home = env.HOME ?? homedir();
	switch (client) {
		case "claude-code":
			return { settingsPath: join(home, ".claude", "settings.json"), format: "json" };
		case "codex":
			return { settingsPath: join(home, ".codex", "config.toml"), format: "toml" };
	}
}

/**
 * Path to the file where Claude Code / Codex actually look for the
 * `mcpServers.agentrelay` registration. For Claude Code this is the
 * **user-scope** `~/.claude.json` (NOT `~/.claude/settings.json` — the
 * server-list and the permission overlay live in different files for
 * historical reasons; writing the MCP entry into settings.json was a
 * bug, see issue #1).
 */
export function mcpPath(client: SupportedClient, env: NodeJS.ProcessEnv = process.env): string {
	const home = env.HOME ?? homedir();
	switch (client) {
		case "claude-code":
			return join(home, ".claude.json");
		case "codex":
			// Codex stores everything in one file.
			return clientPaths("codex", env).settingsPath;
	}
}
