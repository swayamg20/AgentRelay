import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { z } from "zod";

const execFileAsync = promisify(execFile);
const bootSessionSchema = z.string().uuid();

/** Returns a kernel-issued identity that changes only when this host boots. */
export async function currentBootSessionId(): Promise<string> {
	let value: string;
	if (process.platform === "linux") {
		value = await readFile("/proc/sys/kernel/random/boot_id", "utf8");
	} else if (process.platform === "darwin") {
		const result = await execFileAsync("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"], {
			encoding: "utf8",
			timeout: 2_000,
			maxBuffer: 1_024,
		});
		value = result.stdout;
	} else {
		throw new Error("Codex provider guardian requires a supported Unix boot identity");
	}
	return bootSessionSchema.parse(value.trim().toLowerCase());
}
