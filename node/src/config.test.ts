import { chmod, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	NodeConfigError,
	loadNodeConfig,
	nodeConfigSchema,
	resolveNodeConfigPath,
	resolveNodeHome,
	writeNodeConfig,
} from "./config.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	const { rm } = await import("node:fs/promises");
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("nodeConfigSchema", () => {
	it("accepts a strict version-one config and canonicalizes the Relay URL", () => {
		const parsed = nodeConfigSchema.parse(validConfig());
		expect(parsed.relay_url).toBe("https://relay.example.test");
		expect(parsed.workspaces.backend.path).toBe("/srv/backend");
	});

	it("allows HTTP only for loopback Relay hosts", () => {
		for (const relayUrl of [
			"http://localhost:3000",
			"http://127.0.0.1:3000",
			"http://127.255.255.254:3000",
			"http://[::1]:3000",
		]) {
			const config = validConfig();
			config.relay_url = relayUrl;
			expect(nodeConfigSchema.parse(config).relay_url).toBe(relayUrl);
		}

		for (const relayUrl of [
			"http://relay.example.test",
			"http://10.0.0.1:3000",
			"http://127.0.0.1.example.test",
			"http://[::2]:3000",
		]) {
			const config = validConfig();
			config.relay_url = relayUrl;
			expect(() => nodeConfigSchema.parse(config)).toThrow(/must use HTTPS/);
		}
	});

	it("reports malformed Relay URLs as schema failures", () => {
		for (const relayUrl of ["not-a-url", " https://relay.example.test", ""]) {
			const config = validConfig();
			config.relay_url = relayUrl;
			expect(nodeConfigSchema.safeParse(config).success).toBe(false);
		}
	});

	it("rejects unknown fields at every boundary", () => {
		const config = validConfig();
		(config.workspaces.backend as Record<string, unknown>).remote_path = "/peer/chosen";
		expect(() => nodeConfigSchema.parse(config)).toThrow();
	});

	it("requires normalized absolute workspace paths", () => {
		const relative = validConfig();
		relative.workspaces.backend.path = "repositories/backend";
		expect(() => nodeConfigSchema.parse(relative)).toThrow(/absolute/);

		const unnormalized = validConfig();
		unnormalized.workspaces.backend.path = "/srv/../srv/backend";
		expect(() => nodeConfigSchema.parse(unnormalized)).toThrow(/normalized/);
	});

	it("requires every workspace to use a locally defined policy profile", () => {
		const config = validConfig();
		config.workspaces.backend.policy_profile = "missing";
		expect(() => nodeConfigSchema.parse(config)).toThrow(/unknown policy profile/);
	});

	it("keeps commands as bounded argv with a unique environment allowlist", () => {
		const blank = validConfig();
		blank.policy_profiles.default.verification_commands.test.argv = [" "];
		expect(() => nodeConfigSchema.parse(blank)).toThrow(/executable/);

		const duplicateEnvironment = validConfig();
		duplicateEnvironment.policy_profiles.default.verification_commands.test.environment = [
			"CI",
			"CI",
		];
		expect(() => nodeConfigSchema.parse(duplicateEnvironment)).toThrow(/unique/);
	});

	it("keeps workspace write authority explicit and owner-local", () => {
		const omitted = nodeConfigSchema.parse(validConfig());
		expect(omitted.policy_profiles.default.workspace_access).toBeUndefined();

		const read = validConfig("read");
		expect(nodeConfigSchema.parse(read).policy_profiles.default.workspace_access).toBe("read");

		const write = validConfig("write");
		expect(nodeConfigSchema.parse(write).policy_profiles.default.workspace_access).toBe("write");

		const invalid = validConfig();
		(invalid.policy_profiles.default as Record<string, unknown>).workspace_access =
			"danger-full-access";
		expect(nodeConfigSchema.safeParse(invalid).success).toBe(false);
	});
});

describe("Node config files", () => {
	it("loads only a regular mode-0600 file and deeply freezes its contents", async () => {
		const root = await temporaryDirectory();
		const path = join(root, "config.json");
		await writeFile(path, JSON.stringify(validConfig()), { mode: 0o600 });

		const loaded = await loadNodeConfig(path);

		expect(Object.isFrozen(loaded)).toBe(true);
		expect(Object.isFrozen(loaded.workspaces.backend)).toBe(true);
		expect(Object.isFrozen(loaded.policy_profiles.default.verification_commands.test.argv)).toBe(
			true,
		);
	});

	it("rejects a config readable by group or other users", async () => {
		const root = await temporaryDirectory();
		const path = join(root, "config.json");
		await writeFile(path, JSON.stringify(validConfig()), { mode: 0o600 });
		await chmod(path, 0o640);

		await expect(loadNodeConfig(path)).rejects.toMatchObject({
			name: "NodeConfigError",
			reason: "insecure_permissions",
		});
	});

	it("rejects a symlink instead of following it to a secret", async () => {
		const root = await temporaryDirectory();
		const target = join(root, "target.json");
		const link = join(root, "config.json");
		await writeFile(target, JSON.stringify(validConfig()), { mode: 0o600 });
		await symlink(target, link);

		await expect(loadNodeConfig(link)).rejects.toBeInstanceOf(NodeConfigError);
	});

	it("distinguishes malformed JSON from a schema-invalid config", async () => {
		const root = await temporaryDirectory();
		const malformed = join(root, "malformed.json");
		const invalid = join(root, "invalid.json");
		await writeFile(malformed, "{", { mode: 0o600 });
		await writeFile(invalid, JSON.stringify({ schema_version: 2 }), { mode: 0o600 });

		await expect(loadNodeConfig(malformed)).rejects.toMatchObject({ reason: "malformed" });
		await expect(loadNodeConfig(invalid)).rejects.toMatchObject({ reason: "invalid" });
	});

	it("writes a validated mode-0600 config that round-trips", async () => {
		const root = await temporaryDirectory();
		const path = join(root, "nested", "config.json");

		const written = await writeNodeConfig(path, validConfig());
		const loaded = await loadNodeConfig(path);

		expect(loaded).toEqual(written);
		expect((await readFile(path, "utf8")).endsWith("\n")).toBe(true);
	});

	it("resolves explicit home and config overrides", () => {
		expect(resolveNodeHome({ AGENTRELAY_NODE_HOME: "/tmp/node-home" })).toBe("/tmp/node-home");
		expect(
			resolveNodeConfigPath({
				AGENTRELAY_NODE_HOME: "/tmp/node-home",
				AGENTRELAY_NODE_CONFIG_PATH: "/tmp/explicit.json",
			}),
		).toBe("/tmp/explicit.json");
	});
});

function validConfig(workspaceAccess?: "read" | "write") {
	return {
		schema_version: 1 as const,
		relay_url: "https://relay.example.test/",
		node: {
			node_id: "10000000-0000-4000-8000-000000000001",
			agent_id: "10000000-0000-4000-8000-000000000002",
			credential_id: "10000000-0000-4000-8000-000000000003",
			token: `ar_node_test_${"a".repeat(32)}`,
		},
		workspaces: {
			backend: {
				path: "/srv/backend",
				repository_url: "https://github.com/example/backend.git",
				allowed_base_refs: ["refs/heads/main"],
				policy_profile: "default",
			},
		},
		policy_profiles: {
			default: {
				max_turn_seconds: 300,
				max_reported_tokens: 100_000,
				...(workspaceAccess === undefined ? {} : { workspace_access: workspaceAccess }),
				network_access: "denied" as const,
				verification_commands: {
					test: {
						argv: ["pnpm", "test"],
						timeout_seconds: 120,
						environment: ["CI"],
					},
				},
			},
		},
	};
}

async function temporaryDirectory(): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), "agentrelay-node-config-"));
	temporaryDirectories.push(path);
	return path;
}
