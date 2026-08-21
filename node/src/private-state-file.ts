import { constants, type Stats } from "node:fs";
import { type FileHandle, lstat, mkdir, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, normalize } from "node:path";
import {
	publishDurableTextExclusive,
	writeDurableText,
	writeDurableTextExclusive,
} from "./durable-file.js";

export const MAX_PRIVATE_STATE_FILE_BYTES = 16 * 1_048_576;
const MAX_PRIVATE_STATE_READ_ATTEMPTS = 8;

type PrivateStateReadAttempt =
	| { readonly state: "absent" }
	| { readonly state: "changed" }
	| { readonly state: "value"; readonly value: unknown };

export async function ensurePrivateStateDirectory(directory: string): Promise<void> {
	if (!isAbsolute(directory) || normalize(directory) !== directory || directory.includes("\0")) {
		throw new Error(`Private state directory must be an absolute normalized path: ${directory}`);
	}
	try {
		await mkdir(directory, { recursive: true, mode: 0o700 });
	} catch (error) {
		if (errorCode(error) !== "EEXIST") throw error;
	}
	await assertPrivateStateDirectory(directory);
}

export async function assertPrivateStateDirectory(directory: string): Promise<void> {
	if (!isAbsolute(directory) || normalize(directory) !== directory || directory.includes("\0")) {
		throw new Error(`Private state directory must be an absolute normalized path: ${directory}`);
	}
	const stats = await lstat(directory);
	if (!stats.isDirectory() || stats.isSymbolicLink()) {
		throw new Error(`Private state directory must be a real directory: ${directory}`);
	}
	if ((stats.mode & 0o777) !== 0o700) {
		throw new Error(`Private state directory must have mode 0700: ${directory}`);
	}
	if (process.getuid !== undefined && stats.uid !== process.getuid()) {
		throw new Error(`Private state directory must be owned by the current user: ${directory}`);
	}
	if ((await realpath(directory)) !== directory) {
		throw new Error(`Private state directory must use its canonical path: ${directory}`);
	}
}

export async function readPrivateJsonIfPresent(path: string): Promise<unknown | null> {
	let observedChange = false;
	for (let attempt = 0; attempt < MAX_PRIVATE_STATE_READ_ATTEMPTS; attempt += 1) {
		const result = await readPrivateJsonAttempt(path);
		if (result.state === "value") return result.value;
		if (result.state === "absent" && !observedChange) return null;
		observedChange = true;
	}
	throw new Error(`Private state file kept changing while it was being read: ${path}`);
}

async function readPrivateJsonAttempt(path: string): Promise<PrivateStateReadAttempt> {
	let handle: FileHandle;
	try {
		handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	} catch (error) {
		if (errorCode(error) === "ENOENT") return { state: "absent" };
		throw new Error(`Cannot open private state file: ${path}`, { cause: error });
	}
	try {
		const stats = await handle.stat();
		if (stats.nlink === 0) return { state: "changed" };
		assertPrivateStateFileMetadata(path, stats);
		if (!(await pathReferencesHandle(path, stats))) return { state: "changed" };
		const serialized = await handle.readFile("utf8");
		if (Buffer.byteLength(serialized, "utf8") > MAX_PRIVATE_STATE_FILE_BYTES) {
			throw new Error(`Private state file exceeds the byte limit: ${path}`);
		}
		const after = await handle.stat();
		if (after.nlink === 0) return { state: "changed" };
		assertPrivateStateFileMetadata(path, after);
		if (
			after.dev !== stats.dev ||
			after.ino !== stats.ino ||
			after.size !== stats.size ||
			after.mode !== stats.mode ||
			after.uid !== stats.uid ||
			after.mtimeMs !== stats.mtimeMs ||
			after.ctimeMs !== stats.ctimeMs
		) {
			throw new Error(`Private state file changed while it was being read: ${path}`);
		}
		if (!(await pathReferencesHandle(path, after))) return { state: "changed" };
		return { state: "value", value: JSON.parse(serialized) };
	} finally {
		await handle.close();
	}
}

function assertPrivateStateFileMetadata(path: string, stats: Stats): void {
	if (!stats.isFile() || stats.nlink !== 1) {
		throw new Error(`Private state file must be a singly linked regular file: ${path}`);
	}
	if (stats.size > MAX_PRIVATE_STATE_FILE_BYTES) {
		throw new Error(`Private state file exceeds the byte limit: ${path}`);
	}
	if ((stats.mode & 0o777) !== 0o600) {
		throw new Error(`Private state file must have mode 0600: ${path}`);
	}
	if (process.getuid !== undefined && stats.uid !== process.getuid()) {
		throw new Error(`Private state file must be owned by the current user: ${path}`);
	}
}

async function pathReferencesHandle(path: string, handleStats: Stats): Promise<boolean> {
	let pathStats: Awaited<ReturnType<typeof lstat>>;
	try {
		pathStats = await lstat(path);
	} catch (error) {
		if (errorCode(error) === "ENOENT") return false;
		throw new Error(`Private state file path changed while it was being read: ${path}`, {
			cause: error,
		});
	}
	if (pathStats.isSymbolicLink() || !pathStats.isFile() || pathStats.nlink !== 1) {
		throw new Error(`Private state file path changed while it was being read: ${path}`);
	}
	return pathStats.dev === handleStats.dev && pathStats.ino === handleStats.ino;
}

export async function writePrivateJson(path: string, value: unknown): Promise<void> {
	const serialized = serializePrivateJson(path, value);
	await ensurePrivateStateDirectory(dirname(path));
	await writeDurableText(path, `${serialized}\n`, { fileMode: 0o600, directoryMode: 0o700 });
}

export async function writePrivateJsonExclusive(path: string, value: unknown): Promise<void> {
	const serialized = serializePrivateJson(path, value);
	await ensurePrivateStateDirectory(dirname(path));
	await writeDurableTextExclusive(path, `${serialized}\n`, {
		fileMode: 0o600,
		directoryMode: 0o700,
	});
}

export async function publishPrivateJsonExclusive(
	path: string,
	value: unknown,
): Promise<"created" | "exists"> {
	const serialized = serializePrivateJson(path, value);
	await ensurePrivateStateDirectory(dirname(path));
	return publishDurableTextExclusive(path, `${serialized}\n`, {
		fileMode: 0o600,
		directoryMode: 0o700,
	});
}

function serializePrivateJson(path: string, value: unknown): string {
	const serialized = JSON.stringify(value, null, 2);
	if (
		serialized === undefined ||
		Buffer.byteLength(`${serialized}\n`, "utf8") > MAX_PRIVATE_STATE_FILE_BYTES
	) {
		throw new Error(`Private state file exceeds the byte limit: ${path}`);
	}
	return serialized;
}

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? String(error.code)
		: undefined;
}
