import { lstat, opendir } from "node:fs/promises";
import { join } from "node:path";
import { type LinuxMount, hasNestedLinuxMount, readLinuxMounts } from "./linux-mounts.js";
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
	readonly signal?: AbortSignal;
}): Promise<void> {
	const { root, gitDirectory, rootDevice, signal } = input;
	signal?.throwIfAborted();
	const currentUid = process.getuid?.();
	if (currentUid === undefined) {
		throw new MissionWorkspaceError(
			"unsupported_platform",
			"Mission workspace ownership inspection requires Unix",
		);
	}
	const ownerUid = BigInt(currentUid);
	await rejectAlternates(gitDirectory);
	signal?.throwIfAborted();
	await rejectNestedLinuxMounts(root);
	signal?.throwIfAborted();
	const pending = [{ directory: root, gitMetadata: false }];
	while (pending.length > 0) {
		signal?.throwIfAborted();
		const current = pending.pop();
		if (current === undefined) break;
		const entries = await opendir(current.directory);
		for await (const entry of entries) {
			signal?.throwIfAborted();
			const path = join(current.directory, entry.name);
			const gitMetadata =
				current.gitMetadata || (current.directory === root && entry.name === ".git");
			const stats = await lstat(path, { bigint: true });
			signal?.throwIfAborted();
			if (stats.dev.toString() !== rootDevice) {
				throw new MissionWorkspaceError(
					"workspace_mounts_unsupported",
					"Mission workspace cannot contain another filesystem",
				);
			}
			if (stats.uid !== ownerUid) {
				throw new MissionWorkspaceError(
					"workspace_not_owned",
					"Mission workspace entries must be owner-controlled",
				);
			}
			if (!stats.isSymbolicLink() && (stats.mode & 0o22n) !== 0n) {
				throw new MissionWorkspaceError(
					"workspace_permissions_unsafe",
					"Mission workspace entries cannot be group- or world-writable",
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
	let mounts: readonly LinuxMount[];
	try {
		mounts = await readLinuxMounts();
	} catch (error) {
		throw new MissionWorkspaceError(
			"workspace_mounts_unsupported",
			"Linux mount metadata could not be validated",
			{ cause: error },
		);
	}
	if (hasNestedLinuxMount(mounts, root)) {
		throw new MissionWorkspaceError(
			"workspace_mounts_unsupported",
			"Mission workspace cannot contain nested mounts",
		);
	}
}

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? String(error.code)
		: undefined;
}
