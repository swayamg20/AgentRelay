import { constants } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import { isIPv4 } from "node:net";
import { homedir } from "node:os";
import { isAbsolute, join, normalize } from "node:path";
import {
	policyProfileNameSchema,
	repositoryRefSchema,
	repositoryUrlSchema,
	uuidSchema,
} from "@agentrelay/protocol";
import { z } from "zod";
import { writeDurableJson } from "./durable-file.js";

const SECRET_FILE_MODE = 0o600;
const MAX_COMMAND_ARGUMENT_LENGTH = 4_096;
const MAX_COMMAND_ARGUMENTS = 128;
const MAX_VERIFICATION_COMMANDS = 32;

export const relayUrlSchema = z
	.string()
	.min(1)
	.max(2_048)
	.transform((value, ctx) => {
		let url: URL;
		try {
			url = new URL(value);
		} catch {
			ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Relay URL must be a valid URL" });
			return z.NEVER;
		}
		if (value !== value.trim()) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Relay URL cannot contain surrounding whitespace",
			});
		}
		if (url.protocol !== "http:" && url.protocol !== "https:") {
			ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Relay URL must use HTTP or HTTPS" });
		}
		if (url.protocol === "http:" && !isLoopbackHostname(url.hostname)) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Relay URL must use HTTPS unless its host is loopback",
			});
		}
		if (url.username || url.password || url.search || url.hash) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Relay URL cannot contain credentials, query parameters, or a fragment",
			});
		}
		return value.replace(/\/+$/, "");
	})
	.pipe(z.string().min(1));

function isLoopbackHostname(hostname: string): boolean {
	return (
		hostname === "localhost" ||
		hostname === "[::1]" ||
		(isIPv4(hostname) && hostname.startsWith("127."))
	);
}

const nodeCredentialSchema = z
	.object({
		node_id: uuidSchema,
		agent_id: uuidSchema,
		credential_id: uuidSchema,
		token: z.string().regex(/^ar_node_(?:live|test)_[a-z2-7]{32}$/),
	})
	.strict();

const absoluteWorkspacePathSchema = z
	.string()
	.min(1)
	.max(4_096)
	.refine((value) => !value.includes("\0"), "Workspace path cannot contain NUL")
	.refine((value) => isAbsolute(value), "Workspace path must be absolute")
	.refine((value) => normalize(value) === value, "Workspace path must be normalized");

const environmentVariableNameSchema = z
	.string()
	.min(1)
	.max(128)
	.regex(/^[A-Za-z_][A-Za-z0-9_]*$/);

const commandArgumentSchema = z
	.string()
	.max(MAX_COMMAND_ARGUMENT_LENGTH)
	.refine((value) => !value.includes("\0"), "Command arguments cannot contain NUL");

export const verificationCommandConfigSchema = z
	.object({
		argv: z
			.array(commandArgumentSchema)
			.min(1)
			.max(MAX_COMMAND_ARGUMENTS)
			.refine((argv) => argv[0]?.trim().length !== 0, "Command executable cannot be blank"),
		timeout_seconds: z.number().int().positive().max(3_600),
		environment: z
			.array(environmentVariableNameSchema)
			.max(64)
			.refine((values) => new Set(values).size === values.length, {
				message: "Environment allowlist entries must be unique",
			}),
	})
	.strict();

export const policyProfileConfigSchema = z
	.object({
		max_turn_seconds: z.number().int().positive().max(86_400),
		max_reported_tokens: z.number().int().positive().max(100_000_000),
		workspace_access: z.enum(["read", "write"]).optional(),
		network_access: z.literal("denied"),
		verification_commands: z
			.record(policyProfileNameSchema, verificationCommandConfigSchema)
			.refine((commands) => Object.keys(commands).length <= MAX_VERIFICATION_COMMANDS, {
				message: `Policy profiles support at most ${MAX_VERIFICATION_COMMANDS} verification commands`,
			}),
	})
	.strict();

export const workspaceConfigSchema = z
	.object({
		path: absoluteWorkspacePathSchema,
		repository_url: repositoryUrlSchema,
		allowed_base_refs: z
			.array(repositoryRefSchema)
			.min(1)
			.max(32)
			.refine((refs) => new Set(refs).size === refs.length, {
				message: "Allowed base refs must be unique",
			}),
		policy_profile: policyProfileNameSchema,
	})
	.strict();

export const nodeConfigSchema = z
	.object({
		schema_version: z.literal(1),
		relay_url: relayUrlSchema,
		node: nodeCredentialSchema,
		workspaces: z.record(policyProfileNameSchema, workspaceConfigSchema),
		policy_profiles: z.record(policyProfileNameSchema, policyProfileConfigSchema),
	})
	.strict()
	.superRefine((config, ctx) => {
		for (const [alias, workspace] of Object.entries(config.workspaces)) {
			if (!Object.hasOwn(config.policy_profiles, workspace.policy_profile)) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					message: `Workspace ${alias} references an unknown policy profile`,
					path: ["workspaces", alias, "policy_profile"],
				});
			}
		}
	});

type MutableNodeConfig = z.infer<typeof nodeConfigSchema>;
type MutableWorkspaceConfig = z.infer<typeof workspaceConfigSchema>;
type MutablePolicyProfileConfig = z.infer<typeof policyProfileConfigSchema>;
type MutableVerificationCommandConfig = z.infer<typeof verificationCommandConfigSchema>;

export type DeepReadonly<T> = T extends (...args: never[]) => unknown
	? T
	: T extends readonly (infer Item)[]
		? readonly DeepReadonly<Item>[]
		: T extends object
			? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
			: T;

export type NodeConfig = DeepReadonly<MutableNodeConfig>;
export type WorkspaceConfig = DeepReadonly<MutableWorkspaceConfig>;
export type PolicyProfileConfig = DeepReadonly<MutablePolicyProfileConfig>;
export type VerificationCommandConfig = DeepReadonly<MutableVerificationCommandConfig>;

export class NodeConfigError extends Error {
	constructor(
		readonly reason: "unreadable" | "insecure_permissions" | "malformed" | "invalid",
		readonly path: string,
		message: string,
		options: ErrorOptions = {},
	) {
		super(message, options);
		this.name = "NodeConfigError";
	}
}

export function resolveNodeHome(env: NodeJS.ProcessEnv = process.env): string {
	return env.AGENTRELAY_NODE_HOME ?? join(homedir(), ".agentrelay", "node");
}

export function resolveNodeConfigPath(env: NodeJS.ProcessEnv = process.env): string {
	return env.AGENTRELAY_NODE_CONFIG_PATH ?? join(resolveNodeHome(env), "config.json");
}

export async function loadNodeConfig(path = resolveNodeConfigPath()): Promise<NodeConfig> {
	let handle: FileHandle;
	try {
		handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	} catch (error) {
		throw new NodeConfigError("unreadable", path, `Cannot open Node config at ${path}`, {
			cause: error,
		});
	}

	let raw: string;
	try {
		const stats = await handle.stat();
		if (!stats.isFile()) {
			throw new NodeConfigError("unreadable", path, "Node config must be a regular file");
		}
		if ((stats.mode & 0o777) !== SECRET_FILE_MODE) {
			throw new NodeConfigError(
				"insecure_permissions",
				path,
				`Node config must have mode 0600; found ${formatMode(stats.mode)}`,
			);
		}
		raw = await handle.readFile("utf8");
	} catch (error) {
		if (error instanceof NodeConfigError) throw error;
		throw new NodeConfigError("unreadable", path, `Cannot read Node config at ${path}`, {
			cause: error,
		});
	} finally {
		await handle.close();
	}

	let decoded: unknown;
	try {
		decoded = JSON.parse(raw);
	} catch (error) {
		throw new NodeConfigError("malformed", path, "Node config is not valid JSON", {
			cause: error,
		});
	}

	const parsed = nodeConfigSchema.safeParse(decoded);
	if (!parsed.success) {
		throw new NodeConfigError("invalid", path, "Node config does not match schema version 1", {
			cause: parsed.error,
		});
	}
	return deepFreeze(parsed.data);
}

export async function writeNodeConfig(path: string, input: unknown): Promise<NodeConfig> {
	const parsed = nodeConfigSchema.parse(input);
	await writeDurableJson(path, parsed, { fileMode: SECRET_FILE_MODE, directoryMode: 0o700 });
	return deepFreeze(parsed);
}

function formatMode(mode: number): string {
	return (mode & 0o777).toString(8).padStart(4, "0");
}

function deepFreeze<T>(value: T): DeepReadonly<T> {
	if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
		return value as DeepReadonly<T>;
	}
	for (const nested of Object.values(value)) {
		deepFreeze(nested);
	}
	return Object.freeze(value) as DeepReadonly<T>;
}
