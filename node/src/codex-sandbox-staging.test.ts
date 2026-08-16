import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
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
