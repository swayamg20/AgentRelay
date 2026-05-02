/**
 * Pure mutations on a TrustFile structure. The bin script reads, mutates,
 * serialises, and writes — these functions are the deterministic middle.
 */

import yaml from "js-yaml";
import type { TeammateEntry, TrustFile } from "../trust.js";
import { FALLBACK_TRUST } from "../trust.js";

export function ensureTrust(file: TrustFile | undefined): TrustFile {
	if (!file) {
		return JSON.parse(JSON.stringify(FALLBACK_TRUST)) as TrustFile;
	}
	return JSON.parse(JSON.stringify(file)) as TrustFile;
}

export function blockTeammate(
	file: TrustFile,
	handle: string,
): { next: TrustFile; changed: boolean } {
	const next = ensureTrust(file);
	if (next.blocked.includes(handle)) return { next, changed: false };
	next.blocked = [...next.blocked, handle].sort();
	return { next, changed: true };
}

export function unblockTeammate(
	file: TrustFile,
	handle: string,
): { next: TrustFile; changed: boolean } {
	const next = ensureTrust(file);
	if (!next.blocked.includes(handle)) return { next, changed: false };
	next.blocked = next.blocked.filter((h) => h !== handle);
	return { next, changed: true };
}

export interface TrustSetUpdate {
	auto_read?: boolean;
	auto_test?: boolean;
	auto_write_paths?: string[];
	require_approval?: string[];
}

export function setTeammate(file: TrustFile, handle: string, update: TrustSetUpdate): TrustFile {
	const next = ensureTrust(file);
	const existing: TeammateEntry = next.teammates[handle] ?? {};
	const merged: TeammateEntry = { ...existing };
	if (update.auto_read !== undefined) merged.auto_read = update.auto_read;
	if (update.auto_test !== undefined) merged.auto_test = update.auto_test;
	if (update.auto_write_paths !== undefined) merged.auto_write_paths = [...update.auto_write_paths];
	if (update.require_approval !== undefined) merged.require_approval = [...update.require_approval];
	next.teammates[handle] = merged;
	return next;
}

export function resetTeammate(
	file: TrustFile,
	handle: string,
): { next: TrustFile; changed: boolean } {
	const next = ensureTrust(file);
	if (!(handle in next.teammates)) return { next, changed: false };
	delete next.teammates[handle];
	return { next, changed: true };
}

export function listTrust(file: TrustFile): {
	teammates: { handle: string; entry: TeammateEntry }[];
	blocked: string[];
	unknownPolicy: TrustFile["unknown_teammates"]["policy"];
} {
	return {
		teammates: Object.entries(file.teammates)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([handle, entry]) => ({ handle, entry })),
		blocked: [...file.blocked].sort(),
		unknownPolicy: file.unknown_teammates.policy,
	};
}

/**
 * Serialise a TrustFile back to YAML with stable key ordering. We preserve
 * the schema rather than the user's original formatting (CLI mutations
 * sort blocked + teammate keys); humans editing the file directly retain
 * their full formatting because the CLI only writes when something changed.
 */
export function serializeTrust(file: TrustFile): string {
	const ordered = {
		version: file.version,
		teammates: Object.fromEntries(
			Object.entries(file.teammates).sort(([a], [b]) => a.localeCompare(b)),
		),
		unknown_teammates: file.unknown_teammates,
		blocked: [...file.blocked].sort(),
		defaults: file.defaults,
	};
	return yaml.dump(ordered, { lineWidth: 100, noRefs: true, sortKeys: false });
}
