import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, type BigIntStats, type Stats } from "node:fs";
import { type FileHandle, lstat, mkdir, mkdtemp, open, realpath, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { inflateSync } from "node:zlib";
import {
	CODEX_PATCH_GIT_TIMEOUT_MS,
	CODEX_PATCH_MAX_BLOB_BYTES,
	CODEX_PATCH_MAX_GIT_OUTPUT_BYTES,
	CODEX_PATCH_MAX_PATHS,
	CODEX_PATCH_MAX_TRANSACTION_BLOB_BYTES,
	type CodexPatchChange,
	type CodexPatchImage,
	CodexWorkspacePatchError,
	validateCodexPatchPath,
} from "./codex-workspace-patch-contract.js";
import type { LocalFilesystemIdentity } from "./mission-workspace.js";
import { assertPrivateStateDirectory } from "./private-state-file.js";

export interface ExactRegularFileSnapshot {
	readonly image: CodexPatchImage;
	readonly bytes: Buffer;
}

export interface CompiledCodexWorkspacePatch {
	readonly headCommit: string;
	readonly createdDirectories: readonly string[];
	readonly changes: readonly CodexPatchChange[];
	readonly blobs: ReadonlyMap<string, Buffer>;
}

export interface CompileCodexWorkspacePatchInput {
	readonly gitExecutable: string;
	readonly workspaceRoot: string;
	readonly workspaceIdentity: LocalFilesystemIdentity;
	readonly compilerRoot: string;
	readonly transactionId: string;
	readonly patch: string;
}

interface GitResult {
	readonly stdout: Buffer;
}

interface GitIndexEntry {
	readonly mode: 0o644 | 0o755;
	readonly objectId: string;
}

export async function compileCodexWorkspacePatch(
	input: CompileCodexWorkspacePatchInput,
): Promise<CompiledCodexWorkspacePatch> {
	assertSafePatchHeaders(input.patch);
	await assertTrustedGitExecutable(input.gitExecutable);
	await assertExactWorkspaceRoot(input.workspaceRoot, input.workspaceIdentity);
	await mkdir(input.compilerRoot, { recursive: true, mode: 0o700 });
	await assertCompilerRoot(input.compilerRoot);
	const sessionRoot = await mkdtemp(join(input.compilerRoot, ".compiler-"));
	await safeMode(sessionRoot, 0o700);
	const repository = join(sessionRoot, "repository");
	const home = join(sessionRoot, "home");
	const temporary = join(sessionRoot, "tmp");
	const xdg = join(sessionRoot, "xdg");
	await Promise.all(
		[repository, home, temporary, xdg].map(async (path) => {
			await mkdir(path, { mode: 0o700 });
			await safeMode(path, 0o700);
		}),
	);
	const environment = gitEnvironment({ home, temporary, xdg });

	try {
		const numstatPaths = parseNumstatPaths(
			(
				await runGit({
					executable: input.gitExecutable,
					args: ["apply", "--numstat", "-z", "--no-index", "-p1", "--whitespace=nowarn", "-"],
					cwd: sessionRoot,
					environment,
					stdin: Buffer.from(input.patch, "utf8"),
					failure: "patch_not_applicable",
					fatal: false,
					description: "numstat validation",
				})
			).stdout,
		);
		const touchedPaths = uniqueBoundedPaths([
			...numstatPaths,
			...parseExtendedHeaderPaths(input.patch),
		]);
		const headCommit = decodeObjectId(
			(
				await runGit({
					executable: input.gitExecutable,
					args: ["rev-parse", "--verify", "HEAD^{commit}"],
					cwd: input.workspaceRoot,
					environment,
					failure: "compiler_failure",
					fatal: true,
				})
			).stdout,
			"compiler_failure",
		);

		const before = new Map<string, ExactRegularFileSnapshot | null>();
		const internedPreimages = new Map<string, Buffer>();
		let preimageBytes = 0;
		for (const path of touchedPaths) {
			const snapshot = await readExactRegularFile(
				input.workspaceRoot,
				input.workspaceIdentity,
				path,
			);
			if (snapshot === null) {
				before.set(path, null);
				continue;
			}
			const interned = internedPreimages.get(snapshot.image.blob_sha256);
			if (interned === undefined) {
				preimageBytes += snapshot.bytes.length;
				if (preimageBytes > CODEX_PATCH_MAX_TRANSACTION_BLOB_BYTES) {
					throw new CodexWorkspacePatchError(
						"unsupported_patch",
						true,
						"Patch preimages exceed the aggregate blob byte limit",
						input.transactionId,
					);
				}
				internedPreimages.set(snapshot.image.blob_sha256, snapshot.bytes);
			}
			before.set(path, Object.freeze({ image: snapshot.image, bytes: interned ?? snapshot.bytes }));
		}
		assertNoFileDirectoryTransitions(touchedPaths);

		await runGit({
			executable: input.gitExecutable,
			args: [
				"init",
				`--object-format=${headCommit.length === 64 ? "sha256" : "sha1"}`,
				"--template=",
				repository,
			],
			cwd: sessionRoot,
			environment,
			failure: "unsupported_patch",
			fatal: true,
		});
		const initialIndex = new Map<string, GitIndexEntry>();
		for (const [path, snapshot] of before) {
			if (snapshot === null) continue;
			await writeCompilerFile(repository, path, snapshot);
			const objectId = decodeObjectId(
				(
					await runGit({
						executable: input.gitExecutable,
						args: ["hash-object", "-w", "--stdin"],
						cwd: repository,
						environment,
						stdin: snapshot.bytes,
						failure: "unsupported_patch",
						fatal: true,
					})
				).stdout,
			);
			initialIndex.set(path, { mode: snapshot.image.mode, objectId });
		}
		if (initialIndex.size > 0) {
			await runGit({
				executable: input.gitExecutable,
				args: ["update-index", "-z", "--index-info"],
				cwd: repository,
				environment,
				stdin: encodeIndexInfo(initialIndex),
				failure: "unsupported_patch",
				fatal: true,
			});
			await runGit({
				executable: input.gitExecutable,
				args: ["update-index", "--refresh", "--"],
				cwd: repository,
				environment,
				failure: "unsupported_patch",
				fatal: true,
			});
		}

		await runGit({
			executable: input.gitExecutable,
			args: [
				"-c",
				"core.autocrlf=false",
				"-c",
				"core.safecrlf=false",
				"-c",
				"core.fileMode=true",
				"-c",
				"core.attributesFile=/dev/null",
				"apply",
				"--index",
				"--binary",
				"--whitespace=nowarn",
				"-p1",
				"-",
			],
			cwd: repository,
			environment,
			stdin: Buffer.from(input.patch, "utf8"),
			failure: "patch_not_applicable",
			fatal: false,
			description: "synthetic-index application",
		});

		await runGit({
			executable: input.gitExecutable,
			args: ["diff-files", "--quiet", "--"],
			cwd: repository,
			environment,
			failure: "unsupported_patch",
			fatal: true,
		});
		const untracked = await runGit({
			executable: input.gitExecutable,
			args: ["ls-files", "--others", "--exclude-standard", "-z", "--"],
			cwd: repository,
			environment,
			failure: "unsupported_patch",
			fatal: true,
		});
		if (untracked.stdout.length !== 0) {
			throw new CodexWorkspacePatchError(
				"unsupported_patch",
				true,
				"Patch compiler produced an untracked output",
				input.transactionId,
			);
		}

		const finalIndex = parseIndexEntries(
			(
				await runGit({
					executable: input.gitExecutable,
					args: ["ls-files", "--stage", "-z", "--"],
					cwd: repository,
					environment,
					failure: "unsupported_patch",
					fatal: true,
				})
			).stdout,
		);
		const repositoryStats = await lstat(repository, { bigint: true });
		const repositoryIdentity = {
			device: repositoryStats.dev.toString(),
			inode: repositoryStats.ino.toString(),
		};
		for (const [path, entry] of finalIndex) {
			await normalizeCompilerFileMode(repository, repositoryIdentity, path, entry.mode);
		}
		for (const path of finalIndex.keys()) {
			if (!before.has(path)) {
				throw new CodexWorkspacePatchError(
					"unsupported_patch",
					true,
					"Patch compiler produced an unexpected path",
					input.transactionId,
				);
			}
		}

		const blobs = new Map<string, Buffer>();
		const unorderedChanges: Array<Omit<CodexPatchChange, "temporary_name">> = [];
		for (const path of touchedPaths) {
			const previous = before.get(path) ?? null;
			const entry = finalIndex.get(path);
			const next =
				entry === undefined
					? null
					: await readExactRegularFile(repository, repositoryIdentity, path);
			if (entry !== undefined && next === null) {
				throw new CodexWorkspacePatchError(
					"unsupported_patch",
					true,
					"Patch compiler output is missing",
					input.transactionId,
				);
			}
			if (
				entry !== undefined &&
				next !== null &&
				(entry.mode !== next.image.mode ||
					entry.objectId !== gitObjectId(next.bytes, entry.objectId.length))
			) {
				throw new CodexWorkspacePatchError(
					"unsupported_patch",
					true,
					"Patch compiler index and output disagree",
					input.transactionId,
				);
			}
			if (sameImage(previous?.image ?? null, next?.image ?? null)) continue;
			if (previous !== null) blobs.set(previous.image.blob_sha256, previous.bytes);
			if (next !== null) blobs.set(next.image.blob_sha256, next.bytes);
			assertBlobBounds(blobs, input.transactionId);
			unorderedChanges.push({
				path,
				operation: next === null ? "delete" : "write",
				before: previous?.image ?? null,
				after: next?.image ?? null,
			});
		}
		if (unorderedChanges.length === 0) {
			throw new CodexWorkspacePatchError(
				"patch_not_applicable",
				false,
				"Patch does not change the current workspace",
				input.transactionId,
			);
		}
		const ordered = orderChanges(unorderedChanges).map(
			(change, index): CodexPatchChange => ({
				...change,
				temporary_name:
					change.operation === "write" ? `.agentrelay-patch-${input.transactionId}-${index}` : null,
			}),
		);
		const createdDirectories = await findCreatedDirectories(
			input.workspaceRoot,
			input.workspaceIdentity,
			ordered,
		);
		return Object.freeze({
			headCommit,
			createdDirectories: Object.freeze(createdDirectories),
			changes: Object.freeze(ordered.map((change) => Object.freeze(change))),
			blobs,
		});
	} finally {
		await rm(sessionRoot, { recursive: true, force: true });
	}
}

export async function readCodexWorkspaceHead(input: {
	readonly gitExecutable: string;
	readonly workspaceRoot: string;
	readonly workspaceIdentity: LocalFilesystemIdentity;
	readonly compilerRoot: string;
}): Promise<string> {
	await assertTrustedGitExecutable(input.gitExecutable);
	await assertExactWorkspaceRoot(input.workspaceRoot, input.workspaceIdentity);
	await mkdir(input.compilerRoot, { recursive: true, mode: 0o700 });
	await assertCompilerRoot(input.compilerRoot);
	const sessionRoot = await mkdtemp(join(input.compilerRoot, ".head-"));
	await safeMode(sessionRoot, 0o700);
	const home = join(sessionRoot, "home");
	const temporary = join(sessionRoot, "tmp");
	const xdg = join(sessionRoot, "xdg");
	await Promise.all(
		[home, temporary, xdg].map(async (path) => {
			await mkdir(path, { mode: 0o700 });
			await safeMode(path, 0o700);
		}),
	);
	try {
		return decodeObjectId(
			(
				await runGit({
					executable: input.gitExecutable,
					args: ["rev-parse", "--verify", "HEAD^{commit}"],
					cwd: input.workspaceRoot,
					environment: gitEnvironment({ home, temporary, xdg }),
					failure: "compiler_failure",
					fatal: true,
				})
			).stdout,
			"compiler_failure",
		);
	} finally {
		await rm(sessionRoot, { recursive: true, force: true });
	}
}

export async function assertTrustedGitExecutable(path: string): Promise<void> {
	if (!isAbsolute(path) || normalize(path) !== path || path.includes("\0")) {
		throw new CodexWorkspacePatchError(
			"compiler_failure",
			true,
			"Patch compiler Git executable must be absolute and normalized",
		);
	}
	if ((await realpath(path)) !== path) {
		throw new CodexWorkspacePatchError(
			"compiler_failure",
			true,
			"Patch compiler Git executable must use its canonical path",
		);
	}
	const stats = await lstat(path);
	if (
		!stats.isFile() ||
		stats.isSymbolicLink() ||
		(stats.mode & 0o111) === 0 ||
		(stats.mode & 0o7022) !== 0
	) {
		throw new CodexWorkspacePatchError(
			"compiler_failure",
			true,
			"Patch compiler Git executable is not trusted",
		);
	}
	const uid = process.getuid?.();
	if (uid !== undefined && stats.uid !== 0 && stats.uid !== uid) {
		throw new CodexWorkspacePatchError(
			"compiler_failure",
			true,
			"Patch compiler Git executable has an untrusted owner",
		);
	}
}

export async function assertExactWorkspaceRoot(
	root: string,
	identity: LocalFilesystemIdentity,
): Promise<void> {
	const stats = await lstat(root, { bigint: true });
	if (
		!stats.isDirectory() ||
		stats.isSymbolicLink() ||
		stats.dev.toString() !== identity.device ||
		stats.ino.toString() !== identity.inode ||
		(await realpath(root)) !== root
	) {
		throw new CodexWorkspacePatchError(
			"workspace_changed",
			true,
			"Workspace root identity changed",
		);
	}
	assertOwnedMode(stats, "Workspace root");
}

export async function readExactRegularFile(
	root: string,
	rootIdentity: LocalFilesystemIdentity,
	path: string,
	options: { readonly allowReservedTemporary?: boolean } = {},
): Promise<ExactRegularFileSnapshot | null> {
	if (options.allowReservedTemporary === true) {
		validateReservedTemporaryPath(path);
	} else {
		validateCodexPatchPath(path);
	}
	await assertExactWorkspaceRoot(root, rootIdentity);
	await assertPathAncestors(root, rootIdentity, path);
	const target = join(root, path);
	let pathStats: BigIntStats;
	try {
		pathStats = await lstat(target, { bigint: true });
	} catch (error) {
		if (errorCode(error) === "ENOENT") return null;
		if (isPathRaceError(error)) {
			throw new CodexWorkspacePatchError(
				"workspace_changed",
				true,
				"Patch target changed while it was being inspected",
				undefined,
				{ cause: error },
			);
		}
		throw new CodexWorkspacePatchError(
			"compiler_failure",
			true,
			"Patch target could not be inspected",
			undefined,
			{ cause: error },
		);
	}
	if (pathStats.isSymbolicLink() || !pathStats.isFile() || pathStats.nlink !== 1n) {
		throw new CodexWorkspacePatchError(
			"unsupported_patch",
			true,
			"Patch targets must be unlinked regular files",
		);
	}
	assertOwnedMode(pathStats, "Patch target");
	if (String(pathStats.dev) !== rootIdentity.device) {
		throw new CodexWorkspacePatchError(
			"unsupported_patch",
			true,
			"Patch targets must remain on the workspace filesystem",
		);
	}
	const mode = Number(pathStats.mode & 0o7777n);
	if (mode !== 0o644 && mode !== 0o755) {
		throw new CodexWorkspacePatchError(
			"unsupported_patch",
			true,
			"Patch targets support only modes 0644 and 0755",
		);
	}
	if (pathStats.size > BigInt(CODEX_PATCH_MAX_BLOB_BYTES)) {
		throw new CodexWorkspacePatchError(
			"unsupported_patch",
			true,
			"Patch target exceeds the blob byte limit",
		);
	}

	let handle: FileHandle | undefined;
	try {
		try {
			handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
		} catch (error) {
			if (!isPathRaceError(error)) {
				throw new CodexWorkspacePatchError(
					"compiler_failure",
					true,
					"Patch target could not be opened",
					undefined,
					{ cause: error },
				);
			}
			throw new CodexWorkspacePatchError(
				"workspace_changed",
				true,
				"Patch target changed while it was being opened",
				undefined,
				{ cause: error },
			);
		}
		const opened = await handle.stat({ bigint: true });
		if (
			!opened.isFile() ||
			opened.nlink !== 1n ||
			opened.dev !== pathStats.dev ||
			opened.ino !== pathStats.ino ||
			opened.size !== pathStats.size ||
			Number(opened.mode & 0o7777n) !== mode
		) {
			throw new CodexWorkspacePatchError(
				"workspace_changed",
				true,
				"Patch target changed while it was being read",
			);
		}
		assertOwnedMode(opened, "Patch target");
		const bytes = await handle.readFile();
		const after = await handle.stat({ bigint: true });
		if (
			after.dev !== opened.dev ||
			after.ino !== opened.ino ||
			after.nlink !== 1n ||
			after.size !== opened.size ||
			after.mode !== opened.mode ||
			after.uid !== opened.uid ||
			after.mtimeNs !== opened.mtimeNs ||
			after.ctimeNs !== opened.ctimeNs ||
			bytes.length !== Number(opened.size)
		) {
			throw new CodexWorkspacePatchError(
				"workspace_changed",
				true,
				"Patch target changed while it was being read",
			);
		}
		let finalPathStats: BigIntStats;
		try {
			finalPathStats = await lstat(target, { bigint: true });
		} catch (error) {
			if (!isPathRaceError(error)) {
				throw new CodexWorkspacePatchError(
					"compiler_failure",
					true,
					"Patch target could not be inspected after reading",
					undefined,
					{ cause: error },
				);
			}
			throw new CodexWorkspacePatchError(
				"workspace_changed",
				true,
				"Patch target changed while it was being read",
				undefined,
				{ cause: error },
			);
		}
		if (
			finalPathStats.isSymbolicLink() ||
			!finalPathStats.isFile() ||
			finalPathStats.dev !== after.dev ||
			finalPathStats.ino !== after.ino ||
			finalPathStats.nlink !== 1n ||
			finalPathStats.size !== after.size ||
			finalPathStats.mode !== after.mode ||
			finalPathStats.uid !== after.uid
		) {
			throw new CodexWorkspacePatchError(
				"workspace_changed",
				true,
				"Patch target changed while it was being read",
			);
		}
		const sha256 = createHash("sha256").update(bytes).digest("hex");
		return Object.freeze({
			image: Object.freeze({ blob_sha256: sha256, byte_length: bytes.length, mode }),
			bytes,
		});
	} catch (error) {
		if (error instanceof CodexWorkspacePatchError) throw error;
		throw new CodexWorkspacePatchError(
			"compiler_failure",
			true,
			"Patch target could not be read",
			undefined,
			{ cause: error },
		);
	} finally {
		await handle?.close();
	}
}

export async function assertPathAncestors(
	root: string,
	rootIdentity: LocalFilesystemIdentity,
	path: string,
): Promise<void> {
	const parent = dirname(path);
	if (parent === ".") return;
	let current = root;
	for (const segment of parent.split("/")) {
		current = join(current, segment);
		let stats: Awaited<ReturnType<typeof lstat>>;
		try {
			stats = await lstat(current);
		} catch (error) {
			if (errorCode(error) === "ENOENT") return;
			throw error;
		}
		if (!stats.isDirectory() || stats.isSymbolicLink()) {
			throw new CodexWorkspacePatchError(
				"unsafe_path",
				true,
				"Patch path ancestors must be real directories",
			);
		}
		assertOwnedMode(stats, "Patch path ancestor");
		if (String(stats.dev) !== rootIdentity.device) {
			throw new CodexWorkspacePatchError(
				"unsafe_path",
				true,
				"Patch path ancestors must remain on the workspace filesystem",
			);
		}
	}
}

function parseNumstatPaths(output: Buffer): readonly string[] {
	const paths: string[] = [];
	let offset = 0;
	while (offset < output.length) {
		const firstTab = output.indexOf(0x09, offset);
		const secondTab = firstTab < 0 ? -1 : output.indexOf(0x09, firstTab + 1);
		const terminator = secondTab < 0 ? -1 : output.indexOf(0x00, secondTab + 1);
		if (firstTab < 0 || secondTab < 0 || terminator < 0) {
			throw unsafeCompilerOutput("Patch compiler numstat output is malformed");
		}
		const added = output.subarray(offset, firstTab).toString("ascii");
		const deleted = output.subarray(firstTab + 1, secondTab).toString("ascii");
		if (!/^(?:[0-9]+|-)$/.test(added) || !/^(?:[0-9]+|-)$/.test(deleted)) {
			throw unsafeCompilerOutput("Patch compiler numstat counts are malformed");
		}
		const path = output.subarray(secondTab + 1, terminator);
		offset = terminator + 1;
		if (path.length === 0) {
			const oldEnd = output.indexOf(0x00, offset);
			const newEnd = oldEnd < 0 ? -1 : output.indexOf(0x00, oldEnd + 1);
			if (oldEnd < 0 || newEnd < 0) {
				throw unsafeCompilerOutput("Patch compiler rename output is malformed");
			}
			paths.push(decodePath(output.subarray(offset, oldEnd)));
			paths.push(decodePath(output.subarray(oldEnd + 1, newEnd)));
			offset = newEnd + 1;
		} else {
			paths.push(decodePath(path));
		}
	}
	return uniqueBoundedPaths(paths);
}

function uniqueBoundedPaths(paths: readonly string[]): readonly string[] {
	const unique = [...new Set(paths)];
	if (unique.length === 0 || unique.length > CODEX_PATCH_MAX_PATHS) {
		throw new CodexWorkspacePatchError(
			"unsafe_path",
			true,
			"Patch path count is outside the supported bounds",
		);
	}
	return Object.freeze(unique);
}

function parseExtendedHeaderPaths(patch: string): readonly string[] {
	const paths: string[] = [];
	let extendedHeader = false;
	for (const line of patch.split("\n")) {
		if (line.startsWith("diff --git ")) {
			extendedHeader = true;
			continue;
		}
		if (!extendedHeader) continue;
		if (
			line.startsWith("--- ") ||
			line.startsWith("+++ ") ||
			line.startsWith("@@ ") ||
			line === "GIT binary patch"
		) {
			extendedHeader = false;
			continue;
		}
		for (const prefix of ["rename from ", "rename to ", "copy from ", "copy to "]) {
			if (!line.startsWith(prefix)) continue;
			paths.push(validateCodexPatchPath(decodeGitHeaderPath(line.slice(prefix.length))));
			break;
		}
	}
	return Object.freeze(paths);
}

function decodeGitHeaderPath(value: string): string {
	if (!value.startsWith('"')) return value;
	if (!value.endsWith('"') || value.length < 2) {
		throw new CodexWorkspacePatchError("unsafe_path", true, "Quoted patch path is malformed");
	}
	const bytes: number[] = [];
	const inner = value.slice(1, -1);
	for (let index = 0; index < inner.length; index += 1) {
		const character = inner[index] ?? "";
		if (character !== "\\") {
			const codePoint = inner.codePointAt(index);
			if (codePoint === undefined) {
				throw new CodexWorkspacePatchError("unsafe_path", true, "Quoted patch path is malformed");
			}
			const decoded = String.fromCodePoint(codePoint);
			const encoded = Buffer.from(decoded, "utf8");
			for (const byte of encoded) bytes.push(byte);
			if (decoded.length === 2) index += 1;
			continue;
		}
		const escaped = inner[index + 1];
		if (escaped === undefined) {
			throw new CodexWorkspacePatchError("unsafe_path", true, "Quoted patch path is malformed");
		}
		const named = GIT_PATH_ESCAPES[escaped];
		if (named !== undefined) {
			bytes.push(named);
			index += 1;
			continue;
		}
		if (/[0-7]/.test(escaped)) {
			let octal = escaped;
			while (octal.length < 3 && /[0-7]/.test(inner[index + 1 + octal.length] ?? "")) {
				octal += inner[index + 1 + octal.length];
			}
			const byte = Number.parseInt(octal, 8);
			if (byte > 0xff) {
				throw new CodexWorkspacePatchError("unsafe_path", true, "Quoted patch path is malformed");
			}
			bytes.push(byte);
			index += octal.length;
			continue;
		}
		throw new CodexWorkspacePatchError(
			"unsafe_path",
			true,
			"Quoted patch path uses an unsupported escape",
		);
	}
	return decodePath(Buffer.from(bytes));
}

const GIT_PATH_ESCAPES: Readonly<Record<string, number>> = Object.freeze({
	"\\": 0x5c,
	'"': 0x22,
	a: 0x07,
	b: 0x08,
	t: 0x09,
	n: 0x0a,
	v: 0x0b,
	f: 0x0c,
	r: 0x0d,
});

function decodePath(value: Buffer): string {
	let decoded: string;
	try {
		decoded = new TextDecoder("utf-8", { fatal: true }).decode(value);
	} catch (error) {
		throw new CodexWorkspacePatchError(
			"unsafe_path",
			true,
			"Patch paths must be valid UTF-8",
			undefined,
			{ cause: error },
		);
	}
	return validateCodexPatchPath(decoded);
}

function parseIndexEntries(output: Buffer): ReadonlyMap<string, GitIndexEntry> {
	const entries = new Map<string, GitIndexEntry>();
	let offset = 0;
	while (offset < output.length) {
		const end = output.indexOf(0x00, offset);
		if (end < 0) throw unsafeCompilerOutput("Patch compiler index output is malformed");
		const record = output.subarray(offset, end);
		const tab = record.indexOf(0x09);
		if (tab < 0) throw unsafeCompilerOutput("Patch compiler index output is malformed");
		const metadata = record.subarray(0, tab).toString("ascii").split(" ");
		if (metadata.length !== 3 || metadata[2] !== "0") {
			throw unsafeCompilerOutput("Patch compiler emitted an unsupported index stage");
		}
		const mode = metadata[0] === "100644" ? 0o644 : metadata[0] === "100755" ? 0o755 : null;
		if (mode === null || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(metadata[1] ?? "")) {
			throw unsafeCompilerOutput("Patch compiler emitted an unsupported file mode or object");
		}
		const path = decodePath(record.subarray(tab + 1));
		if (entries.has(path)) throw unsafeCompilerOutput("Patch compiler emitted a duplicate path");
		entries.set(path, { mode, objectId: metadata[1] ?? "" });
		offset = end + 1;
	}
	if (entries.size > CODEX_PATCH_MAX_PATHS) {
		throw unsafeCompilerOutput("Patch compiler index exceeds the path limit");
	}
	return entries;
}

function encodeIndexInfo(entries: ReadonlyMap<string, GitIndexEntry>): Buffer {
	const chunks: Buffer[] = [];
	for (const [path, entry] of entries) {
		chunks.push(
			Buffer.from(
				`${entry.mode === 0o755 ? "100755" : "100644"} ${entry.objectId}\t${path}\0`,
				"utf8",
			),
		);
	}
	return Buffer.concat(chunks);
}

async function writeCompilerFile(
	repository: string,
	path: string,
	snapshot: ExactRegularFileSnapshot,
): Promise<void> {
	const target = join(repository, path);
	await mkdir(dirname(target), { recursive: true, mode: 0o700 });
	const handle = await open(
		target,
		constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
		snapshot.image.mode,
	);
	try {
		await handle.writeFile(snapshot.bytes);
		await handle.chmod(snapshot.image.mode);
	} finally {
		await handle.close();
	}
}

async function normalizeCompilerFileMode(
	repository: string,
	repositoryIdentity: LocalFilesystemIdentity,
	path: string,
	mode: 0o644 | 0o755,
): Promise<void> {
	const target = join(repository, path);
	let handle: FileHandle;
	try {
		handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
	} catch (error) {
		throw new CodexWorkspacePatchError(
			"unsupported_patch",
			true,
			"Patch compiler output is missing or unsafe",
			undefined,
			{ cause: error },
		);
	}
	let opened: Stats;
	try {
		opened = await handle.stat();
		const uid = process.getuid?.();
		if (
			!opened.isFile() ||
			opened.nlink !== 1 ||
			String(opened.dev) !== repositoryIdentity.device ||
			(uid !== undefined && opened.uid !== uid)
		) {
			throw new CodexWorkspacePatchError(
				"unsupported_patch",
				true,
				"Patch compiler output is not an owned regular file",
			);
		}
		await handle.chmod(mode);
	} finally {
		await handle.close();
	}
	const after = await lstat(target);
	if (
		after.isSymbolicLink() ||
		!after.isFile() ||
		after.nlink !== 1 ||
		after.dev !== opened.dev ||
		after.ino !== opened.ino ||
		(after.mode & 0o7777) !== mode
	) {
		throw new CodexWorkspacePatchError(
			"unsupported_patch",
			true,
			"Patch compiler output changed while its mode was normalized",
		);
	}
}

function assertSafePatchHeaders(patch: string): void {
	assertBinaryPatchBounds(patch);
	let expectingNewPath = false;
	let hunk: { oldRemaining: number; newRemaining: number } | null = null;
	for (const line of patch.split("\n")) {
		if (hunk !== null) {
			if (line === "\\ No newline at end of file") continue;
			const marker = line[0];
			if (marker === " ") {
				hunk.oldRemaining -= 1;
				hunk.newRemaining -= 1;
			} else if (marker === "-") {
				hunk.oldRemaining -= 1;
			} else if (marker === "+") {
				hunk.newRemaining -= 1;
			} else {
				throw malformedPatchHeader("Patch hunk body is malformed");
			}
			if (hunk.oldRemaining < 0 || hunk.newRemaining < 0) {
				throw malformedPatchHeader("Patch hunk line counts are malformed");
			}
			if (hunk.oldRemaining === 0 && hunk.newRemaining === 0) hunk = null;
			continue;
		}
		if (expectingNewPath) {
			if (!line.startsWith("+++ ")) {
				throw malformedPatchHeader("Patch old path is not followed by a new path");
			}
			assertPrefixedPatchPath(line.slice(4), "b/");
			expectingNewPath = false;
			continue;
		}
		if (line.startsWith("diff --git ")) {
			assertSafeDiffGitHeader(line.slice("diff --git ".length));
			continue;
		}
		if (line.startsWith("--- ")) {
			assertPrefixedPatchPath(line.slice(4), "a/");
			expectingNewPath = true;
			continue;
		}
		if (line.startsWith("+++ ")) {
			throw malformedPatchHeader("Patch new path is missing its old path");
		}
		if (line.startsWith("@@")) {
			hunk = parseUnifiedHunkHeader(line);
			continue;
		}
		for (const prefix of ["old mode ", "new mode ", "new file mode ", "deleted file mode "]) {
			if (!line.startsWith(prefix)) continue;
			const mode = line.slice(prefix.length);
			if (mode !== "100644" && mode !== "100755") {
				throw new CodexWorkspacePatchError(
					"unsupported_patch",
					true,
					"Patch contains an unsupported file mode",
				);
			}
		}
	}
	if (expectingNewPath || hunk !== null) {
		throw malformedPatchHeader("Patch headers or hunk body are incomplete");
	}
}

function parseUnifiedHunkHeader(
	line: string,
): { oldRemaining: number; newRemaining: number } | null {
	const match = /^@@ -[0-9]+(?:,([0-9]+))? \+[0-9]+(?:,([0-9]+))? @@(?: .*)?$/.exec(line);
	if (match === null) throw malformedPatchHeader("Patch hunk header is malformed");
	const oldRemaining = match[1] === undefined ? 1 : Number(match[1]);
	const newRemaining = match[2] === undefined ? 1 : Number(match[2]);
	if (!Number.isSafeInteger(oldRemaining) || !Number.isSafeInteger(newRemaining)) {
		throw malformedPatchHeader("Patch hunk line counts are malformed");
	}
	return oldRemaining === 0 && newRemaining === 0 ? null : { oldRemaining, newRemaining };
}

function malformedPatchHeader(message: string): CodexWorkspacePatchError {
	return new CodexWorkspacePatchError("patch_not_applicable", false, message);
}

function assertSafeDiffGitHeader(value: string): void {
	if (value.startsWith('"')) {
		const first = takeQuotedGitPath(value);
		if (!first.rest.startsWith(" ")) {
			throw new CodexWorkspacePatchError("unsafe_path", true, "Patch diff header is malformed");
		}
		const remainder = first.rest.slice(1);
		const second = remainder.startsWith('"')
			? takeQuotedGitPath(remainder)
			: { path: remainder, rest: "" };
		if (second.rest !== "") {
			throw new CodexWorkspacePatchError("unsafe_path", true, "Patch diff header is malformed");
		}
		assertPrefixedDiffPath(first.path, "a/");
		assertPrefixedDiffPath(second.path, "b/");
		return;
	}
	const quotedSecondOffset = value.lastIndexOf(' "');
	if (quotedSecondOffset >= 0) {
		const first = value.slice(0, quotedSecondOffset);
		const second = takeQuotedGitPath(value.slice(quotedSecondOffset + 1));
		if (second.rest !== "") {
			throw new CodexWorkspacePatchError("unsafe_path", true, "Patch diff header is malformed");
		}
		assertPrefixedDiffPath(first, "a/");
		assertPrefixedDiffPath(second.path, "b/");
		return;
	}
	if (!value.startsWith("a/") || !value.includes(" b/")) {
		throw new CodexWorkspacePatchError(
			"unsafe_path",
			true,
			"Patch diff paths must use canonical a/ and b/ prefixes",
		);
	}
	assertSafeUnquotedDiffText(value);
}

function takeQuotedGitPath(value: string): { readonly path: string; readonly rest: string } {
	let escaped = false;
	for (let index = 1; index < value.length; index += 1) {
		const character = value[index] ?? "";
		if (escaped) {
			escaped = false;
			continue;
		}
		if (character === "\\") {
			escaped = true;
			continue;
		}
		if (character === '"') {
			const token = value.slice(0, index + 1);
			return { path: decodeGitHeaderPath(token), rest: value.slice(index + 1) };
		}
	}
	throw new CodexWorkspacePatchError("unsafe_path", true, "Quoted patch path is malformed");
}

function assertPrefixedPatchPath(value: string, prefix: "a/" | "b/"): void {
	const unquoted = value.endsWith("\t") ? value.slice(0, -1) : value;
	const path = value.startsWith('"') ? decodeGitHeaderPath(value) : unquoted;
	if (path === "/dev/null") return;
	assertPrefixedDiffPath(path, prefix);
}

function assertPrefixedDiffPath(path: string, prefix: "a/" | "b/"): void {
	if (!path.startsWith(prefix)) {
		throw new CodexWorkspacePatchError(
			"unsafe_path",
			true,
			"Patch paths must use canonical Git prefixes",
		);
	}
	validateCodexPatchPath(path.slice(prefix.length));
}

function assertSafeUnquotedDiffText(value: string): void {
	for (const character of value) {
		const codePoint = character.codePointAt(0);
		if (
			character === "\\" ||
			(codePoint !== undefined && (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)))
		) {
			throw new CodexWorkspacePatchError("unsafe_path", true, "Patch diff path is not canonical");
		}
	}
	const lower = value.toLowerCase();
	if (
		lower.includes("//") ||
		lower.includes("/../") ||
		lower.includes("/./") ||
		lower.includes("/.git/") ||
		lower.includes("/.agentrelay-patch-")
	) {
		throw new CodexWorkspacePatchError("unsafe_path", true, "Patch diff path is not canonical");
	}
}

const GIT_BASE85_ALPHABET =
	"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz!#$%&()*+-;<=>?@^_`{|}~";

function assertBinaryPatchBounds(patch: string): void {
	const lines = patch.split("\n");
	let forwardResultBytes = 0;
	let decompressedBodyBytes = 0;
	for (let index = 0; index < lines.length; index += 1) {
		if (lines[index] !== "GIT binary patch") continue;
		index += 1;
		let blockIndex = 0;
		while (index < lines.length) {
			while (lines[index] === "") index += 1;
			const header = /^(literal|delta) ([0-9]+)$/.exec(lines[index] ?? "");
			if (header === null) break;
			if (blockIndex >= 2) {
				throw new CodexWorkspacePatchError(
					"unsupported_patch",
					true,
					"Binary patch contains too many forward or reverse blocks",
				);
			}
			const kind = header[1] as "literal" | "delta";
			const declared = parseBoundedBinaryLength(header[2] ?? "");
			decompressedBodyBytes += declared;
			if (
				decompressedBodyBytes >
				2 * (CODEX_PATCH_MAX_TRANSACTION_BLOB_BYTES + CODEX_PATCH_MAX_PATHS * 128)
			) {
				throw new CodexWorkspacePatchError(
					"unsupported_patch",
					true,
					"Binary patch bodies exceed the compiler decompression budget",
				);
			}
			index += 1;
			const encoded: string[] = [];
			while (index < lines.length && lines[index] !== "") {
				encoded.push(lines[index] ?? "");
				index += 1;
			}
			const compressed = decodeGitBase85(encoded);
			let body: Buffer;
			try {
				body = inflateSync(compressed, {
					maxOutputLength: CODEX_PATCH_MAX_BLOB_BYTES + 128,
				});
			} catch (error) {
				throw new CodexWorkspacePatchError(
					errorCode(error) === "ERR_BUFFER_TOO_LARGE"
						? "unsupported_patch"
						: "patch_not_applicable",
					errorCode(error) === "ERR_BUFFER_TOO_LARGE",
					errorCode(error) === "ERR_BUFFER_TOO_LARGE"
						? "Binary patch exceeds its decompression bound"
						: "Binary patch compression is malformed",
					undefined,
					{ cause: error },
				);
			}
			if (body.length !== declared) {
				throw new CodexWorkspacePatchError(
					"patch_not_applicable",
					false,
					"Binary patch body length is malformed",
				);
			}
			const resultBytes = kind === "literal" ? declared : decodeGitDeltaResultSize(body);
			if (resultBytes > CODEX_PATCH_MAX_BLOB_BYTES) {
				throw new CodexWorkspacePatchError(
					"unsupported_patch",
					true,
					"Binary patch result exceeds the blob byte limit",
				);
			}
			if (blockIndex === 0) {
				forwardResultBytes += resultBytes;
				if (forwardResultBytes > CODEX_PATCH_MAX_TRANSACTION_BLOB_BYTES) {
					throw new CodexWorkspacePatchError(
						"unsupported_patch",
						true,
						"Binary patch outputs exceed the transaction blob byte limit",
					);
				}
			}
			blockIndex += 1;
		}
	}
}

function parseBoundedBinaryLength(value: string): number {
	let parsed: bigint;
	try {
		parsed = BigInt(value);
	} catch (error) {
		throw new CodexWorkspacePatchError(
			"patch_not_applicable",
			false,
			"Binary patch length is malformed",
			undefined,
			{ cause: error },
		);
	}
	if (parsed > BigInt(CODEX_PATCH_MAX_BLOB_BYTES + 128)) {
		throw new CodexWorkspacePatchError(
			"unsupported_patch",
			true,
			"Binary patch body exceeds the decompression bound",
		);
	}
	return Number(parsed);
}

function decodeGitBase85(lines: readonly string[]): Buffer {
	const chunks: Buffer[] = [];
	for (const line of lines) {
		const marker = line.charCodeAt(0);
		const decodedLength =
			marker >= 0x41 && marker <= 0x5a
				? marker - 0x41 + 1
				: marker >= 0x61 && marker <= 0x7a
					? marker - 0x61 + 27
					: 0;
		if (decodedLength === 0 || line.length !== 1 + Math.ceil(decodedLength / 4) * 5) {
			throw malformedBinaryEncoding();
		}
		const decoded = Buffer.allocUnsafe(decodedLength);
		let outputOffset = 0;
		for (let offset = 1; offset < line.length; offset += 5) {
			let accumulator = 0;
			for (let digit = 0; digit < 5; digit += 1) {
				const value = GIT_BASE85_ALPHABET.indexOf(line[offset + digit] ?? "");
				if (value < 0) throw malformedBinaryEncoding();
				accumulator = accumulator * 85 + value;
			}
			if (accumulator > 0xffff_ffff) throw malformedBinaryEncoding();
			for (let shift = 24; shift >= 0 && outputOffset < decodedLength; shift -= 8) {
				decoded[outputOffset] = (accumulator >>> shift) & 0xff;
				outputOffset += 1;
			}
		}
		chunks.push(decoded);
	}
	return Buffer.concat(chunks);
}

function decodeGitDeltaResultSize(delta: Buffer): number {
	const source = skipGitDeltaSize(delta, 0);
	if (source.value > CODEX_PATCH_MAX_BLOB_BYTES) {
		throw new CodexWorkspacePatchError(
			"unsupported_patch",
			true,
			"Binary delta source exceeds the blob byte limit",
		);
	}
	const result = skipGitDeltaSize(delta, source.offset);
	return result.value;
}

function skipGitDeltaSize(
	delta: Buffer,
	start: number,
): { readonly value: number; readonly offset: number } {
	let value = 0;
	let shift = 0;
	let offset = start;
	while (offset < delta.length && shift <= 49) {
		const byte = delta[offset] ?? 0;
		value += (byte & 0x7f) * 2 ** shift;
		offset += 1;
		if ((byte & 0x80) === 0) {
			if (!Number.isSafeInteger(value)) throw malformedBinaryEncoding();
			return { value, offset };
		}
		shift += 7;
	}
	throw malformedBinaryEncoding();
}

function malformedBinaryEncoding(): CodexWorkspacePatchError {
	return new CodexWorkspacePatchError(
		"patch_not_applicable",
		false,
		"Binary patch encoding is malformed",
	);
}

async function findCreatedDirectories(
	root: string,
	rootIdentity: LocalFilesystemIdentity,
	changes: readonly CodexPatchChange[],
): Promise<string[]> {
	const directories = new Set<string>();
	for (const change of changes) {
		if (change.operation !== "write") continue;
		const segments = dirname(change.path) === "." ? [] : dirname(change.path).split("/");
		let relativeDirectory = "";
		for (const segment of segments) {
			relativeDirectory = relativeDirectory === "" ? segment : `${relativeDirectory}/${segment}`;
			const absolute = join(root, relativeDirectory);
			try {
				const stats = await lstat(absolute);
				if (!stats.isDirectory() || stats.isSymbolicLink()) {
					throw new CodexWorkspacePatchError(
						"unsafe_path",
						true,
						"Patch cannot perform a file-directory transition",
					);
				}
				assertOwnedMode(stats, "Patch path ancestor");
				if (String(stats.dev) !== rootIdentity.device) {
					throw new CodexWorkspacePatchError(
						"unsafe_path",
						true,
						"Patch directories must remain on the workspace filesystem",
					);
				}
			} catch (error) {
				if (errorCode(error) !== "ENOENT") throw error;
				directories.add(relativeDirectory);
			}
		}
	}
	return [...directories].sort((left, right) => {
		const depth = left.split("/").length - right.split("/").length;
		return depth === 0 ? lexicalCompare(left, right) : depth;
	});
}

function orderChanges(
	changes: readonly Omit<CodexPatchChange, "temporary_name">[],
): readonly Omit<CodexPatchChange, "temporary_name">[] {
	return [...changes].sort((left, right) => {
		if (left.operation !== right.operation) return left.operation === "delete" ? -1 : 1;
		if (left.operation === "delete") {
			const depth = right.path.split("/").length - left.path.split("/").length;
			if (depth !== 0) return depth;
		}
		return lexicalCompare(left.path, right.path);
	});
}

function lexicalCompare(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function assertNoFileDirectoryTransitions(paths: readonly string[]): void {
	for (let left = 0; left < paths.length; left += 1) {
		for (let right = left + 1; right < paths.length; right += 1) {
			if (isPathAncestor(paths[left] ?? "", paths[right] ?? "")) {
				throw new CodexWorkspacePatchError(
					"unsupported_patch",
					true,
					"Patch cannot perform file-directory transitions",
				);
			}
		}
	}
}

function isPathAncestor(left: string, right: string): boolean {
	return left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function assertBlobBounds(blobs: ReadonlyMap<string, Buffer>, transactionId: string): void {
	let total = 0;
	for (const bytes of blobs.values()) {
		if (bytes.length > CODEX_PATCH_MAX_BLOB_BYTES) {
			throw new CodexWorkspacePatchError(
				"unsupported_patch",
				true,
				"Patch blob exceeds its byte limit",
				transactionId,
			);
		}
		total += bytes.length;
	}
	if (total > CODEX_PATCH_MAX_TRANSACTION_BLOB_BYTES) {
		throw new CodexWorkspacePatchError(
			"unsupported_patch",
			true,
			"Patch transaction exceeds its total blob byte limit",
			transactionId,
		);
	}
}

function sameImage(left: CodexPatchImage | null, right: CodexPatchImage | null): boolean {
	return (
		left === right ||
		(left !== null &&
			right !== null &&
			left.blob_sha256 === right.blob_sha256 &&
			left.byte_length === right.byte_length &&
			left.mode === right.mode)
	);
}

function gitObjectId(bytes: Buffer, objectIdLength: number): string {
	const header = Buffer.from(`blob ${bytes.length}\0`, "utf8");
	return createHash(objectIdLength === 64 ? "sha256" : "sha1")
		.update(header)
		.update(bytes)
		.digest("hex");
}

function decodeObjectId(
	output: Buffer,
	failure: "unsupported_patch" | "compiler_failure" = "unsupported_patch",
): string {
	const value = output.toString("ascii").trim();
	if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value)) {
		throw new CodexWorkspacePatchError(failure, true, "Patch compiler object ID is malformed");
	}
	return value;
}

function unsafeCompilerOutput(message: string): CodexWorkspacePatchError {
	return new CodexWorkspacePatchError("unsupported_patch", true, message);
}

function assertOwnedMode(stats: Stats | BigIntStats, label: string): void {
	const uid = process.getuid?.();
	if (uid !== undefined && stats.uid.toString() !== String(uid)) {
		throw new CodexWorkspacePatchError(
			"unsafe_path",
			true,
			`${label} must be owned by the current user`,
		);
	}
	const mode = typeof stats.mode === "bigint" ? Number(stats.mode & 0o777n) : stats.mode & 0o777;
	if ((mode & 0o22) !== 0) {
		throw new CodexWorkspacePatchError(
			"unsafe_path",
			true,
			`${label} cannot be group- or world-writable`,
		);
	}
}

async function safeMode(path: string, expected: number): Promise<void> {
	const stats = await lstat(path);
	if (!stats.isDirectory() || stats.isSymbolicLink() || (stats.mode & 0o777) !== expected) {
		throw new CodexWorkspacePatchError(
			"unsupported_patch",
			true,
			"Patch compiler private directory is unsafe",
		);
	}
}

async function assertCompilerRoot(path: string): Promise<void> {
	try {
		await assertPrivateStateDirectory(path);
	} catch (error) {
		throw new CodexWorkspacePatchError(
			"state_corrupt",
			true,
			"Patch compiler root is not private",
			undefined,
			{ cause: error },
		);
	}
}

function gitEnvironment(paths: {
	readonly home: string;
	readonly temporary: string;
	readonly xdg: string;
}): NodeJS.ProcessEnv {
	return {
		HOME: paths.home,
		TMPDIR: paths.temporary,
		TMP: paths.temporary,
		TEMP: paths.temporary,
		XDG_CONFIG_HOME: paths.xdg,
		XDG_CACHE_HOME: paths.xdg,
		XDG_DATA_HOME: paths.xdg,
		LC_ALL: "C",
		LANG: "C",
		TZ: "UTC",
		PATH: "",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_SYSTEM: "/dev/null",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_ATTR_NOSYSTEM: "1",
		GIT_TERMINAL_PROMPT: "0",
		GCM_INTERACTIVE: "Never",
		GIT_OPTIONAL_LOCKS: "0",
	};
}

async function runGit(input: {
	readonly executable: string;
	readonly args: readonly string[];
	readonly cwd: string;
	readonly environment: NodeJS.ProcessEnv;
	readonly stdin?: Buffer;
	readonly failure:
		| "patch_not_applicable"
		| "unsupported_patch"
		| "workspace_changed"
		| "compiler_failure";
	readonly fatal: boolean;
	readonly description?: string;
}): Promise<GitResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(input.executable, [...input.args], {
			cwd: input.cwd,
			env: input.environment,
			stdio: ["pipe", "pipe", "pipe"],
		});
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		let outputBytes = 0;
		let exceeded = false;
		let settled = false;
		const timer = setTimeout(() => {
			exceeded = true;
			child.kill("SIGKILL");
		}, CODEX_PATCH_GIT_TIMEOUT_MS);
		timer.unref?.();
		child.stdout.on("data", (chunk: Buffer) => {
			outputBytes += chunk.length;
			if (outputBytes > CODEX_PATCH_MAX_GIT_OUTPUT_BYTES) {
				exceeded = true;
				child.kill("SIGKILL");
				return;
			}
			stdout.push(chunk);
		});
		child.stderr.on("data", (chunk: Buffer) => {
			outputBytes += chunk.length;
			if (outputBytes > CODEX_PATCH_MAX_GIT_OUTPUT_BYTES) {
				exceeded = true;
				child.kill("SIGKILL");
				return;
			}
			stderr.push(chunk);
		});
		child.once("error", (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(
				new CodexWorkspacePatchError(
					"compiler_failure",
					true,
					"Patch compiler process could not be started",
					undefined,
					{ cause: error },
				),
			);
		});
		child.once("close", (code, signal) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (code !== 0 || signal !== null || exceeded) {
				const boundedFailure = exceeded || signal !== null;
				reject(
					new CodexWorkspacePatchError(
						boundedFailure ? "compiler_failure" : input.failure,
						boundedFailure ? true : input.fatal,
						exceeded
							? "Patch compiler exceeded a resource bound"
							: `Patch compiler ${input.description ?? "operation"} failed (${classifyGitFailure(
									Buffer.concat(stderr),
								)})`,
					),
				);
				return;
			}
			resolve({ stdout: Buffer.concat(stdout) });
		});
		child.stdin.on("error", (error) => {
			if (errorCode(error) !== "EPIPE" && !settled) child.kill("SIGKILL");
		});
		child.stdin.end(input.stdin);
	});
}

function classifyGitFailure(stderr: Buffer): string {
	const value = stderr.toString("utf8");
	if (value.includes("does not match index")) return "index_mismatch";
	if (value.includes("cannot apply binary patch")) return "binary_patch_rejected";
	if (value.includes("without full index line")) return "binary_index_missing";
	if (value.includes("is not in index")) return "source_not_in_index";
	if (value.includes("does not exist in index")) return "path_not_in_index";
	if (value.includes("already exists in index")) return "path_already_in_index";
	if (value.includes("not in the working tree")) return "source_not_in_worktree";
	if (value.includes("lacks permission")) return "mode_mismatch";
	if (value.includes("already exists in working directory")) return "target_exists";
	if (value.includes("No such file or directory")) return "path_missing";
	if (value.includes("removal patch leaves file contents")) return "delete_mismatch";
	if (value.includes("is beyond a symbolic link")) return "symbolic_link";
	if (value.includes("invalid path")) return "invalid_path";
	if (value.includes("new mode") || value.includes("old mode")) return "mode_rejected";
	if (value.includes("patch failed") || value.includes("patch does not apply")) {
		return "hunk_not_applicable";
	}
	if (value.includes("corrupt patch")) return "malformed_patch";
	return "git_rejected";
}

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? String(error.code)
		: undefined;
}

function isPathRaceError(error: unknown): boolean {
	return ["ENOENT", "ENOTDIR", "ELOOP", "EACCES", "EPERM"].includes(errorCode(error) ?? "");
}

function validateReservedTemporaryPath(path: string): void {
	const name = path.split("/").at(-1) ?? "";
	if (!/^\.agentrelay-patch-[a-f0-9]{64}-[0-9]+(?:\.stage)?$/.test(name)) {
		throw new CodexWorkspacePatchError("unsafe_path", true, "Patch temporary path is invalid");
	}
	const parent = dirname(path);
	if (parent !== ".") validateCodexPatchPath(`${parent}/placeholder`);
}
