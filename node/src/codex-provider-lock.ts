import { fstatSync, lstatSync, readFileSync } from "node:fs";

export const INHERITED_PROVIDER_LOCK_FD = 4;

/** Proves that a trusted lifecycle child retained the guardian's exact kernel lock. */
export function assertInheritedProviderLock(path: string): void {
	const descriptor = fstatSync(INHERITED_PROVIDER_LOCK_FD);
	const published = lstatSync(path);
	if (
		published.isSymbolicLink() ||
		!published.isFile() ||
		descriptor.dev !== published.dev ||
		descriptor.ino !== published.ino ||
		descriptor.nlink !== 1 ||
		(published.mode & 0o777) !== 0o600 ||
		(process.getuid !== undefined && published.uid !== process.getuid())
	) {
		throw new Error("Codex provider lifecycle child did not inherit the expected private lock");
	}
	const decoded = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
	if (decoded.schema_version !== 2 || decoded.kind !== "agentrelay_provider_generation_lock") {
		throw new Error("Codex provider lifecycle lock kind is invalid");
	}
}
