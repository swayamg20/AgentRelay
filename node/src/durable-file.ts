import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, mkdir, open, rename, unlink } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";

export interface DurableJsonWriteOptions {
	readonly fileMode?: number;
	readonly directoryMode?: number;
}

/**
 * Atomically replaces one JSON file and makes both its content and directory entry durable.
 * The temporary file stays beside the target so rename cannot cross filesystems.
 */
export async function writeDurableJson(
	path: string,
	value: unknown,
	options: DurableJsonWriteOptions = {},
): Promise<void> {
	const serialized = JSON.stringify(value, null, 2);
	if (serialized === undefined) {
		throw new TypeError("Durable JSON value is not serializable");
	}
	await writeDurableText(path, `${serialized}\n`, options);
}

export async function writeDurableText(
	path: string,
	serialized: string,
	options: DurableJsonWriteOptions = {},
): Promise<void> {
	const directory = dirname(path);
	const fileMode = options.fileMode ?? 0o600;
	const directoryMode = options.directoryMode ?? 0o700;
	const firstCreatedDirectory = await mkdir(directory, { recursive: true, mode: directoryMode });
	if (firstCreatedDirectory !== undefined) {
		await syncCreatedDirectoryEntries(firstCreatedDirectory, directory);
	}

	const temporaryPath = join(directory, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
	let temporaryExists = false;

	try {
		const handle = await open(
			temporaryPath,
			constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
			fileMode,
		);
		temporaryExists = true;
		try {
			await handle.chmod(fileMode);
			await handle.writeFile(serialized, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}

		await rename(temporaryPath, path);
		temporaryExists = false;
		await syncDirectory(directory);
	} catch (error) {
		if (temporaryExists) {
			await unlink(temporaryPath).catch(() => undefined);
		}
		throw error;
	}
}

/**
 * Publishes one complete JSON file without replacing an existing path.
 * A same-directory hard link makes the final name visible only after the staged
 * file has been flushed, so process death cannot expose partial JSON there.
 */
export async function publishDurableJsonExclusive(
	path: string,
	value: unknown,
	options: DurableJsonWriteOptions = {},
): Promise<"created" | "exists"> {
	const serialized = JSON.stringify(value, null, 2);
	if (serialized === undefined) {
		throw new TypeError("Durable JSON value is not serializable");
	}
	return publishDurableTextExclusive(path, `${serialized}\n`, options);
}

/** Publishes one complete text file without replacing an existing path. */
export async function publishDurableTextExclusive(
	path: string,
	serialized: string,
	options: DurableJsonWriteOptions = {},
): Promise<"created" | "exists"> {
	const directory = dirname(path);
	const fileMode = options.fileMode ?? 0o600;
	const directoryMode = options.directoryMode ?? 0o700;
	const firstCreatedDirectory = await mkdir(directory, { recursive: true, mode: directoryMode });
	if (firstCreatedDirectory !== undefined) {
		await syncCreatedDirectoryEntries(firstCreatedDirectory, directory);
	}

	const temporaryPath = join(directory, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
	let temporaryExists = false;
	try {
		const handle = await open(
			temporaryPath,
			constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
			fileMode,
		);
		temporaryExists = true;
		try {
			await handle.chmod(fileMode);
			await handle.writeFile(serialized, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}

		try {
			await link(temporaryPath, path);
			return "created";
		} catch (error) {
			if (errorCode(error) === "EEXIST") return "exists";
			throw error;
		}
	} finally {
		if (temporaryExists) {
			await unlink(temporaryPath).catch((error: unknown) => {
				if (errorCode(error) !== "ENOENT") throw error;
			});
			await syncDirectory(directory);
		}
	}
}

/** Creates one durable file without ever replacing an existing authorization record. */
export async function writeDurableTextExclusive(
	path: string,
	serialized: string,
	options: DurableJsonWriteOptions = {},
): Promise<void> {
	const directory = dirname(path);
	const fileMode = options.fileMode ?? 0o600;
	const directoryMode = options.directoryMode ?? 0o700;
	const firstCreatedDirectory = await mkdir(directory, { recursive: true, mode: directoryMode });
	if (firstCreatedDirectory !== undefined) {
		await syncCreatedDirectoryEntries(firstCreatedDirectory, directory);
	}

	let created = false;
	try {
		const handle = await open(
			path,
			constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
			fileMode,
		);
		created = true;
		try {
			await handle.chmod(fileMode);
			await handle.writeFile(serialized, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
		await syncDirectory(directory);
	} catch (error) {
		if (created) {
			await unlink(path).catch(() => undefined);
			await syncDirectory(directory).catch(() => undefined);
		}
		throw error;
	}
}

async function syncCreatedDirectoryEntries(
	firstCreatedDirectory: string,
	finalDirectory: string,
): Promise<void> {
	await syncDirectory(dirname(firstCreatedDirectory));
	let parent = firstCreatedDirectory;
	const descendants = relative(firstCreatedDirectory, finalDirectory)
		.split(sep)
		.filter((segment) => segment.length > 0);
	for (const descendant of descendants) {
		await syncDirectory(parent);
		parent = join(parent, descendant);
	}
}

export async function syncDirectory(directory: string): Promise<void> {
	const handle = await open(directory, constants.O_RDONLY);
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? String(error.code)
		: undefined;
}
