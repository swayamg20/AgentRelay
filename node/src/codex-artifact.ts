import { lstat, readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { z } from "zod";
import { SUPPORTED_CODEX_CLI_VERSION } from "./codex-app-server-protocol.js";
import type { PinnedCodexLauncher } from "./codex-sandbox-contract.js";

export const PINNED_CODEX_CLI_VERSION = SUPPORTED_CODEX_CLI_VERSION;
// Reproduced independently from npm archive SHA256
// 91a32565acb7fef5d300294577092a121503406e34ce7e992af8bdf1998b65fb.
export const PINNED_CODEX_CLI_SHA256 =
	"2e863156ed35ecc5253b1e2f907a9143077b9f7cb51942070c61996471ff6e04";
export const PINNED_CODEX_BWRAP_SHA256 =
	"77360cb751ccedc5971391444ac86a8a33c15b04d6b4a6fe45f5d25496e62c4c";

const CODEX_WRAPPER_PACKAGE = "@openai/codex";
const CODEX_PLATFORM_PACKAGE = "@openai/codex-linux-x64";
const CODEX_PLATFORM_PACKAGE_VERSION = `${PINNED_CODEX_CLI_VERSION}-linux-x64`;
const CODEX_PLATFORM_PACKAGE_ALIAS = `npm:${CODEX_WRAPPER_PACKAGE}@${CODEX_PLATFORM_PACKAGE_VERSION}`;
const CODEX_TARGET = "x86_64-unknown-linux-musl";

const wrapperPackageSchema = z
	.object({
		name: z.literal(CODEX_WRAPPER_PACKAGE),
		version: z.literal(PINNED_CODEX_CLI_VERSION),
		optionalDependencies: z.record(z.string()),
	})
	.passthrough();

const platformPackageSchema = z
	.object({
		name: z.literal(CODEX_WRAPPER_PACKAGE),
		version: z.literal(CODEX_PLATFORM_PACKAGE_VERSION),
		os: z.tuple([z.literal("linux")]),
		cpu: z.tuple([z.literal("x64")]),
	})
	.passthrough();

export type CodexPackageJsonResolver = (packageName: string, parent: string | URL) => string;

export interface CodexArtifactResolutionOptions {
	readonly platform?: NodeJS.Platform;
	readonly arch?: string;
	/** Test seam. Production resolution remains anchored to this module and the wrapper package. */
	readonly resolvePackageJson?: CodexPackageJsonResolver;
}

/** Resolves only the owner-pinned Linux x64 Codex artifact shipped by the package graph. */
export async function resolvePinnedCodexLauncher(
	options: CodexArtifactResolutionOptions = {},
): Promise<PinnedCodexLauncher> {
	const platform = options.platform ?? process.platform;
	const arch = options.arch ?? process.arch;
	if (platform !== "linux" || arch !== "x64") {
		throw new Error(`Pinned Codex artifact supports only linux/x64; received ${platform}/${arch}`);
	}

	const resolvePackageJson = options.resolvePackageJson ?? resolveInstalledPackageJson;
	const wrapperPackageJson = await resolvePackageMetadataPath(
		resolvePackageJson,
		CODEX_WRAPPER_PACKAGE,
		import.meta.url,
		"wrapper",
	);
	const wrapperMetadata = wrapperPackageSchema.safeParse(
		await readPackageMetadata(wrapperPackageJson, "wrapper"),
	);
	if (!wrapperMetadata.success) {
		throw new Error("Pinned Codex wrapper package metadata is incompatible", {
			cause: wrapperMetadata.error,
		});
	}
	if (
		wrapperMetadata.data.optionalDependencies[CODEX_PLATFORM_PACKAGE] !==
		CODEX_PLATFORM_PACKAGE_ALIAS
	) {
		throw new Error("Pinned Codex wrapper optional dependency alias is incompatible");
	}

	const platformPackageJson = await resolvePackageMetadataPath(
		resolvePackageJson,
		CODEX_PLATFORM_PACKAGE,
		wrapperPackageJson,
		"Linux x64 platform",
	);
	const platformMetadata = platformPackageSchema.safeParse(
		await readPackageMetadata(platformPackageJson, "Linux x64 platform"),
	);
	if (!platformMetadata.success) {
		throw new Error("Pinned Codex Linux x64 package metadata is incompatible", {
			cause: platformMetadata.error,
		});
	}

	const packageRoot = dirname(platformPackageJson);
	const readRoot = await assertCanonicalPackagedPath(
		join(packageRoot, "vendor", CODEX_TARGET),
		"vendor root",
		"directory",
	);
	const executable = await assertCanonicalPackagedPath(
		join(readRoot, "bin", "codex"),
		"executable",
		"file",
	);
	const sandboxHelperExecutable = await assertCanonicalPackagedPath(
		join(readRoot, "codex-resources", "bwrap"),
		"sandbox helper",
		"file",
	);

	// These digests come from an independent extraction of the exact npm archive, not this install.
	return Object.freeze({
		executable,
		readRoot,
		sha256: PINNED_CODEX_CLI_SHA256,
		sandboxHelper: Object.freeze({
			executable: sandboxHelperExecutable,
			readRoot,
			sha256: PINNED_CODEX_BWRAP_SHA256,
		}),
	});
}

function resolveInstalledPackageJson(packageName: string, parent: string | URL): string {
	return createRequire(parent).resolve(`${packageName}/package.json`);
}

async function resolvePackageMetadataPath(
	resolvePackageJson: CodexPackageJsonResolver,
	packageName: string,
	parent: string | URL,
	label: string,
): Promise<string> {
	let resolved: string;
	try {
		resolved = resolvePackageJson(packageName, parent);
	} catch (error) {
		throw new Error(`Pinned Codex ${label} package is unavailable`, { cause: error });
	}
	return assertCanonicalPackagedPath(resolved, `${label} package metadata`, "file");
}

async function readPackageMetadata(path: string, label: string): Promise<unknown> {
	try {
		return JSON.parse(await readFile(path, "utf8"));
	} catch (error) {
		throw new Error(`Pinned Codex ${label} package metadata cannot be read`, { cause: error });
	}
}

async function assertCanonicalPackagedPath(
	path: string,
	label: string,
	kind: "file" | "directory",
): Promise<string> {
	let canonical: string;
	try {
		canonical = await realpath(path);
	} catch (error) {
		throw new Error(`Pinned Codex ${label} is unavailable at its fixed package path`, {
			cause: error,
		});
	}
	if (canonical !== path) {
		throw new Error(`Pinned Codex ${label} must use its canonical package path`);
	}
	const stats = await lstat(path);
	if (stats.isSymbolicLink() || (kind === "file" ? !stats.isFile() : !stats.isDirectory())) {
		throw new Error(`Pinned Codex ${label} has the wrong filesystem type`);
	}
	return canonical;
}
