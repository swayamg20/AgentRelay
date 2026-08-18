import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type CodexPackageJsonResolver, resolvePinnedCodexLauncher } from "./codex-artifact.js";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("resolvePinnedCodexLauncher", () => {
	it("resolves the exact Linux x64 artifact relative to the wrapper package", async () => {
		const fixture = await createFixture();
		const calls: Array<{ packageName: string; parent: string | URL }> = [];
		const resolvePackageJson: CodexPackageJsonResolver = (packageName, parent) => {
			calls.push({ packageName, parent });
			return fixture.resolvePackageJson(packageName, parent);
		};

		const launcher = await resolvePinnedCodexLauncher({
			platform: "linux",
			arch: "x64",
			resolvePackageJson,
		});

		expect(launcher).toEqual({
			executable: fixture.executable,
			readRoot: fixture.readRoot,
			sha256: "2e863156ed35ecc5253b1e2f907a9143077b9f7cb51942070c61996471ff6e04",
			sandboxHelper: {
				executable: fixture.sandboxHelper,
				readRoot: fixture.readRoot,
				sha256: "77360cb751ccedc5971391444ac86a8a33c15b04d6b4a6fe45f5d25496e62c4c",
			},
		});
		expect(calls).toHaveLength(2);
		expect(calls[0]?.packageName).toBe("@openai/codex");
		expect(calls[0]?.parent).toMatch(/codex-artifact\.(?:ts|js)$/);
		expect(calls[1]).toEqual({
			packageName: "@openai/codex-linux-x64",
			parent: fixture.wrapperPackageJson,
		});
		expect(Object.isFrozen(launcher)).toBe(true);
		expect(Object.isFrozen(launcher.sandboxHelper)).toBe(true);
	});

	it.each([
		["darwin", "x64"],
		["linux", "arm64"],
		["win32", "x64"],
	] as const)(
		"rejects unsupported host %s/%s before package resolution",
		async (platform, arch) => {
			const resolvePackageJson = () => {
				throw new Error("must not resolve");
			};
			await expect(
				resolvePinnedCodexLauncher({ platform, arch, resolvePackageJson }),
			).rejects.toThrow(`supports only linux/x64; received ${platform}/${arch}`);
		},
	);

	it("rejects incompatible wrapper identity", async () => {
		const fixture = await createFixture({ wrapper: { version: "0.147.0" } });
		await expect(resolveFixture(fixture)).rejects.toThrow(
			"wrapper package metadata is incompatible",
		);
	});

	it("rejects an unexpected platform package alias", async () => {
		const fixture = await createFixture({
			wrapper: {
				optionalDependencies: {
					"@openai/codex-linux-x64": "npm:@openai/codex@latest",
				},
			},
		});
		await expect(resolveFixture(fixture)).rejects.toThrow(
			"wrapper optional dependency alias is incompatible",
		);
	});

	it.each([
		[{ version: "0.147.0-linux-x64" }, "version"],
		[{ os: ["darwin"] }, "os"],
		[{ cpu: ["arm64"] }, "cpu"],
	] as const)("rejects incompatible platform %s metadata", async (platform, _field) => {
		const fixture = await createFixture({ platform });
		await expect(resolveFixture(fixture)).rejects.toThrow(
			"Linux x64 package metadata is incompatible",
		);
	});

	it("rejects a missing platform package", async () => {
		const fixture = await createFixture();
		const resolvePackageJson: CodexPackageJsonResolver = (packageName, parent) => {
			if (packageName === "@openai/codex-linux-x64") throw new Error("missing");
			return fixture.resolvePackageJson(packageName, parent);
		};
		await expect(
			resolvePinnedCodexLauncher({ platform: "linux", arch: "x64", resolvePackageJson }),
		).rejects.toThrow("Linux x64 platform package is unavailable");
	});

	it.each([
		["executable", "executable"],
		["sandboxHelper", "sandbox helper"],
	] as const)("rejects a missing %s at the fixed vendor path", async (field, message) => {
		const fixture = await createFixture();
		await rm(fixture[field]);
		await expect(resolveFixture(fixture)).rejects.toThrow(
			`Pinned Codex ${message} is unavailable at its fixed package path`,
		);
	});

	it("rejects a vendor executable redirected through a symlink", async () => {
		const fixture = await createFixture();
		const redirected = join(fixture.root, "redirected-codex");
		await writeFile(redirected, "redirected");
		await rm(fixture.executable);
		await symlink(redirected, fixture.executable);
		await expect(resolveFixture(fixture)).rejects.toThrow(
			"executable must use its canonical package path",
		);
	});
});

interface FixtureOverrides {
	readonly wrapper?: Record<string, unknown>;
	readonly platform?: Record<string, unknown>;
}

interface CodexArtifactFixture {
	readonly root: string;
	readonly wrapperPackageJson: string;
	readonly executable: string;
	readonly sandboxHelper: string;
	readonly readRoot: string;
	readonly resolvePackageJson: CodexPackageJsonResolver;
}

async function createFixture(overrides: FixtureOverrides = {}): Promise<CodexArtifactFixture> {
	const root = await realpath(await mkdtemp(join(tmpdir(), "agentrelay-codex-artifact-")));
	roots.push(root);
	const wrapperPackageJson = join(root, "wrapper", "package.json");
	const platformPackageJson = join(root, "platform", "package.json");
	const readRoot = join(dirname(platformPackageJson), "vendor", "x86_64-unknown-linux-musl");
	const executable = join(readRoot, "bin", "codex");
	const sandboxHelper = join(readRoot, "codex-resources", "bwrap");
	await Promise.all([
		mkdir(dirname(wrapperPackageJson), { recursive: true }),
		mkdir(dirname(executable), { recursive: true }),
		mkdir(dirname(sandboxHelper), { recursive: true }),
	]);
	await Promise.all([
		writeFile(
			wrapperPackageJson,
			JSON.stringify({
				name: "@openai/codex",
				version: "0.146.0",
				optionalDependencies: {
					"@openai/codex-linux-x64": "npm:@openai/codex@0.146.0-linux-x64",
				},
				...overrides.wrapper,
			}),
		),
		writeFile(
			platformPackageJson,
			JSON.stringify({
				name: "@openai/codex",
				version: "0.146.0-linux-x64",
				os: ["linux"],
				cpu: ["x64"],
				...overrides.platform,
			}),
		),
		writeFile(executable, "codex"),
		writeFile(sandboxHelper, "bwrap"),
	]);
	return {
		root,
		wrapperPackageJson,
		executable,
		sandboxHelper,
		readRoot,
		resolvePackageJson(packageName) {
			if (packageName === "@openai/codex") return wrapperPackageJson;
			if (packageName === "@openai/codex-linux-x64") return platformPackageJson;
			throw new Error(`Unexpected package: ${packageName}`);
		},
	};
}

function resolveFixture(fixture: CodexArtifactFixture) {
	return resolvePinnedCodexLauncher({
		platform: "linux",
		arch: "x64",
		resolvePackageJson: fixture.resolvePackageJson,
	});
}
