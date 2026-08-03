import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { syncDirectory } from "./durable-file.js";

const lockMetadataSchema = z
	.object({
		schema_version: z.literal(1),
		lock_id: z.string().uuid(),
		pid: z.number().int().positive(),
		started_at: z.string().datetime({ offset: true }),
	})
	.strict();

type LockMetadata = z.infer<typeof lockMetadataSchema>;

export interface ProcessLock {
	readonly path: string;
	readonly metadata: Readonly<LockMetadata>;
	release(): Promise<void>;
}

export interface AcquireProcessLockOptions {
	readonly pid?: number;
	readonly now?: () => Date;
	readonly id?: () => string;
	readonly isProcessAlive?: (pid: number) => boolean;
}

export class ProcessLockError extends Error {
	constructor(
		readonly reason: "already_running" | "stale_lock" | "invalid_lock" | "unavailable",
		readonly path: string,
		message: string,
		readonly owner?: Readonly<LockMetadata>,
		options: ErrorOptions = {},
	) {
		super(message, options);
		this.name = "ProcessLockError";
	}
}

export async function acquireProcessLock(
	path: string,
	options: AcquireProcessLockOptions = {},
): Promise<ProcessLock> {
	const metadata = lockMetadataSchema.parse({
		schema_version: 1,
		lock_id: (options.id ?? randomUUID)(),
		pid: options.pid ?? process.pid,
		started_at: (options.now ?? (() => new Date()))().toISOString(),
	});
	const isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;

	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	for (let attempt = 0; attempt < 3; attempt += 1) {
		try {
			return await createLock(path, metadata);
		} catch (error) {
			if (!isAlreadyExists(error)) {
				throw new ProcessLockError(
					"unavailable",
					path,
					`Cannot acquire process lock at ${path}`,
					undefined,
					{
						cause: error,
					},
				);
			}
		}

		const existing = await readExistingLock(path);
		if (existing === null) continue;
		if (isProcessAlive(existing.pid)) {
			throw new ProcessLockError(
				"already_running",
				path,
				`AgentRelay Node is already running with PID ${existing.pid}`,
				existing,
			);
		}
		throw new ProcessLockError(
			"stale_lock",
			path,
			`Stale AgentRelay Node lock found for non-running PID ${existing.pid} at ${path}; remove it only after confirming no Node process is running`,
			existing,
		);
	}

	throw new ProcessLockError("unavailable", path, `Could not acquire process lock at ${path}`);
}

async function createLock(path: string, metadata: LockMetadata): Promise<ProcessLock> {
	const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
	try {
		await handle.chmod(0o600);
		await handle.writeFile(`${JSON.stringify(metadata, null, 2)}\n`, "utf8");
		await handle.sync();
		await syncDirectory(dirname(path));
	} catch (error) {
		await handle.close().catch(() => undefined);
		await unlink(path).catch(() => undefined);
		throw error;
	}

	let released = false;
	return {
		path,
		metadata: Object.freeze({ ...metadata }),
		async release(): Promise<void> {
			if (released) return;
			released = true;
			await handle.close();

			const current = await readExistingLock(path).catch(() => null);
			if (current?.lock_id !== metadata.lock_id) return;
			await unlink(path).catch((error: unknown) => {
				if (!isNotFound(error)) throw error;
			});
			await syncDirectory(dirname(path));
		},
	};
}

async function readExistingLock(path: string): Promise<LockMetadata | null> {
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (error) {
		if (isNotFound(error)) return null;
		throw new ProcessLockError(
			"unavailable",
			path,
			`Cannot read process lock at ${path}`,
			undefined,
			{
				cause: error,
			},
		);
	}

	let decoded: unknown;
	try {
		decoded = JSON.parse(raw);
	} catch (error) {
		throw new ProcessLockError(
			"invalid_lock",
			path,
			`Process lock at ${path} is malformed`,
			undefined,
			{
				cause: error,
			},
		);
	}
	const parsed = lockMetadataSchema.safeParse(decoded);
	if (!parsed.success) {
		throw new ProcessLockError(
			"invalid_lock",
			path,
			`Process lock at ${path} is invalid`,
			undefined,
			{
				cause: parsed.error,
			},
		);
	}
	return parsed.data;
}

function defaultIsProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return !isNoSuchProcess(error);
	}
}

function isAlreadyExists(error: unknown): boolean {
	return errorCode(error) === "EEXIST";
}

function isNotFound(error: unknown): boolean {
	return errorCode(error) === "ENOENT";
}

function isNoSuchProcess(error: unknown): boolean {
	return errorCode(error) === "ESRCH";
}

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? String(error.code)
		: undefined;
}
