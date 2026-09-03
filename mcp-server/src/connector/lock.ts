import { constants, type Stats } from "node:fs";
import { type FileHandle, lstat, mkdir, open, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, normalize } from "node:path";
import { connectorWatchLockPath } from "../cli/paths.js";

interface KernelFileLock {
	tryLock(fileDescriptor: number): boolean;
	unlock(fileDescriptor: number): void;
}

let nativeFileLock: KernelFileLock | undefined;

export class ConnectorLockError extends Error {
	constructor(
		public readonly kind: "already_running" | "unavailable",
		public readonly path: string,
		message: string,
		options: ErrorOptions = {},
	) {
		super(message, options);
		this.name = "ConnectorLockError";
	}
}

export interface ConnectorProcessLock {
	readonly path: string;
	release(): Promise<void>;
}

export interface AcquireConnectorLockOptions {
	path?: string;
}

/**
 * Hold one kernel-backed lock for the process lifetime so connector processes
 * cannot race the shared replay cursor. The lock file is deliberately kept:
 * closing the descriptor, including on a crash, releases ownership.
 */
export async function acquireConnectorLock(
	options: AcquireConnectorLockOptions = {},
): Promise<ConnectorProcessLock> {
	const path = options.path ?? connectorWatchLockPath();
	let kernelLock: KernelFileLock;
	try {
		kernelLock = loadNativeFileLock();
	} catch (error) {
		throw unavailable(path, error);
	}

	await ensureSafeLockDirectory(path);
	const handle = await openConnectorLockFile(path);
	let acquired: boolean;
	try {
		acquired = kernelLock.tryLock(handle.fd);
	} catch (error) {
		await handle.close().catch(() => undefined);
		throw unavailable(path, error);
	}

	if (!acquired) {
		await handle.close().catch(() => undefined);
		throw new ConnectorLockError(
			"already_running",
			path,
			`AgentRelay watch is already running for connector state at ${path}`,
		);
	}

	try {
		await validateLockFile(path, handle, true);
	} catch (error) {
		await handle.close().catch(() => undefined);
		throw unavailable(path, error);
	}

	return connectorLock(path, handle, kernelLock);
}

async function ensureSafeLockDirectory(path: string): Promise<void> {
	const directory = dirname(path);
	try {
		if (!isAbsolute(path) || normalize(path) !== path || path.includes("\0")) {
			throw new Error("Connector lock path must be absolute and normalized");
		}
		await mkdir(directory, { mode: 0o700, recursive: true });
		const stats = await lstat(directory);
		if (
			!stats.isDirectory() ||
			stats.isSymbolicLink() ||
			(process.platform !== "win32" && (stats.mode & 0o022) !== 0) ||
			(process.getuid !== undefined && stats.uid !== process.getuid()) ||
			(await realpath(directory)) !== directory
		) {
			throw new Error("Connector lock directory is not owner-controlled");
		}
	} catch (error) {
		throw unavailable(path, error);
	}
}

async function openConnectorLockFile(path: string): Promise<FileHandle> {
	let handle: FileHandle | undefined;
	try {
		handle = await open(path, lockOpenFlags(), 0o600);
		await validateLockFile(path, handle, false);
		await handle.chmod(0o600);
		await validateLockFile(path, handle, true);
		return handle;
	} catch (error) {
		await handle?.close().catch(() => undefined);
		throw unavailable(path, error);
	}
}

function connectorLock(
	path: string,
	handle: FileHandle,
	kernelLock: KernelFileLock,
): ConnectorProcessLock {
	let releasePromise: Promise<void> | undefined;
	return {
		path,
		release(): Promise<void> {
			releasePromise ??= releaseKernelLock(handle, kernelLock);
			return releasePromise;
		},
	};
}

async function releaseKernelLock(handle: FileHandle, kernelLock: KernelFileLock): Promise<void> {
	let unlockError: unknown;
	try {
		kernelLock.unlock(handle.fd);
	} catch (error) {
		unlockError = error;
	} finally {
		await handle.close();
	}
	if (unlockError !== undefined) throw unlockError;
}

async function validateLockFile(
	path: string,
	handle: FileHandle,
	requirePrivateMode: boolean,
): Promise<void> {
	let pathStats: Stats;
	try {
		pathStats = await lstat(path);
	} catch (error) {
		throw new ConnectorLockError(
			"unavailable",
			path,
			`Connector lock path changed while it was being inspected: ${path}`,
			{ cause: error },
		);
	}
	const handleStats = await handle.stat();
	if (
		pathStats.isSymbolicLink() ||
		!pathStats.isFile() ||
		!handleStats.isFile() ||
		pathStats.dev !== handleStats.dev ||
		pathStats.ino !== handleStats.ino ||
		handleStats.nlink !== 1 ||
		(requirePrivateMode && process.platform !== "win32" && (handleStats.mode & 0o777) !== 0o600) ||
		(process.getuid !== undefined && handleStats.uid !== process.getuid())
	) {
		throw new ConnectorLockError(
			"unavailable",
			path,
			`Connector lock must be one private regular file owned by the current user: ${path}`,
		);
	}
}

function lockOpenFlags(): number {
	const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
	return constants.O_CREAT | constants.O_RDWR | noFollow;
}

function loadNativeFileLock(): KernelFileLock {
	if (nativeFileLock !== undefined) return nativeFileLock;
	const loaded = createRequire(import.meta.url)("fs-native-extensions") as Partial<KernelFileLock>;
	if (typeof loaded.tryLock !== "function" || typeof loaded.unlock !== "function") {
		throw new TypeError("fs-native-extensions does not expose the required lock operations");
	}
	nativeFileLock = loaded as KernelFileLock;
	return nativeFileLock;
}

function unavailable(path: string, error: unknown): ConnectorLockError {
	if (error instanceof ConnectorLockError) return error;
	const detail = error instanceof Error ? `: ${error.message}` : "";
	return new ConnectorLockError(
		"unavailable",
		path,
		`Cannot acquire AgentRelay connector ownership at ${path}${detail}`,
		{ cause: error },
	);
}
