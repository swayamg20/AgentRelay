/**
 * Filesystem helpers for the `agentrelay` CLI. Centralised so the 0600
 * permission rule (lld §6) is enforced in exactly one place.
 */

import { chmod, mkdir, open, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const SECRET_MODE = 0o600;

export async function writePrivateArchive(path: string, contents: string): Promise<void> {
	const file = await open(path, "wx", SECRET_MODE);
	try {
		await file.chmod(SECRET_MODE);
		await file.writeFile(contents);
	} finally {
		await file.close();
	}
}

/**
 * Write a file atomically with mode 0600. Used for `config.json` and
 * `trust.yaml`. Atomic = write to a sibling tempfile, fsync via rename.
 */
export async function writeSecretFile(path: string, contents: string): Promise<void> {
	const dir = dirname(path);
	await mkdir(dir, { recursive: true });
	const tmp = `${path}.${process.pid}.tmp`;
	await writeFile(tmp, contents, { mode: SECRET_MODE });
	await chmod(tmp, SECRET_MODE);
	await rename(tmp, path);
}
