import { chmod, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { digestCanonicalJson } from "./capsule-correlation.js";
import { codexProviderEgressBinding } from "./codex-provider-egress-policy.js";
import type { RuntimeContainmentBinding } from "./runtime-containment-manifest.js";
import {
	containmentEvidence,
	createRuntimeContainmentManifest,
	openRuntimeContainmentManifest,
	readRuntimeContainmentManifest,
} from "./runtime-containment-manifest.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("runtime containment manifest", () => {
	it("does not create a missing manifest while opening recovery state", async () => {
		const directory = await realpath(
			await mkdtemp(join(tmpdir(), "agentrelay-containment-manifest-")),
		);
		temporaryDirectories.push(directory);
		const path = join(directory, "containment.json");

		await expect(openRuntimeContainmentManifest(path, validBinding())).rejects.toThrow(
			"Containment manifest is missing",
		);
		await expect(readFile(path, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("durably reopens only the exact authorized binding", async () => {
		const directory = await realpath(
			await mkdtemp(join(tmpdir(), "agentrelay-containment-manifest-")),
		);
		temporaryDirectories.push(directory);
		const path = join(directory, "private", "containment.json");
		const binding = validBinding();

		const created = await createRuntimeContainmentManifest(
			path,
			binding,
			() => new Date("2026-08-16T00:00:00.000Z"),
		);
		const reopened = await openRuntimeContainmentManifest(path, binding);

		expect(reopened).toEqual(created);
		expect("workspace_access" in reopened.binding).toBe(false);
		expect(await readFile(path, "utf8")).not.toContain("workspace_access");
		expect(await readRuntimeContainmentManifest(path)).toEqual(created);
		expect((await stat(path)).mode & 0o777).toBe(0o600);
		await expect(createRuntimeContainmentManifest(path, binding)).resolves.toEqual(created);
		const changedBinding = {
			...binding,
			workspace: {
				...binding.workspace,
				root: {
					...binding.workspace.root,
					identity: { ...binding.workspace.root.identity, inode: "999" },
				},
			},
		};
		await expect(openRuntimeContainmentManifest(path, changedBinding)).rejects.toThrow(
			"does not authorize this exact workspace and policy",
		);
		await expect(createRuntimeContainmentManifest(path, changedBinding)).rejects.toThrow(
			"does not authorize this exact workspace and policy",
		);
	});

	it("converges partial staging debris and concurrent final publication", async () => {
		const directory = await realpath(
			await mkdtemp(join(tmpdir(), "agentrelay-containment-manifest-")),
		);
		temporaryDirectories.push(directory);
		const path = join(directory, "containment.json");
		await writeFile(join(directory, ".containment.json.99999999.crashed.tmp"), '{"partial":', {
			mode: 0o600,
		});
		const binding = validBinding();

		const [first, second] = await Promise.all([
			createRuntimeContainmentManifest(path, binding, () => new Date("2026-08-16T00:00:00.000Z")),
			createRuntimeContainmentManifest(path, binding, () => new Date("2026-08-16T00:00:01.000Z")),
		]);

		expect(second).toEqual(first);
		expect(await readRuntimeContainmentManifest(path)).toEqual(first);
		expect((await stat(path)).mode & 0o777).toBe(0o600);
		expect((await stat(path)).nlink).toBe(1);
	});

	it("binds explicit read-only workspace access into the retained digest", async () => {
		const directory = await realpath(
			await mkdtemp(join(tmpdir(), "agentrelay-containment-manifest-")),
		);
		temporaryDirectories.push(directory);
		const path = join(directory, "containment.json");
		const binding = { ...validBinding(), workspace_access: "read" as const };

		const created = await createRuntimeContainmentManifest(path, binding);
		const reopened = await openRuntimeContainmentManifest(path, binding);

		expect(reopened).toEqual(created);
		expect(reopened.binding.workspace_access).toBe("read");
		await expect(
			openRuntimeContainmentManifest(path, { ...binding, workspace_access: "write" }),
		).rejects.toThrow("does not authorize this exact workspace and policy");
	});

	it("rejects legacy egress-less and altered provider policies", async () => {
		const directory = await realpath(
			await mkdtemp(join(tmpdir(), "agentrelay-containment-manifest-")),
		);
		temporaryDirectories.push(directory);
		const path = join(directory, "containment.json");
		const binding = validBinding();
		const created = await createRuntimeContainmentManifest(path, binding);
		expect(created.schema_version).toBe(1);
		expect(created.binding.provider_egress).toEqual(codexProviderEgressBinding());
		expect(JSON.stringify(created)).not.toContain("OPENAI_API_KEY");
		expect(JSON.stringify(created)).not.toContain("CODEX_API_KEY");

		const legacyBinding = structuredClone(binding) as unknown as Record<string, unknown>;
		delete legacyBinding.provider_egress;
		await writeFile(
			path,
			`${JSON.stringify({
				...created,
				binding_sha256: digestCanonicalJson(legacyBinding),
				binding: legacyBinding,
			})}\n`,
		);
		await expect(readRuntimeContainmentManifest(path)).rejects.toThrow(
			"Containment manifest does not authorize the required provider egress policy",
		);

		const alteredBinding = structuredClone(binding);
		const alteredEgress = {
			...alteredBinding.provider_egress,
			base_url: "https://evil.test/v1",
		};
		await writeFile(
			path,
			`${JSON.stringify({
				...created,
				binding_sha256: digestCanonicalJson({
					...alteredBinding,
					provider_egress: alteredEgress,
				}),
				binding: { ...alteredBinding, provider_egress: alteredEgress },
			})}\n`,
		);
		await expect(readRuntimeContainmentManifest(path)).rejects.toThrow(
			"Containment manifest does not authorize the required provider egress policy",
		);
	});

	it("rejects tampering and exposes no local path as evidence", async () => {
		const directory = await realpath(
			await mkdtemp(join(tmpdir(), "agentrelay-containment-manifest-")),
		);
		temporaryDirectories.push(directory);
		const path = join(directory, "containment.json");
		const binding = validBinding();
		const manifest = await createRuntimeContainmentManifest(path, binding);

		const evidence = containmentEvidence(manifest);
		expect(JSON.stringify(evidence)).not.toContain("/private/");

		const decoded = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
		decoded.retention = "dispose";
		await writeFile(path, `${JSON.stringify(decoded)}\n`);
		await chmod(path, 0o600);
		await expect(openRuntimeContainmentManifest(path, binding)).rejects.toThrow();
	});
});

function validBinding(): RuntimeContainmentBinding {
	const path = (value: string, inode: string) => ({
		path: value,
		identity: { device: "1", inode },
	});
	return {
		backend: "codex_bubblewrap_0_146",
		runtime_version: "0.146.0",
		workspace: {
			repository_url: "https://github.com/example/backend.git",
			base_commit: "a".repeat(40),
			reachable_from_ref: "refs/heads/main",
			root: path("/private/workspace", "10"),
			git_directory: path("/private/workspace/.git", "11"),
		},
		launcher: {
			executable: path("/private/launcher/bin/codex", "20"),
			executable_sha256: "b".repeat(64),
			read_root: path("/private/launcher", "21"),
			sandbox_helper: {
				executable: path("/private/launcher/codex-resources/bwrap", "22"),
				executable_sha256: "f".repeat(64),
			},
			config_path: "/private/control/config.toml",
			config_sha256: "c".repeat(64),
		},
		provider: {
			executable: path("/private/provider/bin/codex", "30"),
			executable_sha256: "d".repeat(64),
			read_root: path("/private/provider", "31"),
		},
		provider_egress: codexProviderEgressBinding(),
		probe: {
			executable: path("/private/node/bin/node", "32"),
			executable_sha256: "1".repeat(64),
			read_root: path("/private/node/bin", "33"),
		},
		private_paths: {
			control_root: path("/private/control", "40"),
			launcher_home: path("/private/control/launcher", "41"),
			runtime_root: path("/private/runtime", "42"),
			runtime_home: path("/private/runtime/home", "43"),
			runtime_tmp: path("/private/runtime/tmp", "44"),
		},
		read_only_roots: [path("/private/read", "50")],
		denied_roots: [path("/private/denied", "60")],
		policy_grant_sha256: "e".repeat(64),
	};
}
