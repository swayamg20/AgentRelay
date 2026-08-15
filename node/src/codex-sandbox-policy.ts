import { constants } from "node:fs";
import { type FileHandle, lstat, open, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, normalize, relative } from "node:path";
import {
	CODEX_SANDBOX_CONFIG_FILE,
	CODEX_SANDBOX_MANIFEST_FILE,
	CODEX_SANDBOX_PROFILE_NAME,
	type CodexSandboxContainmentInput,
	type ContainmentLayout,
	type ContainmentOpenMode,
} from "./codex-sandbox-contract.js";
import type { ContainmentProbeExecutable } from "./codex-sandbox-probe.js";
import { writeDurableTextExclusive } from "./durable-file.js";
import { assertPrivateStateDirectory, ensurePrivateStateDirectory } from "./private-state-file.js";

const SAFE_CHILD_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const MAX_CONFIG_BYTES = 128 * 1_024;
const AMBIENT_CODEX_CONFIG_PATHS = [
	"/etc/codex/config.toml",
	"/etc/codex/managed_config.toml",
	"/etc/codex/requirements.toml",
] as const;

// Codex's `:minimal` profile mounts these host trees, while Bubblewrap creates
// fresh /dev and /proc mounts. Denials below one of these visible roots need an
// explicit mask; all other unapproved host paths are absent from the tmpfs view.
const LINUX_VISIBLE_BASE_ROOTS = [
	"/bin",
	"/dev",
	"/etc",
	"/lib",
	"/lib64",
	"/nix/store",
	"/proc",
	"/run/current-system/sw",
	"/sbin",
	"/usr",
] as const;

export function assertSupportedLinuxContainment(): void {
	if (process.platform !== "linux") {
		throw new Error("Codex Bubblewrap containment is supported only on Linux");
	}
}

export function assertCodexSandboxInput(input: CodexSandboxContainmentInput): void {
	if ((input.readOnlyRoots?.length ?? 0) > 32 || (input.forbiddenRoots?.length ?? 0) > 32) {
		throw new Error("Containment supports at most 32 additional read or denied roots");
	}
	for (const digest of [
		input.launcher.sha256,
		input.launcher.sandboxHelper.sha256,
		input.provider.sha256,
		input.policyGrantSha256,
	]) {
		if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("Containment digests must use SHA-256");
	}
}

/** Prevents host-wide Codex layers from silently changing the pinned sandbox policy. */
export async function assertNoAmbientCodexConfiguration(
	paths: readonly string[] = AMBIENT_CODEX_CONFIG_PATHS,
): Promise<void> {
	for (const path of paths) {
		try {
			await lstat(path);
		} catch (error) {
			if (errorCode(error) === "ENOENT") continue;
			throw new Error(`Cannot inspect ambient Codex configuration at ${path}`, { cause: error });
		}
		throw new Error(`Ambient Codex configuration is unsupported: ${path}`);
	}
}

export async function prepareContainmentLayout(
	input: CodexSandboxContainmentInput,
	mode: ContainmentOpenMode,
): Promise<ContainmentLayout> {
	const prepareDirectory =
		mode === "create" ? ensurePrivateStateDirectory : assertPrivateStateDirectory;
	await prepareDirectory(input.controlDirectory);
	await prepareDirectory(input.runtimeDirectory);
	assertDisjoint(input.controlDirectory, input.runtimeDirectory, "control and runtime roots");
	assertDisjoint(input.controlDirectory, input.workspace.root, "control root and workspace");
	assertDisjoint(input.runtimeDirectory, input.workspace.root, "runtime root and workspace");

	const launcherHome = join(input.controlDirectory, "sandbox-launcher");
	const stagedProbeRoot = join(input.runtimeDirectory, "probe-runtime");
	const stagedProbeBin = join(stagedProbeRoot, "bin");
	const runtimeHome = join(input.runtimeDirectory, "codex-home");
	const runtimeTmp = join(input.runtimeDirectory, "tmp");
	await Promise.all([
		prepareDirectory(launcherHome),
		prepareDirectory(stagedProbeRoot),
		prepareDirectory(stagedProbeBin),
		prepareDirectory(runtimeHome),
		prepareDirectory(runtimeTmp),
	]);
	return {
		controlRoot: input.controlDirectory,
		launcherHome,
		launcherPath: join(launcherHome, CODEX_SANDBOX_CONFIG_FILE),
		stagedProbeRoot,
		stagedProbeExecutable: join(stagedProbeBin, "node"),
		runtimeRoot: input.runtimeDirectory,
		runtimeHome,
		runtimeTmp,
		manifestPath: join(input.controlDirectory, CODEX_SANDBOX_MANIFEST_FILE),
	};
}

export async function buildCodexSandboxConfig(
	input: CodexSandboxContainmentInput,
	layout: ContainmentLayout,
	probe: ContainmentProbeExecutable,
): Promise<string> {
	const readRoots = await canonicalContainmentRoots([
		input.launcher.readRoot,
		input.provider.readRoot,
		probe.readRoot,
		...(input.readOnlyRoots ?? []),
	]);
	const deniedRoots = await canonicalContainmentRoots([
		await realpath(homedir()),
		layout.controlRoot,
		...(input.forbiddenRoots ?? []),
	]);
	if (readRoots.some((readRoot) => deniedRoots.some((denied) => isPathWithin(denied, readRoot)))) {
		throw new Error("A readable root cannot contain a denied containment root");
	}
	const explicitDenyRoots = deniedRoots.filter((deniedRoot) =>
		[...LINUX_VISIBLE_BASE_ROOTS, input.workspace.root, layout.runtimeHome, layout.runtimeTmp].some(
			(visibleRoot) => isPathWithin(deniedRoot, visibleRoot),
		),
	);

	const filesystemEntries = new Map<string, "read" | "write" | "deny">();
	filesystemEntries.set(":minimal", "read");
	for (const path of explicitDenyRoots) filesystemEntries.set(path, "deny");
	for (const path of readRoots) filesystemEntries.set(path, "read");
	filesystemEntries.set(input.workspace.root, "write");
	filesystemEntries.set(input.workspace.gitDirectory, "read");
	filesystemEntries.set(layout.runtimeHome, "write");
	filesystemEntries.set(layout.runtimeTmp, "write");

	return [
		`default_permissions = ${tomlString(CODEX_SANDBOX_PROFILE_NAME)}`,
		"",
		"[features]",
		"use_legacy_landlock = false",
		"",
		`[projects.${tomlString(input.workspace.root)}]`,
		'trust_level = "untrusted"',
		"",
		"[shell_environment_policy]",
		'inherit = "none"',
		"ignore_default_excludes = false",
		"",
		"[shell_environment_policy.set]",
		`HOME = ${tomlString(layout.runtimeHome)}`,
		`CODEX_HOME = ${tomlString(layout.runtimeHome)}`,
		`TMPDIR = ${tomlString(layout.runtimeTmp)}`,
		`TMP = ${tomlString(layout.runtimeTmp)}`,
		`TEMP = ${tomlString(layout.runtimeTmp)}`,
		`PATH = ${tomlString(SAFE_CHILD_PATH)}`,
		'LANG = "C.UTF-8"',
		'LC_ALL = "C.UTF-8"',
		'TZ = "UTC"',
		"",
		`[permissions.${CODEX_SANDBOX_PROFILE_NAME}.filesystem]`,
		...[...filesystemEntries.entries()]
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([path, access]) => `${tomlString(path)} = ${tomlString(access)}`),
		"",
		`[permissions.${CODEX_SANDBOX_PROFILE_NAME}.network]`,
		"enabled = false",
		"",
	].join("\n");
}

export async function createPrivateContainmentConfig(
	path: string,
	expected: string,
): Promise<void> {
	await writeDurableTextExclusive(path, expected, { fileMode: 0o600, directoryMode: 0o700 });
}

export async function assertPrivateContainmentConfig(
	path: string,
	expected: string,
): Promise<void> {
	if ((await readPrivateContainmentConfig(path)) !== expected) {
		throw new Error("Containment launcher config changed after creation");
	}
}

export async function readPrivateContainmentConfig(path: string): Promise<string> {
	const handle: FileHandle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const stats = await handle.stat();
		if (!stats.isFile() || (stats.mode & 0o777) !== 0o600 || stats.size > MAX_CONFIG_BYTES) {
			throw new Error("Containment launcher config is not a private bounded file");
		}
		if (process.getuid !== undefined && stats.uid !== process.getuid()) {
			throw new Error("Containment launcher config is not owned by the current user");
		}
		return handle.readFile("utf8");
	} finally {
		await handle.close();
	}
}

export function assertAbsoluteNormalizedPath(path: string, label: string): void {
	if (!isAbsolute(path) || normalize(path) !== path || path.includes("\0")) {
		throw new Error(`${label} must be an absolute normalized path without NUL`);
	}
}

export function isPathWithin(path: string, root: string): boolean {
	const child = relative(root, path);
	return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

export async function canonicalContainmentRoots(paths: readonly string[]): Promise<string[]> {
	const roots = await Promise.all(
		paths.map(async (path) => {
			assertAbsoluteNormalizedPath(path, "containment root");
			const canonical = await realpath(path);
			if (canonical !== path) throw new Error("Containment roots must use canonical paths");
			return canonical;
		}),
	);
	return [...new Set(roots)].sort();
}

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? String(error.code)
		: undefined;
}

function assertDisjoint(left: string, right: string, label: string): void {
	if (isPathWithin(left, right) || isPathWithin(right, left)) {
		throw new Error(`Containment requires disjoint ${label}`);
	}
}

function tomlString(value: string): string {
	return JSON.stringify(value);
}
