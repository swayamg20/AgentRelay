import { describe, expect, it } from "vitest";
import type { PolicyProfileConfig } from "./config.js";
import {
	type PolicyError,
	canonicalPolicyGrant,
	policyGrantSha256,
	resolvePolicyProfile,
	resolveVerificationCommand,
	resolveVerificationCommandExecution,
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

	it("preserves the existing read digest and binds only explicit workspace write authority", () => {
		const omitted = policyGrantSha256("restricted", PROFILE);
		const explicitRead = policyGrantSha256("restricted", {
			...PROFILE,
			workspace_access: "read",
		});
		const explicitWrite = policyGrantSha256("restricted", {
			...PROFILE,
			workspace_access: "write",
		});

		expect(omitted).toBe("7c2968fd598231f76513f4052f9949f8c87cb73084e248e75006aff7e7ea6fed");
		expect(explicitRead).toBe(omitted);
		expect(explicitWrite).not.toBe(omitted);
		expect(
			canonicalPolicyGrant("restricted", { ...PROFILE, workspace_access: "read" }),
		).not.toContain("workspace_access");
		expect(
			JSON.parse(canonicalPolicyGrant("restricted", { ...PROFILE, workspace_access: "write" })),
		).toMatchObject({ workspace_access: "write" });
	});

	it("normalizes explicit read to the immutable legacy-read snapshot", () => {
		const resolved = resolvePolicyProfile(
			{ restricted: { ...PROFILE, workspace_access: "read" } },
			"restricted",
		);

		expect(resolved.profile.workspace_access).toBeUndefined();
		expect(resolved.grant.grant_sha256).toBe(policyGrantSha256("restricted", PROFILE));
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

describe("resolveVerificationCommandExecution", () => {
	const workspaceRoot = "/srv/agentrelay/workspace";

	it("derives one frozen execFile invocation only from local policy and trusted authority", () => {
		const resolved = resolvePolicyProfile({ restricted: PROFILE }, "restricted");
		const sourceEnvironment: NodeJS.ProcessEnv = {
			CI: "true",
			GITHUB_TOKEN: "must-not-escape",
			HOME: "/owner/home",
			NODE_OPTIONS: "--require=/tmp/loader.cjs",
			PATH: "/owner/bin",
		};
		const remoteLikeSelection = {
			commandId: "contract",
			executable: "sh",
			argv: ["sh", "-c", "curl attacker.invalid"],
			args: ["-c", "curl attacker.invalid"],
			cwd: "/attacker/chosen",
			timeoutMs: Number.MAX_SAFE_INTEGER,
			env: { PATH: "/attacker/bin", GITHUB_TOKEN: "remote-secret" },
		};

		const execution = resolveVerificationCommandExecution(resolved, remoteLikeSelection, {
			requiredCommandIds: ["contract"],
			canonicalWorkspaceRoot: workspaceRoot,
			remainingAuthorityMs: 45_000,
			sourceEnvironment,
		});

		expect(execution).toEqual({
			executable: "pnpm",
			args: ["test:contract"],
			cwd: workspaceRoot,
			shell: false,
			timeoutMs: 45_000,
			env: { CI: "true", PATH: "/owner/bin" },
		});
		expect(Object.keys(execution)).toEqual([
			"executable",
			"args",
			"cwd",
			"shell",
			"timeoutMs",
			"env",
		]);
		expect(Object.isFrozen(execution)).toBe(true);
		expect(Object.isFrozen(execution.args)).toBe(true);
		expect(Object.isFrozen(execution.env)).toBe(true);
		expect(execution).not.toHaveProperty("command");
		expect(execution.env).not.toHaveProperty("GITHUB_TOKEN");
		expect(execution.env).not.toHaveProperty("HOME");
		expect(execution.env).not.toHaveProperty("NODE_OPTIONS");

		sourceEnvironment.PATH = "/changed/after-resolution";
		expect(execution.env.PATH).toBe("/owner/bin");
	});

	it.each([
		{ remainingAuthorityMs: 1, expectedTimeoutMs: 1 },
		{ remainingAuthorityMs: 119_999, expectedTimeoutMs: 119_999 },
		{ remainingAuthorityMs: 120_000, expectedTimeoutMs: 120_000 },
		{ remainingAuthorityMs: Number.MAX_SAFE_INTEGER, expectedTimeoutMs: 120_000 },
	])(
		"bounds execution to $expectedTimeoutMs ms with $remainingAuthorityMs ms of authority",
		({ remainingAuthorityMs, expectedTimeoutMs }) => {
			const resolved = resolvePolicyProfile({ restricted: PROFILE }, "restricted");
			const execution = resolveVerificationCommandExecution(
				resolved,
				{ commandId: "contract" },
				{
					requiredCommandIds: ["contract"],
					canonicalWorkspaceRoot: workspaceRoot,
					remainingAuthorityMs,
					sourceEnvironment: {},
				},
			);

			expect(execution.timeoutMs).toBe(expectedTimeoutMs);
		},
	);

	it.each([
		{
			commandId: "unit",
			requiredCommandIds: ["contract"],
			code: "verification_command_not_required",
		},
		{
			commandId: "missing",
			requiredCommandIds: ["missing"],
			code: "verification_command_not_allowed",
		},
		{
			commandId: "toString",
			requiredCommandIds: ["toString"],
			code: "verification_command_not_allowed",
		},
		{
			commandId: "constructor",
			requiredCommandIds: ["constructor"],
			code: "verification_command_not_allowed",
		},
		{
			commandId: "__proto__",
			requiredCommandIds: ["__proto__"],
			code: "verification_command_not_allowed",
		},
	])(
		"rejects command selection $commandId with $code",
		({ commandId, requiredCommandIds, code }) => {
			const resolved = resolvePolicyProfile({ restricted: PROFILE }, "restricted");

			expect(() =>
				resolveVerificationCommandExecution(
					resolved,
					{ commandId },
					{
						requiredCommandIds,
						canonicalWorkspaceRoot: workspaceRoot,
						remainingAuthorityMs: 1_000,
						sourceEnvironment: {},
					},
				),
			).toThrowError(expect.objectContaining<Partial<PolicyError>>({ code }));
		},
	);

	it.each(["relative/workspace", "/srv/workspace/../other", "/srv/workspace\0other"])(
		"rejects non-canonical workspace root %s",
		(canonicalWorkspaceRoot) => {
			const resolved = resolvePolicyProfile({ restricted: PROFILE }, "restricted");

			expect(() =>
				resolveVerificationCommandExecution(
					resolved,
					{ commandId: "contract" },
					{
						requiredCommandIds: ["contract"],
						canonicalWorkspaceRoot,
						remainingAuthorityMs: 1_000,
						sourceEnvironment: {},
					},
				),
			).toThrowError(
				expect.objectContaining<Partial<PolicyError>>({
					code: "verification_command_workspace_invalid",
				}),
			);
		},
	);

	it.each([
		{ remainingAuthorityMs: 0, code: "verification_command_authority_expired" },
		{ remainingAuthorityMs: -1, code: "verification_command_authority_expired" },
		{ remainingAuthorityMs: 1.5, code: "verification_command_authority_invalid" },
		{ remainingAuthorityMs: Number.NaN, code: "verification_command_authority_invalid" },
		{
			remainingAuthorityMs: Number.POSITIVE_INFINITY,
			code: "verification_command_authority_invalid",
		},
		{
			remainingAuthorityMs: Number.MAX_SAFE_INTEGER + 1,
			code: "verification_command_authority_invalid",
		},
	])(
		"rejects remaining authority $remainingAuthorityMs with $code",
		({ remainingAuthorityMs, code }) => {
			const resolved = resolvePolicyProfile({ restricted: PROFILE }, "restricted");

			expect(() =>
				resolveVerificationCommandExecution(
					resolved,
					{ commandId: "contract" },
					{
						requiredCommandIds: ["contract"],
						canonicalWorkspaceRoot: workspaceRoot,
						remainingAuthorityMs,
						sourceEnvironment: {},
					},
				),
			).toThrowError(expect.objectContaining<Partial<PolicyError>>({ code }));
		},
	);

	it.each([
		"HOME",
		"NODE_OPTIONS",
		"NODE_PATH",
		"LD_PRELOAD",
		"DYLD_INSERT_LIBRARIES",
		"AWS_ACCESS_KEY_ID",
		"GITHUB_TOKEN",
		"PRIVATE_KEY",
		"CLIENT_SECRET",
		"HTTPS_PROXY",
		"NO_PROXY",
		"UNREVIEWED_OPERATIONAL_SETTING",
	])("rejects configured environment variable %s", (environmentName) => {
		const profile: PolicyProfileConfig = {
			...PROFILE,
			verification_commands: {
				...PROFILE.verification_commands,
				contract: {
					...PROFILE.verification_commands.contract!,
					environment: [environmentName],
				},
			},
		};
		const resolved = resolvePolicyProfile({ restricted: profile }, "restricted");

		expect(() =>
			resolveVerificationCommandExecution(
				resolved,
				{ commandId: "contract" },
				{
					requiredCommandIds: ["contract"],
					canonicalWorkspaceRoot: workspaceRoot,
					remainingAuthorityMs: 1_000,
					sourceEnvironment: { [environmentName]: "must-not-escape" },
				},
			),
		).toThrowError(
			expect.objectContaining<Partial<PolicyError>>({
				code: "verification_command_environment_not_allowed",
			}),
		);
	});
});
