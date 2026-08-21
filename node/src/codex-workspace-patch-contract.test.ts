import { describe, expect, it } from "vitest";
import { digestCanonicalJson } from "./capsule-correlation.js";
import {
	type CodexPatchChange,
	type CodexWorkspacePatchError,
	codexPatchJournalSchema,
	codexPatchPlanSha256,
	codexPatchSha256,
	codexPatchTransactionId,
	parseCodexPatchToolCall,
	validateCodexPatchPath,
} from "./codex-workspace-patch-contract.js";
import { assertCodexPatchJournalStorageBound } from "./codex-workspace-patch-store.js";
import { MAX_PRIVATE_STATE_FILE_BYTES } from "./private-state-file.js";

describe("Codex workspace patch contract", () => {
	it("hashes the exact decoded patch bytes and rejects unpaired surrogates", () => {
		expect(codexPatchSha256("é\n")).toBe(
			"edd3a863872a04239eb29ad4bc12fc892b3d4ae57cc7e786a3697816f8e141c2",
		);
		expect(() => codexPatchSha256("\ud800")).toThrowError(
			expect.objectContaining<CodexWorkspacePatchError>({
				name: "CodexWorkspacePatchError",
				code: "invalid_request",
				fatal: true,
			}),
		);
	});

	it("uses length-delimited provider correlation for transaction identity", () => {
		const first = codexPatchTransactionId({
			capsule_id: "10000000-0000-4000-8000-000000000001",
			provider_thread_id: "ab",
			provider_turn_id: "c",
			call_id: "d",
		});
		const second = codexPatchTransactionId({
			capsule_id: "10000000-0000-4000-8000-000000000001",
			provider_thread_id: "a",
			provider_turn_id: "bc",
			call_id: "d",
		});
		expect(first).toMatch(/^[a-f0-9]{64}$/);
		expect(second).not.toBe(first);
	});

	it.each([
		"/absolute",
		"../escape",
		"path/../escape",
		"path\\windows",
		"path//empty",
		"path/.git/config",
		"path/.GIT/config",
		"path/.agentrelay-patch-owned",
		"path/control\u0000name",
		"path/control\u0085name",
		"cafe\u0301.txt",
	])("rejects unsafe path %j", (path) => {
		expect(() => validateCodexPatchPath(path)).toThrowError(
			expect.objectContaining({ code: "unsafe_path", fatal: true }),
		);
	});

	it("validates the exact tool-call boundary", () => {
		const parsed = parseCodexPatchToolCall({
			capsuleId: "10000000-0000-4000-8000-000000000001",
			providerThreadId: "thread-1",
			providerTurnId: "turn-1",
			callId: "call-1",
			hostTurn: {
				turnId: "logical-turn",
				sessionId: "session",
				missionId: "10000000-0000-4000-8000-000000000002",
				deliveryId: "10000000-0000-4000-8000-000000000003",
				executionAttempt: 1,
				contractVersion: 1,
			},
			patch: "diff --git a/a b/a\n",
		});
		expect(parsed.providerThreadId).toBe("thread-1");
		expect(() => parseCodexPatchToolCall({ ...parsed, patch: "\udfff" })).toThrowError(
			expect.objectContaining({ code: "invalid_request", fatal: true }),
		);
		expect(() => parseCodexPatchToolCall({ ...parsed, patch: "x".repeat(1_048_577) })).toThrowError(
			expect.objectContaining({ code: "invalid_request", fatal: true }),
		);
		expect(() => validateCodexPatchPath(`${"a".repeat(256)}.txt`)).toThrowError(
			expect.objectContaining({ code: "unsafe_path", fatal: true }),
		);
	});

	it("rejects a schema-valid path-heavy plan before its journal exceeds private storage", () => {
		const roots = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-"].sort();
		const paths = roots.map((root) => [root, ...Array.from({ length: 511 }, () => "a")].join("/"));
		const key = {
			capsule_id: "10000000-0000-4000-8000-000000000001",
			provider_thread_id: "thread-1",
			provider_turn_id: "turn-1",
			call_id: "call-1",
		};
		const transactionId = codexPatchTransactionId(key);
		const image = {
			blob_sha256: "a".repeat(64),
			byte_length: 1,
			mode: 0o644 as const,
		};
		const changes: readonly CodexPatchChange[] = paths.map((path, index) => ({
			path,
			operation: "write",
			before: null,
			after: image,
			temporary_name: `.agentrelay-patch-${transactionId}-${index}`,
		}));
		const createdDirectories = paths
			.flatMap((path) => {
				const segments = path.split("/");
				return segments.slice(0, -1).map((_, index) => segments.slice(0, index + 1).join("/"));
			})
			.sort((left, right) => {
				const depth = left.split("/").length - right.split("/").length;
				return depth !== 0 ? depth : left < right ? -1 : left > right ? 1 : 0;
			});
		const workspace = {
			root: "/workspace",
			device: "1",
			inode: "2",
			identity_sha256: digestCanonicalJson({ root: "/workspace", device: "1", inode: "2" }),
			head_commit: "b".repeat(40),
		};
		const journal = codexPatchJournalSchema.parse({
			schema_version: 1,
			transaction_id: transactionId,
			state: "commit_intent",
			key,
			host_turn: {
				turnId: "logical-turn",
				sessionId: "session",
				missionId: "10000000-0000-4000-8000-000000000002",
				deliveryId: "10000000-0000-4000-8000-000000000003",
				executionAttempt: 1,
				contractVersion: 1,
			},
			patch_sha256: "c".repeat(64),
			patch_bytes: 1,
			authority: {
				grant_sha256: "d".repeat(64),
				grant_id: "10000000-0000-4000-8000-000000000004",
				lease_id: "10000000-0000-4000-8000-000000000005",
				fencing_token: "1",
				delivery_id: "10000000-0000-4000-8000-000000000003",
				execution_attempt: 1,
				policy_profile: "coding",
				policy_grant_sha256: "e".repeat(64),
				workspace_resource_sha256: "f".repeat(64),
			},
			workspace,
			plan_sha256: codexPatchPlanSha256({
				head_commit: workspace.head_commit,
				created_directories: createdDirectories,
				changes,
			}),
			created_directories: createdDirectories,
			changes,
			result: null,
			reason: null,
		});

		expect(Buffer.byteLength(`${JSON.stringify(journal, null, 2)}\n`, "utf8")).toBeGreaterThan(
			MAX_PRIVATE_STATE_FILE_BYTES,
		);
		expect(() => assertCodexPatchJournalStorageBound(journal)).toThrowError(
			expect.objectContaining({ code: "unsupported_patch", fatal: true }),
		);
	});
});
