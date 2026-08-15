import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertNoAmbientCodexConfiguration } from "./codex-sandbox-policy.js";

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
});

async function temporaryRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "agentrelay-codex-policy-"));
	temporaryRoots.push(root);
	return root;
}
