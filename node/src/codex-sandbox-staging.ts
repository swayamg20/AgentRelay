import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, open, realpath, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import type {
	ContainmentLayout,
	ContainmentOpenMode,
	PinnedExecutable,
} from "./codex-sandbox-contract.js";
import { assertAbsoluteNormalizedPath } from "./codex-sandbox-policy.js";
import { syncDirectory } from "./durable-file.js";

const STAGED_EXECUTABLE_MODE = 0o500;
const MAX_EXECUTABLE_BYTES = 512 * 1_048_576;
const COPY_BUFFER_BYTES = 1_048_576;

/** Pins the Node capability-probe runtime inside an owner-private immutable tree. */
export async function prepareStagedContainmentProbe(
	layout: ContainmentLayout,
	mode: ContainmentOpenMode,
	recovery?: PinnedExecutable,
): Promise<PinnedExecutable> {
	if (mode === "recover") {
		if (
			recovery === undefined ||
			recovery.executable !== layout.stagedProbeExecutable ||
			recovery.readRoot !== layout.stagedProbeRoot
		) {
			throw new Error("Containment recovery is missing its exact staged probe runtime");
		}
		await assertStagedExecutable(recovery.executable, recovery.sha256);
		return recovery;
	}

	const source = await realpath(process.execPath);
	const sha256 = await stageExecutable(source, layout.stagedProbeExecutable);
	return Object.freeze({
		executable: layout.stagedProbeExecutable,
		readRoot: layout.stagedProbeRoot,
		sha256,
	});
}

async function stageExecutable(source: string, destination: string): Promise<string> {
	assertAbsoluteNormalizedPath(source, "probe runtime executable");
	const sourceHandle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
	let destinationHandle: FileHandle | undefined;
	let destinationCreated = false;
	try {
		await assertSourceHandle(sourceHandle);
		destinationHandle = await open(
			destination,
			constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
			STAGED_EXECUTABLE_MODE,
		);
		destinationCreated = true;
		const digest = await copyAndDigest(sourceHandle, destinationHandle);
		await destinationHandle.chmod(STAGED_EXECUTABLE_MODE);
		await destinationHandle.sync();
		await destinationHandle.close();
		destinationHandle = undefined;
		await syncDirectory(dirname(destination));
		return digest;
	} catch (error) {
		await destinationHandle?.close().catch(() => undefined);
		if (destinationCreated) {
			await unlink(destination).catch(() => undefined);
			await syncDirectory(dirname(destination)).catch(() => undefined);
		}
		throw error;
	} finally {
		await sourceHandle.close();
	}
}

async function assertSourceHandle(handle: FileHandle): Promise<void> {
	const stats = await handle.stat({ bigint: true });
	if (
		!stats.isFile() ||
		stats.size > BigInt(MAX_EXECUTABLE_BYTES) ||
		(stats.mode & 0o111n) === 0n
	) {
		throw new Error("Probe runtime must be an executable bounded regular file");
	}
	const currentUid = process.getuid?.();
	if (currentUid !== undefined && stats.uid !== 0n && stats.uid !== BigInt(currentUid)) {
		throw new Error("Probe runtime must be owned by root or the current user");
	}
}

async function assertStagedExecutable(path: string, expectedSha256: string): Promise<void> {
	const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const stats = await handle.stat({ bigint: true });
		if (
			!stats.isFile() ||
			(stats.mode & 0o777n) !== BigInt(STAGED_EXECUTABLE_MODE) ||
			stats.nlink !== 1n ||
			stats.size > BigInt(MAX_EXECUTABLE_BYTES)
		) {
			throw new Error("Staged probe runtime has unsafe filesystem metadata");
		}
		if (process.getuid !== undefined && stats.uid !== BigInt(process.getuid())) {
			throw new Error("Staged probe runtime is not owned by the current user");
		}
		if ((await digestHandle(handle)) !== expectedSha256) {
			throw new Error("Staged probe runtime digest changed after creation");
		}
	} finally {
		await handle.close();
	}
}

async function copyAndDigest(source: FileHandle, destination: FileHandle): Promise<string> {
	const hash = createHash("sha256");
	const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
	let offset = 0;
	while (true) {
		const { bytesRead } = await source.read(buffer, 0, buffer.length, offset);
		if (bytesRead === 0) break;
		const chunk = buffer.subarray(0, bytesRead);
		hash.update(chunk);
		await writeAll(destination, chunk, offset);
		offset += bytesRead;
	}
	return hash.digest("hex");
}

async function digestHandle(handle: FileHandle): Promise<string> {
	const hash = createHash("sha256");
	const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
	let offset = 0;
	while (true) {
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
		if (bytesRead === 0) break;
		hash.update(buffer.subarray(0, bytesRead));
		offset += bytesRead;
	}
	return hash.digest("hex");
}

async function writeAll(handle: FileHandle, value: Buffer, position: number): Promise<void> {
	let written = 0;
	while (written < value.length) {
		const result = await handle.write(value, written, value.length - written, position + written);
		if (result.bytesWritten === 0) throw new Error("Staged probe runtime copy made no progress");
		written += result.bytesWritten;
	}
}
