import { chmod, mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildCodexChildEnvironment, prepareCodexHome } from "./capsule-environment.js";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("Codex Capsule environment", () => {
	it("allowlists only inert process settings plus the locally derived home", () => {
		const home = "/private/capsule/codex-home";
		expect(
			buildCodexChildEnvironment(
				{
					PATH: "/usr/bin",
					TMPDIR: "/private/tmp",
					LANG: "en_US.UTF-8",
					TZ: "UTC",
					HOME: "/owner/home",
					CODEX_HOME: "/owner/codex",
					AGENTRELAY_NODE_TOKEN: "relay-secret",
					OPENAI_API_KEY: "provider-secret",
					AWS_SECRET_ACCESS_KEY: "cloud-secret",
					SSH_AUTH_SOCK: "/owner/agent.sock",
					HTTP_PROXY: "http://proxy.invalid",
					NODE_OPTIONS: "--require=/owner/inject.cjs",
					LD_PRELOAD: "/owner/inject.so",
					DYLD_INSERT_LIBRARIES: "/owner/inject.dylib",
				},
				home,
			),
		).toEqual({
			PATH: "/usr/bin",
			TMPDIR: "/private/tmp",
			LANG: "en_US.UTF-8",
			TZ: "UTC",
			HOME: home,
			CODEX_HOME: home,
		});
	});

	it("creates and revalidates one canonical mode-0700 home below the Capsule", async () => {
		const capsule = await temporaryDirectory();
		const expected = join(capsule, "codex-home");

		expect(await prepareCodexHome(capsule)).toBe(expected);
		expect(await prepareCodexHome(capsule)).toBe(expected);
		expect((await stat(expected)).mode & 0o777).toBe(0o700);
		expect(await realpath(expected)).toBe(expected);
	});

	it("rejects a non-private Capsule directory", async () => {
		const capsule = await temporaryDirectory();
		await chmod(capsule, 0o755);
		await expect(prepareCodexHome(capsule)).rejects.toThrow(/mode 0700/);
	});

	it("rejects symlink aliases and unsafe existing home entries", async () => {
		const parent = await temporaryDirectory();
		const capsule = join(parent, "capsule");
		await mkdir(capsule, { mode: 0o700 });
		const alias = join(parent, "capsule-alias");
		await symlink(capsule, alias);
		await expect(prepareCodexHome(alias)).rejects.toThrow(/real directory/);

		const canonicalParent = join(parent, "canonical-parent");
		await mkdir(join(canonicalParent, "real-capsule"), { recursive: true, mode: 0o700 });
		const parentAlias = join(parent, "parent-alias");
		await symlink(canonicalParent, parentAlias);
		await expect(prepareCodexHome(join(parentAlias, "real-capsule"))).rejects.toThrow(
			/canonical path/,
		);

		const home = join(capsule, "codex-home");
		await writeFile(home, "not a directory", { mode: 0o600 });
		await expect(prepareCodexHome(capsule)).rejects.toThrow(/real directory/);
	});

	it("rejects an existing home whose permissions are not exactly 0700", async () => {
		const capsule = await temporaryDirectory();
		const home = join(capsule, "codex-home");
		await mkdir(home, { mode: 0o700 });
		await chmod(home, 0o500);
		await expect(prepareCodexHome(capsule)).rejects.toThrow(/mode 0700/);
	});
});

async function temporaryDirectory(): Promise<string> {
	const directory = await realpath(await mkdtemp(join(tmpdir(), "agentrelay-capsule-env-")));
	await chmod(directory, 0o700);
	directories.push(directory);
	return directory;
}
