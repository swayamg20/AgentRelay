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

export function clientPaths(client: SupportedClient, env: NodeJS.ProcessEnv = process.env): ClientPaths {
	const home = env.HOME ?? homedir();
	switch (client) {
		case "claude-code":
			return { settingsPath: join(home, ".claude", "settings.json"), format: "json" };
		case "codex":
			return { settingsPath: join(home, ".codex", "config.toml"), format: "toml" };
	}
}
