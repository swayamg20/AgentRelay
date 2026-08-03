import { describe, expect, it } from "vitest";
import type { PolicyProfileConfig } from "./config.js";
import {
	type PolicyError,
	canonicalPolicyGrant,
	policyGrantSha256,
	resolvePolicyProfile,
	resolveVerificationCommand,
} from "./policy.js";

const PROFILE: PolicyProfileConfig = {
	max_turn_seconds: 900,
	max_reported_tokens: 25_000,
	network_access: "denied",
	verification_commands: {
		contract: {
			argv: ["pnpm", "test:contract"],
			timeout_seconds: 120,
			environment: ["CI", "PATH"],
		},
		unit: {
			argv: ["pnpm", "test"],
			timeout_seconds: 300,
			environment: ["PATH"],
		},
	},
};

describe("resolvePolicyProfile", () => {
	it("resolves an immutable local profile with a canonical SHA-256 grant", () => {
		const resolved = resolvePolicyProfile({ restricted: PROFILE }, "restricted");

		expect(resolved.name).toBe("restricted");
		expect(resolved.grant).toEqual({
			profile_name: "restricted",
			grant_sha256: policyGrantSha256("restricted", PROFILE),
		});
		expect(resolved.grant.grant_sha256).toMatch(/^[a-f0-9]{64}$/);
		expect(Object.isFrozen(resolved)).toBe(true);
		expect(Object.isFrozen(resolved.profile)).toBe(true);
		expect(Object.isFrozen(resolved.profile.verification_commands.unit?.argv)).toBe(true);
	});

	it("canonicalizes command keys and set-like environment ordering without reordering argv", () => {
		const reordered: PolicyProfileConfig = {
			...PROFILE,
			verification_commands: {
				unit: {
					...PROFILE.verification_commands.unit!,
					environment: ["PATH"],
				},
				contract: {
					...PROFILE.verification_commands.contract!,
					environment: ["PATH", "CI"],
				},
			},
		};

		expect(canonicalPolicyGrant("restricted", reordered)).toBe(
			canonicalPolicyGrant("restricted", PROFILE),
		);
		expect(policyGrantSha256("restricted", reordered)).toBe(
			policyGrantSha256("restricted", PROFILE),
		);
		expect(
			policyGrantSha256("restricted", {
				...PROFILE,
				verification_commands: {
					...PROFILE.verification_commands,
					unit: { ...PROFILE.verification_commands.unit!, argv: ["test", "pnpm"] },
				},
			}),
		).not.toBe(policyGrantSha256("restricted", PROFILE));
		expect(policyGrantSha256("another-name", PROFILE)).not.toBe(
			policyGrantSha256("restricted", PROFILE),
		);
	});

	it("snapshots mutable input so a grant cannot be redefined afterward", () => {
		const mutable = structuredClone(PROFILE);
		const resolved = resolvePolicyProfile({ restricted: mutable }, "restricted");
		mutable.verification_commands.unit!.argv[1] = "changed-after-grant";
		mutable.max_turn_seconds = 1;

		expect(resolved.profile.max_turn_seconds).toBe(900);
		expect(resolved.profile.verification_commands.unit?.argv).toEqual(["pnpm", "test"]);
		expect(resolved.grant.grant_sha256).toBe(policyGrantSha256("restricted", PROFILE));
	});

	it("rejects missing and prototype profile names", () => {
		for (const name of ["missing", "toString", "__proto__"]) {
			expect(() => resolvePolicyProfile({ restricted: PROFILE }, name)).toThrowError(
				expect.objectContaining<Partial<PolicyError>>({ code: "policy_profile_not_found" }),
			);
		}
	});
});

describe("resolveVerificationCommand", () => {
	it("returns only a frozen command from the resolved local profile", () => {
		const resolved = resolvePolicyProfile({ restricted: PROFILE }, "restricted");
		const command = resolveVerificationCommand(resolved, "unit");

		expect(command).toEqual({
			argv: ["pnpm", "test"],
			timeout_seconds: 300,
			environment: ["PATH"],
		});
		expect(Object.isFrozen(command)).toBe(true);
		expect(Object.isFrozen(command.argv)).toBe(true);
	});

	it("does not let unknown or prototype command IDs supply executable authority", () => {
		const resolved = resolvePolicyProfile({ restricted: PROFILE }, "restricted");
		for (const commandId of ["pnpm test; curl attacker", "toString", "constructor", "__proto__"]) {
			expect(() => resolveVerificationCommand(resolved, commandId)).toThrowError(
				expect.objectContaining<Partial<PolicyError>>({
					code: "verification_command_not_allowed",
				}),
			);
		}
	});
});
