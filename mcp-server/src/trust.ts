/**
 * Layer 3 of the AgentRelay trust model: per-teammate trust policy.
 *
 * Loads `~/.agentrelay/trust.yaml` (override via AGENTRELAY_TRUST_PATH),
 * validates it against the schema in `docs/lld.md` §6.2, and exposes
 * `computeOverlay(senderHandle)` — the per-handoff decision the MCP server
 * uses to derive a session-scoped Claude Code / Codex permission overlay.
 *
 * Precedence (highest first):
 *   1. `blocked`           → reject (kill switch from `agentrelay block`)
 *   2. listed in `teammates` → merge `defaults` with their overrides
 *   3. unknown + `unknown_teammates.policy: "reject"`              → reject
 *   4. unknown + `unknown_teammates.policy: "allow_with_default_trust"` → defaults
 *
 * If the file is missing, we fall back to the safest possible policy:
 * unknown teammates rejected, no auto-write paths anywhere, every Edit /
 * Write / Bash tool requires human approval. The MCP server still boots —
 * no trust.yaml just means every handoff goes through the human gate.
 */

import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { z } from "zod";

const teammateEntrySchema = z
	.object({
		auto_read: z.boolean().optional(),
		auto_test: z.boolean().optional(),
		auto_write_paths: z.array(z.string()).optional(),
		require_approval: z.array(z.string()).optional(),
	})
	.passthrough();

const trustFileSchema = z
	.object({
		version: z.literal(1),
		teammates: z.record(z.string(), teammateEntrySchema).optional().default({}),
		unknown_teammates: z
			.object({
				policy: z.enum(["reject", "allow_with_default_trust"]),
			})
			.optional()
			.default({ policy: "reject" }),
		blocked: z.array(z.string()).optional().default([]),
		defaults: teammateEntrySchema.optional().default({}),
	})
	.passthrough();

export type TrustFile = z.infer<typeof trustFileSchema>;
export type TeammateEntry = z.infer<typeof teammateEntrySchema>;

export interface TrustOverlay {
	auto_read: boolean;
	auto_test: boolean;
	auto_write_paths: string[];
	require_approval: string[];
}

export type OverlayDecision =
	| { decision: "reject"; reason: "blocked" | "unknown_rejected" }
	| { decision: "allow"; overlay: TrustOverlay; source: "listed" | "defaults" };

export type LoadTrustResult =
	| { ok: true; trust: TrustFile; path: string; source: "file" }
	| { ok: true; trust: TrustFile; path: string; source: "fallback"; reason: "missing" }
	| { ok: false; reason: "unreadable" | "malformed" | "invalid"; path: string; detail?: string };

/**
 * Safe fallback applied when no trust.yaml exists. Matches the
 * "everything requires approval, unknown teammates rejected" policy.
 */
export const FALLBACK_TRUST: TrustFile = {
	version: 1,
	teammates: {},
	unknown_teammates: { policy: "reject" },
	blocked: [],
	defaults: {
		auto_read: false,
		auto_test: false,
		auto_write_paths: [],
		require_approval: ["Edit", "Write", "Bash"],
	},
};

const SAFE_OVERLAY: TrustOverlay = {
	auto_read: false,
	auto_test: false,
	auto_write_paths: [],
	require_approval: ["Edit", "Write", "Bash"],
};

export function resolveTrustPath(env: NodeJS.ProcessEnv = process.env): string {
	const override = env.AGENTRELAY_TRUST_PATH;
	if (override && override.length > 0) return override;
	return join(homedir(), ".agentrelay", "trust.yaml");
}

export async function loadTrust(env: NodeJS.ProcessEnv = process.env): Promise<LoadTrustResult> {
	const path = resolveTrustPath(env);

	let exists = true;
	try {
		await stat(path);
	} catch {
		exists = false;
	}
	if (!exists) {
		return { ok: true, trust: FALLBACK_TRUST, path, source: "fallback", reason: "missing" };
	}

	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (err) {
		return { ok: false, reason: "unreadable", path, detail: errMsg(err) };
	}

	let parsed: unknown;
	try {
		parsed = yaml.load(raw, { schema: yaml.JSON_SCHEMA });
	} catch (err) {
		return { ok: false, reason: "malformed", path, detail: errMsg(err) };
	}

	const result = trustFileSchema.safeParse(parsed);
	if (!result.success) {
		return { ok: false, reason: "invalid", path, detail: result.error.message };
	}

	return { ok: true, trust: result.data, path, source: "file" };
}

/**
 * Derive a teammate-specific overlay. Pure function over a loaded TrustFile;
 * the caller is responsible for the I/O of `loadTrust`. This separation
 * makes precedence-tree tests trivial and keeps the policy engine
 * deterministic.
 */
export function computeOverlay(trust: TrustFile, senderHandle: string): OverlayDecision {
	if (trust.blocked.includes(senderHandle)) {
		return { decision: "reject", reason: "blocked" };
	}

	const entry = trust.teammates[senderHandle];
	if (entry) {
		return {
			decision: "allow",
			source: "listed",
			overlay: mergeEntries(trust.defaults, entry),
		};
	}

	if (trust.unknown_teammates.policy === "reject") {
		return { decision: "reject", reason: "unknown_rejected" };
	}

	return {
		decision: "allow",
		source: "defaults",
		overlay: mergeEntries(undefined, trust.defaults),
	};
}

/**
 * Glob-prefix match per `lld.md` §6.2: trailing slashes are treated as
 * directory prefixes. `docs/` matches `docs/api.md` and
 * `docs/setup/quickstart.md`. Exact paths match exactly. A literal `*`
 * is reserved for future use; v0.1 doesn't support it and tests assert
 * that a `*` segment is treated as part of the literal prefix.
 */
export function isPathAutoWritable(overlay: TrustOverlay, path: string): boolean {
	const normalized = stripLeadingSlash(path);
	for (const pattern of overlay.auto_write_paths) {
		const p = stripLeadingSlash(pattern);
		if (p.endsWith("/")) {
			if (normalized === p.slice(0, -1) || normalized.startsWith(p)) return true;
		} else if (normalized === p) {
			return true;
		}
	}
	return false;
}

function mergeEntries(base: TeammateEntry | undefined, override: TeammateEntry): TrustOverlay {
	const fallback = SAFE_OVERLAY;
	return {
		auto_read: pickBool(override.auto_read, base?.auto_read, fallback.auto_read),
		auto_test: pickBool(override.auto_test, base?.auto_test, fallback.auto_test),
		auto_write_paths: pickArr(override.auto_write_paths, base?.auto_write_paths, fallback.auto_write_paths),
		require_approval: pickArr(
			override.require_approval,
			base?.require_approval,
			fallback.require_approval,
		),
	};
}

function pickBool(...candidates: Array<boolean | undefined>): boolean {
	for (const c of candidates) {
		if (typeof c === "boolean") return c;
	}
	return false;
}

function pickArr(...candidates: Array<string[] | undefined>): string[] {
	for (const c of candidates) {
		if (Array.isArray(c)) return [...c];
	}
	return [];
}

function stripLeadingSlash(s: string): string {
	return s.startsWith("/") ? s.slice(1) : s;
}

function errMsg(err: unknown): string {
	if (err instanceof Error) return err.message;
	return String(err);
}
