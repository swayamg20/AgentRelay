import { chmod, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCodexChildEnvironment } from "./capsule-environment.js";
import { CodexAppServerError, verifyCodexCliVersion } from "./codex-app-server-process.js";
import { resolvePinnedCodexLauncher } from "./codex-artifact.js";
import { assertPinnedCodexArtifact } from "./codex-capsule-provisioning-validation.js";
import { type PinnedOwnerGitExecutable, pinOwnerGitExecutable } from "./codex-git-artifact.js";
import type { CodexProcessBoundary } from "./codex-process-boundary.js";
import type { PinnedCodexLauncher } from "./codex-sandbox-contract.js";

export interface CodexRuntimeDoctorOptions {
	readonly signal: AbortSignal;
}

export interface CodexWorkspaceMediatorDoctorOptions extends CodexRuntimeDoctorOptions {
	readonly gitExecutable: string;
}

export interface CodexRuntimeDoctorDependencies {
	readonly resolveLauncher?: () => Promise<PinnedCodexLauncher>;
	readonly pinGit?: (executable: string) => Promise<PinnedOwnerGitExecutable>;
}

export type CodexRuntimeDoctorFailure =
	| "unsupported"
	| "artifact"
	| "git"
	| "setup"
	| "version"
	| "cancelled"
	| "teardown"
	| "cleanup";

const FAILURE_MESSAGES: Readonly<Record<CodexRuntimeDoctorFailure, string>> = Object.freeze({
	unsupported: "Codex runtime doctor requires linux/x64",
	artifact: "Pinned Codex runtime artifact verification failed",
	git: "Owner-selected Git executable verification failed",
	setup: "Codex runtime doctor could not prepare its private probe home",
	version: "Pinned Codex runtime version probe failed",
	cancelled: "Codex runtime doctor was cancelled",
	teardown: "Codex runtime doctor could not prove version-probe termination",
	cleanup: "Codex runtime doctor could not remove its private probe home",
});

export class CodexRuntimeDoctorError extends Error {
	constructor(readonly reason: CodexRuntimeDoctorFailure) {
		super(FAILURE_MESSAGES[reason]);
		this.name = "CodexRuntimeDoctorError";
	}
}

const directDoctorProcessBoundary: CodexProcessBoundary = Object.freeze({
	prepare: async (request: Parameters<CodexProcessBoundary["prepare"]>[0], signal: AbortSignal) => {
		signal.throwIfAborted();
		return {
			executable: request.executable,
			argv: [...request.argv],
			workspaceCwd: request.workspaceCwd,
			cwd: request.cwd,
			env: { ...request.env },
		};
	},
});

/** Verifies the owner-pinned runtime without claiming Relay work or opening runtime state. */
export async function runCodexRuntimeDoctor(
	options: CodexRuntimeDoctorOptions,
	dependencies: CodexRuntimeDoctorDependencies = {},
): Promise<PinnedCodexLauncher> {
	if (options.signal.aborted) throw new CodexRuntimeDoctorError("cancelled");
	if (
		dependencies.resolveLauncher === undefined &&
		(process.platform !== "linux" || process.arch !== "x64")
	) {
		throw new CodexRuntimeDoctorError("unsupported");
	}

	let launcher: PinnedCodexLauncher;
	try {
		launcher = await (dependencies.resolveLauncher ?? resolvePinnedCodexLauncher)();
		options.signal.throwIfAborted();
		await assertPinnedCodexArtifact(launcher);
		options.signal.throwIfAborted();
	} catch {
		throw new CodexRuntimeDoctorError(options.signal.aborted ? "cancelled" : "artifact");
	}

	let probeHome: string | null = null;
	let probeTerminationProven = true;
	let result: PinnedCodexLauncher | null = null;
	let failure: CodexRuntimeDoctorError | null = null;
	try {
		try {
			probeHome = await createPrivateProbeHome();
		} catch {
			throw new CodexRuntimeDoctorError("setup");
		}
		options.signal.throwIfAborted();
		await verifyCodexCliVersion(
			launcher.executable,
			probeHome,
			buildCodexChildEnvironment(process.env, probeHome),
			directDoctorProcessBoundary,
			options.signal,
		);
		options.signal.throwIfAborted();
		result = freezeLauncher(launcher);
	} catch (error) {
		if (error instanceof CodexRuntimeDoctorError) {
			failure = error;
		} else if (options.signal.aborted && error === options.signal.reason) {
			failure = new CodexRuntimeDoctorError("cancelled");
		} else if (isUnprovenTermination(error)) {
			probeTerminationProven = false;
			failure = new CodexRuntimeDoctorError("teardown");
		} else {
			failure = new CodexRuntimeDoctorError(options.signal.aborted ? "cancelled" : "version");
		}
	}
	if (probeHome !== null && probeTerminationProven) {
		try {
			await rm(probeHome, { recursive: true, force: true });
		} catch {
			failure = new CodexRuntimeDoctorError("cleanup");
		}
	}
	if (failure !== null) throw failure;
	if (result === null) throw new CodexRuntimeDoctorError("version");
	return result;
}

/** Pins the owner-selected compiler used only by the trusted workspace mediator. */
export async function runCodexWorkspaceMediatorDoctor(
	options: CodexWorkspaceMediatorDoctorOptions,
	dependencies: CodexRuntimeDoctorDependencies = {},
): Promise<PinnedOwnerGitExecutable> {
	if (options.signal.aborted) throw new CodexRuntimeDoctorError("cancelled");
	try {
		const git = await (dependencies.pinGit ?? pinOwnerGitExecutable)(options.gitExecutable);
		options.signal.throwIfAborted();
		if (git.executable.path !== options.gitExecutable) {
			throw new Error("Git verification changed the owner-selected path");
		}
		return Object.freeze({
			executable: Object.freeze({
				path: git.executable.path,
				identity: Object.freeze({ ...git.executable.identity }),
			}),
			sha256: git.sha256,
		});
	} catch {
		throw new CodexRuntimeDoctorError(options.signal.aborted ? "cancelled" : "git");
	}
}

async function createPrivateProbeHome(): Promise<string> {
	const created = await mkdtemp(join(tmpdir(), "agentrelay-codex-doctor-"));
	try {
		await chmod(created, 0o700);
		return await realpath(created);
	} catch (error) {
		await rm(created, { recursive: true, force: true }).catch(() => undefined);
		throw error;
	}
}

function freezeLauncher(launcher: PinnedCodexLauncher): PinnedCodexLauncher {
	return Object.freeze({
		executable: launcher.executable,
		readRoot: launcher.readRoot,
		sha256: launcher.sha256,
		sandboxHelper: Object.freeze({
			executable: launcher.sandboxHelper.executable,
			readRoot: launcher.sandboxHelper.readRoot,
			sha256: launcher.sandboxHelper.sha256,
		}),
	});
}

function isUnprovenTermination(error: unknown): boolean {
	return error instanceof CodexAppServerError && error.reason === "transport";
}
