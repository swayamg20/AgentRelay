import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { resolvePinnedCodexLauncher } from "../src/codex-artifact.js";

export function resolvePinnedCodex() {
	return resolvePinnedCodexLauncher();
}

export async function sha256File(path: string): Promise<string> {
	const handle = await open(path, "r");
	try {
		const hash = createHash("sha256");
		for await (const chunk of handle.createReadStream()) hash.update(chunk);
		return hash.digest("hex");
	} finally {
		await handle.close();
	}
}
