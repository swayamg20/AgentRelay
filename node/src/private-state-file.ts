import { constants } from "node:fs";
import { type FileHandle, lstat, mkdir, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, normalize } from "node:path";
import { writeDurableJson } from "./durable-file.js";

export const MAX_PRIVATE_STATE_FILE_BYTES = 16 * 1_048_576;

export async function ensurePrivateStateDirectory(directory: string): Promise<void> {
	if (!isAbsolute(directory) || normalize(directory) !== directory || directory.includes("\0")) {
		throw new Error(`Private state directory must be an absolute normalized path: ${directory}`);
	}
	try {
		await mkdir(directory, { recursive: true, mode: 0o700 });
	} catch (error) {
		if (errorCode(error) !== "EEXIST") throw error;
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
	let handle: FileHandle;
	try {
		handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	} catch (error) {
		if (errorCode(error) === "ENOENT") return null;
		throw new Error(`Cannot open private state file: ${path}`, { cause: error });
	}
	try {
		const stats = await handle.stat();
		if (!stats.isFile()) throw new Error(`Private state file is not regular: ${path}`);
		if (stats.size > MAX_PRIVATE_STATE_FILE_BYTES) {
			throw new Error(`Private state file exceeds the byte limit: ${path}`);
		}
		if ((stats.mode & 0o777) !== 0o600) {
			throw new Error(`Private state file must have mode 0600: ${path}`);
		}
		if (process.getuid !== undefined && stats.uid !== process.getuid()) {
			throw new Error(`Private state file must be owned by the current user: ${path}`);
		}
		const serialized = await handle.readFile("utf8");
		if (Buffer.byteLength(serialized, "utf8") > MAX_PRIVATE_STATE_FILE_BYTES) {
			throw new Error(`Private state file exceeds the byte limit: ${path}`);
		}
		return JSON.parse(serialized);
	} finally {
		await handle.close();
	}
}

export async function writePrivateJson(path: string, value: unknown): Promise<void> {
	const serialized = JSON.stringify(value, null, 2);
	if (
		serialized === undefined ||
		Buffer.byteLength(`${serialized}\n`, "utf8") > MAX_PRIVATE_STATE_FILE_BYTES
	) {
		throw new Error(`Private state file exceeds the byte limit: ${path}`);
	}
	await ensurePrivateStateDirectory(dirname(path));
	await writeDurableJson(path, value, { fileMode: 0o600, directoryMode: 0o700 });
}

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? String(error.code)
		: undefined;
}
