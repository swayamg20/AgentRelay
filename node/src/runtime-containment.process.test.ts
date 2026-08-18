import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
	appendFile,
	chmod,
	copyFile,
	mkdir,
	mkdtemp,
	open,
	readFile,
	readlink,
	realpath,
	rm,
	symlink,
	unlink,
	writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, describe, expect, it, vi } from "vitest";
import { resolvePinnedCodex, sha256File } from "../test-support/pinned-codex.js";
import { SupervisedCodexProviderGuardian } from "./codex-provider-guardian.js";
import {
	prepareCodexSandboxContainment,
	recoverCodexSandboxContainment,
} from "./codex-sandbox-containment.js";
import { prepareMissionWorkspace } from "./mission-workspace.js";
import {
	LocalReferenceMonitor,
	type RuntimeAuthorityEvidence,
	type RuntimeCapability,
	compileRuntimeAuthorityGrant,
	runtimeAuthorityRequest,
} from "./runtime-authority.js";
import {
	createRuntimeContainmentManifest,
	readRuntimeContainmentManifest,
} from "./runtime-containment-manifest.js";

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];
const REPOSITORY_URL = "https://github.com/example/contained.git";
const PROCESS_TIMEOUT_MS = 20_000;
const MAX_PROCESS_OUTPUT_BYTES = 1_048_576;
const MAX_PROBE_RESULT_BYTES = 64 * 1_024;

afterAll(async () => {
	await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true })));
});

describe.runIf(
	process.platform === "linux" && process.env.AGENTRELAY_RUN_CONTAINMENT_TESTS === "1",
)("Codex Bubblewrap containment", () => {
	it.each([
		["write", true],
		["read", false],
	] as const)(
		"allows only the %s-bound workspace, read roots, and private runtime directories",
		async (workspaceAccess, workspaceWrite) => {
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
				workspaceAccess,
			};
			const containment = await prepareCodexSandboxContainment(input);
			expect(containment.authorization.workspaceAccess).toBe(workspaceAccess);
			const parentNetworkNamespace = await readlink("/proc/self/ns/net");
			const resultPath = join(containment.runtimeTmp, `.agentrelay-${randomUUID()}.result`);
			const resultToken = randomUUID();
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
				resultPath,
				resultToken,
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
			let result: Record<string, unknown>;
			try {
				const output = await run(prepared);
				expect(output).toEqual({ stdout: "", stderr: "" });
				result = await readContainedProbeResult(resultPath, resultToken);
			} finally {
				await unlink(resultPath).catch(() => undefined);
			}

			expect(result).toMatchObject({
				workspaceRead: true,
				workspaceWrite,
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
			expect(recovered.authorization.workspaceAccess).toBe(workspaceAccess);
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
		},
		60_000,
	);

	it("keeps pinned Codex alive while the parent guardian rejects unauthorized effects", async () => {
		const fixture = await createFixture();
		const launcher = await resolvePinnedCodex();
		const deadlineAtMs = Date.now() + 55_000;
		const grant = liveRuntimeAuthorityGrant(deadlineAtMs);
		const authorityEvidence: RuntimeAuthorityEvidence[] = [];
		const authority = new LocalReferenceMonitor(grant, {
			record: (evidence) => authorityEvidence.push(evidence),
		});
		const containment = await prepareCodexSandboxContainment({
			controlDirectory: fixture.control,
			runtimeDirectory: fixture.runtime,
			workspace: fixture.workspace,
			launcher,
			provider: launcher,
			forbiddenRoots: [fixture.sibling, fixture.ownerHome],
			policyGrantSha256: "b".repeat(64),
			workspaceAccess: "read",
		});
		expect(containment.authorization.workspaceAccess).toBe("read");

		const generation = await new SupervisedCodexProviderGuardian({
			capsuleId: randomUUID(),
			command: { executable: launcher.executable },
			cwd: fixture.workspace.root,
			capsuleDirectory: fixture.runtime,
			env: {},
			boundary: containment.boundary,
			deadlineAtMs,
			authoritySignal: authority.signal,
			requestTimeoutMs: PROCESS_TIMEOUT_MS,
			supervisor: {
				executable: process.execPath,
				args: [
					"--import",
					createRequire(import.meta.url).resolve("tsx"),
					fileURLToPath(new URL("./bin/agentrelay-codex-guardian.ts", import.meta.url)),
				],
			},
		}).openGeneration();
		try {
			for (const capability of PRODUCT_DENIED_CAPABILITIES) {
				const effect = vi.fn();
				await expect(
					authority.perform(runtimeAuthorityRequest(grant, capability), effect),
				).rejects.toMatchObject({ code: "product_denied" });
				expect(effect).not.toHaveBeenCalled();
			}

			const wrongWorkspaceEffect = vi.fn();
			await expect(
				authority.perform(
					{
						...runtimeAuthorityRequest(grant, {
							action: "workspace_read",
							resource: "workspace",
						}),
						workspace_alias: "peer-workspace",
					},
					wrongWorkspaceEffect,
				),
			).rejects.toMatchObject({ code: "wrong_workspace" });
			expect(wrongWorkspaceEffect).not.toHaveBeenCalled();

			authority.revoke("revoked");
			const delayedOutputEffect = vi.fn();
			await expect(
				authority.perform(
					runtimeAuthorityRequest(
						grant,
						{ action: "outbound_publish", resource: "relay" },
						{ output_bytes: 1 },
					),
					delayedOutputEffect,
				),
			).rejects.toMatchObject({ code: "revoked" });
			expect(delayedOutputEffect).not.toHaveBeenCalled();
			await generation.termination;

			expect(JSON.stringify(authorityEvidence)).not.toContain(fixture.root);
			expect(JSON.stringify(authorityEvidence)).not.toContain("peer-workspace");
			expect(authorityEvidence.at(-1)).toMatchObject({
				decision: "deny",
				code: "revoked",
				action: "outbound_publish",
			});
		} finally {
			authority.revoke("revoked");
			await generation.terminate("capsule_shutdown").catch(() => undefined);
		}
	}, 60_000);

	it("recovers the exact legacy write-mode binding without adding workspace_access", async () => {
		const fixture = await createFixture();
		const launcher = await resolvePinnedCodex();
		const provider = {
			executable: fixture.providerExecutable,
			readRoot: fixture.providerRoot,
			sha256: await sha256File(fixture.providerExecutable),
		};
		const current = await prepareCodexSandboxContainment({
			controlDirectory: fixture.control,
			runtimeDirectory: fixture.runtime,
			workspace: fixture.workspace,
			launcher,
			provider,
			forbiddenRoots: [fixture.sibling, fixture.ownerHome],
			policyGrantSha256: "c".repeat(64),
			workspaceAccess: "write",
		});
		const currentManifest = await readRuntimeContainmentManifest(current.recovery.manifestPath);
		const legacyBinding = { ...currentManifest.binding };
		delete legacyBinding.workspace_access;
		await unlink(current.recovery.manifestPath);
		const legacyManifest = await createRuntimeContainmentManifest(
			current.recovery.manifestPath,
			legacyBinding,
		);
		const retainedManifest = await readFile(current.recovery.manifestPath, "utf8");
		const recovery = {
			manifestPath: current.recovery.manifestPath,
			instanceId: legacyManifest.instance_id,
			bindingSha256: legacyManifest.binding_sha256,
		};

		expect("workspace_access" in legacyManifest.binding).toBe(false);
		expect(retainedManifest).not.toContain("workspace_access");
		expect(legacyManifest.binding_sha256).not.toBe(currentManifest.binding_sha256);
		const recovered = await recoverCodexSandboxContainment(recovery);
		expect(recovered.authorization.workspaceAccess).toBe("write");
		expect(recovered.recovery).toEqual(recovery);
		expect(recovered.evidence.bindingSha256).toBe(legacyManifest.binding_sha256);

		const workspaceWrite = join(fixture.workspace.root, "legacy-recovery-write.txt");
		const prepared = await recovered.boundary.prepare({
			executable: provider.executable,
			argv: [
				"-e",
				"require('node:fs').writeFileSync(process.argv[1], 'legacy-write\\n')",
				workspaceWrite,
			],
			cwd: fixture.workspace.root,
			env: { HOME: recovered.runtimeHome, CODEX_HOME: recovered.runtimeHome },
		});
		expect(await run(prepared)).toEqual({ stdout: "", stderr: "" });
		expect(await readFile(workspaceWrite, "utf8")).toBe("legacy-write\n");
		expect(await readFile(current.recovery.manifestPath, "utf8")).toBe(retainedManifest);
	}, 60_000);
});

const PRODUCT_DENIED_CAPABILITIES = [
	{ action: "repository_push", resource: "repository" },
	{ action: "repository_merge", resource: "repository" },
	{ action: "package_publish", resource: "package" },
	{ action: "deploy", resource: "deployment" },
	{ action: "network_access", resource: "network" },
	{ action: "secret_read", resource: "secret" },
	{ action: "privilege_expand", resource: "privilege" },
] as const satisfies readonly RuntimeCapability[];

function liveRuntimeAuthorityGrant(deadlineAtMs: number) {
	const limits = {
		turn_ms: 55_000,
		reported_tokens: 10_000,
		output_bytes: 32_000,
		artifact_count: 8,
		artifact_bytes: 1_000_000,
		artifact_types: ["patch"],
	};
	return compileRuntimeAuthorityGrant({
		schema_version: 1,
		product_policy_version: 1,
		grant_id: randomUUID(),
		agent_id: randomUUID(),
		node_id: randomUUID(),
		workspace_binding_id: randomUUID(),
		workspace_alias: "contained-workspace",
		workspace_resource_sha256: "a".repeat(64),
		mission_id: randomUUID(),
		delivery_id: randomUUID(),
		execution_attempt: 1,
		lease_id: randomUUID(),
		fencing_token: "1",
		policy_profile: "contained",
		policy_grant_sha256: "b".repeat(64),
		lease_expires_at: new Date(deadlineAtMs).toISOString(),
		hard_expires_at: new Date(deadlineAtMs).toISOString(),
		capabilities: [
			{ action: "runtime_start", resource: "runtime" },
			{ action: "workspace_read", resource: "workspace" },
			{ action: "outbound_publish", resource: "relay" },
			...PRODUCT_DENIED_CAPABILITIES,
		],
		limit_sources: { product: limits, local: limits, mission: limits, runtime: limits },
	});
}

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

async function readContainedProbeResult(
	path: string,
	expectedToken: string,
): Promise<Record<string, unknown>> {
	const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const stats = await handle.stat({ bigint: true });
		const currentUid = process.getuid?.();
		if (
			currentUid === undefined ||
			!stats.isFile() ||
			(stats.mode & 0o777n) !== 0o600n ||
			stats.nlink !== 1n ||
			stats.uid !== BigInt(currentUid) ||
			stats.size < 1n ||
			stats.size > BigInt(MAX_PROBE_RESULT_BYTES)
		) {
			throw new Error("Contained probe result has unsafe filesystem metadata");
		}
		const serialized = await handle.readFile("utf8");
		if (Buffer.byteLength(serialized, "utf8") > MAX_PROBE_RESULT_BYTES) {
			throw new Error("Contained probe result exceeded its byte limit");
		}
		const envelope: unknown = JSON.parse(serialized);
		if (!isRecord(envelope) || envelope.token !== expectedToken || !isRecord(envelope.result)) {
			throw new Error("Contained probe result did not match its one-shot request");
		}
		return envelope.result;
	} finally {
		await handle.close();
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
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
