import { constants } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import { writeDurableJson } from "./durable-file.js";
import type { JournalStorage, NodeJournalState } from "./journal.js";

export function createFileJournalStorage(path: string): JournalStorage {
	return {
		async load(): Promise<unknown | null> {
			let handle: FileHandle;
			try {
				handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
			} catch (error) {
				if (errorCode(error) === "ENOENT") return null;
				throw error;
			}
			try {
				const stats = await handle.stat();
				if (!stats.isFile()) throw new Error(`Node journal is not a regular file: ${path}`);
				if ((stats.mode & 0o777) !== 0o600) {
					throw new Error(`Node journal must have mode 0600: ${path}`);
				}
				return JSON.parse(await handle.readFile("utf8"));
			} finally {
				await handle.close();
			}
		},
		async save(state: NodeJournalState): Promise<void> {
			await writeDurableJson(path, state, { fileMode: 0o600, directoryMode: 0o700 });
		},
	};
}

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? String(error.code)
		: undefined;
}
