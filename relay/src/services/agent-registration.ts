import { eq } from "drizzle-orm";
import { type KeyEnvironment, generateKey } from "../auth/keys.js";
import type { Database } from "../db/client.js";
import { type Agent, agents, apiKeys } from "../db/schema.js";
import { RelayError } from "../errors.js";

type AgentRegistrationWriter = Pick<Database, "insert" | "select">;

export interface RegisterAgentInput {
	handle: string;
	email?: string;
	displayName?: string;
	role: string;
	pepper: string;
	keyEnvironment: KeyEnvironment;
	keyLabel?: string;
}

export interface RegisterAgentResult {
	agent: Agent;
	apiKey: string;
}

export async function registerAgentWithInitialKey(
	writer: AgentRegistrationWriter,
	input: RegisterAgentInput,
): Promise<RegisterAgentResult> {
	const [existing] = await writer
		.select({ id: agents.id })
		.from(agents)
		.where(eq(agents.handle, input.handle));
	if (existing) {
		throw new RelayError("invalid_params", `Handle '${input.handle}' is already registered`);
	}

	const generated = generateKey(input.keyEnvironment, input.pepper);
	const [agent] = await writer
		.insert(agents)
		.values({
			handle: input.handle,
			email: input.email ?? input.handle,
			displayName: input.displayName ?? input.handle,
			role: input.role,
		})
		.returning();
	if (!agent) throw new RelayError("internal", "Failed to create agent");

	await writer.insert(apiKeys).values({
		agentId: agent.id,
		keyHash: generated.hash,
		salt: generated.salt,
		label: input.keyLabel ?? "initial",
	});

	return { agent, apiKey: generated.raw };
}
