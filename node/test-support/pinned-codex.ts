import { createHash } from "node:crypto";
import { open, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { PinnedCodexLauncher } from "../src/codex-sandbox-containment.js";

export async function resolvePinnedCodex(): Promise<PinnedCodexLauncher> {
	if (process.platform !== "linux" || !["x64", "arm64"].includes(process.arch)) {
		throw new Error("Pinned containment test supports Linux x64 or arm64");
	}
	const require = createRequire(import.meta.url);
	const mainPackage = require.resolve("@openai/codex/package.json");
	const platformPackage = createRequire(mainPackage).resolve(
		`@openai/codex-linux-${process.arch}/package.json`,
	);
	const target =
		process.arch === "x64" ? "x86_64-unknown-linux-musl" : "aarch64-unknown-linux-musl";
	const readRoot = await realpath(join(dirname(platformPackage), "vendor", target));
	const executable = await realpath(join(readRoot, "bin", "codex"));
	const sandboxHelperExecutable = await realpath(join(readRoot, "codex-resources", "bwrap"));
	return {
		executable,
		readRoot,
		sha256: await sha256File(executable),
		sandboxHelper: {
			executable: sandboxHelperExecutable,
			readRoot,
			sha256: await sha256File(sandboxHelperExecutable),
		},
	};
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
