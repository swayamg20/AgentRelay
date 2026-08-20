import { createHash } from "node:crypto";
import { isAbsolute, normalize } from "node:path";
import type { PolicyProfileConfig, VerificationCommandConfig } from "./config.js";

export type PolicyErrorCode =
	| "policy_profile_not_found"
	| "verification_command_not_allowed"
	| "verification_command_not_required"
	| "verification_command_workspace_invalid"
	| "verification_command_authority_invalid"
	| "verification_command_authority_expired"
	| "verification_command_environment_not_allowed";

export class PolicyError extends Error {
	constructor(
		readonly code: PolicyErrorCode,
		message: string,
	) {
		super(message);
		this.name = "PolicyError";
	}
}

export interface LocalPolicyGrant {
	readonly profile_name: string;
	readonly grant_sha256: string;
}

export interface ResolvedPolicyProfile {
	readonly name: string;
	readonly profile: PolicyProfileConfig;
	readonly grant: LocalPolicyGrant;
}

export type PolicyWorkspaceAccess = "read" | "write";

/** Omitted and explicit read policy are the same legacy-safe authority. */
export function policyWorkspaceAccess(profile: PolicyProfileConfig): PolicyWorkspaceAccess {
	return profile.workspace_access === "write" ? "write" : "read";
}

export interface VerificationCommandSelection {
	readonly commandId: string;
}

export interface VerificationCommandExecutionAuthority {
	readonly requiredCommandIds: readonly string[];
	readonly canonicalWorkspaceRoot: string;
	readonly remainingAuthorityMs: number;
	readonly sourceEnvironment: Readonly<NodeJS.ProcessEnv>;
}

export interface ResolvedVerificationCommandExecution {
	readonly executable: string;
	readonly args: readonly string[];
	readonly cwd: string;
	readonly shell: false;
	readonly timeoutMs: number;
	readonly env: Readonly<Record<string, string>>;
}

const SAFE_VERIFICATION_ENVIRONMENT = new Set([
	"CI",
	"LANG",
	"LC_ALL",
	"LC_CTYPE",
	"PATH",
	"PATHEXT",
	"Path",
	"SystemRoot",
	"SYSTEMROOT",
	"TEMP",
	"TMP",
	"TMPDIR",
	"TZ",
	"WINDIR",
]);

/**
 * Resolves a Relay-requested name against owner-controlled local policy. The caller
 * receives an immutable snapshot so later config mutation cannot redefine a grant.
 */
export function resolvePolicyProfile(
	profiles: Readonly<Record<string, PolicyProfileConfig>>,
	profileName: string,
): ResolvedPolicyProfile {
	if (!Object.hasOwn(profiles, profileName)) {
		throw new PolicyError(
			"policy_profile_not_found",
			`Local policy profile is not configured: ${profileName}`,
		);
	}

	const configured = profiles[profileName];
	if (configured === undefined) {
		throw new PolicyError(
			"policy_profile_not_found",
			`Local policy profile is not configured: ${profileName}`,
		);
	}

	const profile = immutableProfileSnapshot(configured);
	return Object.freeze({
		name: profileName,
		profile,
		grant: Object.freeze({
			profile_name: profileName,
			grant_sha256: policyGrantSha256(profileName, profile),
		}),
	});
}

/** Returns only the locally registered command selected by an opaque command ID. */
export function resolveVerificationCommand(
	resolved: ResolvedPolicyProfile,
	commandId: string,
): VerificationCommandConfig {
	const commands = resolved.profile.verification_commands;
	if (!Object.hasOwn(commands, commandId)) {
		throw new PolicyError(
			"verification_command_not_allowed",
			`Verification command is not allowed by local policy: ${commandId}`,
		);
	}

	const command = commands[commandId];
	if (command === undefined) {
		throw new PolicyError(
			"verification_command_not_allowed",
			`Verification command is not allowed by local policy: ${commandId}`,
		);
	}
	return immutableCommandSnapshot(command);
}

/**
 * Turns an untrusted opaque command selection into one owner-authorized execFile
 * invocation. Callers must realpath the workspace root before supplying it here.
 */
export function resolveVerificationCommandExecution(
	resolved: ResolvedPolicyProfile,
	selection: VerificationCommandSelection,
	authority: VerificationCommandExecutionAuthority,
): ResolvedVerificationCommandExecution {
	assertCanonicalWorkspaceRoot(authority.canonicalWorkspaceRoot);
	const remainingAuthorityMs = assertRemainingAuthority(authority.remainingAuthorityMs);
	const commandId = selection.commandId;

	if (!authority.requiredCommandIds.includes(commandId)) {
		throw new PolicyError(
			"verification_command_not_required",
			`Verification command is not required by the Mission: ${commandId}`,
		);
	}

	const command = resolveVerificationCommand(resolved, commandId);
	const [executable, ...configuredArgs] = command.argv;
	if (executable === undefined) {
		throw new PolicyError(
			"verification_command_not_allowed",
			`Verification command is not allowed by local policy: ${commandId}`,
		);
	}

	const environment: Record<string, string> = {};
	for (const name of command.environment) {
		if (!SAFE_VERIFICATION_ENVIRONMENT.has(name)) {
			throw new PolicyError(
				"verification_command_environment_not_allowed",
				`Verification command environment variable is not allowed: ${name}`,
			);
		}
		const value = authority.sourceEnvironment[name];
		if (value !== undefined) environment[name] = value;
	}

	return Object.freeze({
		executable,
		args: Object.freeze(configuredArgs),
		cwd: authority.canonicalWorkspaceRoot,
		shell: false,
		timeoutMs: Math.min(command.timeout_seconds * 1_000, remainingAuthorityMs),
		env: Object.freeze(environment),
	});
}

/** Hashes a canonical semantic representation, including the local profile name. */
export function policyGrantSha256(profileName: string, profile: PolicyProfileConfig): string {
	return createHash("sha256")
		.update(canonicalPolicyGrant(profileName, profile), "utf8")
		.digest("hex");
}

export function canonicalPolicyGrant(profileName: string, profile: PolicyProfileConfig): string {
	const verificationCommands = Object.keys(profile.verification_commands)
		.sort()
		.map((commandId) => {
			const command = profile.verification_commands[commandId];
			if (command === undefined) {
				throw new Error(`Policy command vanished while canonicalizing: ${commandId}`);
			}
			return {
				command_id: commandId,
				argv: [...command.argv],
				timeout_seconds: command.timeout_seconds,
				environment: [...command.environment].sort(),
			};
		});

	return JSON.stringify({
		schema_version: 1,
		profile_name: profileName,
		max_turn_seconds: profile.max_turn_seconds,
		max_reported_tokens: profile.max_reported_tokens,
		...(profile.workspace_access === "write" ? { workspace_access: "write" } : {}),
		network_access: profile.network_access,
		verification_commands: verificationCommands,
	});
}

function immutableProfileSnapshot(profile: PolicyProfileConfig): PolicyProfileConfig {
	const verificationCommands = Object.fromEntries(
		Object.entries(profile.verification_commands).map(([commandId, command]) => [
			commandId,
			immutableCommandSnapshot(command),
		]),
	);
	return Object.freeze({
		max_turn_seconds: profile.max_turn_seconds,
		max_reported_tokens: profile.max_reported_tokens,
		...(profile.workspace_access === "write" ? { workspace_access: "write" as const } : {}),
		network_access: profile.network_access,
		verification_commands: Object.freeze(verificationCommands),
	});
}

function immutableCommandSnapshot(command: VerificationCommandConfig): VerificationCommandConfig {
	return Object.freeze({
		argv: Object.freeze([...command.argv]),
		timeout_seconds: command.timeout_seconds,
		environment: Object.freeze([...command.environment]),
	});
}

function assertCanonicalWorkspaceRoot(workspaceRoot: string): void {
	if (
		workspaceRoot.includes("\0") ||
		!isAbsolute(workspaceRoot) ||
		normalize(workspaceRoot) !== workspaceRoot
	) {
		throw new PolicyError(
			"verification_command_workspace_invalid",
			"Verification command workspace root must be absolute, normalized, and canonical",
		);
	}
}

function assertRemainingAuthority(remainingAuthorityMs: number): number {
	if (!Number.isSafeInteger(remainingAuthorityMs)) {
		throw new PolicyError(
			"verification_command_authority_invalid",
			"Verification command remaining authority must be a safe integer in milliseconds",
		);
	}
	if (remainingAuthorityMs <= 0) {
		throw new PolicyError(
			"verification_command_authority_expired",
			"Verification command authority has expired",
		);
	}
	return remainingAuthorityMs;
}
