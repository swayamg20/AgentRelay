import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CodexSandboxContainmentInput } from "./codex-sandbox-contract.js";
import {
	assertNoAmbientCodexConfiguration,
	buildCodexSandboxConfig,
	prepareContainmentLayout,
} from "./codex-sandbox-policy.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryRoots.splice(0).map((path) => rm(path, { force: true, recursive: true })),
	);
});

describe("Codex sandbox policy", () => {
	it("allows absent ambient configuration", async () => {
		const root = await temporaryRoot();
		await expect(
			assertNoAmbientCodexConfiguration([join(root, "missing.toml")]),
		).resolves.toBeUndefined();
	});

	it("rejects an ambient configuration layer", async () => {
		const root = await temporaryRoot();
		const path = join(root, "config.toml");
		await writeFile(path, 'sandbox_mode = "danger-full-access"\n');

		await expect(assertNoAmbientCodexConfiguration([path])).rejects.toThrow(
			"Ambient Codex configuration is unsupported",
		);
	});

	it("stages the probe outside the denied control tree", async () => {
		const root = await temporaryRoot();
		const input = fixtureInput(root);
		const layout = await prepareContainmentLayout(input, "create");

		expect(layout.stagedProbeRoot).toBe(join(input.runtimeDirectory, "probe-runtime"));
		expect(layout.stagedProbeRoot.startsWith(`${input.controlDirectory}/`)).toBe(false);
	});

	it("masks visible carveouts and leaves rootless host paths absent", async () => {
		const root = await temporaryRoot();
		const toolRoot = join(root, "tool-runtime");
		const readOnlyRoot = join(root, "read-only");
		const workspaceRoot = join(root, "workspace");
		const workspaceDeny = join(workspaceRoot, "private");
		const rootlessDeny = join(root, "unapproved-sibling");
		await Promise.all([
			mkdir(toolRoot),
			mkdir(readOnlyRoot),
			mkdir(join(workspaceRoot, ".git"), { recursive: true }),
			mkdir(workspaceDeny, { recursive: true }),
			mkdir(rootlessDeny),
		]);
		const executable = {
			executable: join(toolRoot, "codex"),
			readRoot: toolRoot,
			sha256: "a".repeat(64),
		};
		const input: CodexSandboxContainmentInput = {
			...fixtureInput(root),
			launcher: { ...executable, sandboxHelper: executable },
			provider: executable,
			readOnlyRoots: [readOnlyRoot],
			forbiddenRoots: [workspaceDeny, rootlessDeny],
		};
		const layout = await prepareContainmentLayout(input, "create");
		const config = await buildCodexSandboxConfig(input, layout, {
			executable: layout.stagedProbeExecutable,
			readRoot: layout.stagedProbeRoot,
			sha256: "d".repeat(64),
		});

		expect(config).toContain(`${JSON.stringify(workspaceDeny)} = "deny"`);
		expect(config).not.toContain(`${JSON.stringify(rootlessDeny)} = "deny"`);
		expect(config).not.toContain(`${JSON.stringify(input.controlDirectory)} = "deny"`);
	});
});

function fixtureInput(root: string): CodexSandboxContainmentInput {
	const executable = {
		executable: "/opt/agentrelay/codex",
		readRoot: "/opt/agentrelay",
		sha256: "a".repeat(64),
	};
	return {
		controlDirectory: join(root, "control"),
		runtimeDirectory: join(root, "runtime"),
		workspace: {
			repositoryUrl: "https://example.test/repository.git",
			baseCommit: "b".repeat(40),
			root: join(root, "workspace"),
			gitDirectory: join(root, "workspace", ".git"),
			rootIdentity: { device: "1", inode: "2" },
			gitIdentity: { device: "1", inode: "3" },
			reachableFromRef: "refs/heads/main",
		},
		launcher: { ...executable, sandboxHelper: executable },
		provider: executable,
		policyGrantSha256: "c".repeat(64),
	};
}

async function temporaryRoot(): Promise<string> {
	const root = await realpath(await mkdtemp(join(tmpdir(), "agentrelay-codex-policy-")));
	temporaryRoots.push(root);
	return root;
}
