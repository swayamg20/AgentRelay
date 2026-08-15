import { lstat, opendir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";

const MAX_READ_TREE_ENTRIES = 100_000;

/** Rejects storage aliases that could make an approved read tree expose unrelated host data. */
export async function assertContainmentReadTreesIsolated(input: {
	readonly roots: readonly string[];
	readonly deniedRoots: readonly string[];
}): Promise<void> {
	for (const root of minimalRoots(input.roots)) {
		await assertReadTreeIsolated(root, input.deniedRoots);
	}
}

async function assertReadTreeIsolated(root: string, deniedRoots: readonly string[]): Promise<void> {
	await rejectNestedLinuxMounts(root);
	const rootStats = await lstat(root, { bigint: true });
	const rootDevice = rootStats.dev;
	const pending = [root];
	let inspectedEntries = 0;

	while (pending.length > 0) {
		const directory = pending.pop();
		if (directory === undefined) break;
		const entries = await opendir(directory);
		for await (const entry of entries) {
			inspectedEntries += 1;
			if (inspectedEntries > MAX_READ_TREE_ENTRIES) {
				throw new Error("Containment read tree exceeds its bounded inspection limit");
			}
			const path = join(directory, entry.name);
			const stats = await lstat(path, { bigint: true });
			if (stats.dev !== rootDevice) {
				throw new Error("Containment read tree cannot cross filesystem boundaries");
			}
			if (stats.isSymbolicLink()) {
				await assertSafeSymlink(path, deniedRoots);
				continue;
			}
			if ((stats.mode & 0o22n) !== 0n) {
				throw new Error("Containment read tree cannot contain writable host entries");
			}
			assertOwnerControlled(stats.uid);
			if (stats.isDirectory()) {
				pending.push(path);
				continue;
			}
			if (!stats.isFile()) {
				throw new Error("Containment read tree cannot contain device, socket, or pipe entries");
			}
			if (stats.nlink > 1n) {
				throw new Error("Containment read tree files cannot be hard-linked elsewhere");
			}
		}
	}
}

async function assertSafeSymlink(path: string, deniedRoots: readonly string[]): Promise<void> {
	let target: string;
	try {
		target = await realpath(path);
	} catch (error) {
		if (errorCode(error) === "ENOENT") return;
		throw new Error("Containment read tree symbolic link could not be inspected", { cause: error });
	}
	if (deniedRoots.some((root) => isWithin(target, root))) {
		throw new Error("Containment read tree symbolic links cannot target denied roots");
	}
}

function assertOwnerControlled(uid: bigint): void {
	const currentUid = process.getuid?.();
	if (currentUid !== undefined && uid !== 0n && uid !== BigInt(currentUid)) {
		throw new Error("Containment read tree entries must be owned by root or the current user");
	}
}

async function rejectNestedLinuxMounts(root: string): Promise<void> {
	if (process.platform !== "linux") return;
	const mountInfo = await readFile("/proc/self/mountinfo", "utf8");
	for (const line of mountInfo.split("\n")) {
		if (line.length === 0) continue;
		const encodedMountPoint = line.split(" ")[4];
		if (encodedMountPoint === undefined) {
			throw new Error("Linux mount metadata was malformed");
		}
		const mountPoint = decodeMountInfoPath(encodedMountPoint);
		if (mountPoint !== root && isWithin(mountPoint, root)) {
			throw new Error("Containment read tree cannot contain nested mounts");
		}
	}
}

function minimalRoots(roots: readonly string[]): string[] {
	const ordered = [...new Set(roots)].sort((left, right) => left.length - right.length);
	return ordered.filter(
		(root, index) => !ordered.slice(0, index).some((parent) => isWithin(root, parent)),
	);
}

function decodeMountInfoPath(value: string): string {
	return value.replace(/\\([0-7]{3})/g, (_match, octal: string) =>
		String.fromCharCode(Number.parseInt(octal, 8)),
	);
}

function isWithin(path: string, root: string): boolean {
	const child = relative(root, path);
	return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? String(error.code)
		: undefined;
}
