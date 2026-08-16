import { randomUUID } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import { type KernelFileLock, kernelFileLock } from "./kernel-file-lock.js";
import {
	NODE_PROCESS_LOCK_KIND,
	type OwnerMetadata,
	ProcessLockError,
	type ProcessLockKind,
	assertStableProcessLock,
	openStableProcessLock,
	ownerMetadataSchema,
	readOwnerMetadata,
	writeOwnerMetadata,
} from "./process-lock-state.js";

export {
	NODE_PROCESS_LOCK_KIND,
	PROVIDER_GENERATION_LOCK_KIND,
	ProcessLockError,
} from "./process-lock-state.js";
export type { ProcessLockKind } from "./process-lock-state.js";

export interface ProcessLock {
	readonly path: string;
	readonly metadata: Readonly<OwnerMetadata>;
	/** Duplicate this descriptor into a supervised child to retain the same kernel ownership. */
	inheritFileDescriptor(): number;
	release(): Promise<void>;
}

export interface AcquireProcessLockOptions {
	readonly pid?: number;
	readonly now?: () => Date;
	readonly id?: () => string;
	readonly kernelLock?: KernelFileLock;
	readonly kind?: ProcessLockKind;
}

export async function acquireProcessLock(
	path: string,
	options: AcquireProcessLockOptions = {},
): Promise<ProcessLock> {
	const metadata = ownerMetadataSchema.parse({
		schema_version: 2,
		lock_id: (options.id ?? randomUUID)(),
		pid: options.pid ?? process.pid,
		started_at: (options.now ?? (() => new Date()))().toISOString(),
	});
	const kind = options.kind ?? NODE_PROCESS_LOCK_KIND;
	const handle = await openStableProcessLock(path, kind);
	const lock = options.kernelLock ?? kernelFileLock;

	let acquired: boolean;
	try {
		acquired = lock.tryLock(handle.fd);
	} catch (error) {
		await handle.close().catch(() => undefined);
		throw new ProcessLockError(
			"unavailable",
			path,
			`Kernel process locking is unavailable for ${path}`,
			undefined,
			{ cause: error },
		);
	}

	if (!acquired) {
		const owner = await readOwnerMetadata(path);
		await handle.close().catch(() => undefined);
		throw new ProcessLockError(
			"already_running",
			path,
			owner === undefined
				? `${ownerLabel(kind)} ownership is already held at ${path}; owner diagnostics are unavailable`
				: `${ownerLabel(kind)} ownership is already held at ${path}; last reported owner PID ${owner.pid}`,
			owner,
		);
	}

	try {
		await assertStableProcessLock(path, handle);
		await writeOwnerMetadata(path, metadata);
		await assertStableProcessLock(path, handle);
	} catch (error) {
		await handle.close().catch(() => undefined);
		if (error instanceof ProcessLockError) throw error;
		throw new ProcessLockError(
			"unavailable",
			path,
			`Cannot write process owner diagnostics for ${path}`,
			undefined,
			{ cause: error },
		);
	}

	return processLock(path, metadata, handle, lock);
}

function processLock(
	path: string,
	metadata: OwnerMetadata,
	handle: FileHandle,
	lock: KernelFileLock,
): ProcessLock {
	let releasePromise: Promise<void> | undefined;
	return {
		path,
		metadata: Object.freeze({ ...metadata }),
		inheritFileDescriptor(): number {
			if (releasePromise !== undefined) {
				throw new ProcessLockError("unavailable", path, "Process ownership is already releasing");
			}
			return handle.fd;
		},
		release(): Promise<void> {
			releasePromise ??= releaseKernelLock(handle, lock);
			return releasePromise;
		},
	};
}

function ownerLabel(kind: ProcessLockKind): string {
	return kind === NODE_PROCESS_LOCK_KIND ? "AgentRelay Node" : "AgentRelay provider generation";
}

async function releaseKernelLock(handle: FileHandle, lock: KernelFileLock): Promise<void> {
	let unlockError: unknown;
	try {
		lock.unlock(handle.fd);
	} catch (error) {
		unlockError = error;
	} finally {
		await handle.close();
	}
	if (unlockError !== undefined) throw unlockError;
}
