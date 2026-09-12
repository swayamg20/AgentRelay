import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, lstat, open, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { configDir } from "../cli/paths.js";
import { type ConnectorProcessLock, acquireConnectorLock } from "../connector/lock.js";
import { connectorPickupKey } from "../connector/state.js";
import {
	type LiveJournal,
	type LiveScope,
	LiveSessionError,
	liveJournalSchema,
	liveScopeSchema,
} from "./contracts.js";

export interface LiveStore {
	read(): LiveJournal;
	save(state: LiveJournal): Promise<void>;
}

export function liveStatePath(scope: LiveScope, root = configDir()): string {
	return join(
		root,
		"live",
		`${connectorPickupKey(scope.relayUrl, scope.agentId, scope.peerHandle, scope.threadId)}.json`,
	);
}

/** One stable kernel lock owns the journal, model driver, and reply outbox together. */
export async function openLiveStore(options: {
	path: string;
	scope: LiveScope;
	maxTurns: number;
	expiresAt: number;
}): Promise<LiveStore & { close(): Promise<void> }> {
	const scope = liveScopeSchema.parse(options.scope);
	const lock = await acquireConnectorLock({ path: `${options.path}.lock` });
	try {
		let current = await readJournal(options.path);
		if (current) {
			if (
				JSON.stringify(current.scope) !== JSON.stringify(scope) ||
				current.maxTurns !== options.maxTurns
			) {
				throw new LiveSessionError(
					"scope_changed",
					"Live session scope changed; use the original peer, thread and turn limit",
				);
			}
		} else {
			current = liveJournalSchema.parse({
				version: 1,
				scope,
				maxTurns: options.maxTurns,
				expiresAt: options.expiresAt,
				lastSequence: 0,
				turnsStarted: 0,
				pending: null,
				receipts: [],
			});
			await writeJournal(options.path, current);
		}
		return ownedStore(options.path, current, lock);
	} catch (error) {
		await lock.release();
		throw error;
	}
}

function ownedStore(path: string, initial: LiveJournal, lock: ConnectorProcessLock) {
	let current = initial;
	let closed = false;
	return {
		read: () => structuredClone(current),
		async save(next: LiveJournal) {
			if (closed) throw new LiveSessionError("closed", "Live session ownership has ended");
			const parsed = liveJournalSchema.parse(next);
			if (
				JSON.stringify(parsed.scope) !== JSON.stringify(initial.scope) ||
				parsed.expiresAt !== initial.expiresAt ||
				parsed.maxTurns !== initial.maxTurns ||
				parsed.lastSequence < current.lastSequence ||
				parsed.turnsStarted < current.turnsStarted
			) {
				throw new LiveSessionError(
					"journal_conflict",
					"Live session authority or progress cannot be rewritten",
				);
			}
			await writeJournal(path, parsed);
			current = parsed;
		},
		async close() {
			closed = true;
			await lock.release();
		},
	};
}

async function readJournal(path: string): Promise<LiveJournal | null> {
	let file: FileHandle;
	try {
		file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw new LiveSessionError("journal_unreadable", "Cannot safely open the live journal");
	}
	try {
		const stats = await file.stat();
		if (
			!stats.isFile() ||
			stats.nlink !== 1 ||
			(stats.mode & 0o777) !== 0o600 ||
			(process.getuid && stats.uid !== process.getuid()) ||
			stats.size > 256_000
		) {
			throw new Error("unsafe journal");
		}
		return liveJournalSchema.parse(JSON.parse(await file.readFile("utf8")));
	} catch {
		throw new LiveSessionError(
			"journal_invalid",
			"Live journal is invalid or not private; it was not reset",
		);
	} finally {
		await file.close();
	}
}

async function writeJournal(path: string, state: LiveJournal): Promise<void> {
	// Unlike a rename alone, sync both the new content and its directory entry.
	const temporary = `${path}.${randomUUID()}.tmp`;
	const file = await open(temporary, "wx", 0o600);
	try {
		await file.writeFile(`${JSON.stringify(state)}\n`);
		await file.sync();
	} finally {
		await file.close();
	}
	try {
		const existing = await lstat(path).catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return undefined;
			throw error;
		});
		if (existing && (!existing.isFile() || existing.nlink !== 1 || existing.isSymbolicLink())) {
			throw new LiveSessionError("journal_replaced", "Live journal path was replaced");
		}
		await rename(temporary, path);
		const directory = await open(dirname(path), "r");
		try {
			await directory.sync();
		} finally {
			await directory.close();
		}
	} finally {
		await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "ENOENT") throw error;
		});
	}
}
