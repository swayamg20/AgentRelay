import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, lstat, open, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, normalize, relative } from "node:path";
import type { CodexProcessBoundary, CodexProcessRequest } from "./codex-process-boundary.js";
import { writeDurableText } from "./durable-file.js";
import {
	type LocalFilesystemIdentity,
	type PreparedMissionWorkspace,
	revalidateMissionWorkspaceIsolation,
} from "./mission-workspace.js";
import { ensurePrivateStateDirectory } from "./private-state-file.js";
import {
	type RuntimeContainmentBinding,
	type RuntimeContainmentEvidence,
	boundPath,
	containmentEvidence,
	openRuntimeContainmentManifest,
	workspaceBinding,
} from "./runtime-containment-manifest.js";

const PROFILE_NAME = "agentrelay-runtime";
const RUNTIME_VERSION = "0.146.0";
const CONFIG_FILE = "config.toml";
const MANIFEST_FILE = "containment.json";
const SAFE_CHILD_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const MAX_CONFIG_BYTES = 128 * 1_024;

export interface PinnedExecutable {
	readonly executable: string;
	readonly readRoot: string;
	readonly sha256: string;
}

export interface CodexSandboxContainmentInput {
	readonly controlDirectory: string;
	readonly runtimeDirectory: string;
	readonly workspace: PreparedMissionWorkspace;
	readonly launcher: PinnedExecutable;
	readonly provider: PinnedExecutable;
	readonly readOnlyRoots?: readonly string[];
	readonly forbiddenRoots?: readonly string[];
	readonly policyGrantSha256: string;
}

export interface CodexSandboxContainment {
	readonly boundary: CodexProcessBoundary;
	readonly evidence: RuntimeContainmentEvidence;
	readonly runtimeHome: string;
	readonly runtimeTmp: string;
}

interface ContainmentLayout {
	readonly controlRoot: string;
	readonly launcherHome: string;
	readonly launcherPath: string;
	readonly runtimeRoot: string;
	readonly runtimeHome: string;
	readonly runtimeTmp: string;
	readonly manifestPath: string;
}

export async function prepareCodexSandboxContainment(
	input: CodexSandboxContainmentInput,
): Promise<CodexSandboxContainment> {
	assertSupportedPlatform();
	assertInputBounds(input);
	const layout = await prepareLayout(input);
	const config = await buildLauncherConfig(input, layout);
	await openOrCreatePrivateConfig(layout.launcherPath, config);
	const binding = await buildBinding(input, layout, config);
	const manifest = await openRuntimeContainmentManifest(layout.manifestPath, binding);

	return Object.freeze({
		boundary: new PinnedCodexSandboxBoundary(input, layout),
		evidence: containmentEvidence(manifest),
		runtimeHome: layout.runtimeHome,
		runtimeTmp: layout.runtimeTmp,
	});
}

function assertInputBounds(input: CodexSandboxContainmentInput): void {
	if ((input.readOnlyRoots?.length ?? 0) > 32 || (input.forbiddenRoots?.length ?? 0) > 32) {
		throw new Error("Containment supports at most 32 additional read or denied roots");
	}
	for (const digest of [input.launcher.sha256, input.provider.sha256, input.policyGrantSha256]) {
		if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("Containment digests must use SHA-256");
	}
}

class PinnedCodexSandboxBoundary implements CodexProcessBoundary {
	constructor(
		private readonly input: CodexSandboxContainmentInput,
		private readonly layout: ContainmentLayout,
	) {}

	async prepare(request: CodexProcessRequest) {
		assertSupportedPlatform();
		assertProcessRequest(request, this.input, this.layout);
		const config = await readPrivateConfig(this.layout.launcherPath);
		if (config === null) throw new Error("Containment launcher config is missing");
		const binding = await buildBinding(this.input, this.layout, config);
		await openRuntimeContainmentManifest(this.layout.manifestPath, binding);
		return {
			executable: this.input.launcher.executable,
			argv: [
				"sandbox",
				"--permission-profile",
				PROFILE_NAME,
				"--cd",
				this.input.workspace.root,
				"--",
				request.executable,
				...request.argv,
			],
			cwd: this.input.workspace.root,
			env: {
				HOME: this.layout.launcherHome,
				CODEX_HOME: this.layout.launcherHome,
				PATH: join(this.layout.launcherHome, "empty-path"),
			},
		};
	}
}

async function prepareLayout(input: CodexSandboxContainmentInput): Promise<ContainmentLayout> {
	await ensurePrivateStateDirectory(input.controlDirectory);
	await ensurePrivateStateDirectory(input.runtimeDirectory);
	assertDisjoint(input.controlDirectory, input.runtimeDirectory, "control and runtime roots");
	assertDisjoint(input.controlDirectory, input.workspace.root, "control root and workspace");
	assertDisjoint(input.runtimeDirectory, input.workspace.root, "runtime root and workspace");

	const launcherHome = join(input.controlDirectory, "sandbox-launcher");
	const runtimeHome = join(input.runtimeDirectory, "codex-home");
	const runtimeTmp = join(input.runtimeDirectory, "tmp");
	await Promise.all([
		ensurePrivateStateDirectory(launcherHome),
		ensurePrivateStateDirectory(join(launcherHome, "empty-path")),
		ensurePrivateStateDirectory(runtimeHome),
		ensurePrivateStateDirectory(runtimeTmp),
	]);
	return {
		controlRoot: input.controlDirectory,
		launcherHome,
		launcherPath: join(launcherHome, CONFIG_FILE),
		runtimeRoot: input.runtimeDirectory,
		runtimeHome,
		runtimeTmp,
		manifestPath: join(input.controlDirectory, MANIFEST_FILE),
	};
}

async function buildLauncherConfig(
	input: CodexSandboxContainmentInput,
	layout: ContainmentLayout,
): Promise<string> {
	const readRoots = await canonicalRoots([
		input.launcher.readRoot,
		input.provider.readRoot,
		...(input.readOnlyRoots ?? []),
	]);
	const deniedRoots = await canonicalRoots([
		await realpath(homedir()),
		layout.controlRoot,
		...(input.forbiddenRoots ?? []),
	]);
	assertReadRootsDoNotContainDeniedRoots(readRoots, deniedRoots);

	const filesystemEntries = new Map<string, "read" | "write" | "deny">();
	filesystemEntries.set(":minimal", "read");
	for (const path of deniedRoots) filesystemEntries.set(path, "deny");
	for (const path of readRoots) filesystemEntries.set(path, "read");
	filesystemEntries.set(input.workspace.root, "write");
	filesystemEntries.set(input.workspace.gitDirectory, "read");
	filesystemEntries.set(layout.runtimeHome, "write");
	filesystemEntries.set(layout.runtimeTmp, "write");

	const lines = [
		`default_permissions = ${tomlString(PROFILE_NAME)}`,
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
		`[permissions.${PROFILE_NAME}.filesystem]`,
		...[...filesystemEntries.entries()]
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([path, access]) => `${tomlString(path)} = ${tomlString(access)}`),
		"",
		`[permissions.${PROFILE_NAME}.network]`,
		"enabled = false",
		"",
	];
	return lines.join("\n");
}

async function buildBinding(
	input: CodexSandboxContainmentInput,
	layout: ContainmentLayout,
	config: string,
): Promise<RuntimeContainmentBinding> {
	const [workspace, launcher, provider, privatePaths, readOnlyRoots, deniedRoots] =
		await Promise.all([
			inspectWorkspace(input.workspace),
			inspectExecutable(input.launcher),
			inspectExecutable(input.provider),
			inspectPrivatePaths(layout),
			inspectRoots(input.readOnlyRoots ?? []),
			inspectRoots([
				await realpath(homedir()),
				layout.controlRoot,
				...(input.forbiddenRoots ?? []),
			]),
		]);
	return {
		backend: "codex_bubblewrap_0_146",
		runtime_version: RUNTIME_VERSION,
		workspace,
		launcher: {
			executable: launcher.executable,
			executable_sha256: input.launcher.sha256,
			read_root: launcher.readRoot,
			config_path: layout.launcherPath,
			config_sha256: sha256(config),
		},
		provider: {
			executable: provider.executable,
			executable_sha256: input.provider.sha256,
			read_root: provider.readRoot,
		},
		private_paths: privatePaths,
		read_only_roots: readOnlyRoots,
		denied_roots: deniedRoots,
		policy_grant_sha256: input.policyGrantSha256,
	};
}

async function inspectWorkspace(workspace: PreparedMissionWorkspace) {
	await revalidateMissionWorkspaceIsolation(workspace);
	const [root, gitDirectory] = await Promise.all([
		inspectPath(workspace.root, "workspace root", false),
		inspectPath(workspace.gitDirectory, "workspace Git directory", false),
	]);
	if (
		root.identity.device !== workspace.rootIdentity.device ||
		root.identity.inode !== workspace.rootIdentity.inode ||
		gitDirectory.identity.device !== workspace.gitIdentity.device ||
		gitDirectory.identity.inode !== workspace.gitIdentity.inode
	) {
		throw new Error("Mission workspace identity changed after preflight");
	}
	return { ...workspaceBinding(workspace), root, git_directory: gitDirectory };
}

async function inspectExecutable(executable: PinnedExecutable) {
	const executablePath = await inspectPath(executable.executable, "executable", true);
	const readRoot = await inspectPath(executable.readRoot, "executable read root", false);
	if (!isWithin(executablePath.path, readRoot.path)) {
		throw new Error("Pinned executable must be contained by its approved read root");
	}
	if ((await sha256File(executablePath.path)) !== executable.sha256) {
		throw new Error("Pinned executable digest does not match the owner-approved value");
	}
	return { executable: executablePath, readRoot };
}

async function inspectPrivatePaths(layout: ContainmentLayout) {
	const [controlRoot, launcherHome, runtimeRoot, runtimeHome, runtimeTmp] = await Promise.all([
		inspectPath(layout.controlRoot, "control root", false),
		inspectPath(layout.launcherHome, "launcher home", false),
		inspectPath(layout.runtimeRoot, "runtime root", false),
		inspectPath(layout.runtimeHome, "runtime home", false),
		inspectPath(layout.runtimeTmp, "runtime tmp", false),
	]);
	return {
		control_root: controlRoot,
		launcher_home: launcherHome,
		runtime_root: runtimeRoot,
		runtime_home: runtimeHome,
		runtime_tmp: runtimeTmp,
	};
}

async function inspectRoots(paths: readonly string[]) {
	const roots = await canonicalRoots(paths);
	return Promise.all(roots.map((path) => inspectPath(path, "containment root", false)));
}

async function inspectPath(path: string, label: string, requireFile: boolean) {
	assertAbsoluteNormalized(path, label);
	const canonical = await realpath(path);
	if (canonical !== path) throw new Error(`${label} must use its canonical path`);
	const stats = await lstat(path, { bigint: true });
	if (stats.isSymbolicLink() || (requireFile ? !stats.isFile() : !stats.isDirectory())) {
		throw new Error(`${label} has the wrong filesystem type`);
	}
	if ((stats.mode & 0o22n) !== 0n) throw new Error(`${label} cannot be group- or world-writable`);
	const currentUid = process.getuid?.();
	if (currentUid !== undefined && stats.uid !== 0n && stats.uid !== BigInt(currentUid)) {
		throw new Error(`${label} must be owned by root or the current user`);
	}
	const identity: LocalFilesystemIdentity = {
		device: stats.dev.toString(),
		inode: stats.ino.toString(),
	};
	return boundPath(path, identity);
}

async function canonicalRoots(paths: readonly string[]): Promise<string[]> {
	const roots = await Promise.all(
		paths.map(async (path) => {
			assertAbsoluteNormalized(path, "containment root");
			const canonical = await realpath(path);
			if (canonical !== path) throw new Error("Containment roots must use canonical paths");
			return canonical;
		}),
	);
	return [...new Set(roots)].sort();
}

function assertProcessRequest(
	request: CodexProcessRequest,
	input: CodexSandboxContainmentInput,
	layout: ContainmentLayout,
): void {
	if (request.executable !== input.provider.executable || request.cwd !== input.workspace.root) {
		throw new Error("Containment request does not match its pinned provider workspace");
	}
	if (request.env.HOME !== layout.runtimeHome || request.env.CODEX_HOME !== layout.runtimeHome) {
		throw new Error("Containment request does not use the private runtime home");
	}
}

function assertReadRootsDoNotContainDeniedRoots(
	readRoots: readonly string[],
	deniedRoots: readonly string[],
): void {
	if (readRoots.some((readRoot) => deniedRoots.some((denied) => isWithin(denied, readRoot)))) {
		throw new Error("A readable root cannot contain a denied containment root");
	}
}

function assertDisjoint(left: string, right: string, label: string): void {
	if (isWithin(left, right) || isWithin(right, left)) {
		throw new Error(`Containment requires disjoint ${label}`);
	}
}

function isWithin(path: string, root: string): boolean {
	const child = relative(root, path);
	return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

function assertAbsoluteNormalized(path: string, label: string): void {
	if (!isAbsolute(path) || normalize(path) !== path || path.includes("\0")) {
		throw new Error(`${label} must be an absolute normalized path without NUL`);
	}
}

async function openOrCreatePrivateConfig(path: string, expected: string): Promise<void> {
	const existing = await readPrivateConfig(path, true);
	if (existing === null) {
		await writeDurableText(path, expected, { fileMode: 0o600, directoryMode: 0o700 });
		return;
	}
	if (existing !== expected) throw new Error("Containment launcher config changed after creation");
}

async function readPrivateConfig(path: string, allowMissing = false): Promise<string | null> {
	let handle: FileHandle;
	try {
		handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	} catch (error) {
		if (allowMissing && errorCode(error) === "ENOENT") return null;
		throw error;
	}
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

async function sha256File(path: string): Promise<string> {
	const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const hash = createHash("sha256");
		for await (const chunk of handle.createReadStream()) hash.update(chunk);
		return hash.digest("hex");
	} finally {
		await handle.close();
	}
}

function sha256(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

function tomlString(value: string): string {
	return JSON.stringify(value);
}

function assertSupportedPlatform(): void {
	if (process.platform !== "linux") {
		throw new Error("Codex Bubblewrap containment is supported only on Linux");
	}
}

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? String(error.code)
		: undefined;
}
