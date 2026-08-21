import { createHash } from "node:crypto";
import { type HostTurnRef, hostTurnRefSchema } from "@agentrelay/protocol";
import { z } from "zod";
import { digestCanonicalJson } from "./capsule-correlation.js";

export const CODEX_PATCH_MAX_BYTES = 1_048_576;
export const CODEX_PATCH_MAX_PATHS = 64;
export const CODEX_PATCH_MAX_PATH_BYTES = 1_024;
export const CODEX_PATCH_MAX_SEGMENT_BYTES = 255;
export const CODEX_PATCH_MAX_CREATED_DIRECTORIES =
	CODEX_PATCH_MAX_PATHS * Math.ceil(CODEX_PATCH_MAX_PATH_BYTES / 2);
export const CODEX_PATCH_MAX_BLOB_BYTES = 4 * 1_048_576;
export const CODEX_PATCH_MAX_TRANSACTION_BLOB_BYTES = 32 * 1_048_576;
export const CODEX_PATCH_MAX_GIT_OUTPUT_BYTES = 1_048_576;
export const CODEX_PATCH_GIT_TIMEOUT_MS = 30_000;

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const providerReferenceSchema = z
	.string()
	.min(1)
	.max(512)
	.refine((value) => !hasUnpairedSurrogate(value) && !hasControlCharacter(value), {
		message: "Provider references must be valid, printable Unicode",
	});

export const codexPatchPathSchema = z.string().superRefine((value, ctx) => {
	try {
		validateCodexPatchPath(value);
	} catch (error) {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			message: error instanceof Error ? error.message : "Invalid patch path",
		});
	}
});

export const codexPatchToolCallSchema = z
	.object({
		capsuleId: z.string().uuid(),
		providerThreadId: providerReferenceSchema,
		providerTurnId: providerReferenceSchema,
		callId: providerReferenceSchema,
		hostTurn: hostTurnRefSchema,
		patch: z.string(),
	})
	.strict()
	.superRefine((call, ctx) => {
		if (hasUnpairedSurrogate(call.patch)) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Patch must not contain unpaired UTF-16 surrogates",
				path: ["patch"],
			});
			return;
		}
		if (Buffer.byteLength(call.patch, "utf8") > CODEX_PATCH_MAX_BYTES) {
			ctx.addIssue({
				code: z.ZodIssueCode.too_big,
				maximum: CODEX_PATCH_MAX_BYTES,
				type: "string",
				inclusive: true,
				message: "Patch exceeds the byte limit",
				path: ["patch"],
			});
		}
	});

export interface CodexPatchToolCall {
	readonly capsuleId: string;
	readonly providerThreadId: string;
	readonly providerTurnId: string;
	readonly callId: string;
	readonly hostTurn: HostTurnRef;
	readonly patch: string;
}

export const codexPatchImageSchema = z
	.object({
		blob_sha256: sha256Schema,
		byte_length: z.number().int().nonnegative().max(CODEX_PATCH_MAX_BLOB_BYTES),
		mode: z.union([z.literal(0o644), z.literal(0o755)]),
	})
	.strict();

export type CodexPatchImage = z.infer<typeof codexPatchImageSchema>;

export const codexPatchChangeSchema = z
	.object({
		path: codexPatchPathSchema,
		operation: z.enum(["write", "delete"]),
		before: codexPatchImageSchema.nullable(),
		after: codexPatchImageSchema.nullable(),
		temporary_name: z
			.string()
			.regex(/^\.agentrelay-patch-[a-f0-9]{64}-[0-9]+$/)
			.nullable(),
	})
	.strict()
	.superRefine((change, ctx) => {
		if (change.operation === "write" && change.after === null) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Write changes require an after image",
				path: ["after"],
			});
		}
		if (change.operation === "delete" && (change.before === null || change.after !== null)) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Delete changes require only a before image",
				path: ["before"],
			});
		}
		if (
			(change.operation === "write" && change.temporary_name === null) ||
			(change.operation === "delete" && change.temporary_name !== null)
		) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Temporary names are required only for write changes",
				path: ["temporary_name"],
			});
		}
	});

export type CodexPatchChange = z.infer<typeof codexPatchChangeSchema>;

const patchKeySchema = z
	.object({
		capsule_id: z.string().uuid(),
		provider_thread_id: providerReferenceSchema,
		provider_turn_id: providerReferenceSchema,
		call_id: providerReferenceSchema,
	})
	.strict();

export const codexPatchAuthoritySchema = z
	.object({
		grant_sha256: sha256Schema,
		grant_id: z.string().uuid(),
		lease_id: z.string().uuid(),
		fencing_token: z.string().regex(/^[1-9][0-9]*$/),
		delivery_id: z.string().uuid(),
		execution_attempt: z.number().int().safe().positive(),
		policy_profile: z.string().min(1).max(64),
		policy_grant_sha256: sha256Schema,
		workspace_resource_sha256: sha256Schema,
	})
	.strict();

const patchWorkspaceSchema = z
	.object({
		root: z.string().min(1),
		device: z.string().regex(/^[0-9]+$/),
		inode: z.string().regex(/^[0-9]+$/),
		identity_sha256: sha256Schema,
		head_commit: z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/),
	})
	.strict();

export const codexPatchResultSchema = z
	.object({
		transactionId: sha256Schema,
		patchSha256: sha256Schema,
		planSha256: sha256Schema,
		filesChanged: z.number().int().positive().max(CODEX_PATCH_MAX_PATHS),
	})
	.strict();

export type CodexPatchResult = z.infer<typeof codexPatchResultSchema>;

export const codexPatchJournalSchema = z
	.object({
		schema_version: z.literal(1),
		transaction_id: sha256Schema,
		state: z.enum(["commit_intent", "committed", "indeterminate", "rejected"]),
		key: patchKeySchema,
		host_turn: hostTurnRefSchema,
		patch_sha256: sha256Schema,
		patch_bytes: z.number().int().nonnegative().max(CODEX_PATCH_MAX_BYTES),
		authority: codexPatchAuthoritySchema,
		workspace: patchWorkspaceSchema,
		plan_sha256: sha256Schema,
		created_directories: z.array(codexPatchPathSchema).max(CODEX_PATCH_MAX_CREATED_DIRECTORIES),
		changes: z.array(codexPatchChangeSchema).max(CODEX_PATCH_MAX_PATHS),
		result: codexPatchResultSchema.nullable(),
		reason: z.string().min(1).max(128).nullable(),
	})
	.strict()
	.superRefine((journal, ctx) => {
		if (journal.state === "rejected") {
			if (journal.changes.length !== 0 || journal.created_directories.length !== 0) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					message: "Rejected patch state cannot contain a workspace plan",
					path: ["changes"],
				});
			}
		} else if (journal.changes.length === 0) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Non-rejected patch state requires at least one change",
				path: ["changes"],
			});
		}
		if (journal.transaction_id !== codexPatchTransactionId(journal.key)) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Patch transaction ID does not match its exact key",
				path: ["transaction_id"],
			});
		}
		if (
			journal.workspace.identity_sha256 !==
			digestCanonicalJson({
				root: journal.workspace.root,
				device: journal.workspace.device,
				inode: journal.workspace.inode,
			})
		) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Workspace identity digest does not match its durable coordinates",
				path: ["workspace", "identity_sha256"],
			});
		}
		const planSha256 = codexPatchPlanSha256({
			head_commit: journal.workspace.head_commit,
			created_directories: journal.created_directories,
			changes: journal.changes,
		});
		if (journal.plan_sha256 !== planSha256) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Patch plan digest does not match its durable body",
				path: ["plan_sha256"],
			});
		}
		const changePaths = journal.changes.map((change) => change.path);
		if (new Set(changePaths).size !== changePaths.length) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Patch plan paths must be unique",
				path: ["changes"],
			});
		}
		if (!isCanonicalChangeOrder(journal.changes)) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Patch changes are not in canonical application order",
				path: ["changes"],
			});
		}
		for (const [index, change] of journal.changes.entries()) {
			const expectedTemporary =
				change.operation === "write"
					? `.agentrelay-patch-${journal.transaction_id}-${index}`
					: null;
			if (change.temporary_name !== expectedTemporary) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					message: "Patch temporary name does not match its transaction and operation order",
					path: ["changes", index, "temporary_name"],
				});
			}
			if (samePatchImage(change.before, change.after)) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					message: "Patch changes require distinct before and after images",
					path: ["changes", index],
				});
			}
		}
		if (new Set(journal.created_directories).size !== journal.created_directories.length) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Patch-created directories must be unique",
				path: ["created_directories"],
			});
		}
		if (!isCanonicalDirectoryOrder(journal.created_directories)) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Patch-created directories are not in canonical creation order",
				path: ["created_directories"],
			});
		}
		for (const [index, directory] of journal.created_directories.entries()) {
			if (
				!journal.changes.some(
					(change) => change.operation === "write" && change.path.startsWith(`${directory}/`),
				)
			) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					message: "Patch-created directory is not an ancestor of a write",
					path: ["created_directories", index],
				});
			}
		}
		const blobLengths = new Map<string, number>();
		for (const change of journal.changes) {
			for (const image of [change.before, change.after]) {
				if (image === null) continue;
				const existing = blobLengths.get(image.blob_sha256);
				if (existing !== undefined && existing !== image.byte_length) {
					ctx.addIssue({
						code: z.ZodIssueCode.custom,
						message: "Patch blob references disagree on byte length",
						path: ["changes"],
					});
				}
				blobLengths.set(image.blob_sha256, image.byte_length);
			}
		}
		if (
			[...blobLengths.values()].reduce((total, length) => total + length, 0) >
			CODEX_PATCH_MAX_TRANSACTION_BLOB_BYTES
		) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Patch transaction blobs exceed the aggregate byte limit",
				path: ["changes"],
			});
		}
		if (journal.state === "committed") {
			if (journal.result === null || journal.reason !== null) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					message: "Committed patch state requires only a result",
					path: ["result"],
				});
			} else if (
				journal.result.transactionId !== journal.transaction_id ||
				journal.result.patchSha256 !== journal.patch_sha256 ||
				journal.result.planSha256 !== journal.plan_sha256 ||
				journal.result.filesChanged !== journal.changes.length
			) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					message: "Committed patch result does not match its durable transaction",
					path: ["result"],
				});
			}
		} else if (journal.state === "indeterminate" || journal.state === "rejected") {
			if (journal.result !== null || journal.reason === null) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					message: "Terminal non-committed patch state requires only a reason",
					path: ["reason"],
				});
			}
		} else if (journal.result !== null || journal.reason !== null) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Commit intent cannot contain a result or reason",
			});
		}
	});

export type CodexPatchJournal = z.infer<typeof codexPatchJournalSchema>;
export type CodexPatchKey = z.infer<typeof patchKeySchema>;
export type CodexPatchAuthorityRecord = z.infer<typeof codexPatchAuthoritySchema>;
export type CodexPatchWorkspaceRecord = z.infer<typeof patchWorkspaceSchema>;

export type CodexWorkspacePatchErrorCode =
	| "invalid_request"
	| "correlation_mismatch"
	| "idempotency_conflict"
	| "unsafe_path"
	| "unsupported_patch"
	| "patch_not_applicable"
	| "compiler_failure"
	| "authority_mismatch"
	| "workspace_changed"
	| "state_corrupt"
	| "indeterminate"
	| "post_intent_failure"
	| "closed";

export class CodexWorkspacePatchError extends Error {
	constructor(
		readonly code: CodexWorkspacePatchErrorCode,
		readonly fatal: boolean,
		message: string,
		readonly transactionId?: string,
		options: ErrorOptions = {},
	) {
		super(message, options);
		this.name = "CodexWorkspacePatchError";
	}
}

export function parseCodexPatchToolCall(value: unknown): CodexPatchToolCall {
	const parsed = codexPatchToolCallSchema.safeParse(value);
	if (!parsed.success) {
		throw new CodexWorkspacePatchError("invalid_request", true, "Codex patch tool call is invalid");
	}
	return Object.freeze({ ...parsed.data, hostTurn: Object.freeze({ ...parsed.data.hostTurn }) });
}

export function codexPatchKey(call: CodexPatchToolCall): CodexPatchKey {
	return patchKeySchema.parse({
		capsule_id: call.capsuleId,
		provider_thread_id: call.providerThreadId,
		provider_turn_id: call.providerTurnId,
		call_id: call.callId,
	});
}

export function codexPatchTransactionId(key: CodexPatchKey): string {
	const hash = createHash("sha256");
	for (const value of [key.capsule_id, key.provider_thread_id, key.provider_turn_id, key.call_id]) {
		const bytes = Buffer.from(value, "utf8");
		const length = Buffer.allocUnsafe(4);
		length.writeUInt32BE(bytes.length);
		hash.update(length).update(bytes);
	}
	return hash.digest("hex");
}

export function codexPatchSha256(patch: string): string {
	if (hasUnpairedSurrogate(patch)) {
		throw new CodexWorkspacePatchError(
			"invalid_request",
			true,
			"Patch must not contain unpaired UTF-16 surrogates",
		);
	}
	return createHash("sha256").update(Buffer.from(patch, "utf8")).digest("hex");
}

export function codexPatchPlanSha256(plan: {
	readonly head_commit: string;
	readonly created_directories: readonly string[];
	readonly changes: readonly CodexPatchChange[];
}): string {
	return digestCanonicalJson(plan);
}

export function validateCodexPatchPath(value: string): string {
	if (
		value.length === 0 ||
		value.startsWith("/") ||
		value.includes("\\") ||
		hasControlCharacter(value) ||
		hasUnpairedSurrogate(value) ||
		value.normalize("NFC") !== value
	) {
		throw new CodexWorkspacePatchError("unsafe_path", true, "Patch path is not canonical");
	}
	const bytes = Buffer.byteLength(value, "utf8");
	if (bytes > CODEX_PATCH_MAX_PATH_BYTES) {
		throw new CodexWorkspacePatchError("unsafe_path", true, "Patch path exceeds the byte limit");
	}
	const segments = value.split("/");
	for (const segment of segments) {
		if (
			segment.length === 0 ||
			segment === "." ||
			segment === ".." ||
			Buffer.byteLength(segment, "utf8") > CODEX_PATCH_MAX_SEGMENT_BYTES ||
			segment.toLowerCase() === ".git" ||
			segment.toLowerCase().startsWith(".agentrelay-patch-")
		) {
			throw new CodexWorkspacePatchError("unsafe_path", true, "Patch path has a forbidden segment");
		}
	}
	return value;
}

function hasControlCharacter(value: string): boolean {
	for (const character of value) {
		const codePoint = character.codePointAt(0);
		if (
			codePoint !== undefined &&
			(codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f))
		) {
			return true;
		}
	}
	return false;
}

function isCanonicalChangeOrder(changes: readonly CodexPatchChange[]): boolean {
	for (let index = 1; index < changes.length; index += 1) {
		const previous = changes[index - 1];
		const current = changes[index];
		if (previous === undefined || current === undefined) return false;
		if (compareChanges(previous, current) > 0) return false;
	}
	return true;
}

function compareChanges(left: CodexPatchChange, right: CodexPatchChange): number {
	if (left.operation !== right.operation) return left.operation === "delete" ? -1 : 1;
	if (left.operation === "delete") {
		const depth = right.path.split("/").length - left.path.split("/").length;
		if (depth !== 0) return depth;
	}
	return lexicalCompare(left.path, right.path);
}

function isCanonicalDirectoryOrder(paths: readonly string[]): boolean {
	for (let index = 1; index < paths.length; index += 1) {
		const previous = paths[index - 1];
		const current = paths[index];
		if (previous === undefined || current === undefined) return false;
		const depth = previous.split("/").length - current.split("/").length;
		if (depth > 0 || (depth === 0 && lexicalCompare(previous, current) > 0)) return false;
	}
	return true;
}

function lexicalCompare(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function hasUnpairedSurrogate(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		if (code >= 0xd800 && code <= 0xdbff) {
			const next = value.charCodeAt(index + 1);
			if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
			index += 1;
			continue;
		}
		if (code >= 0xdc00 && code <= 0xdfff) return true;
	}
	return false;
}

function samePatchImage(left: CodexPatchImage | null, right: CodexPatchImage | null): boolean {
	return (
		left !== null &&
		right !== null &&
		left.blob_sha256 === right.blob_sha256 &&
		left.byte_length === right.byte_length &&
		left.mode === right.mode
	);
}
