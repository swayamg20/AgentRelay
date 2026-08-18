import {
	chmod,
	link,
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	realpath,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ContainmentLayout } from "./codex-sandbox-contract.js";
import { prepareStagedContainmentProbe } from "./codex-sandbox-staging.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryRoots.splice(0).map((path) => rm(path, { force: true, recursive: true })),
	);
});

describe("staged containment probe", () => {
	it("copies an executable into one private immutable recovery binding", async () => {
		const fixture = await createFixture();
		const created = await prepareStagedContainmentProbe(
			fixture.layout,
			"create",
			undefined,
			fixture.source,
		);

		expect(created).toMatchObject({
			executable: fixture.layout.stagedProbeExecutable,
			readRoot: fixture.layout.stagedProbeRoot,
		});
		expect((await stat(created.executable)).mode & 0o777).toBe(0o500);
		expect(await readFile(created.executable, "utf8")).toBe("#!/bin/sh\nexit 0\n");
		await expect(
			prepareStagedContainmentProbe(fixture.layout, "recover", created),
		).resolves.toEqual(created);
	});

	it("rejects changed staged metadata during recovery", async () => {
		const fixture = await createFixture();
		const created = await prepareStagedContainmentProbe(
			fixture.layout,
			"create",
			undefined,
			fixture.source,
		);
		await chmod(created.executable, 0o700);

		await expect(prepareStagedContainmentProbe(fixture.layout, "recover", created)).rejects.toThrow(
			"unsafe filesystem metadata",
		);
	});

	it("converges an exact pre-manifest retry and removes a crashed publication link", async () => {
		const fixture = await createFixture();
		const created = await prepareStagedContainmentProbe(
			fixture.layout,
			"create",
			undefined,
			fixture.source,
		);
		const original = await stat(created.executable);
		const crashedLink = join(fixture.layout.stagedProbeRoot, "bin", ".node.99999999.crashed.tmp");
		await link(created.executable, crashedLink);
		expect((await stat(created.executable)).nlink).toBe(2);

		const retried = await prepareStagedContainmentProbe(
			fixture.layout,
			"create",
			undefined,
			fixture.source,
		);

		expect(retried).toEqual(created);
		expect((await stat(retried.executable)).ino).toBe(original.ino);
		expect((await stat(retried.executable)).nlink).toBe(1);
		expect(await readdir(join(fixture.layout.stagedProbeRoot, "bin"))).toEqual(["node"]);
	});

	it("rejects a different probe source without replacing the completed publication", async () => {
		const fixture = await createFixture();
		const created = await prepareStagedContainmentProbe(
			fixture.layout,
			"create",
			undefined,
			fixture.source,
		);
		const original = await stat(created.executable);
		await chmod(fixture.source, 0o700);
		await writeFile(fixture.source, "#!/bin/sh\nexit 1\n", { mode: 0o500 });
		await chmod(fixture.source, 0o500);

		await expect(
			prepareStagedContainmentProbe(fixture.layout, "create", undefined, fixture.source),
		).rejects.toThrow("digest changed after creation");

		expect((await stat(created.executable)).ino).toBe(original.ino);
		expect(await readFile(created.executable, "utf8")).toBe("#!/bin/sh\nexit 0\n");
	});
});

async function createFixture(): Promise<{
	readonly layout: ContainmentLayout;
	readonly source: string;
}> {
	const root = await realpath(await mkdtemp(join(tmpdir(), "agentrelay-staged-probe-")));
	temporaryRoots.push(root);
	const launcherHome = join(root, "launcher");
	const stagedProbeRoot = join(launcherHome, "probe-runtime");
	const stagedProbeBin = join(stagedProbeRoot, "bin");
	await mkdir(stagedProbeBin, { mode: 0o700, recursive: true });
	const source = join(root, "source-probe");
	await writeFile(source, "#!/bin/sh\nexit 0\n", { mode: 0o500 });
	await chmod(source, 0o500);
	return {
		source,
		layout: {
			controlRoot: root,
			launcherHome,
			launcherPath: join(launcherHome, "config.toml"),
			stagedProbeRoot,
			stagedProbeExecutable: join(stagedProbeBin, "node"),
			runtimeRoot: join(root, "runtime"),
			runtimeHome: join(root, "runtime", "home"),
			runtimeTmp: join(root, "runtime", "tmp"),
			manifestPath: join(root, "containment.json"),
		},
	};
}
