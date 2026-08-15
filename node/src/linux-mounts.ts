import { readFile } from "node:fs/promises";
import { posix } from "node:path";

export interface LinuxMount {
	readonly id: number;
	readonly device: string;
	readonly root: string;
	readonly mountPoint: string;
}

export interface ClassifiedLinuxRoot {
	readonly path: string;
	readonly access: "read" | "write" | "deny";
}

export async function readLinuxMounts(): Promise<readonly LinuxMount[]> {
	if (process.platform !== "linux") return [];
	return parseLinuxMounts(await readFile("/proc/self/mountinfo", "utf8"));
}

export function parseLinuxMounts(value: string): readonly LinuxMount[] {
	const mounts: LinuxMount[] = [];
	for (const line of value.split("\n")) {
		if (line.length === 0) continue;
		const fields = line.split(" ");
		const separator = fields.indexOf("-");
		const id = Number(fields[0]);
		const device = fields[2];
		const root = decodeMountInfoPath(fields[3]);
		const mountPoint = decodeMountInfoPath(fields[4]);
		if (
			separator < 6 ||
			!Number.isSafeInteger(id) ||
			id < 1 ||
			device === undefined ||
			!/^[0-9]+:[0-9]+$/.test(device) ||
			root === undefined ||
			mountPoint === undefined ||
			!isNormalizedAbsolute(root) ||
			!isNormalizedAbsolute(mountPoint)
		) {
			throw new Error("Linux mount metadata was malformed");
		}
		mounts.push({ id, device, root, mountPoint });
	}
	if (mounts.length === 0 && process.platform === "linux") {
		throw new Error("Linux mount metadata was empty");
	}
	return mounts;
}

export function hasNestedLinuxMount(mounts: readonly LinuxMount[], root: string): boolean {
	return mounts.some(
		(mount) => mount.mountPoint !== root && isPosixPathWithin(mount.mountPoint, root),
	);
}

/** Rejects disjoint namespace paths that resolve to overlapping writable or secret storage. */
export function assertNoLinuxStorageAliases(
	roots: readonly ClassifiedLinuxRoot[],
	mounts: readonly LinuxMount[],
): void {
	if (mounts.length === 0) return;
	const resolved = roots.map((root) => ({ ...root, storage: storagePath(root.path, mounts) }));
	for (let leftIndex = 0; leftIndex < resolved.length; leftIndex += 1) {
		for (let rightIndex = leftIndex + 1; rightIndex < resolved.length; rightIndex += 1) {
			const left = resolved[leftIndex];
			const right = resolved[rightIndex];
			if (left === undefined || right === undefined) continue;
			if (left.access === right.access && left.access !== "write") continue;
			if (pathsOverlap(left.path, right.path)) continue;
			if (left.storage.device !== right.storage.device) continue;
			if (pathsOverlap(left.storage.path, right.storage.path)) {
				throw new Error("Containment roots cannot alias storage across access boundaries");
			}
		}
	}
}

function storagePath(path: string, mounts: readonly LinuxMount[]) {
	let selected: LinuxMount | undefined;
	for (const mount of mounts) {
		if (!isPosixPathWithin(path, mount.mountPoint)) continue;
		if (
			selected === undefined ||
			mount.mountPoint.length > selected.mountPoint.length ||
			(mount.mountPoint === selected.mountPoint && mount.id > selected.id)
		) {
			selected = mount;
		}
	}
	if (selected === undefined)
		throw new Error("Containment root is absent from Linux mount metadata");
	const suffix = posix.relative(selected.mountPoint, path);
	return {
		device: selected.device,
		path: suffix.length === 0 ? selected.root : posix.join(selected.root, suffix),
	};
}

function pathsOverlap(left: string, right: string): boolean {
	return isPosixPathWithin(left, right) || isPosixPathWithin(right, left);
}

function isPosixPathWithin(path: string, root: string): boolean {
	const child = posix.relative(root, path);
	return child === "" || (!posix.isAbsolute(child) && child !== ".." && !child.startsWith("../"));
}

function isNormalizedAbsolute(path: string): boolean {
	return posix.isAbsolute(path) && posix.normalize(path) === path && !path.includes("\0");
}

function decodeMountInfoPath(value: string | undefined): string | undefined {
	return value?.replace(/\\([0-7]{3})/g, (_match, octal: string) =>
		String.fromCharCode(Number.parseInt(octal, 8)),
	);
}
