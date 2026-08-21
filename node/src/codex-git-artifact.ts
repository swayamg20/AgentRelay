import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { type FileHandle, lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, normalize } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";

const MAX_TRUSTED_GIT_EXECUTABLE_BYTES = 64n * 1_048_576n;

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const filesystemIdentitySchema = z
	.object({ device: z.string().regex(/^\d+$/), inode: z.string().regex(/^\d+$/) })
	.strict();
const canonicalPathSchema = z
	.string()
	.min(1)
	.max(4_096)
	.refine((value) => !value.includes("\0"), "Path cannot contain NUL")
	.refine((value) => isAbsolute(value), "Path must be absolute")
	.refine((value) => normalize(value) === value, "Path must be normalized");

export const pinnedOwnerGitExecutableSchema = z
	.object({
		executable: z
			.object({ path: canonicalPathSchema, identity: filesystemIdentitySchema })
			.strict(),
		sha256: sha256Schema,
	})
	.strict();

export type PinnedOwnerGitExecutable = Readonly<z.infer<typeof pinnedOwnerGitExecutableSchema>>;

/** Pins one owner-selected Git executable through a stable, no-follow file handle. */
export async function pinOwnerGitExecutable(path: string): Promise<PinnedOwnerGitExecutable> {
	assertAbsoluteNormalizedPath(path);
	if ((await realpath(path)) !== path) {
		throw new Error("Owner-selected Git executable must use its canonical path");
	}

	let handle: FileHandle;
	try {
		handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	} catch (error) {
		throw new Error("Owner-selected Git executable cannot be opened safely", { cause: error });
	}
	try {
		const before = await handle.stat({ bigint: true });
		assertTrustedGitMetadata(before);
		await assertPathReferencesHandle(path, before);
		const sha256 = await sha256Handle(handle, before.size);
		const after = await handle.stat({ bigint: true });
		assertTrustedGitMetadata(after);
		assertStableMetadata(before, after);
		await assertPathReferencesHandle(path, after);
		return deepFreezePinnedGit({
			executable: {
				path,
				identity: { device: after.dev.toString(), inode: after.ino.toString() },
			},
			sha256,
		});
	} finally {
		await handle.close();
	}
}

/** Revalidates the exact owner-selected path, filesystem object, and digest. */
export async function assertPinnedOwnerGitExecutable(
	value: PinnedOwnerGitExecutable,
): Promise<void> {
	const expected = pinnedOwnerGitExecutableSchema.parse(value);
	const current = await pinOwnerGitExecutable(expected.executable.path);
	if (!isDeepStrictEqual(current, expected)) {
		throw new Error("Owner-selected Git executable changed after it was pinned");
	}
}

function assertAbsoluteNormalizedPath(path: string): void {
	if (
		!isAbsolute(path) ||
		normalize(path) !== path ||
		path.includes("\0") ||
		Buffer.byteLength(path, "utf8") > 4_096
	) {
		throw new Error("Owner-selected Git executable must be an absolute normalized path");
	}
}

function assertTrustedGitMetadata(stats: BigIntStats): void {
	const currentUid = process.getuid?.();
	if (
		currentUid === undefined ||
		!stats.isFile() ||
		stats.nlink !== 1n ||
		stats.size < 1n ||
		stats.size > MAX_TRUSTED_GIT_EXECUTABLE_BYTES ||
		(stats.uid !== 0n && stats.uid !== BigInt(currentUid)) ||
		(stats.mode & 0o111n) === 0n ||
		(stats.mode & 0o7022n) !== 0n
	) {
		throw new Error("Owner-selected Git executable is not a trusted executable file");
	}
}

async function assertPathReferencesHandle(path: string, handleStats: BigIntStats): Promise<void> {
	const pathStats = await lstat(path, { bigint: true });
	assertTrustedGitMetadata(pathStats);
	if (
		pathStats.isSymbolicLink() ||
		pathStats.dev !== handleStats.dev ||
		pathStats.ino !== handleStats.ino
	) {
		throw new Error("Owner-selected Git executable path changed during verification");
	}
	assertStableMetadata(handleStats, pathStats);
}

function assertStableMetadata(before: BigIntStats, after: BigIntStats): void {
	if (
		before.dev !== after.dev ||
		before.ino !== after.ino ||
		before.size !== after.size ||
		before.mode !== after.mode ||
		before.uid !== after.uid ||
		before.nlink !== after.nlink ||
		before.mtimeNs !== after.mtimeNs ||
		before.ctimeNs !== after.ctimeNs
	) {
		throw new Error("Owner-selected Git executable changed during verification");
	}
}

async function sha256Handle(handle: FileHandle, size: bigint): Promise<string> {
	const hash = createHash("sha256");
	const buffer = Buffer.allocUnsafe(64 * 1_024);
	let offset = 0n;
	while (offset < size) {
		const remaining = size - offset;
		const length = Number(remaining < BigInt(buffer.length) ? remaining : BigInt(buffer.length));
		const { bytesRead } = await handle.read(buffer, 0, length, Number(offset));
		if (bytesRead === 0) {
			throw new Error("Owner-selected Git executable changed during verification");
		}
		hash.update(buffer.subarray(0, bytesRead));
		offset += BigInt(bytesRead);
	}
	return hash.digest("hex");
}

function deepFreezePinnedGit(value: unknown): PinnedOwnerGitExecutable {
	const parsed = pinnedOwnerGitExecutableSchema.parse(value);
	return Object.freeze({
		executable: Object.freeze({
			path: parsed.executable.path,
			identity: Object.freeze({ ...parsed.executable.identity }),
		}),
		sha256: parsed.sha256,
	});
}
