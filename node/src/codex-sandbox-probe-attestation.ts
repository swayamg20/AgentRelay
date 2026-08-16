import { constants } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";

const ATTESTATION_MODE = 0o600;

/** Verifies the one-shot success record created by the fixed containment probe. */
export async function assertContainmentProbeAttestation(
	path: string,
	expectedToken: string,
): Promise<void> {
	let handle: FileHandle;
	try {
		handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	} catch (error) {
		throw new Error("Codex sandbox capability probe did not publish a safe attestation", {
			cause: error,
		});
	}

	try {
		const stats = await handle.stat({ bigint: true });
		const currentUid = process.getuid?.();
		if (
			currentUid === undefined ||
			!stats.isFile() ||
			(stats.mode & 0o777n) !== BigInt(ATTESTATION_MODE) ||
			stats.nlink !== 1n ||
			stats.uid !== BigInt(currentUid) ||
			stats.size !== BigInt(Buffer.byteLength(expectedToken, "utf8"))
		) {
			throw new Error("Codex sandbox capability probe published an unsafe attestation");
		}
		if ((await handle.readFile("utf8")) !== expectedToken) {
			throw new Error("Codex sandbox capability probe attestation did not match");
		}
	} finally {
		await handle.close();
	}
}
