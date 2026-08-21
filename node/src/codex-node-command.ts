import { close, fstatSync } from "node:fs";
import { isAbsolute, normalize } from "node:path";
import { z } from "zod";
import {
	type DetachedCodexCapsuleLauncherOptions,
	createDetachedCodexCapsuleLauncher,
} from "./codex-capsule-launcher.js";
import {
	type CodexNodeRuntime,
	type CodexNodeRuntimeOptions,
	openCodexNodeRuntime,
} from "./codex-node-runtime.js";
import {
	CodexOwnerCredentialError,
	type CodexOwnerCredentialSource,
	readCodexOwnerCredentialSourceFromOwnedFd,
} from "./codex-owner-credential.js";
import type { NodeConfig } from "./config.js";
import type { CapsuleLauncher, CapsuleProcessCommand } from "./persistent-capsule-adapter.js";

const MAX_OWNED_FILE_DESCRIPTOR = 0x7fffffff;
const MAX_GIT_EXECUTABLE_PATH_BYTES = 4_096;
const ownerCredentialFdOptionSchema = z
	.tuple([
		z
			.string()
			.regex(/^(?:[3-9]|[1-9][0-9]+)$/)
			.refine((value) => Number(value) <= MAX_OWNED_FILE_DESCRIPTOR),
	])
	.transform(([value]) => Number(value));
const gitExecutableOptionSchema = z
	.string()
	.min(1)
	.max(MAX_GIT_EXECUTABLE_PATH_BYTES)
	.refine((value) => Buffer.byteLength(value, "utf8") <= MAX_GIT_EXECUTABLE_PATH_BYTES)
	.refine((value) => !value.includes("\0"))
	.refine((value) => isAbsolute(value))
	.refine((value) => normalize(value) === value);

/** Preserves one-versus-many option occurrences after CAC's numeric normalization. */
export const CODEX_OWNER_CREDENTIAL_FD_OPTION_CONFIG = Object.freeze({ type: [String] });

export interface CodexNodeCommandRuntime extends CodexNodeRuntime {
	close(): void;
}

export interface OwnedCodexOwnerCredentialFd {
	readSource(signal: AbortSignal): Promise<CodexOwnerCredentialSource>;
	close(): Promise<void>;
}

export interface CodexNodeCommandOptions {
	readonly config: NodeConfig;
	readonly stateDirectory: string;
	readonly lifetimeSignal: AbortSignal;
	readonly gitExecutable?: unknown;
	readonly capsuleCommand: CapsuleProcessCommand;
	readonly ownerCredentialFd: OwnedCodexOwnerCredentialFd;
}

export interface CodexNodeCommandDependencies {
	readonly openRuntime?: (options: CodexNodeRuntimeOptions) => Promise<CodexNodeRuntime>;
	readonly createLauncher?: (options: DetachedCodexCapsuleLauncherOptions) => CapsuleLauncher;
}

export interface CodexOwnerCredentialFdDependencies {
	readonly readSource?: typeof readCodexOwnerCredentialSourceFromOwnedFd;
	readonly closeFd?: (fd: number) => Promise<void>;
	readonly inspectFd?: (fd: number) => { isFIFO(): boolean; isSocket(): boolean };
}

/** Owns one inherited credential descriptor until it is handed to the bounded reader. */
export function ownCodexOwnerCredentialFd(
	value: unknown,
	dependencies: CodexOwnerCredentialFdDependencies = {},
): OwnedCodexOwnerCredentialFd {
	const fd = parseOwnerCredentialFd(value);
	let stats: { isFIFO(): boolean; isSocket(): boolean };
	try {
		stats = (dependencies.inspectFd ?? fstatSync)(fd);
	} catch {
		throw new CodexOwnerCredentialError("channel");
	}
	if (!stats.isFIFO() && !stats.isSocket()) throw new CodexOwnerCredentialError("channel");
	const readSource = dependencies.readSource ?? readCodexOwnerCredentialSourceFromOwnedFd;
	const closeFd = dependencies.closeFd ?? closeFileDescriptor;
	let state: "owned" | "transferred" | "closed" = "owned";
	let closePromise: Promise<void> | null = null;

	return Object.freeze({
		readSource(signal: AbortSignal): Promise<CodexOwnerCredentialSource> {
			if (state !== "owned") {
				return Promise.reject(new CodexOwnerCredentialError("unavailable"));
			}
			state = "transferred";
			return readSource(fd, signal);
		},
		close(): Promise<void> {
			if (state !== "owned") return closePromise ?? Promise.resolve();
			state = "closed";
			closePromise = closeFd(fd);
			return closePromise;
		},
	});
}

/** Keeps the admitted owner channel reserved until command composition has fully unwound. */
export async function withOwnedCodexOwnerCredentialFd<Result>(
	value: unknown,
	operation: (owner: OwnedCodexOwnerCredentialFd) => Promise<Result>,
	dependencies: CodexOwnerCredentialFdDependencies = {},
): Promise<Result> {
	const owner = ownCodexOwnerCredentialFd(value, dependencies);
	try {
		return await operation(owner);
	} finally {
		await owner.close();
	}
}

/**
 * Opens the passive Codex control plane before consuming the owner credential.
 * Relay work is still outside this boundary and starts only after this returns.
 */
export async function openCodexNodeCommandRuntime(
	options: CodexNodeCommandOptions,
	dependencies: CodexNodeCommandDependencies = {},
): Promise<CodexNodeCommandRuntime> {
	const gitExecutable = selectedGitExecutable(options.config, options.gitExecutable);
	let credentialSource: CodexOwnerCredentialSource | null = null;
	const createLauncher = dependencies.createLauncher ?? createDetachedCodexCapsuleLauncher;
	const launcher = createLauncher({
		command: options.capsuleCommand,
		lifetimeSignal: options.lifetimeSignal,
		claimOwnerCredential: (signal) => {
			const source = credentialSource;
			if (source === null) return Promise.reject(new CodexOwnerCredentialError("unavailable"));
			return source.claim(signal);
		},
	});

	try {
		const runtime = await (dependencies.openRuntime ?? openCodexNodeRuntime)({
			stateDirectory: options.stateDirectory,
			launcher,
			signal: options.lifetimeSignal,
			...(gitExecutable === undefined ? {} : { gitExecutable }),
		});
		options.lifetimeSignal.throwIfAborted();
		credentialSource = await options.ownerCredentialFd.readSource(options.lifetimeSignal);
		options.lifetimeSignal.throwIfAborted();

		let closed = false;
		return {
			...runtime,
			close() {
				if (closed) return;
				closed = true;
				const source = credentialSource;
				credentialSource = null;
				source?.close();
			},
		};
	} catch (error) {
		const source = credentialSource;
		credentialSource = null;
		source?.close();
		throw error;
	}
}

export function configRequiresCodexWorkspaceGit(config: NodeConfig): boolean {
	return Object.values(config.workspaces).some(
		(workspace) => config.policy_profiles[workspace.policy_profile]?.workspace_access === "write",
	);
}

function selectedGitExecutable(config: NodeConfig, value: unknown): string | undefined {
	if (value === undefined) {
		if (configRequiresCodexWorkspaceGit(config)) {
			throw new Error(
				"--git-executable is required when a configured workspace selects write access",
			);
		}
		return undefined;
	}
	const parsed = gitExecutableOptionSchema.safeParse(value);
	if (!parsed.success) {
		throw new Error("--git-executable must be an absolute normalized path");
	}
	return parsed.data;
}

function parseOwnerCredentialFd(value: unknown): number {
	const parsed = ownerCredentialFdOptionSchema.safeParse(value);
	if (!parsed.success) {
		throw new Error(
			`--owner-credential-fd must be an integer from 3 to ${MAX_OWNED_FILE_DESCRIPTOR}`,
		);
	}
	return parsed.data;
}

function closeFileDescriptor(fd: number): Promise<void> {
	return new Promise((resolve) => {
		try {
			close(fd, () => resolve());
		} catch {
			resolve();
		}
	});
}
