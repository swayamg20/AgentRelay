import { lstat, opendir, readFile } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import {
	type LocalFilesystemIdentity,
	MissionWorkspaceError,
} from "./mission-workspace-contract.js";

export async function assertOwnedDirectoryIdentity(
	path: string,
	label: string,
): Promise<LocalFilesystemIdentity> {
	const currentUid = process.getuid?.();
	if (currentUid === undefined) {
		throw new MissionWorkspaceError(
			"unsupported_platform",
			"Mission workspace ownership inspection requires Unix",
		);
	}
	const stats = await lstat(path, { bigint: true });
	if (!stats.isDirectory() || stats.isSymbolicLink()) {
		throw new MissionWorkspaceError(
			"git_metadata_not_isolated",
			`${label} must be a real directory`,
		);
	}
	if (stats.uid !== BigInt(currentUid)) {
		throw new MissionWorkspaceError("workspace_not_owned", `${label} must be owner-controlled`);
	}
	if ((stats.mode & 0o22n) !== 0n) {
		throw new MissionWorkspaceError(
			"workspace_permissions_unsafe",
			`${label} cannot be group- or world-writable`,
		);
	}
	return Object.freeze({ device: stats.dev.toString(), inode: stats.ino.toString() });
}

export async function assertMissionWorkspaceStorageIsolated(input: {
	readonly root: string;
	readonly gitDirectory: string;
	readonly rootDevice: string;
}): Promise<void> {
	const { root, gitDirectory, rootDevice } = input;
	await rejectAlternates(gitDirectory);
	await rejectNestedLinuxMounts(root);
	const pending = [{ directory: root, gitMetadata: false }];
	while (pending.length > 0) {
		const current = pending.pop();
		if (current === undefined) break;
		const entries = await opendir(current.directory);
		for await (const entry of entries) {
			const path = join(current.directory, entry.name);
			const gitMetadata =
				current.gitMetadata || (current.directory === root && entry.name === ".git");
			const stats = await lstat(path, { bigint: true });
			if (stats.dev.toString() !== rootDevice) {
				throw new MissionWorkspaceError(
					"workspace_mounts_unsupported",
					"Mission workspace cannot contain another filesystem",
				);
			}
			if (stats.isDirectory()) {
				pending.push({ directory: path, gitMetadata });
				continue;
			}
			if (stats.isSymbolicLink()) {
				if (gitMetadata) {
					throw new MissionWorkspaceError(
						"git_metadata_not_isolated",
						"Mission workspace Git metadata cannot contain symbolic links",
					);
				}
				continue;
			}
			if (!stats.isFile()) {
				throw new MissionWorkspaceError(
					"workspace_special_files_unsupported",
					"Mission workspace cannot contain device, socket, or pipe entries",
				);
			}
			if (stats.nlink > 1n) {
				throw new MissionWorkspaceError(
					"workspace_hardlinks_unsupported",
					"Mission workspace files cannot share storage with another path",
				);
			}
		}
	}
}

async function rejectAlternates(gitDirectory: string): Promise<void> {
	const alternatesPath = join(gitDirectory, "objects", "info", "alternates");
	const stats = await lstat(alternatesPath).catch((error: unknown) => {
		if (errorCode(error) === "ENOENT") return null;
		throw error;
	});
	if (stats !== null) {
		throw new MissionWorkspaceError(
			"git_alternates_unsupported",
			"Mission workspace cannot borrow Git objects from another repository",
		);
	}
}

async function rejectNestedLinuxMounts(root: string): Promise<void> {
	if (process.platform !== "linux") return;
	const mountInfo = await readFile("/proc/self/mountinfo", "utf8");
	for (const line of mountInfo.split("\n")) {
		if (line.length === 0) continue;
		const encodedMountPoint = line.split(" ")[4];
		if (encodedMountPoint === undefined) {
			throw new MissionWorkspaceError(
				"workspace_mounts_unsupported",
				"Linux mount metadata was malformed",
			);
		}
		const mountPoint = decodeMountInfoPath(encodedMountPoint);
		if (mountPoint !== root && isWithin(mountPoint, root)) {
			throw new MissionWorkspaceError(
				"workspace_mounts_unsupported",
				"Mission workspace cannot contain nested mounts",
			);
		}
	}
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
