import { createHash } from "node:crypto";
import type { PolicyProfileConfig, VerificationCommandConfig } from "./config.js";

export type PolicyErrorCode = "policy_profile_not_found" | "verification_command_not_allowed";

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
