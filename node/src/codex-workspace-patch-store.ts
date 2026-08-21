import { createHash, randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { link, lstat, mkdir, open, readdir, rename, rm, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
	CODEX_PATCH_MAX_BLOB_BYTES,
	CODEX_PATCH_MAX_TRANSACTION_BLOB_BYTES,
	type CodexPatchImage,
	type CodexPatchJournal,
	CodexWorkspacePatchError,
	codexPatchJournalSchema,
} from "./codex-workspace-patch-contract.js";
import { syncDirectory } from "./durable-file.js";
import {
	MAX_PRIVATE_STATE_FILE_BYTES,
	assertPrivateStateDirectory,
	ensurePrivateStateDirectory,
	readPrivateJsonIfPresent,
	writePrivateJson,
} from "./private-state-file.js";

// Terminal result/reason fields are bounded; reserve their worst-case pretty-JSON growth.
const CODEX_PATCH_TERMINAL_JOURNAL_RESERVE_BYTES = 2_048;
export const CODEX_PATCH_MAX_COMMIT_INTENT_JOURNAL_BYTES =
	MAX_PRIVATE_STATE_FILE_BYTES - CODEX_PATCH_TERMINAL_JOURNAL_RESERVE_BYTES;

export interface CodexWorkspacePatchStorePaths {
	readonly root: string;
	readonly lock: string;
	readonly compiler: string;
	readonly transactions: string;
}

export class CodexWorkspacePatchStore {
	readonly paths: CodexWorkspacePatchStorePaths;

	private constructor(paths: CodexWorkspacePatchStorePaths) {
		this.paths = Object.freeze({ ...paths });
	}

	static async open(controlRoot: string, workspaceIdentitySha256: string) {
		if (!/^[a-f0-9]{64}$/.test(workspaceIdentitySha256)) {
			throw new CodexWorkspacePatchError(
				"state_corrupt",
				true,
				"Workspace patch store identity is invalid",
			);
		}
		await assertPrivateStateDirectory(controlRoot);
		const base = join(controlRoot, ".workspace-patches");
		const root = join(base, workspaceIdentitySha256);
		await ensureDurablePrivateDirectory(base);
		await ensureDurablePrivateDirectory(root);
		const compiler = join(root, "compiler");
		const transactions = join(root, "transactions");
		await ensureDurablePrivateDirectory(compiler);
		await ensureDurablePrivateDirectory(transactions);
		return new CodexWorkspacePatchStore({
			root,
			lock: join(root, "patch.lock"),
			compiler,
			transactions,
		});
	}

	async cleanupAbandonedState(): Promise<void> {
		await assertPrivateStateDirectory(this.paths.transactions);
		await assertPrivateStateDirectory(this.paths.compiler);
		let changed = false;
		for (const name of await readdir(this.paths.transactions)) {
			if (!/^\.prepare-[a-f0-9]{64}-[0-9a-f-]{36}$/.test(name)) continue;
			const abandoned = join(this.paths.transactions, name);
			await assertPrivateStateDirectory(abandoned);
			await rm(abandoned, { recursive: true });
			changed = true;
		}
		if (changed) await syncDirectory(this.paths.transactions);

		changed = false;
		for (const name of await readdir(this.paths.compiler)) {
			if (!/^\.(?:compiler|head)-[A-Za-z0-9]{6}$/.test(name)) {
				throw corrupt("Patch compiler scratch entry is invalid");
			}
			const abandoned = join(this.paths.compiler, name);
			await assertPrivateStateDirectory(abandoned);
			await rm(abandoned, { recursive: true });
			changed = true;
		}
		if (changed) await syncDirectory(this.paths.compiler);
	}

	async listJournals(): Promise<readonly CodexPatchJournal[]> {
		await assertPrivateStateDirectory(this.paths.transactions);
		const names = (await readdir(this.paths.transactions)).sort();
		const journals: CodexPatchJournal[] = [];
		for (const name of names) {
			if (/^\.prepare-[a-f0-9]{64}-[0-9a-f-]{36}$/.test(name)) {
				await assertPrivateStateDirectory(join(this.paths.transactions, name));
				continue;
			}
			if (!/^[a-f0-9]{64}$/.test(name)) {
				throw corrupt("Patch transaction directory name is invalid");
			}
			const directory = this.transactionDirectory(name);
			const stats = await lstat(directory);
			if (!stats.isDirectory() || stats.isSymbolicLink()) {
				throw corrupt("Patch transaction path is not a real directory", name);
			}
			await assertPrivateStateDirectory(directory);
			const journal = await this.readJournal(name);
			if (journal === null) {
				throw corrupt("Patch transaction is missing its durable journal", name);
			}
			journals.push(journal);
		}
		return Object.freeze(journals);
	}

	async publishIntent(
		journalValue: CodexPatchJournal,
		blobs: ReadonlyMap<string, Buffer>,
	): Promise<void> {
		const parsed = codexPatchJournalSchema.safeParse(journalValue);
		if (!parsed.success || parsed.data.state !== "commit_intent") {
			throw corrupt("Refusing to publish an invalid patch commit intent", undefined, parsed.error);
		}
		assertCodexPatchJournalStorageBound(parsed.data);
		await this.publishNewJournal(parsed.data, blobs);
	}

	async publishRejected(journalValue: CodexPatchJournal): Promise<void> {
		const parsed = codexPatchJournalSchema.safeParse(journalValue);
		if (!parsed.success || parsed.data.state !== "rejected") {
			throw corrupt("Refusing to publish an invalid patch rejection", undefined, parsed.error);
		}
		await this.publishNewJournal(parsed.data, new Map());
	}

	private async publishNewJournal(
		journal: CodexPatchJournal,
		blobs: ReadonlyMap<string, Buffer>,
	): Promise<void> {
		validateBlobs(journal, blobs);
		const finalDirectory = this.transactionDirectory(journal.transaction_id);
		try {
			await lstat(finalDirectory);
			throw corrupt("Patch transaction already exists", journal.transaction_id);
		} catch (error) {
			if (error instanceof CodexWorkspacePatchError) throw error;
			if (errorCode(error) !== "ENOENT") throw error;
		}

		const preparationDirectory = join(
			this.paths.transactions,
			`.prepare-${journal.transaction_id}-${randomUUID()}`,
		);
		let preparationExists = false;
		try {
			await ensureDurablePrivateDirectory(preparationDirectory);
			preparationExists = true;
			const blobsDirectory = join(preparationDirectory, "blobs");
			await ensureDurablePrivateDirectory(blobsDirectory);
			for (const [sha256, bytes] of blobs) {
				await publishPrivateBufferExclusive(join(blobsDirectory, `${sha256}.bin`), bytes);
			}
			await writePrivateJson(join(preparationDirectory, "state.json"), journal);
			await syncDirectory(preparationDirectory);
			await rename(preparationDirectory, finalDirectory);
			preparationExists = false;
			await syncDirectory(this.paths.transactions);
		} finally {
			if (preparationExists) {
				await rm(preparationDirectory, { recursive: true }).catch(() => undefined);
				await syncDirectory(this.paths.transactions).catch(() => undefined);
			}
		}
		const persisted = await this.readJournal(journal.transaction_id);
		if (persisted === null || !isDeepStrictEqual(persisted, journal)) {
			throw corrupt("Patch transaction journal durable readback failed", journal.transaction_id);
		}
		for (const change of journal.changes) {
			if (change.before !== null) await this.readBlob(journal.transaction_id, change.before);
			if (change.after !== null) await this.readBlob(journal.transaction_id, change.after);
		}
	}

	async readJournal(transactionId: string): Promise<CodexPatchJournal | null> {
		assertTransactionId(transactionId);
		const directory = this.transactionDirectory(transactionId);
		try {
			const stats = await lstat(directory);
			if (!stats.isDirectory() || stats.isSymbolicLink()) {
				throw corrupt("Patch transaction path is not a real directory", transactionId);
			}
			await assertPrivateStateDirectory(directory);
		} catch (error) {
			if (error instanceof CodexWorkspacePatchError) throw error;
			if (errorCode(error) === "ENOENT") return null;
			throw corrupt("Patch transaction directory is missing or unsafe", transactionId, error);
		}
		let decoded: unknown | null;
		try {
			decoded = await readPrivateJsonIfPresent(this.journalPath(transactionId));
		} catch (error) {
			throw corrupt("Patch transaction journal is missing or unsafe", transactionId, error);
		}
		if (decoded === null) {
			throw corrupt("Patch transaction is missing its durable journal", transactionId);
		}
		const parsed = codexPatchJournalSchema.safeParse(decoded);
		if (!parsed.success || parsed.data.transaction_id !== transactionId) {
			throw corrupt("Patch transaction journal is invalid", transactionId, parsed.error);
		}
		return Object.freeze(parsed.data);
	}

	async writeJournal(journalValue: CodexPatchJournal): Promise<void> {
		const parsed = codexPatchJournalSchema.safeParse(journalValue);
		if (!parsed.success) {
			throw corrupt(
				"Refusing to persist an invalid patch transaction journal",
				undefined,
				parsed.error,
			);
		}
		const journal = parsed.data;
		const directory = this.transactionDirectory(journal.transaction_id);
		const existing = await this.readJournal(journal.transaction_id);
		if (existing === null) {
			throw corrupt("Patch transaction journal does not exist", journal.transaction_id);
		}
		if (!isDeepStrictEqual(immutableJournalBody(existing), immutableJournalBody(journal))) {
			throw corrupt("Patch transaction immutable fields changed", journal.transaction_id);
		}
		if (existing.state !== "commit_intent") {
			if (isDeepStrictEqual(existing, journal)) return;
			throw corrupt("Patch transaction terminal state is immutable", journal.transaction_id);
		}
		if (journal.state !== "committed" && journal.state !== "indeterminate") {
			throw corrupt("Patch transaction state transition is invalid", journal.transaction_id);
		}
		await assertPrivateStateDirectory(directory);
		await writePrivateJson(this.journalPath(journal.transaction_id), journal);
		const persisted = await this.readJournal(journal.transaction_id);
		if (persisted === null || !isDeepStrictEqual(persisted, journal)) {
			throw corrupt("Patch transaction terminal readback failed", journal.transaction_id);
		}
	}

	async readBlob(transactionId: string, image: CodexPatchImage): Promise<Buffer> {
		assertTransactionId(transactionId);
		try {
			await assertPrivateStateDirectory(this.transactionDirectory(transactionId));
			await assertPrivateStateDirectory(this.blobsDirectory(transactionId));
		} catch (error) {
			throw corrupt("Patch transaction blob directory is missing or unsafe", transactionId, error);
		}
		const path = join(this.blobsDirectory(transactionId), `${image.blob_sha256}.bin`);
		let pathStats: BigIntStats;
		try {
			pathStats = await lstat(path, { bigint: true });
			assertBlobMetadata(pathStats, image, transactionId);
		} catch (error) {
			if (error instanceof CodexWorkspacePatchError) throw error;
			throw corrupt("Patch transaction blob is missing or unsafe", transactionId, error);
		}
		let handle: Awaited<ReturnType<typeof open>>;
		try {
			handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		} catch (error) {
			throw corrupt("Patch transaction blob is missing or unsafe", transactionId, error);
		}
		try {
			const opened = await handle.stat({ bigint: true });
			assertBlobMetadata(opened, image, transactionId);
			if (!sameFileIdentity(pathStats, opened)) {
				throw corrupt("Patch transaction blob changed while opening", transactionId);
			}
			const bytes = await handle.readFile();
			if (bytes.length !== image.byte_length || sha256Buffer(bytes) !== image.blob_sha256) {
				throw corrupt("Patch transaction blob content is invalid", transactionId);
			}
			const after = await handle.stat({ bigint: true });
			assertBlobMetadata(after, image, transactionId);
			let finalPathStats: BigIntStats;
			try {
				finalPathStats = await lstat(path, { bigint: true });
			} catch (error) {
				throw corrupt("Patch transaction blob changed while reading", transactionId, error);
			}
			assertBlobMetadata(finalPathStats, image, transactionId);
			if (!sameFileIdentity(opened, after) || !sameFileIdentity(after, finalPathStats)) {
				throw corrupt("Patch transaction blob changed while reading", transactionId);
			}
			return bytes;
		} finally {
			await handle.close();
		}
	}

	private transactionDirectory(transactionId: string): string {
		assertTransactionId(transactionId);
		return join(this.paths.transactions, transactionId);
	}

	private blobsDirectory(transactionId: string): string {
		return join(this.transactionDirectory(transactionId), "blobs");
	}

	private journalPath(transactionId: string): string {
		return join(this.transactionDirectory(transactionId), "state.json");
	}
}

export function assertCodexPatchJournalStorageBound(journal: CodexPatchJournal): void {
	const serialized = JSON.stringify(journal, null, 2);
	if (
		serialized === undefined ||
		Buffer.byteLength(`${serialized}\n`, "utf8") > CODEX_PATCH_MAX_COMMIT_INTENT_JOURNAL_BYTES
	) {
		throw new CodexWorkspacePatchError(
			"unsupported_patch",
			true,
			"Patch plan exceeds the durable journal byte limit",
			journal.transaction_id,
		);
	}
}

function validateBlobs(journal: CodexPatchJournal, blobs: ReadonlyMap<string, Buffer>): void {
	const expected = new Map<string, number>();
	for (const change of journal.changes) {
		for (const image of [change.before, change.after]) {
			if (image !== null) expected.set(image.blob_sha256, image.byte_length);
		}
	}
	if (blobs.size !== expected.size) {
		throw corrupt("Patch transaction blob set is incomplete", journal.transaction_id);
	}
	let total = 0;
	for (const [sha256, bytes] of blobs) {
		if (!/^[a-f0-9]{64}$/.test(sha256) || sha256Buffer(bytes) !== sha256) {
			throw corrupt("Patch blob digest does not match its content", journal.transaction_id);
		}
		if (bytes.length > CODEX_PATCH_MAX_BLOB_BYTES || expected.get(sha256) !== bytes.length) {
			throw corrupt("Patch blob does not match its journal image", journal.transaction_id);
		}
		total += bytes.length;
	}
	if (total > CODEX_PATCH_MAX_TRANSACTION_BLOB_BYTES) {
		throw corrupt(
			"Patch transaction blobs exceed the aggregate byte limit",
			journal.transaction_id,
		);
	}
}

function immutableJournalBody(journal: CodexPatchJournal): unknown {
	const { state: _state, result: _result, reason: _reason, ...body } = journal;
	return body;
}

function assertBlobMetadata(
	stats: BigIntStats,
	image: CodexPatchImage,
	transactionId: string,
): void {
	const uid = process.getuid?.();
	if (
		!stats.isFile() ||
		stats.isSymbolicLink() ||
		stats.nlink !== 1n ||
		Number(stats.mode & 0o777n) !== 0o600 ||
		(uid !== undefined && stats.uid !== BigInt(uid)) ||
		stats.size !== BigInt(image.byte_length) ||
		stats.size > BigInt(CODEX_PATCH_MAX_BLOB_BYTES)
	) {
		throw corrupt("Patch transaction blob metadata is invalid", transactionId);
	}
}

function sameFileIdentity(left: BigIntStats, right: BigIntStats): boolean {
	return left.dev === right.dev && left.ino === right.ino && left.nlink === right.nlink;
}

async function ensureDurablePrivateDirectory(path: string): Promise<void> {
	let created = false;
	try {
		await mkdir(path, { mode: 0o700 });
		created = true;
	} catch (error) {
		if (errorCode(error) !== "EEXIST") throw error;
	}
	await ensurePrivateStateDirectory(path);
	if (created) await syncDirectory(dirname(path));
}

async function publishPrivateBufferExclusive(path: string, bytes: Buffer): Promise<void> {
	await ensurePrivateStateDirectory(dirname(path));
	const temporaryPath = join(
		dirname(path),
		`.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
	);
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
			await handle.writeFile(bytes);
			await handle.sync();
		} finally {
			await handle.close();
		}
		try {
			await link(temporaryPath, path);
		} catch (error) {
			if (errorCode(error) !== "EEXIST") throw error;
		}
	} finally {
		if (temporaryExists) {
			await unlink(temporaryPath).catch((error: unknown) => {
				if (errorCode(error) !== "ENOENT") throw error;
			});
			await syncDirectory(dirname(path));
		}
	}
}

function assertTransactionId(value: string): void {
	if (!/^[a-f0-9]{64}$/.test(value)) {
		throw corrupt("Patch transaction ID is invalid");
	}
}

function sha256Buffer(value: Buffer): string {
	return createHash("sha256").update(value).digest("hex");
}

function corrupt(message: string, transactionId?: string, cause?: unknown) {
	return new CodexWorkspacePatchError(
		"state_corrupt",
		true,
		message,
		transactionId,
		cause === undefined ? undefined : { cause },
	);
}

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? String(error.code)
		: undefined;
}
