import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { type FileHandle, link, lstat, open, readdir, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize } from "node:path";
import { z } from "zod";
import { syncDirectory } from "./durable-file.js";
import {
	ensurePrivateStateDirectory,
	readPrivateJsonIfPresent,
	writePrivateJson,
} from "./private-state-file.js";

const MAX_LOCK_FILE_BYTES = 4_096;
const ACQUISITION_ATTEMPTS = 8;

const legacyLockMetadataSchema = z
	.object({
		schema_version: z.literal(1),
		lock_id: z.string().uuid(),
		pid: z.number().int().positive(),
		started_at: z.string().datetime({ offset: true }),
	})
	.strict();

const kernelLockFileSchema = z
	.object({
		schema_version: z.literal(2),
		kind: z.literal("agentrelay_node_kernel_lock"),
	})
	.strict();

export const ownerMetadataSchema = z
	.object({
		schema_version: z.literal(2),
		lock_id: z.string().uuid(),
		pid: z.number().int().positive(),
		started_at: z.string().datetime({ offset: true }),
	})
	.strict();

export type LegacyLockMetadata = z.infer<typeof legacyLockMetadataSchema>;
export type OwnerMetadata = z.infer<typeof ownerMetadataSchema>;

const KERNEL_LOCK_FILE = Object.freeze({
	schema_version: 2 as const,
	kind: "agentrelay_node_kernel_lock" as const,
});

interface OpenLockFile {
	readonly handle: FileHandle;
	readonly contents:
		| { readonly kind: "legacy"; readonly metadata: LegacyLockMetadata }
		| { readonly kind: "kernel" };
}

export class ProcessLockError extends Error {
	constructor(
		readonly reason: "already_running" | "invalid_lock" | "unavailable",
		readonly path: string,
		message: string,
		readonly owner?: Readonly<LegacyLockMetadata | OwnerMetadata>,
		options: ErrorOptions = {},
	) {
		super(message, options);
		this.name = "ProcessLockError";
	}
}

export async function openStableProcessLock(path: string): Promise<FileHandle> {
	await prepareLockDirectory(path);
	for (let attempt = 0; attempt < ACQUISITION_ATTEMPTS; attempt += 1) {
		const existing = await openLockFile(path);
		if (existing === null) {
			await publishKernelLockFile(path);
			continue;
		}
		if (existing.contents.kind === "kernel") return existing.handle;

		await existing.handle.close().catch(() => undefined);
		throw new ProcessLockError(
			"invalid_lock",
			path,
			`Legacy schema-1 process ownership at ${path} cannot be reclaimed safely from PID metadata. Stop every Node that can access this state, verify the state is offline, then remove this legacy file once; the next start will create the permanent kernel lock`,
			existing.contents.metadata,
		);
	}

	throw new ProcessLockError(
		"unavailable",
		path,
		`Could not acquire process lock at ${path} because its ownership file kept changing`,
	);
}

export async function assertStableProcessLock(path: string, handle: FileHandle): Promise<void> {
	await assertPathReferencesHandle(path, handle);
	if ((await handle.stat()).nlink !== 1) {
		throw invalidLock(path, `Process lock must have exactly one filesystem link: ${path}`);
	}
}

async function assertPathReferencesHandle(path: string, handle: FileHandle): Promise<void> {
	let pathStats: Awaited<ReturnType<typeof lstat>>;
	try {
		pathStats = await lstat(path);
	} catch (error) {
		throw invalidLock(
			path,
			`Process lock path changed while it was being inspected: ${path}`,
			error,
		);
	}
	const handleStats = await handle.stat();
	if (
		pathStats.isSymbolicLink() ||
		!pathStats.isFile() ||
		pathStats.dev !== handleStats.dev ||
		pathStats.ino !== handleStats.ino
	) {
		throw invalidLock(path, `Process lock path changed while it was being inspected: ${path}`);
	}
}

export async function readOwnerMetadata(path: string): Promise<OwnerMetadata | undefined> {
	try {
		const decoded = await readPrivateJsonIfPresent(ownerMetadataPath(path));
		if (decoded === null) return undefined;
		const parsed = ownerMetadataSchema.safeParse(decoded);
		return parsed.success ? parsed.data : undefined;
	} catch {
		return undefined;
	}
}

export async function writeOwnerMetadata(path: string, metadata: OwnerMetadata): Promise<void> {
	await writePrivateJson(ownerMetadataPath(path), metadata);
}

async function openLockFile(path: string): Promise<OpenLockFile | null> {
	let handle: FileHandle;
	try {
		handle = await open(path, constants.O_RDWR | constants.O_NOFOLLOW);
	} catch (error) {
		if (isNotFound(error)) return null;
		throw new ProcessLockError(
			isUnsafeFileError(error) ? "invalid_lock" : "unavailable",
			path,
			`Cannot open private process lock at ${path}`,
			undefined,
			{ cause: error },
		);
	}

	try {
		const stats = await validatePrivateRegularFile(path, handle);
		await assertPathReferencesHandle(path, handle);
		const decoded = await readLockJson(path, handle, stats.size);

		if (kernelLockFileSchema.safeParse(decoded).success) {
			if (stats.nlink !== 1) await removePublishedTemporaryLinks(path, handle);
			return { handle, contents: { kind: "kernel" } };
		}
		const legacy = legacyLockMetadataSchema.safeParse(decoded);
		if (legacy.success) {
			return { handle, contents: { kind: "legacy", metadata: legacy.data } };
		}
		throw invalidLock(path, `Process lock at ${path} is invalid`);
	} catch (error) {
		await handle.close().catch(() => undefined);
		throw error;
	}
}

async function publishKernelLockFile(path: string): Promise<void> {
	const directory = dirname(path);
	const temporaryPath = join(directory, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
	let temporaryExists = false;

	try {
		const handle = await open(
			temporaryPath,
			constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
			0o600,
		);
		temporaryExists = true;
		try {
			await handle.chmod(0o600);
			await handle.writeFile(`${JSON.stringify(KERNEL_LOCK_FILE, null, 2)}\n`, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}

		try {
			await link(temporaryPath, path);
		} catch (error) {
			if (isAlreadyExists(error)) return;
			throw error;
		}
	} catch (error) {
		throw new ProcessLockError(
			"unavailable",
			path,
			`Cannot provision private process lock at ${path}`,
			undefined,
			{ cause: error },
		);
	} finally {
		if (temporaryExists) {
			await unlink(temporaryPath).catch((error: unknown) => {
				if (!isNotFound(error)) throw error;
			});
			await syncDirectory(directory);
		}
	}
}

async function readLockJson(path: string, handle: FileHandle, size: number): Promise<unknown> {
	if (size > MAX_LOCK_FILE_BYTES) {
		throw invalidLock(path, `Process lock at ${path} exceeds the byte limit`);
	}
	const buffer = Buffer.alloc(size);
	let bytesRead = 0;
	while (bytesRead < size) {
		const result = await handle.read(buffer, bytesRead, size - bytesRead, bytesRead);
		if (result.bytesRead === 0) break;
		bytesRead += result.bytesRead;
	}
	if (bytesRead !== size || (await handle.stat()).size !== size) {
		throw invalidLock(path, `Process lock at ${path} changed while it was being read`);
	}
	try {
		return JSON.parse(buffer.toString("utf8"));
	} catch (error) {
		throw invalidLock(path, `Process lock at ${path} is malformed`, error);
	}
}

async function removePublishedTemporaryLinks(path: string, handle: FileHandle): Promise<void> {
	const directory = dirname(path);
	const expected = await handle.stat();
	let removed = false;
	for (const name of await readdir(directory)) {
		if (!isLockTemporaryName(path, name)) continue;
		const candidate = join(directory, name);
		let candidateStats: Stats;
		try {
			candidateStats = await lstat(candidate);
		} catch (error) {
			if (isNotFound(error)) continue;
			throw error;
		}
		if (
			candidateStats.isSymbolicLink() ||
			!candidateStats.isFile() ||
			candidateStats.dev !== expected.dev ||
			candidateStats.ino !== expected.ino ||
			(candidateStats.mode & 0o777) !== 0o600 ||
			(process.getuid !== undefined && candidateStats.uid !== process.getuid())
		) {
			continue;
		}
		await assertPathReferencesHandle(candidate, handle);
		try {
			await unlink(candidate);
			removed = true;
		} catch (error) {
			if (!isNotFound(error)) throw error;
		}
	}
	if (removed) await syncDirectory(directory);
	await assertStableProcessLock(path, handle);
}

function isLockTemporaryName(path: string, name: string): boolean {
	const escapedName = basename(path).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(
		`^\\.${escapedName}\\.[1-9][0-9]*\\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.tmp$`,
	).test(name);
}

async function prepareLockDirectory(path: string): Promise<void> {
	if (!isAbsolute(path) || normalize(path) !== path || path.includes("\0")) {
		throw invalidLock(path, `Process lock path must be absolute and normalized: ${path}`);
	}
	try {
		await ensurePrivateStateDirectory(dirname(path));
	} catch (error) {
		throw invalidLock(
			path,
			`Process lock parent directory is not private and canonical: ${path}`,
			error,
		);
	}
}

async function validatePrivateRegularFile(path: string, handle: FileHandle): Promise<Stats> {
	const stats = await handle.stat();
	if (!stats.isFile()) throw invalidLock(path, `Process lock must be a regular file: ${path}`);
	if (stats.size > MAX_LOCK_FILE_BYTES) {
		throw invalidLock(path, `Process lock at ${path} exceeds the byte limit`);
	}
	if ((stats.mode & 0o777) !== 0o600) {
		throw invalidLock(path, `Process lock must have mode 0600: ${path}`);
	}
	if (process.getuid !== undefined && stats.uid !== process.getuid()) {
		throw invalidLock(path, `Process lock must be owned by the current user: ${path}`);
	}
	return stats;
}

function ownerMetadataPath(path: string): string {
	const filename = basename(path);
	const stem = filename.endsWith(".lock") ? filename.slice(0, -".lock".length) : filename;
	return join(dirname(path), `${stem}.owner.json`);
}

function invalidLock(path: string, message: string, cause?: unknown): ProcessLockError {
	return new ProcessLockError(
		"invalid_lock",
		path,
		message,
		undefined,
		cause === undefined ? undefined : { cause },
	);
}

function isUnsafeFileError(error: unknown): boolean {
	return ["EACCES", "EISDIR", "ELOOP", "EPERM"].includes(errorCode(error) ?? "");
}

function isAlreadyExists(error: unknown): boolean {
	return errorCode(error) === "EEXIST";
}

function isNotFound(error: unknown): boolean {
	return errorCode(error) === "ENOENT";
}

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? String(error.code)
		: undefined;
}
