import { chmod, link, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertContainmentProbeAttestation } from "./codex-sandbox-probe-attestation.js";

const TOKEN = "expected-probe-attestation";
const temporaryRoots: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("assertContainmentProbeAttestation", () => {
	it("accepts an exact owner-private one-link result", async () => {
		const path = await createResult(TOKEN);

		await expect(assertContainmentProbeAttestation(path, TOKEN)).resolves.toBeUndefined();
	});

	it("rejects missing, linked, and symbolic-link results", async () => {
		const root = await createRoot();
		const missing = join(root, "missing");
		await expect(assertContainmentProbeAttestation(missing, TOKEN)).rejects.toThrow(
			"did not publish a safe attestation",
		);

		const linked = await createResult(TOKEN, root);
		await link(linked, join(root, "alias"));
		await expect(assertContainmentProbeAttestation(linked, TOKEN)).rejects.toThrow(
			"published an unsafe attestation",
		);

		const target = join(root, "target");
		await writeFile(target, TOKEN, { mode: 0o600 });
		const symbolic = join(root, "symbolic");
		await symlink(target, symbolic);
		await expect(assertContainmentProbeAttestation(symbolic, TOKEN)).rejects.toThrow(
			"did not publish a safe attestation",
		);
	});

	it("rejects permissive metadata and mismatched contents", async () => {
		const permissive = await createResult(TOKEN);
		await chmod(permissive, 0o640);
		await expect(assertContainmentProbeAttestation(permissive, TOKEN)).rejects.toThrow(
			"published an unsafe attestation",
		);

		const mismatch = await createResult("not-the-token");
		await expect(assertContainmentProbeAttestation(mismatch, TOKEN)).rejects.toThrow(
			"published an unsafe attestation",
		);

		const sameSizeMismatch = await createResult("0".repeat(TOKEN.length));
		await expect(assertContainmentProbeAttestation(sameSizeMismatch, TOKEN)).rejects.toThrow(
			"attestation did not match",
		);
	});
});

async function createRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "agentrelay-probe-attestation-"));
	temporaryRoots.push(root);
	return root;
}

async function createResult(contents: string, root?: string): Promise<string> {
	const directory = root ?? (await createRoot());
	const path = join(directory, `result-${Math.random()}`);
	await writeFile(path, contents, { flag: "wx", mode: 0o600 });
	return path;
}
