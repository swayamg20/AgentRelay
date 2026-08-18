import { createHash, randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { type FileHandle, link, lstat, open, readdir, realpath, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
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
	sourceExecutable: string = process.execPath,
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

	const source = await realpath(sourceExecutable);
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
	const destinationDirectory = dirname(destination);
	const temporaryPath = join(
		destinationDirectory,
		`.${basename(destination)}.${process.pid}.${randomUUID()}.tmp`,
	);
	let temporaryHandle: FileHandle | undefined;
	let temporaryExists = false;
	try {
		await assertSourceHandle(sourceHandle);
		temporaryHandle = await open(
			temporaryPath,
			constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
			STAGED_EXECUTABLE_MODE,
		);
		temporaryExists = true;
		const digest = await copyAndDigest(sourceHandle, temporaryHandle);
		await temporaryHandle.chmod(STAGED_EXECUTABLE_MODE);
		await temporaryHandle.sync();
		await temporaryHandle.close();
		temporaryHandle = undefined;
		try {
			await link(temporaryPath, destination);
		} catch (error) {
			if (errorCode(error) !== "EEXIST") throw error;
		}
		await unlink(temporaryPath).catch((error: unknown) => {
			if (errorCode(error) !== "ENOENT") throw error;
		});
		temporaryExists = false;
		await removePublicationAliases(destination);
		await syncDirectory(destinationDirectory);
		await assertStagedExecutable(destination, digest);
		return digest;
	} catch (error) {
		await temporaryHandle?.close().catch(() => undefined);
		if (temporaryExists) {
			await unlink(temporaryPath).catch(() => undefined);
			await syncDirectory(destinationDirectory).catch(() => undefined);
		}
		throw error;
	} finally {
		await sourceHandle.close();
	}
}

async function removePublicationAliases(destination: string): Promise<void> {
	const directory = dirname(destination);
	const prefix = `.${basename(destination)}.`;
	const target = await lstat(destination, { bigint: true });
	let removed = false;
	for (const name of await readdir(directory)) {
		if (!name.startsWith(prefix) || !name.endsWith(".tmp")) continue;
		const candidate = join(directory, name);
		let stats: BigIntStats;
		try {
			stats = await lstat(candidate, { bigint: true });
		} catch (error) {
			if (errorCode(error) === "ENOENT") continue;
			throw error;
		}
		if (stats.dev !== target.dev || stats.ino !== target.ino) continue;
		await unlink(candidate).catch((error: unknown) => {
			if (errorCode(error) !== "ENOENT") throw error;
		});
		removed = true;
	}
	if (removed) await syncDirectory(directory);
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

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? String(error.code)
		: undefined;
}
