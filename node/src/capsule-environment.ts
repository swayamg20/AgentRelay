import { join } from "node:path";
import { ensurePrivateStateDirectory } from "./private-state-file.js";

const BASE_CHILD_ENVIRONMENT = [
	"PATH",
	"TMPDIR",
	"TMP",
	"TEMP",
	"LANG",
	"LC_ALL",
	"TZ",
	"SystemRoot",
] as const;

/** Keeps process-loader settings, credentials, proxies, and owner state out of Capsules. */
export function buildBaseCapsuleEnvironment(
	source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
	const result: NodeJS.ProcessEnv = {};
	for (const name of BASE_CHILD_ENVIRONMENT) {
		if (source[name] !== undefined) result[name] = source[name];
	}
	return result;
}

/** Adds only the private, Capsule-local home required by the Codex child process. */
export function buildCodexChildEnvironment(
	source: NodeJS.ProcessEnv,
	codexHome: string,
): NodeJS.ProcessEnv {
	return {
		...buildBaseCapsuleEnvironment(source),
		HOME: codexHome,
		CODEX_HOME: codexHome,
	};
}

/** Derives the runtime home locally; neither a peer nor a Mission chooses this path. */
export async function prepareCodexHome(capsuleDirectory: string): Promise<string> {
	await ensurePrivateStateDirectory(capsuleDirectory);
	const codexHome = join(capsuleDirectory, "codex-home");
	await ensurePrivateStateDirectory(codexHome);
	return codexHome;
}
