import { execFile, spawn } from "node:child_process";
import {
	appendFile,
	chmod,
	copyFile,
	mkdir,
	mkdtemp,
	readFile,
	readlink,
	realpath,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { resolvePinnedCodex, sha256File } from "../test-support/pinned-codex.js";
import { CodexAppServerClient } from "./codex-app-server-client.js";
import {
	prepareCodexSandboxContainment,
	recoverCodexSandboxContainment,
} from "./codex-sandbox-containment.js";
import { prepareMissionWorkspace } from "./mission-workspace.js";

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];
const REPOSITORY_URL = "https://github.com/example/contained.git";
const PROCESS_TIMEOUT_MS = 20_000;
const MAX_PROCESS_OUTPUT_BYTES = 1_048_576;

afterAll(async () => {
	await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true })));
});

describe.runIf(
	process.platform === "linux" && process.env.AGENTRELAY_RUN_CONTAINMENT_TESTS === "1",
)("Codex Bubblewrap containment", () => {
	it("allows only the bound workspace, read roots, and private runtime directories", async () => {
		const fixture = await createFixture();
		const launcher = await resolvePinnedCodex();
		const provider = {
			executable: fixture.providerExecutable,
			readRoot: fixture.providerRoot,
			sha256: await sha256File(fixture.providerExecutable),
		};
		const input = {
			controlDirectory: fixture.control,
			runtimeDirectory: fixture.runtime,
			workspace: fixture.workspace,
			launcher,
			provider,
			readOnlyRoots: [fixture.readOnly, dirname(fixture.probe)],
			forbiddenRoots: [fixture.sibling, fixture.ownerHome],
			policyGrantSha256: "a".repeat(64),
		};
		const containment = await prepareCodexSandboxContainment(input);
		const parentNetworkNamespace = await readlink("/proc/self/ns/net");
		const paths = {
			workspaceFile: join(fixture.workspace.root, "tracked.txt"),
			workspaceWrite: join(fixture.workspace.root, "created.txt"),
			gitMetadataWrite: join(fixture.workspace.gitDirectory, "blocked.txt"),
			readRootFile: join(fixture.readOnly, "allowed.txt"),
			readRootWrite: join(fixture.readOnly, "blocked.txt"),
			siblingSecret: join(fixture.sibling, "secret.txt"),
			siblingWrite: join(fixture.sibling, "created.txt"),
			sharedTempSecret: join(fixture.sharedTemp, "secret.txt"),
			sshSecret: join(fixture.ownerHome, ".ssh", "id_test"),
			awsSecret: join(fixture.ownerHome, ".aws", "credentials"),
			azureSecret: join(fixture.ownerHome, ".azure", "accessTokens.json"),
			controlSecret: join(fixture.control, "node-token.txt"),
			launcherConfig: join(fixture.control, "sandbox-launcher", "config.toml"),
			symlinkEscape: join(fixture.workspace.root, "sibling-link"),
			traversalEscape: join(fixture.workspace.root, "..", "sibling", "secret.txt"),
			runtimeHomeWrite: join(containment.runtimeHome, "state.txt"),
			runtimeTmpWrite: join(containment.runtimeTmp, "scratch.txt"),
		};
		const prepared = await containment.boundary.prepare({
			executable: provider.executable,
			argv: [fixture.probe, JSON.stringify(paths)],
			cwd: fixture.workspace.root,
			env: {
				HOME: containment.runtimeHome,
				CODEX_HOME: containment.runtimeHome,
				AGENTRELAY_NODE_TOKEN: "must-not-cross",
			},
		});
		const output = await run(prepared);
		const result = JSON.parse(output.stdout) as Record<string, unknown>;

		expect(output.stderr).not.toContain("must-not-cross");
		expect(result).toMatchObject({
			workspaceRead: true,
			workspaceWrite: true,
			gitMetadataWrite: false,
			readRootRead: true,
			readRootWrite: false,
			siblingRead: false,
			grandchildSiblingRead: false,
			siblingWrite: false,
			sharedTempRead: false,
			sshRead: false,
			awsRead: false,
			azureRead: false,
			controlRead: false,
			launcherConfigRead: false,
			symlinkRead: false,
			traversalRead: false,
			runtimeHomeWrite: true,
			runtimeTmpWrite: true,
			environmentSecretPresent: false,
			home: containment.runtimeHome,
			codexHome: containment.runtimeHome,
			tmpdir: containment.runtimeTmp,
			networkConnect: false,
		});
		expect(result.networkNamespace).not.toBe(parentNetworkNamespace);
		await expect(readFile(paths.siblingWrite, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
		expect(JSON.stringify(containment.evidence)).not.toContain(fixture.root);

		const recoveryExpectation = containment.recovery;
		const recovered = await recoverCodexSandboxContainment(recoveryExpectation);
		expect(recovered.evidence).toEqual(containment.evidence);
		const freshRecovery = await execFileAsync(
			process.execPath,
			["--import", "tsx/esm", fixture.recoveryHelper, JSON.stringify(recoveryExpectation)],
			{
				cwd: process.cwd(),
				env: process.env,
				encoding: "utf8",
				timeout: PROCESS_TIMEOUT_MS,
				maxBuffer: MAX_PROCESS_OUTPUT_BYTES,
			},
		);
		expect(JSON.parse(freshRecovery.stdout)).toEqual(containment.evidence);

		await appendFile(paths.launcherConfig, "# changed after launch\n");
		await expect(
			containment.boundary.prepare({
				executable: provider.executable,
				argv: [fixture.probe, JSON.stringify(paths)],
				cwd: fixture.workspace.root,
				env: { HOME: containment.runtimeHome, CODEX_HOME: containment.runtimeHome },
			}),
		).rejects.toThrow("authorize this exact workspace and policy");
	}, 60_000);

	it("starts the pinned Codex version probe and app-server inside the real boundary", async () => {
		const fixture = await createFixture();
		const launcher = await resolvePinnedCodex();
		const containment = await prepareCodexSandboxContainment({
			controlDirectory: fixture.control,
			runtimeDirectory: fixture.runtime,
			workspace: fixture.workspace,
			launcher,
			provider: launcher,
			forbiddenRoots: [fixture.sibling, fixture.ownerHome],
			policyGrantSha256: "b".repeat(64),
		});

		const client = await CodexAppServerClient.start({
			command: { executable: launcher.executable },
			cwd: fixture.workspace.root,
			capsuleDirectory: fixture.runtime,
			env: {},
			boundary: containment.boundary,
			requestTimeoutMs: PROCESS_TIMEOUT_MS,
		});
		await client.close();
	}, 60_000);
});

async function createFixture() {
	const root = await realpath(await mkdtemp(join(process.cwd(), ".agentrelay-containment-")));
	temporaryRoots.push(root);
	const repository = join(root, "workspace");
	const readOnly = join(root, "read-only");
	const sibling = join(root, "sibling");
	const ownerHome = join(root, "owner-home");
	const control = join(root, "control");
	const runtime = join(root, "runtime");
	const providerRoot = join(root, "provider-runtime");
	const providerExecutable = join(providerRoot, "node");
	const sharedTemp = await realpath(await mkdtemp(join(tmpdir(), "agentrelay-shared-temp-")));
	temporaryRoots.push(sharedTemp);
	await Promise.all([
		mkdir(repository),
		mkdir(readOnly),
		mkdir(sibling),
		mkdir(join(ownerHome, ".ssh"), { recursive: true }),
		mkdir(join(ownerHome, ".aws"), { recursive: true }),
		mkdir(join(ownerHome, ".azure"), { recursive: true }),
		mkdir(control, { mode: 0o700 }),
		mkdir(providerRoot, { mode: 0o700 }),
	]);
	await copyFile(await realpath(process.execPath), providerExecutable);
	await chmod(providerExecutable, 0o500);
	await Promise.all([
		writeFile(join(readOnly, "allowed.txt"), "approved\n"),
		writeFile(join(sibling, "secret.txt"), "sibling-canary\n"),
		writeFile(join(sharedTemp, "secret.txt"), "shared-temp-canary\n"),
		writeFile(join(ownerHome, ".ssh", "id_test"), "ssh-canary\n"),
		writeFile(join(ownerHome, ".aws", "credentials"), "aws-canary\n"),
		writeFile(join(ownerHome, ".azure", "accessTokens.json"), "azure-canary\n"),
		writeFile(join(control, "node-token.txt"), "node-token-canary\n", { mode: 0o600 }),
	]);
	await symlink(join(sibling, "secret.txt"), join(repository, "sibling-link"));
	await git(repository, ["init", "--initial-branch=main", "."]);
	await git(repository, ["config", "user.name", "AgentRelay Test"]);
	await git(repository, ["config", "user.email", "test@agentrelay.dev"]);
	await git(repository, ["remote", "add", "origin", REPOSITORY_URL]);
	await writeFile(join(repository, "tracked.txt"), "base\n");
	await git(repository, ["add", "tracked.txt", "sibling-link"]);
	await git(repository, ["commit", "-m", "fixture"]);
	const baseCommit = (await git(repository, ["rev-parse", "HEAD"])).trim();
	const workspace = await prepareMissionWorkspace(
		{
			path: repository,
			repository_url: REPOSITORY_URL,
			allowed_base_refs: ["refs/heads/main"],
			policy_profile: "restricted",
		},
		{ repository_url: REPOSITORY_URL, expected_base_commit: baseCommit },
	);
	const probe = await realpath(
		join(dirname(fileURLToPath(import.meta.url)), "../test-support/runtime-containment-probe.mjs"),
	);
	const recoveryHelper = await realpath(
		join(
			dirname(fileURLToPath(import.meta.url)),
			"../test-support/runtime-containment-recovery.ts",
		),
	);
	return {
		root,
		workspace,
		readOnly,
		sibling,
		ownerHome,
		control,
		runtime,
		providerRoot,
		providerExecutable,
		sharedTemp,
		probe,
		recoveryHelper,
	};
}

async function git(cwd: string, argv: readonly string[]): Promise<string> {
	const result = await execFileAsync("git", [...argv], {
		cwd,
		encoding: "utf8",
		env: {
			PATH: process.env.PATH,
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_CONFIG_SYSTEM: "/dev/null",
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_TERMINAL_PROMPT: "0",
		},
	});
	return result.stdout;
}

async function run(processSpec: {
	readonly executable: string;
	readonly argv: readonly string[];
	readonly cwd: string;
	readonly env: NodeJS.ProcessEnv;
}): Promise<{ stdout: string; stderr: string }> {
	const child = spawn(processSpec.executable, [...processSpec.argv], {
		cwd: processSpec.cwd,
		detached: true,
		env: { ...processSpec.env },
		stdio: ["ignore", "pipe", "pipe"],
		shell: false,
	});
	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => {
		stdout += chunk;
		if (Buffer.byteLength(stdout, "utf8") > MAX_PROCESS_OUTPUT_BYTES) {
			killProcessGroup(child.pid);
		}
	});
	child.stderr.on("data", (chunk: string) => {
		stderr += chunk;
		if (Buffer.byteLength(stderr, "utf8") > MAX_PROCESS_OUTPUT_BYTES) {
			killProcessGroup(child.pid);
		}
	});
	let timedOut = false;
	const timeout = setTimeout(() => {
		timedOut = true;
		killProcessGroup(child.pid);
	}, PROCESS_TIMEOUT_MS);
	const status = await new Promise<number | null>((resolve, reject) => {
		child.once("error", reject);
		child.once("close", resolve);
	}).finally(() => clearTimeout(timeout));
	if (timedOut) throw new Error("Contained probe timed out");
	if (
		Buffer.byteLength(stdout, "utf8") > MAX_PROCESS_OUTPUT_BYTES ||
		Buffer.byteLength(stderr, "utf8") > MAX_PROCESS_OUTPUT_BYTES
	) {
		throw new Error("Contained probe exceeded its output limit");
	}
	if (status !== 0) throw new Error(`Contained probe failed (${status}): ${stderr}`);
	return { stdout, stderr };
}

function killProcessGroup(pid: number | undefined): void {
	if (pid === undefined) return;
	try {
		process.kill(-pid, "SIGKILL");
	} catch (error) {
		if (
			typeof error !== "object" ||
			error === null ||
			!("code" in error) ||
			error.code !== "ESRCH"
		) {
			throw error;
		}
	}
}
