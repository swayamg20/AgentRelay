import { type ChildProcess, spawn } from "node:child_process";
import { isAbsolute, normalize } from "node:path";
import { Writable } from "node:stream";
import { buildBaseCapsuleEnvironment } from "./capsule-environment.js";
import { CODEX_OWNER_CREDENTIAL_FD } from "./codex-owner-credential-channel.js";
import type { CodexOwnerCredential } from "./codex-owner-credential.js";
import type { CapsuleLauncher, CapsuleProcessCommand } from "./persistent-capsule-adapter-core.js";
import {
	killProcessGroupAndProveTerminated,
	proveOwnedPipesClosed,
} from "./process-group-termination.js";

const DEFAULT_CREDENTIAL_TIMEOUT_MS = 5_000;
const MIN_CREDENTIAL_TIMEOUT_MS = 10;
const MAX_CREDENTIAL_TIMEOUT_MS = 60_000;
const TERMINATION_PROOF_TIMEOUT_MS = 2_000;

const FAILURE_MESSAGES = {
	cancelled: "Codex Mission capsule launch was cancelled",
	credential: "Codex owner credential is unavailable",
	invalidCommand: "Codex Mission capsule command is invalid",
	invalidDescriptor: "Codex Mission capsule launcher requires a schema-v2 descriptor",
	invalidDirectory: "Codex Mission capsule directory is invalid",
	invalidTimeout: "Codex owner credential timeout is invalid",
	spawn: "Codex Mission capsule could not be started",
	timeout: "Codex owner credential transfer timed out",
	transfer: "Codex owner credential transfer failed",
	teardown: "Codex Mission capsule termination could not be proven",
	unsupported: "Codex Mission capsules currently require Unix",
} as const;

type LaunchFailure = keyof typeof FAILURE_MESSAGES;

export interface DetachedCodexCapsuleLauncherOptions {
	readonly command: CapsuleProcessCommand;
	readonly lifetimeSignal: AbortSignal;
	readonly claimOwnerCredential: (signal: AbortSignal) => Promise<CodexOwnerCredential>;
	readonly credentialTimeoutMs?: number;
}

export function createDetachedCodexCapsuleLauncher(
	options: DetachedCodexCapsuleLauncherOptions,
): CapsuleLauncher {
	if (process.platform === "win32") throw launchFailure("unsupported");
	const command = validateCommand(options.command);
	const credentialTimeoutMs = validateCredentialTimeout(options.credentialTimeoutMs);

	return {
		async start(capsuleDirectory, descriptor) {
			if (descriptor.schema_version !== 2) throw launchFailure("invalidDescriptor");
			await startDetachedCodexCapsule({
				command,
				capsuleDirectory: validateCapsuleDirectory(capsuleDirectory),
				lifetimeSignal: options.lifetimeSignal,
				claimOwnerCredential: options.claimOwnerCredential,
				credentialTimeoutMs,
			});
		},
	};
}

interface StartOptions {
	readonly command: CapsuleProcessCommand;
	readonly capsuleDirectory: string;
	readonly lifetimeSignal: AbortSignal;
	readonly claimOwnerCredential: (signal: AbortSignal) => Promise<CodexOwnerCredential>;
	readonly credentialTimeoutMs: number;
}

async function startDetachedCodexCapsule(options: StartOptions): Promise<void> {
	if (options.lifetimeSignal.aborted) throw launchFailure("cancelled");
	const timeout = new AbortController();
	const timer = setTimeout(() => timeout.abort(), options.credentialTimeoutMs);
	const claimSignal = AbortSignal.any([options.lifetimeSignal, timeout.signal]);
	let credential: CodexOwnerCredential | null = null;
	let child: ChildProcess | null = null;
	let childClosed: Promise<unknown> | null = null;
	let credentialChannel: Writable | null = null;

	try {
		credential = await claimCredential(options.claimOwnerCredential, claimSignal, () =>
			claimInterruption(timeout.signal),
		);
		if (timeout.signal.aborted) throw launchFailure("timeout");
		if (options.lifetimeSignal.aborted) throw launchFailure("cancelled");

		try {
			child = spawn(
				options.command.executable,
				[...options.command.args, "serve", "--directory", options.capsuleDirectory],
				{
					cwd: options.capsuleDirectory,
					detached: true,
					env: buildBaseCapsuleEnvironment(),
					shell: false,
					stdio: ["ignore", "ignore", "ignore", "pipe"],
				},
			);
		} catch {
			throw launchFailure("spawn");
		}
		childClosed = waitForChildClose(child);
		const spawned = waitForChildSpawn(child);
		void spawned.catch(() => undefined);
		const inheritedChannel = child.stdio[CODEX_OWNER_CREDENTIAL_FD];
		if (!(inheritedChannel instanceof Writable)) throw launchFailure("spawn");
		credentialChannel = inheritedChannel;

		await runBeforeTimeout(spawned, timeout.signal, "spawn");
		const channelFailure = watchCredentialChannel(credentialChannel);
		try {
			await runBeforeTimeout(
				Promise.race([credential.writeTo(credentialChannel), channelFailure.failure]),
				timeout.signal,
				"transfer",
			);
		} finally {
			channelFailure.stop();
		}
		if (!credentialChannel.closed || !credentialChannel.writableFinished) {
			throw launchFailure("transfer");
		}
		child.unref();
	} catch (error) {
		const failure = sanitizeLaunchFailure(error, options.lifetimeSignal, timeout.signal, child);
		if (child !== null && childClosed !== null) {
			destroyCredentialChannel(credentialChannel);
			await terminateFailedLaunch(child, childClosed);
		}
		throw failure;
	} finally {
		clearTimeout(timer);
		disposeCredential(credential);
	}
}

async function claimCredential(
	claim: (signal: AbortSignal) => Promise<CodexOwnerCredential>,
	signal: AbortSignal,
	interruption: () => Error,
): Promise<CodexOwnerCredential> {
	return new Promise((resolve, reject) => {
		let settled = false;
		const finish = (operation: () => void) => {
			if (settled) return false;
			settled = true;
			signal.removeEventListener("abort", onAbort);
			operation();
			return true;
		};
		const onAbort = () => finish(() => reject(interruption()));

		signal.addEventListener("abort", onAbort, { once: true });
		if (signal.aborted) {
			onAbort();
			return;
		}

		Promise.resolve()
			.then(() => claim(signal))
			.then(
				(credential) => {
					if (!finish(() => resolve(credential))) disposeCredential(credential);
				},
				() => finish(() => reject(launchFailure("credential"))),
			);
	});
}

function runBeforeTimeout(
	operation: Promise<unknown>,
	timeoutSignal: AbortSignal,
	failure: "spawn" | "transfer",
): Promise<void> {
	return new Promise((resolve, reject) => {
		let settled = false;
		const finish = (action: () => void) => {
			if (settled) return;
			settled = true;
			timeoutSignal.removeEventListener("abort", onTimeout);
			action();
		};
		const onTimeout = () => finish(() => reject(launchFailure("timeout")));

		timeoutSignal.addEventListener("abort", onTimeout, { once: true });
		if (timeoutSignal.aborted) {
			onTimeout();
			return;
		}
		operation.then(
			() => finish(resolve),
			() => finish(() => reject(launchFailure(failure))),
		);
	});
}

function destroyCredentialChannel(channel: Writable | null): void {
	try {
		if (channel !== null && !channel.destroyed) channel.destroy();
	} catch {
		// Group and pipe termination is still proven below.
	}
}

function disposeCredential(credential: CodexOwnerCredential | null): void {
	try {
		credential?.dispose();
	} catch {
		// Owner credentials never add raw cleanup failures to the launch surface.
	}
}

function watchCredentialChannel(channel: Writable): {
	readonly failure: Promise<never>;
	stop(): void;
} {
	let rejectFailure!: (error: Error) => void;
	const failure = new Promise<never>((_resolve, reject) => {
		rejectFailure = reject;
	});
	const onError = () => rejectFailure(launchFailure("transfer"));
	const onClose = () => {
		if (!channel.writableFinished) rejectFailure(launchFailure("transfer"));
	};
	channel.once("error", onError);
	channel.once("close", onClose);
	return {
		failure,
		stop() {
			channel.removeListener("error", onError);
			channel.removeListener("close", onClose);
		},
	};
}

async function terminateFailedLaunch(child: ChildProcess, closed: Promise<unknown>): Promise<void> {
	try {
		if (child.pid === undefined) {
			await proveOwnedPipesClosed(closed, TERMINATION_PROOF_TIMEOUT_MS);
			return;
		}
		await killProcessGroupAndProveTerminated(child.pid, closed, TERMINATION_PROOF_TIMEOUT_MS, () =>
			child.kill("SIGKILL"),
		);
	} catch {
		throw launchFailure("teardown");
	}
}

function waitForChildSpawn(child: ChildProcess): Promise<void> {
	return new Promise((resolve, reject) => {
		const onSpawn = () => {
			child.removeListener("error", onError);
			resolve();
		};
		const onError = () => {
			child.removeListener("spawn", onSpawn);
			reject(launchFailure("spawn"));
		};
		child.once("spawn", onSpawn);
		child.once("error", onError);
	});
}

function waitForChildClose(child: ChildProcess): Promise<unknown> {
	return new Promise((resolve) => child.once("close", resolve));
}

function validateCommand(command: CapsuleProcessCommand): CapsuleProcessCommand {
	if (
		typeof command !== "object" ||
		command === null ||
		typeof command.executable !== "string" ||
		!Array.isArray(command.args) ||
		!isAbsolute(command.executable) ||
		normalize(command.executable) !== command.executable ||
		command.executable.includes("\0") ||
		command.args.some((argument) => typeof argument !== "string" || argument.includes("\0"))
	) {
		throw launchFailure("invalidCommand");
	}
	return Object.freeze({ executable: command.executable, args: Object.freeze([...command.args]) });
}

function validateCapsuleDirectory(directory: string): string {
	if (
		typeof directory !== "string" ||
		!isAbsolute(directory) ||
		normalize(directory) !== directory ||
		directory.includes("\0")
	) {
		throw launchFailure("invalidDirectory");
	}
	return directory;
}

function validateCredentialTimeout(value: number | undefined): number {
	const timeout = value ?? DEFAULT_CREDENTIAL_TIMEOUT_MS;
	if (
		!Number.isSafeInteger(timeout) ||
		timeout < MIN_CREDENTIAL_TIMEOUT_MS ||
		timeout > MAX_CREDENTIAL_TIMEOUT_MS
	) {
		throw launchFailure("invalidTimeout");
	}
	return timeout;
}

function claimInterruption(timeoutSignal: AbortSignal): Error {
	return launchFailure(timeoutSignal.aborted ? "timeout" : "cancelled");
}

function sanitizeLaunchFailure(
	error: unknown,
	lifetimeSignal: AbortSignal,
	timeoutSignal: AbortSignal,
	child: ChildProcess | null,
): Error {
	if (error instanceof CodexCapsuleLaunchError) return error;
	if (timeoutSignal.aborted) return launchFailure("timeout");
	if (lifetimeSignal.aborted && child === null) return launchFailure("cancelled");
	return launchFailure(child === null ? "credential" : "transfer");
}

function launchFailure(reason: LaunchFailure): CodexCapsuleLaunchError {
	return new CodexCapsuleLaunchError(FAILURE_MESSAGES[reason]);
}

class CodexCapsuleLaunchError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CodexCapsuleLaunchError";
	}
}
