import { z } from "zod";
import { writeSecretFile } from "../cli/io.js";
import { type AgentRelayConfig, loadConfig, unavailableMessage } from "../config.js";

const codexThreadIdSchema = z.string().uuid();

export interface CodexConnectorBinding {
	runtime: "codex";
	thread_id: string;
}

export interface BindingDeps {
	env?: NodeJS.ProcessEnv;
	loadConfig?: typeof loadConfig;
	writeConfig?: (path: string, config: AgentRelayConfig) => Promise<void>;
}

export async function bindCodex(
	opts: { threadId?: string } = {},
	deps: BindingDeps = {},
): Promise<CodexConnectorBinding> {
	const env = deps.env ?? process.env;
	const loaded = await (deps.loadConfig ?? loadConfig)(env);
	if (!loaded.ok) throw new Error(unavailableMessage(loaded));

	const candidate = opts.threadId ?? env.CODEX_THREAD_ID;
	if (!candidate) {
		throw new Error(
			"Codex thread ID unavailable. Run this command from the Codex chat to bind it, or pass --thread <uuid>.",
		);
	}
	const parsed = codexThreadIdSchema.safeParse(candidate);
	if (!parsed.success) {
		throw new Error("Codex thread ID must be a UUID.");
	}

	const binding: CodexConnectorBinding = {
		runtime: "codex",
		thread_id: parsed.data,
	};
	const next: AgentRelayConfig = { ...loaded.config, connector_binding: binding };
	await (deps.writeConfig ?? writeConfig)(loaded.path, next);
	return binding;
}

export async function unbindCodex(deps: BindingDeps = {}): Promise<boolean> {
	const env = deps.env ?? process.env;
	const loaded = await (deps.loadConfig ?? loadConfig)(env);
	if (!loaded.ok) throw new Error(unavailableMessage(loaded));
	if (loaded.config.connector_binding?.runtime !== "codex") return false;

	const next: AgentRelayConfig = { ...loaded.config, connector_binding: null };
	await (deps.writeConfig ?? writeConfig)(loaded.path, next);
	return true;
}

async function writeConfig(path: string, config: AgentRelayConfig): Promise<void> {
	await writeSecretFile(path, `${JSON.stringify(config, null, 2)}\n`);
}
