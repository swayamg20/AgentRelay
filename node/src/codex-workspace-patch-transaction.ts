import { constants, type Stats } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, realpath, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { digestCanonicalJson } from "./capsule-correlation.js";
import type { CapsuleRuntimeActivation } from "./capsule-runtime.js";
import {
	assertExactWorkspaceRoot,
	assertPathAncestors,
	assertTrustedGitExecutable,
	compileCodexWorkspacePatch,
	readCodexWorkspaceHead,
	readExactRegularFile,
} from "./codex-workspace-patch-compiler.js";
import {
	type CodexPatchAuthorityRecord,
	type CodexPatchChange,
	type CodexPatchImage,
	type CodexPatchJournal,
	type CodexPatchResult,
	type CodexPatchToolCall,
	type CodexPatchWorkspaceRecord,
	CodexWorkspacePatchError,
	codexPatchJournalSchema,
	codexPatchKey,
	codexPatchPlanSha256,
	codexPatchResultSchema,
	codexPatchSha256,
	codexPatchTransactionId,
	parseCodexPatchToolCall,
} from "./codex-workspace-patch-contract.js";
import {
	CodexWorkspacePatchStore,
	assertCodexPatchJournalStorageBound,
} from "./codex-workspace-patch-store.js";
import { syncDirectory } from "./durable-file.js";
import { isPathWithin } from "./filesystem-path.js";
import type { LocalFilesystemIdentity } from "./mission-workspace.js";
import { assertPrivateStateDirectory } from "./private-state-file.js";
import { type ProcessLock, WORKSPACE_PATCH_LOCK_KIND, acquireProcessLock } from "./process-lock.js";
import { runtimeAuthorityGrantSha256 } from "./runtime-authority.js";

export interface CodexWorkspacePatchMediator {
	recover(authority: CapsuleRuntimeActivation): Promise<readonly CodexPatchResult[]>;
	apply(call: unknown, authority: CapsuleRuntimeActivation): Promise<CodexPatchResult>;
	inspect(call: unknown, authority: CapsuleRuntimeActivation): Promise<CodexPatchInspection>;
	close(): Promise<void>;
}

export type CodexPatchInspection =
	| { readonly state: "absent" }
	| { readonly state: "committed"; readonly result: CodexPatchResult }
	| { readonly state: "rejected" }
	| { readonly state: "indeterminate" };

export interface OpenCodexWorkspacePatchMediatorOptions {
	readonly capsuleId: string;
	/** Canonical dedicated checkout with no writer outside this workspace-global mediator lock. */
	readonly workspaceRoot: string;
	readonly workspaceResourceSha256: string;
	/** Canonical private Node-owned state shared by every Capsule that can bind this checkout. */
	readonly workspaceGlobalControlRoot: string;
	/** Canonical owner-selected executable outside both workspace and patch-control state. */
	readonly gitExecutable: string;
	readonly fault?: (point: CodexWorkspacePatchFaultPoint) => void | Promise<void>;
}

export interface CodexWorkspacePatchFaultPoint {
	readonly kind:
		| "after_commit_intent"
		| "after_directory_staging_create"
		| "after_directory_create"
		| "after_temporary_staging_create"
		| "after_temporary_write"
		| "after_target_effect"
		| "before_directory_publish"
		| "before_directory_staging_create"
		| "before_staging_cleanup"
		| "before_target_delete"
		| "before_target_publish"
		| "before_target_read"
		| "before_temporary_cleanup"
		| "before_temporary_staging_create";
	readonly transactionId: string;
	readonly path?: string;
}

interface WorkspaceBinding {
	readonly root: string;
	readonly identity: LocalFilesystemIdentity;
	readonly identitySha256: string;
	readonly resourceSha256: string;
}

type ImageClassification = "before" | "after" | "divergent";
type StagingClassification = "before" | "preparing" | "after" | "divergent";

class DivergentWorkspaceError extends Error {
	constructor(readonly reason: string) {
		super(reason);
		this.name = "DivergentWorkspaceError";
	}
}

export async function openCodexWorkspacePatchMediator(
	options: OpenCodexWorkspacePatchMediatorOptions,
): Promise<CodexWorkspacePatchMediator> {
	const capsuleId = validateUuid(options.capsuleId, "Capsule ID");
	if (!/^[a-f0-9]{64}$/.test(options.workspaceResourceSha256)) {
		throw new CodexWorkspacePatchError(
			"invalid_request",
			true,
			"Workspace resource digest is invalid",
		);
	}
	const binding = await inspectWorkspaceBinding(
		options.workspaceRoot,
		options.workspaceResourceSha256,
	);
	await assertPrivateStateDirectory(options.workspaceGlobalControlRoot);
	const controlRoot = await realpath(options.workspaceGlobalControlRoot);
	if (isPathWithin(controlRoot, binding.root) || isPathWithin(binding.root, controlRoot)) {
		throw new CodexWorkspacePatchError(
			"invalid_request",
			true,
			"Patch control state must be disjoint from the workspace",
		);
	}
	await assertTrustedGitExecutable(options.gitExecutable);
	const gitExecutable = await realpath(options.gitExecutable);
	if (isPathWithin(gitExecutable, binding.root) || isPathWithin(gitExecutable, controlRoot)) {
		throw new CodexWorkspacePatchError(
			"invalid_request",
			true,
			"Patch compiler Git executable must be outside writable patch state",
		);
	}
	const store = await CodexWorkspacePatchStore.open(controlRoot, binding.identitySha256);
	const lock = await acquireProcessLock(store.paths.lock, { kind: WORKSPACE_PATCH_LOCK_KIND });
	try {
		await store.cleanupAbandonedState();
		return new DurableCodexWorkspacePatchMediator({
			capsuleId,
			binding,
			gitExecutable,
			store,
			lock,
			fault: options.fault,
		});
	} catch (error) {
		await lock.release().catch(() => undefined);
		throw error;
	}
}

class DurableCodexWorkspacePatchMediator implements CodexWorkspacePatchMediator {
	readonly #capsuleId: string;
	readonly #binding: WorkspaceBinding;
	readonly #gitExecutable: string;
	readonly #store: CodexWorkspacePatchStore;
	readonly #lock: ProcessLock;
	readonly #fault?: OpenCodexWorkspacePatchMediatorOptions["fault"];
	#tail: Promise<void> = Promise.resolve();
	#closing = false;
	#closed = false;
	#closePromise: Promise<void> | undefined;

	constructor(input: {
		readonly capsuleId: string;
		readonly binding: WorkspaceBinding;
		readonly gitExecutable: string;
		readonly store: CodexWorkspacePatchStore;
		readonly lock: ProcessLock;
		readonly fault?: OpenCodexWorkspacePatchMediatorOptions["fault"];
	}) {
		this.#capsuleId = input.capsuleId;
		this.#binding = input.binding;
		this.#gitExecutable = input.gitExecutable;
		this.#store = input.store;
		this.#lock = input.lock;
		this.#fault = input.fault;
	}

	recover(authority: CapsuleRuntimeActivation): Promise<readonly CodexPatchResult[]> {
		return this.enqueue(() => this.recoverPending(authority));
	}

	apply(callValue: unknown, authority: CapsuleRuntimeActivation): Promise<CodexPatchResult> {
		return this.enqueue(async () => {
			const call = parseCodexPatchToolCall(callValue);
			this.assertCallCorrelation(call, authority);
			const key = codexPatchKey(call);
			const transactionId = codexPatchTransactionId(key);
			const patchSha256 = codexPatchSha256(call.patch);
			const patchBytes = Buffer.byteLength(call.patch, "utf8");
			const existing = await this.#store.readJournal(transactionId);
			if (existing !== null) {
				this.assertExactReplay(existing, call, authority, patchSha256, patchBytes);
				if (existing.state === "commit_intent") {
					const recovered = await this.recoverPending(authority);
					const result = recovered.find((item) => item.transactionId === transactionId);
					if (result === undefined) {
						throw new CodexWorkspacePatchError(
							"state_corrupt",
							true,
							"Exact pending patch was not recovered",
							transactionId,
						);
					}
					return result;
				}
				return this.resolveExisting(existing, authority);
			}
			await this.recoverPending(authority);

			await assertLiveWriteAuthority(authority);
			let compiled: Awaited<ReturnType<typeof compileCodexWorkspacePatch>>;
			try {
				compiled = await authority.performWorkspaceRead(() =>
					compileCodexWorkspacePatch({
						gitExecutable: this.#gitExecutable,
						workspaceRoot: this.#binding.root,
						workspaceIdentity: this.#binding.identity,
						compilerRoot: this.#store.paths.compiler,
						transactionId,
						patch: call.patch,
					}),
				);
			} catch (error) {
				if (
					error instanceof CodexWorkspacePatchError &&
					error.code === "patch_not_applicable" &&
					!error.fatal
				) {
					await this.rejectBeforeIntent(call, authority, transactionId, patchSha256, patchBytes);
					throw new CodexWorkspacePatchError(
						"patch_not_applicable",
						false,
						"Patch is not applicable to the current workspace",
						transactionId,
						{ cause: error },
					);
				}
				throw error;
			}
			const planSha256 = codexPatchPlanSha256({
				head_commit: compiled.headCommit,
				created_directories: compiled.createdDirectories,
				changes: compiled.changes,
			});
			const journal = codexPatchJournalSchema.parse({
				schema_version: 1,
				transaction_id: transactionId,
				state: "commit_intent",
				key,
				host_turn: call.hostTurn,
				patch_sha256: patchSha256,
				patch_bytes: patchBytes,
				authority: authorityRecord(authority),
				workspace: workspaceRecord(this.#binding, compiled.headCommit),
				plan_sha256: planSha256,
				created_directories: compiled.createdDirectories,
				changes: compiled.changes,
				result: null,
				reason: null,
			});
			assertCodexPatchJournalStorageBound(journal);
			await this.assertReservedPathsAbsent(journal, authority);
			await assertLiveWriteAuthority(authority);
			await this.#store.publishIntent(journal, compiled.blobs);
			try {
				await this.fault({ kind: "after_commit_intent", transactionId });
			} catch (error) {
				throw new CodexWorkspacePatchError(
					"post_intent_failure",
					true,
					"Workspace patch stopped after durable commit intent",
					transactionId,
					{ cause: error },
				);
			}
			return this.finishIntent(journal, authority);
		});
	}

	inspect(callValue: unknown, authority: CapsuleRuntimeActivation): Promise<CodexPatchInspection> {
		return this.enqueue(async () => {
			const call = parseCodexPatchToolCall(callValue);
			this.assertCallCorrelation(call, authority);
			await authority.performWorkspaceRead(() => undefined);
			const key = codexPatchKey(call);
			const transactionId = codexPatchTransactionId(key);
			const journal = await this.#store.readJournal(transactionId);
			if (journal === null) return Object.freeze({ state: "absent" as const });
			this.assertExactReplay(
				journal,
				call,
				authority,
				codexPatchSha256(call.patch),
				Buffer.byteLength(call.patch, "utf8"),
			);
			if (journal.state === "committed" && journal.result !== null) {
				return Object.freeze({ state: "committed" as const, result: journal.result });
			}
			if (journal.state === "rejected") {
				return Object.freeze({ state: "rejected" as const });
			}
			if (journal.state === "indeterminate") {
				return Object.freeze({ state: "indeterminate" as const });
			}
			throw new CodexWorkspacePatchError(
				"post_intent_failure",
				true,
				"Workspace patch commit intent must be recovered before inspection",
				transactionId,
			);
		});
	}

	close(): Promise<void> {
		if (this.#closePromise !== undefined) return this.#closePromise;
		this.#closing = true;
		this.#closePromise = this.#tail.then(async () => {
			try {
				await this.#lock.release();
			} finally {
				this.#closed = true;
			}
		});
		return this.#closePromise;
	}

	private enqueue<T>(operation: () => Promise<T>): Promise<T> {
		if (this.#closing || this.#closed) {
			return Promise.reject(
				new CodexWorkspacePatchError("closed", true, "Workspace patch mediator is closed"),
			);
		}
		const pending = this.#tail.then(operation, operation);
		this.#tail = pending.then(
			() => undefined,
			() => undefined,
		);
		return pending;
	}

	private async recoverPending(
		authority: CapsuleRuntimeActivation,
	): Promise<readonly CodexPatchResult[]> {
		const journals = await this.#store.listJournals();
		const pending = journals.filter(
			(journal) => journal.state === "commit_intent" || journal.state === "indeterminate",
		);
		if (pending.length > 1) {
			throw new CodexWorkspacePatchError(
				"state_corrupt",
				true,
				"More than one workspace patch transaction is incomplete",
			);
		}
		if (pending.length === 0) return Object.freeze([]);
		const journal = pending[0];
		if (journal === undefined) return Object.freeze([]);
		this.assertJournalAuthority(journal, authority);
		this.assertJournalWorkspace(journal);
		if (journal.state === "indeterminate") {
			throw new CodexWorkspacePatchError(
				"indeterminate",
				true,
				"Workspace patch transaction requires owner inspection",
				journal.transaction_id,
			);
		}
		return Object.freeze([await this.finishIntent(journal, authority)]);
	}

	private async resolveExisting(
		journal: CodexPatchJournal,
		authority: CapsuleRuntimeActivation,
	): Promise<CodexPatchResult> {
		await authority.performWorkspaceRead(() => undefined);
		if (journal.state === "committed" && journal.result !== null) return journal.result;
		if (journal.state === "rejected") {
			throw new CodexWorkspacePatchError(
				"patch_not_applicable",
				false,
				"Patch was previously rejected before commit intent",
				journal.transaction_id,
			);
		}
		if (journal.state === "indeterminate") {
			throw new CodexWorkspacePatchError(
				"indeterminate",
				true,
				"Workspace patch transaction requires owner inspection",
				journal.transaction_id,
			);
		}
		return this.finishIntent(journal, authority);
	}

	private async rejectBeforeIntent(
		call: CodexPatchToolCall,
		authority: CapsuleRuntimeActivation,
		transactionId: string,
		patchSha256: string,
		patchBytes: number,
	): Promise<void> {
		const headCommit = await authority.performWorkspaceRead(() =>
			readCodexWorkspaceHead({
				gitExecutable: this.#gitExecutable,
				workspaceRoot: this.#binding.root,
				workspaceIdentity: this.#binding.identity,
				compilerRoot: this.#store.paths.compiler,
			}),
		);
		const changes: readonly CodexPatchChange[] = Object.freeze([]);
		const createdDirectories: readonly string[] = Object.freeze([]);
		const journal = codexPatchJournalSchema.parse({
			schema_version: 1,
			transaction_id: transactionId,
			state: "rejected",
			key: codexPatchKey(call),
			host_turn: call.hostTurn,
			patch_sha256: patchSha256,
			patch_bytes: patchBytes,
			authority: authorityRecord(authority),
			workspace: workspaceRecord(this.#binding, headCommit),
			plan_sha256: codexPatchPlanSha256({
				head_commit: headCommit,
				created_directories: createdDirectories,
				changes,
			}),
			created_directories: createdDirectories,
			changes,
			result: null,
			reason: "patch_not_applicable",
		});
		await assertLiveWriteAuthority(authority);
		await this.#store.publishRejected(journal);
	}

	private async finishIntent(
		journal: CodexPatchJournal,
		authority: CapsuleRuntimeActivation,
	): Promise<CodexPatchResult> {
		try {
			this.assertJournalAuthority(journal, authority);
			this.assertJournalWorkspace(journal);
			await assertLiveWriteAuthority(authority);
			const head = await authority.performWorkspaceRead(() =>
				readCodexWorkspaceHead({
					gitExecutable: this.#gitExecutable,
					workspaceRoot: this.#binding.root,
					workspaceIdentity: this.#binding.identity,
					compilerRoot: this.#store.paths.compiler,
				}),
			);
			if (head !== journal.workspace.head_commit) {
				throw new DivergentWorkspaceError("head_changed");
			}
			const blobs = await this.loadAndVerifyBlobs(journal);
			await this.assertRecoverablePlan(journal, authority);
			await this.createDirectories(journal, authority);
			for (const change of journal.changes) {
				if (change.operation === "delete") {
					await this.applyDelete(journal, change, authority);
				} else {
					const after = change.after;
					if (after === null) throw new DivergentWorkspaceError("invalid_write_plan");
					const bytes = blobs.get(after.blob_sha256);
					if (bytes === undefined) throw new DivergentWorkspaceError("missing_after_blob");
					await this.applyWrite(journal, change, bytes, authority);
				}
			}
			await this.assertCommittedPlan(journal, authority);
			const finalHead = await authority.performWorkspaceRead(() =>
				readCodexWorkspaceHead({
					gitExecutable: this.#gitExecutable,
					workspaceRoot: this.#binding.root,
					workspaceIdentity: this.#binding.identity,
					compilerRoot: this.#store.paths.compiler,
				}),
			);
			if (finalHead !== journal.workspace.head_commit) {
				throw new DivergentWorkspaceError("head_changed_after_apply");
			}
			const result = codexPatchResultSchema.parse({
				transactionId: journal.transaction_id,
				patchSha256: journal.patch_sha256,
				planSha256: journal.plan_sha256,
				filesChanged: journal.changes.length,
			});
			await this.#store.writeJournal({
				...journal,
				state: "committed",
				result,
				reason: null,
			});
			return result;
		} catch (error) {
			const divergenceReason =
				error instanceof DivergentWorkspaceError
					? error.reason
					: error instanceof CodexWorkspacePatchError &&
							["workspace_changed", "unsafe_path", "unsupported_patch"].includes(error.code)
						? "workspace_divergent"
						: null;
			if (divergenceReason !== null) {
				try {
					await this.markIndeterminate(journal, divergenceReason);
				} catch (persistError) {
					if (persistError instanceof CodexWorkspacePatchError) throw persistError;
					throw new CodexWorkspacePatchError(
						"post_intent_failure",
						true,
						"Workspace patch could not persist its indeterminate state",
						journal.transaction_id,
						{ cause: persistError },
					);
				}
				throw new CodexWorkspacePatchError(
					"indeterminate",
					true,
					"Workspace diverged from both durable patch images",
					journal.transaction_id,
					{ cause: error },
				);
			}
			if (error instanceof CodexWorkspacePatchError) {
				if (
					error.code === "indeterminate" ||
					error.code === "state_corrupt" ||
					error.code === "authority_mismatch"
				) {
					throw error;
				}
			}
			throw new CodexWorkspacePatchError(
				"post_intent_failure",
				true,
				"Workspace patch stopped after durable commit intent",
				journal.transaction_id,
				{ cause: error },
			);
		}
	}

	private async loadAndVerifyBlobs(
		journal: CodexPatchJournal,
	): Promise<ReadonlyMap<string, Buffer>> {
		const images = new Map<string, CodexPatchImage>();
		for (const change of journal.changes) {
			if (change.before !== null) images.set(change.before.blob_sha256, change.before);
			if (change.after !== null) images.set(change.after.blob_sha256, change.after);
		}
		const blobs = new Map<string, Buffer>();
		for (const image of images.values()) {
			blobs.set(image.blob_sha256, await this.#store.readBlob(journal.transaction_id, image));
		}
		return blobs;
	}

	private async assertReservedPathsAbsent(
		journal: CodexPatchJournal,
		authority: CapsuleRuntimeActivation,
	): Promise<void> {
		await authority.performWorkspaceRead(async () => {
			await assertExactWorkspaceRoot(this.#binding.root, this.#binding.identity);
			const reserved = [
				...journal.changes.flatMap((change) =>
					change.operation === "write"
						? [this.temporaryRelativePath(change), this.temporaryStagingRelativePath(change)]
						: [],
				),
				...journal.created_directories.map((path, index) =>
					this.directoryStagingRelativePath(journal, path, index),
				),
			];
			for (const path of reserved) {
				try {
					await lstat(join(this.#binding.root, path));
				} catch (error) {
					if (errorCode(error) === "ENOENT") continue;
					throw new CodexWorkspacePatchError(
						"compiler_failure",
						true,
						"Patch reserved path could not be inspected",
						journal.transaction_id,
						{ cause: error },
					);
				}
				throw new CodexWorkspacePatchError(
					"unsafe_path",
					true,
					"Patch reserved path is already occupied",
					journal.transaction_id,
				);
			}
		});
	}

	private async assertRecoverablePlan(
		journal: CodexPatchJournal,
		authority: CapsuleRuntimeActivation,
	): Promise<void> {
		await authority.performWorkspaceRead(async () => {
			for (const [index, path] of journal.created_directories.entries()) {
				const target = await this.classifyCreatedDirectory(path);
				const staging = await this.classifyDirectoryStaging(journal, path, index);
				if (
					target === "divergent" ||
					staging === "divergent" ||
					(target === "after" && staging !== "before")
				) {
					throw new DivergentWorkspaceError("directory_divergent");
				}
			}
			for (const change of journal.changes) {
				const target = await this.classifyTarget(change, journal.transaction_id);
				if (target === "divergent") throw new DivergentWorkspaceError("target_divergent");
				if (change.operation === "write") {
					const temporary = await this.classifyTemporary(change);
					const staging = await this.classifyTemporaryStaging(change);
					if (
						temporary === "divergent" ||
						staging === "divergent" ||
						(temporary === "after" && staging !== "before")
					) {
						throw new DivergentWorkspaceError("temporary_divergent");
					}
				}
			}
		});
	}

	private async classifyCreatedDirectory(path: string): Promise<"before" | "after" | "divergent"> {
		try {
			await assertExactWorkspaceRoot(this.#binding.root, this.#binding.identity);
			await assertPathAncestors(this.#binding.root, this.#binding.identity, `${path}/child`);
			const stats = await lstat(join(this.#binding.root, path));
			assertExactCreatedDirectory(stats, this.#binding.identity);
			return "after";
		} catch (error) {
			if (errorCode(error) === "ENOENT") return "before";
			if (isDivergenceClassificationError(error)) return "divergent";
			throw error;
		}
	}

	private async classifyDirectoryStaging(
		journal: CodexPatchJournal,
		path: string,
		index: number,
	): Promise<StagingClassification> {
		const relative = this.directoryStagingRelativePath(journal, path, index);
		const target = join(this.#binding.root, relative);
		try {
			await assertExactWorkspaceRoot(this.#binding.root, this.#binding.identity);
			await assertPathAncestors(this.#binding.root, this.#binding.identity, relative);
			const stats = await lstat(target);
			assertOwnedDirectoryStaging(stats, this.#binding.identity);
			const mode = stats.mode & 0o7777;
			if ((mode === 0o755 || (mode & 0o500) === 0o500) && (await readdir(target)).length !== 0) {
				throw new CodexWorkspacePatchError(
					"workspace_changed",
					true,
					"Patch directory staging path is not empty",
				);
			}
			const after = await lstat(target);
			assertOwnedDirectoryStaging(after, this.#binding.identity);
			if (after.dev !== stats.dev || after.ino !== stats.ino) {
				throw new CodexWorkspacePatchError(
					"workspace_changed",
					true,
					"Patch directory staging path changed while inspected",
				);
			}
			return mode === 0o755 ? "after" : "preparing";
		} catch (error) {
			if (errorCode(error) === "ENOENT") return "before";
			if (isDivergenceClassificationError(error)) return "divergent";
			throw error;
		}
	}

	private async assertCommittedPlan(
		journal: CodexPatchJournal,
		authority: CapsuleRuntimeActivation,
	): Promise<void> {
		await authority.performWorkspaceRead(async () => {
			for (const [index, path] of journal.created_directories.entries()) {
				if ((await this.classifyCreatedDirectory(path)) !== "after") {
					throw new DivergentWorkspaceError("directory_not_committed");
				}
				if ((await this.classifyDirectoryStaging(journal, path, index)) !== "before") {
					throw new DivergentWorkspaceError("directory_staging_not_removed");
				}
			}
			for (const change of journal.changes) {
				if ((await this.classifyTarget(change, journal.transaction_id)) !== "after") {
					throw new DivergentWorkspaceError("target_not_committed");
				}
				if (change.operation === "write") {
					if ((await this.classifyTemporary(change)) !== "before") {
						throw new DivergentWorkspaceError("temporary_not_removed");
					}
					if ((await this.classifyTemporaryStaging(change)) !== "before") {
						throw new DivergentWorkspaceError("temporary_staging_not_removed");
					}
				}
			}
		});
	}

	private async createDirectories(
		journal: CodexPatchJournal,
		authority: CapsuleRuntimeActivation,
	): Promise<void> {
		for (const [index, path] of journal.created_directories.entries()) {
			const target = join(this.#binding.root, path);
			const staging = this.directoryStagingPath(journal, path, index);
			const [targetState, initialStagingState] = await authority.performWorkspaceRead(async () =>
				Promise.all([
					this.classifyCreatedDirectory(path),
					this.classifyDirectoryStaging(journal, path, index),
				]),
			);
			let stagingState = initialStagingState;
			if (targetState === "after") {
				if (stagingState !== "before") {
					throw new DivergentWorkspaceError("directory_staging_survived_create");
				}
				continue;
			}
			if (targetState !== "before" || stagingState === "divergent") {
				throw new DivergentWorkspaceError("directory_divergent");
			}
			if (stagingState === "before") {
				await this.fault({
					kind: "before_directory_staging_create",
					transactionId: journal.transaction_id,
					path,
				});
				try {
					await performWorkspaceMutation(authority, () => mkdir(staging, { mode: 0o700 }));
				} catch (error) {
					if (errorCode(error) !== "EEXIST") throw error;
				}
				await syncDirectory(dirname(staging));
				stagingState = await this.classifyDirectoryStaging(journal, path, index);
				if (stagingState !== "preparing" && stagingState !== "after") {
					throw new DivergentWorkspaceError("directory_staging_create_readback_failed");
				}
				await this.fault({
					kind: "after_directory_staging_create",
					transactionId: journal.transaction_id,
					path,
				});
			}
			if (stagingState !== "preparing" && stagingState !== "after") {
				throw new DivergentWorkspaceError("directory_staging_changed");
			}
			const stagingStats = await authority.performWorkspaceRead(() => lstat(staging));
			assertOwnedDirectoryStaging(stagingStats, this.#binding.identity);
			if ((stagingStats.mode & 0o7777) !== 0o700 && stagingState === "preparing") {
				await performWorkspaceMutation(authority, () => chmod(staging, 0o700));
				await syncDirectory(dirname(staging));
				if ((await this.classifyDirectoryStaging(journal, path, index)) !== "preparing") {
					throw new DivergentWorkspaceError("directory_staging_normalization_failed");
				}
			}
			const handle = await authority.performWorkspaceRead(() =>
				open(staging, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW),
			);
			let opened: Stats;
			try {
				opened = await handle.stat();
				assertOwnedDirectoryStaging(opened, this.#binding.identity);
				await performWorkspaceMutation(authority, () => handle.chmod(0o755));
				await handle.sync();
				const normalized = await handle.stat();
				assertExactCreatedDirectory(normalized, this.#binding.identity);
				if (normalized.dev !== opened.dev || normalized.ino !== opened.ino) {
					throw new DivergentWorkspaceError("directory_staging_changed_during_chmod");
				}
			} finally {
				await handle.close();
			}
			await syncDirectory(dirname(staging));
			const [publishTarget, publishStaging] = await authority.performWorkspaceRead(async () =>
				Promise.all([
					this.classifyCreatedDirectory(path),
					this.classifyDirectoryStaging(journal, path, index),
				]),
			);
			if (publishTarget !== "before") {
				throw new DivergentWorkspaceError("directory_changed_before_publish");
			}
			if (publishStaging !== "after") {
				throw new DivergentWorkspaceError("directory_staging_readback_failed");
			}
			await this.fault({
				kind: "before_directory_publish",
				transactionId: journal.transaction_id,
				path,
			});
			await performWorkspaceMutation(authority, () => rename(staging, target));
			await syncDirectory(dirname(target));
			const after = await lstat(target);
			assertExactCreatedDirectory(after, this.#binding.identity);
			if (after.dev !== opened.dev || after.ino !== opened.ino) {
				throw new DivergentWorkspaceError("directory_changed_during_create");
			}
			if ((await this.classifyDirectoryStaging(journal, path, index)) !== "before") {
				throw new DivergentWorkspaceError("directory_staging_survived_create");
			}
			await this.fault({
				kind: "after_directory_create",
				transactionId: journal.transaction_id,
				path,
			});
		}
	}

	private async applyWrite(
		journal: CodexPatchJournal,
		change: CodexPatchChange,
		bytes: Buffer,
		authority: CapsuleRuntimeActivation,
	): Promise<void> {
		const after = change.after;
		if (after === null) throw new DivergentWorkspaceError("invalid_write_plan");
		let target = await authority.performWorkspaceRead(() =>
			this.classifyTarget(change, journal.transaction_id),
		);
		let temporary = await authority.performWorkspaceRead(() => this.classifyTemporary(change));
		if (target === "divergent" || temporary === "divergent") {
			throw new DivergentWorkspaceError("write_divergent");
		}
		if (target === "after") {
			if (temporary === "after") {
				await this.removeTemporary(journal, change, authority);
			}
			return;
		}
		if (temporary === "before") {
			const [currentTarget, currentTemporary] = await authority.performWorkspaceRead(async () =>
				Promise.all([
					this.classifyTarget(change, journal.transaction_id),
					this.classifyTemporary(change),
				]),
			);
			if (currentTarget !== "before") {
				throw new DivergentWorkspaceError("target_changed_before_temporary");
			}
			if (currentTemporary === "divergent") {
				throw new DivergentWorkspaceError("temporary_changed");
			}
			if (currentTemporary === "before") {
				await this.writeTemporary(journal, change, bytes, after, authority);
			}
			await this.fault({
				kind: "after_temporary_write",
				transactionId: journal.transaction_id,
				path: change.path,
			});
		}
		[target, temporary] = await authority.performWorkspaceRead(async () =>
			Promise.all([
				this.classifyTarget(change, journal.transaction_id),
				this.classifyTemporary(change),
			]),
		);
		if (target === "after") {
			if (temporary === "after") await this.removeTemporary(journal, change, authority);
			return;
		}
		if (target !== "before" || temporary !== "after") {
			throw new DivergentWorkspaceError("write_changed_before_commit");
		}
		await this.fault({
			kind: "before_target_publish",
			transactionId: journal.transaction_id,
			path: change.path,
		});
		const temporaryPath = this.temporaryPath(change);
		const targetPath = join(this.#binding.root, change.path);
		await performWorkspaceMutation(authority, () => rename(temporaryPath, targetPath));
		await syncDirectory(dirname(targetPath));
		if ((await this.classifyTarget(change, journal.transaction_id)) !== "after") {
			throw new DivergentWorkspaceError("write_readback_failed");
		}
		if ((await this.readTemporary(change)) !== null) {
			throw new DivergentWorkspaceError("temporary_survived_rename");
		}
		await this.fault({
			kind: "after_target_effect",
			transactionId: journal.transaction_id,
			path: change.path,
		});
	}

	private async applyDelete(
		journal: CodexPatchJournal,
		change: CodexPatchChange,
		authority: CapsuleRuntimeActivation,
	): Promise<void> {
		const target = await authority.performWorkspaceRead(() =>
			this.classifyTarget(change, journal.transaction_id),
		);
		if (target === "after") return;
		if (target !== "before") throw new DivergentWorkspaceError("delete_divergent");
		await this.fault({
			kind: "before_target_delete",
			transactionId: journal.transaction_id,
			path: change.path,
		});
		const targetPath = join(this.#binding.root, change.path);
		await performWorkspaceMutation(authority, () => unlink(targetPath));
		await syncDirectory(dirname(targetPath));
		if ((await this.classifyTarget(change, journal.transaction_id)) !== "after") {
			throw new DivergentWorkspaceError("delete_readback_failed");
		}
		await this.fault({
			kind: "after_target_effect",
			transactionId: journal.transaction_id,
			path: change.path,
		});
	}

	private async writeTemporary(
		journal: CodexPatchJournal,
		change: CodexPatchChange,
		bytes: Buffer,
		after: CodexPatchImage,
		authority: CapsuleRuntimeActivation,
	): Promise<void> {
		const path = this.temporaryPath(change);
		const staging = this.temporaryStagingPath(change);
		const stagingState = await authority.performWorkspaceRead(() =>
			this.classifyTemporaryStaging(change),
		);
		if (stagingState === "divergent") {
			throw new DivergentWorkspaceError("temporary_staging_divergent");
		}
		if (stagingState !== "before") {
			await this.fault({
				kind: "before_staging_cleanup",
				transactionId: journal.transaction_id,
				path: change.path,
			});
			await performWorkspaceMutation(authority, () => unlink(staging));
			await syncDirectory(dirname(staging));
			if ((await this.classifyTemporaryStaging(change)) !== "before") {
				throw new DivergentWorkspaceError("temporary_staging_cleanup_failed");
			}
		}
		await this.fault({
			kind: "before_temporary_staging_create",
			transactionId: journal.transaction_id,
			path: change.path,
		});
		let handle: Awaited<ReturnType<typeof open>>;
		try {
			handle = await performWorkspaceMutation(authority, () =>
				open(
					staging,
					constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
					0o600,
				),
			);
		} catch (error) {
			if (errorCode(error) === "EEXIST") {
				throw new DivergentWorkspaceError("temporary_staging_changed_during_create");
			}
			throw error;
		}
		try {
			await handle.sync();
			await syncDirectory(dirname(staging));
			if ((await this.classifyTemporaryStaging(change)) !== "preparing") {
				throw new DivergentWorkspaceError("temporary_staging_create_readback_failed");
			}
			await this.fault({
				kind: "after_temporary_staging_create",
				transactionId: journal.transaction_id,
				path: change.path,
			});
			await performWorkspaceMutation(authority, () => handle.writeFile(bytes));
			await handle.sync();
			await performWorkspaceMutation(authority, () => handle.chmod(after.mode));
			await handle.sync();
		} finally {
			await handle.close();
		}
		await syncDirectory(dirname(staging));
		const staged = await readExactRegularFile(
			this.#binding.root,
			this.#binding.identity,
			this.temporaryStagingRelativePath(change),
			{ allowReservedTemporary: true },
		);
		if (staged === null || !sameImage(staged.image, after)) {
			throw new DivergentWorkspaceError("temporary_staging_readback_failed");
		}
		const [targetState, temporaryState] = await authority.performWorkspaceRead(async () =>
			Promise.all([
				this.classifyTarget(change, journal.transaction_id),
				this.classifyTemporary(change),
			]),
		);
		if (targetState !== "before") {
			throw new DivergentWorkspaceError("target_changed_before_temporary_publish");
		}
		if (temporaryState !== "before") {
			throw new DivergentWorkspaceError("temporary_changed_before_publish");
		}
		await performWorkspaceMutation(authority, () => rename(staging, path));
		await syncDirectory(dirname(path));
		if ((await this.classifyTemporary(change)) !== "after") {
			throw new DivergentWorkspaceError("temporary_readback_failed");
		}
		if ((await this.classifyTemporaryStaging(change)) !== "before") {
			throw new DivergentWorkspaceError("temporary_staging_survived_publish");
		}
	}

	private async removeTemporary(
		journal: CodexPatchJournal,
		change: CodexPatchChange,
		authority: CapsuleRuntimeActivation,
	): Promise<void> {
		const [target, temporary] = await authority.performWorkspaceRead(async () =>
			Promise.all([
				this.classifyTarget(change, journal.transaction_id),
				this.classifyTemporary(change),
			]),
		);
		if (target !== "after") {
			throw new DivergentWorkspaceError("target_changed_before_cleanup");
		}
		if (temporary === "before") return;
		if (temporary !== "after") throw new DivergentWorkspaceError("temporary_divergent");
		await this.fault({
			kind: "before_temporary_cleanup",
			transactionId: journal.transaction_id,
			path: change.path,
		});
		await this.unlinkTemporaryUnchecked(change, authority);
	}

	private async unlinkTemporaryUnchecked(
		change: CodexPatchChange,
		authority: CapsuleRuntimeActivation,
	): Promise<void> {
		const path = this.temporaryPath(change);
		await performWorkspaceMutation(authority, () => unlink(path));
		await syncDirectory(dirname(path));
		if ((await this.readTemporary(change)) !== null) {
			throw new DivergentWorkspaceError("temporary_cleanup_failed");
		}
	}

	private async classifyTarget(
		change: CodexPatchChange,
		transactionId: string,
	): Promise<ImageClassification> {
		try {
			await this.fault({
				kind: "before_target_read",
				transactionId,
				path: change.path,
			});
			const snapshot = await readExactRegularFile(
				this.#binding.root,
				this.#binding.identity,
				change.path,
			);
			if (sameImage(snapshot?.image ?? null, change.after)) return "after";
			if (sameImage(snapshot?.image ?? null, change.before)) return "before";
			return "divergent";
		} catch (error) {
			if (isDivergenceClassificationError(error)) return "divergent";
			throw error;
		}
	}

	private async classifyTemporary(change: CodexPatchChange): Promise<ImageClassification> {
		const snapshot = await this.readTemporary(change);
		if (snapshot === null) return "before";
		return sameImage(snapshot.image, change.after) ? "after" : "divergent";
	}

	private readTemporary(change: CodexPatchChange) {
		if (change.temporary_name === null) return Promise.resolve(null);
		const relative = this.temporaryRelativePath(change);
		return readExactRegularFile(this.#binding.root, this.#binding.identity, relative, {
			allowReservedTemporary: true,
		});
	}

	private async classifyTemporaryStaging(change: CodexPatchChange): Promise<StagingClassification> {
		const after = change.after;
		if (after === null) throw new DivergentWorkspaceError("missing_staging_image");
		const relative = this.temporaryStagingRelativePath(change);
		try {
			await assertExactWorkspaceRoot(this.#binding.root, this.#binding.identity);
			await assertPathAncestors(this.#binding.root, this.#binding.identity, relative);
			const stats = await lstat(join(this.#binding.root, relative));
			assertOwnedFileStaging(stats, this.#binding.identity, after);
			return "preparing";
		} catch (error) {
			if (errorCode(error) === "ENOENT") return "before";
			if (isDivergenceClassificationError(error)) return "divergent";
			throw error;
		}
	}

	private temporaryRelativePath(change: CodexPatchChange): string {
		const temporaryName = change.temporary_name;
		if (temporaryName === null) throw new DivergentWorkspaceError("missing_temporary_name");
		const parent = dirname(change.path);
		return parent === "." ? temporaryName : `${parent}/${temporaryName}`;
	}

	private temporaryStagingRelativePath(change: CodexPatchChange): string {
		return `${this.temporaryRelativePath(change)}.stage`;
	}

	private temporaryPath(change: CodexPatchChange): string {
		return join(this.#binding.root, this.temporaryRelativePath(change));
	}

	private temporaryStagingPath(change: CodexPatchChange): string {
		return join(this.#binding.root, this.temporaryStagingRelativePath(change));
	}

	private directoryStagingRelativePath(
		journal: CodexPatchJournal,
		path: string,
		index: number,
	): string {
		const parent = dirname(path);
		const name = `.agentrelay-patch-${journal.transaction_id}-dir-${index}`;
		return parent === "." ? name : `${parent}/${name}`;
	}

	private directoryStagingPath(journal: CodexPatchJournal, path: string, index: number): string {
		return join(this.#binding.root, this.directoryStagingRelativePath(journal, path, index));
	}

	private async markIndeterminate(journal: CodexPatchJournal, reason: string): Promise<void> {
		await this.#store.writeJournal({
			...journal,
			state: "indeterminate",
			result: null,
			reason: boundedReason(reason),
		});
	}

	private assertCallCorrelation(
		call: CodexPatchToolCall,
		authority: CapsuleRuntimeActivation,
	): void {
		const grant = authority.grant;
		if (
			call.capsuleId !== this.#capsuleId ||
			call.hostTurn.missionId !== grant.mission_id ||
			call.hostTurn.deliveryId !== grant.delivery_id ||
			call.hostTurn.executionAttempt !== grant.execution_attempt ||
			grant.workspace_resource_sha256 !== this.#binding.resourceSha256
		) {
			throw new CodexWorkspacePatchError(
				"correlation_mismatch",
				true,
				"Patch call does not match the active Capsule turn and workspace authority",
			);
		}
		if (
			!grant.capabilities.some(
				(capability) =>
					capability.action === "workspace_write" && capability.resource === "workspace",
			)
		) {
			throw new CodexWorkspacePatchError(
				"authority_mismatch",
				true,
				"Active authority does not grant workspace write",
			);
		}
	}

	private assertExactReplay(
		journal: CodexPatchJournal,
		call: CodexPatchToolCall,
		authority: CapsuleRuntimeActivation,
		patchSha256: string,
		patchBytes: number,
	): void {
		if (journal.patch_sha256 !== patchSha256 || journal.patch_bytes !== patchBytes) {
			throw new CodexWorkspacePatchError(
				"idempotency_conflict",
				true,
				"Patch call key was reused with different patch bytes",
				journal.transaction_id,
			);
		}
		if (
			!isDeepStrictEqual(journal.key, codexPatchKey(call)) ||
			!isDeepStrictEqual(journal.host_turn, call.hostTurn)
		) {
			throw new CodexWorkspacePatchError(
				"correlation_mismatch",
				true,
				"Patch call key was reused with different correlation",
				journal.transaction_id,
			);
		}
		this.assertJournalAuthority(journal, authority);
		this.assertJournalWorkspace(journal);
	}

	private assertJournalAuthority(
		journal: CodexPatchJournal,
		authority: CapsuleRuntimeActivation,
	): void {
		const grant = authority.grant;
		if (
			!isDeepStrictEqual(journal.authority, authorityRecord(authority)) ||
			journal.key.capsule_id !== this.#capsuleId ||
			journal.host_turn.missionId !== grant.mission_id ||
			journal.host_turn.deliveryId !== grant.delivery_id ||
			journal.host_turn.executionAttempt !== grant.execution_attempt
		) {
			throw new CodexWorkspacePatchError(
				"authority_mismatch",
				true,
				"Patch recovery requires the exact journaled authority grant",
				journal.transaction_id,
			);
		}
	}

	private assertJournalWorkspace(journal: CodexPatchJournal): void {
		const expected = journal.workspace;
		if (
			expected.root !== this.#binding.root ||
			expected.device !== this.#binding.identity.device ||
			expected.inode !== this.#binding.identity.inode ||
			expected.identity_sha256 !== this.#binding.identitySha256
		) {
			throw new CodexWorkspacePatchError(
				"workspace_changed",
				true,
				"Patch transaction belongs to a different workspace identity",
				journal.transaction_id,
			);
		}
	}

	private fault(point: CodexWorkspacePatchFaultPoint): Promise<void> {
		return Promise.resolve(this.#fault?.(Object.freeze({ ...point })));
	}
}

async function inspectWorkspaceBinding(
	workspaceRoot: string,
	resourceSha256: string,
): Promise<WorkspaceBinding> {
	if (
		!isAbsolute(workspaceRoot) ||
		normalize(workspaceRoot) !== workspaceRoot ||
		workspaceRoot.includes("\0")
	) {
		throw new CodexWorkspacePatchError(
			"invalid_request",
			true,
			"Workspace root must be absolute and normalized",
		);
	}
	if ((await realpath(workspaceRoot)) !== workspaceRoot) {
		throw new CodexWorkspacePatchError(
			"invalid_request",
			true,
			"Workspace root must use its canonical path",
		);
	}
	const stats = await lstat(workspaceRoot, { bigint: true });
	if (!stats.isDirectory() || stats.isSymbolicLink()) {
		throw new CodexWorkspacePatchError(
			"invalid_request",
			true,
			"Workspace root is not a real directory",
		);
	}
	const identity = Object.freeze({
		device: stats.dev.toString(),
		inode: stats.ino.toString(),
	});
	await assertExactWorkspaceRoot(workspaceRoot, identity);
	const gitDirectory = join(workspaceRoot, ".git");
	const gitStats = await lstat(gitDirectory);
	const uid = process.getuid?.();
	if (
		!gitStats.isDirectory() ||
		gitStats.isSymbolicLink() ||
		String(gitStats.dev) !== identity.device ||
		(gitStats.mode & 0o22) !== 0 ||
		(uid !== undefined && gitStats.uid !== uid) ||
		(await realpath(gitDirectory)) !== gitDirectory
	) {
		throw new CodexWorkspacePatchError(
			"invalid_request",
			true,
			"Workspace must use owner-controlled checkout-local Git metadata",
		);
	}
	const identitySha256 = digestCanonicalJson({
		root: workspaceRoot,
		device: identity.device,
		inode: identity.inode,
	});
	return Object.freeze({
		root: workspaceRoot,
		identity,
		identitySha256,
		resourceSha256,
	});
}

function authorityRecord(authority: CapsuleRuntimeActivation): CodexPatchAuthorityRecord {
	const grant = authority.grant;
	return Object.freeze({
		grant_sha256: runtimeAuthorityGrantSha256(grant),
		grant_id: grant.grant_id,
		lease_id: grant.lease_id,
		fencing_token: grant.fencing_token,
		delivery_id: grant.delivery_id,
		execution_attempt: grant.execution_attempt,
		policy_profile: grant.policy_profile,
		policy_grant_sha256: grant.policy_grant_sha256,
		workspace_resource_sha256: grant.workspace_resource_sha256,
	});
}

function workspaceRecord(binding: WorkspaceBinding, headCommit: string): CodexPatchWorkspaceRecord {
	return Object.freeze({
		root: binding.root,
		device: binding.identity.device,
		inode: binding.identity.inode,
		identity_sha256: binding.identitySha256,
		head_commit: headCommit,
	});
}

async function assertLiveWriteAuthority(authority: CapsuleRuntimeActivation): Promise<void> {
	await authority.performWorkspaceWrite(() => undefined);
}

function performWorkspaceMutation<T>(
	authority: CapsuleRuntimeActivation,
	syscall: () => T | Promise<T>,
): Promise<T> {
	return authority.performWorkspaceWrite(() => {
		authority.signal.throwIfAborted();
		return syscall();
	});
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

function assertExactCreatedDirectory(stats: Stats, identity: LocalFilesystemIdentity): void {
	assertOwnedCreatedDirectory(stats, identity);
	if ((stats.mode & 0o7777) !== 0o755) {
		throw new CodexWorkspacePatchError(
			"workspace_changed",
			true,
			"Patch-created directory has unexpected metadata",
		);
	}
}

function assertOwnedCreatedDirectory(stats: Stats, identity: LocalFilesystemIdentity): void {
	const uid = process.getuid?.();
	if (
		!stats.isDirectory() ||
		stats.isSymbolicLink() ||
		String(stats.dev) !== identity.device ||
		(stats.mode & 0o22) !== 0 ||
		(uid !== undefined && stats.uid !== uid)
	) {
		throw new CodexWorkspacePatchError(
			"workspace_changed",
			true,
			"Patch-created directory has unexpected metadata",
		);
	}
}

function assertOwnedDirectoryStaging(stats: Stats, identity: LocalFilesystemIdentity): void {
	const uid = process.getuid?.();
	const mode = stats.mode & 0o7777;
	if (
		!stats.isDirectory() ||
		stats.isSymbolicLink() ||
		String(stats.dev) !== identity.device ||
		((mode & ~0o700) !== 0 && mode !== 0o755) ||
		(uid !== undefined && stats.uid !== uid)
	) {
		throw new CodexWorkspacePatchError(
			"workspace_changed",
			true,
			"Patch directory staging path has unexpected metadata",
		);
	}
}

function assertOwnedFileStaging(
	stats: Stats,
	identity: LocalFilesystemIdentity,
	after: CodexPatchImage,
): void {
	const uid = process.getuid?.();
	const mode = stats.mode & 0o7777;
	if (
		!stats.isFile() ||
		stats.isSymbolicLink() ||
		stats.nlink !== 1 ||
		String(stats.dev) !== identity.device ||
		((mode & ~0o600) !== 0 && mode !== after.mode) ||
		stats.size > after.byte_length ||
		(uid !== undefined && stats.uid !== uid)
	) {
		throw new CodexWorkspacePatchError(
			"workspace_changed",
			true,
			"Patch file staging path has unexpected metadata",
		);
	}
}

function isDivergenceClassificationError(error: unknown): boolean {
	return (
		error instanceof CodexWorkspacePatchError &&
		(error.code === "workspace_changed" ||
			error.code === "unsafe_path" ||
			error.code === "unsupported_patch")
	);
}

function validateUuid(value: string, label: string): string {
	if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
		throw new CodexWorkspacePatchError("invalid_request", true, `${label} is invalid`);
	}
	return value;
}

function boundedReason(value: string): string {
	return /^[a-z_]{1,128}$/.test(value) ? value : "workspace_divergent";
}

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? String(error.code)
		: undefined;
}
