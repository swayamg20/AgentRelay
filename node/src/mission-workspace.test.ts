import { execFile } from "node:child_process";
import {
	chmod,
	link,
	mkdir,
	mkdtemp,
	realpath,
	rename,
	rm,
	symlink,
	unlink,
	writeFile,
} from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkspaceConfig } from "./config.js";
import {
	prepareMissionWorkspace,
	revalidateMissionWorkspaceIsolation,
} from "./mission-workspace.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];
const REPOSITORY_URL = "https://github.com/example/backend.git";

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe.skipIf(process.platform === "win32" || process.getuid === undefined)(
	"prepareMissionWorkspace",
	() => {
		it("accepts an owner-controlled standalone checkout", async () => {
			const repository = await createRepository();

			const result = await prepareMissionWorkspace(repository.workspace, repository.expectation);

			expect(result).toMatchObject({
				repositoryUrl: REPOSITORY_URL,
				baseCommit: repository.head,
				root: repository.root,
				gitDirectory: join(repository.root, ".git"),
				reachableFromRef: "refs/heads/main",
				rootIdentity: {
					device: expect.stringMatching(/^\d+$/),
					inode: expect.stringMatching(/^\d+$/),
				},
				gitIdentity: {
					device: expect.stringMatching(/^\d+$/),
					inode: expect.stringMatching(/^\d+$/),
				},
			});
		});

		it("rejects a linked Git worktree whose control directory lives elsewhere", async () => {
			const repository = await createRepository();
			const linkedRoot = join(repository.temporaryRoot, "linked");
			await git(repository.root, ["worktree", "add", "--detach", linkedRoot, repository.head]);

			await expect(
				prepareMissionWorkspace(
					{ ...repository.workspace, path: linkedRoot },
					repository.expectation,
				),
			).rejects.toMatchObject({ code: "git_metadata_not_isolated" });
		});

		it("rejects a checkout that borrows Git objects through alternates", async () => {
			const repository = await createRepository();
			const donor = await createRepository(repository.temporaryRoot, "donor");
			const alternatesDirectory = join(repository.root, ".git", "objects", "info");
			await mkdir(alternatesDirectory, { recursive: true });
			await writeFile(
				join(alternatesDirectory, "alternates"),
				`${join(donor.root, ".git", "objects")}\n`,
			);

			await expect(
				prepareMissionWorkspace(repository.workspace, repository.expectation),
			).rejects.toMatchObject({ code: "git_alternates_unsupported" });
		});

		it("rejects a tracked file that shares storage outside the workspace", async () => {
			const repository = await createRepository();
			const trackedPath = join(repository.root, "README.md");
			const externalPath = join(repository.temporaryRoot, "external-canary.md");
			await writeFile(externalPath, "fixture\n");
			await unlink(trackedPath);
			await link(externalPath, trackedPath);

			await expect(
				prepareMissionWorkspace(repository.workspace, repository.expectation),
			).rejects.toMatchObject({ code: "workspace_hardlinks_unsupported" });
		});

		it("rejects an ignored file that shares storage outside the workspace", async () => {
			const repository = await createRepository();
			await writeFile(join(repository.root, ".gitignore"), ".cache/\n");
			await git(repository.root, ["add", ".gitignore"]);
			await git(repository.root, ["commit", "-m", "ignore cache"]);
			const head = (await git(repository.root, ["rev-parse", "HEAD"])).trim();
			const cache = join(repository.root, ".cache");
			const externalPath = join(repository.temporaryRoot, "external-cache");
			await mkdir(cache);
			await writeFile(externalPath, "shared\n");
			await link(externalPath, join(cache, "shared"));

			await expect(
				prepareMissionWorkspace(repository.workspace, {
					...repository.expectation,
					expected_base_commit: head,
				}),
			).rejects.toMatchObject({ code: "workspace_hardlinks_unsupported" });
		});

		it("rejects a Git-metadata hardlink to an external file", async () => {
			const repository = await createRepository();
			const externalPath = join(repository.temporaryRoot, "git-secret-canary");
			await writeFile(externalPath, "secret\n");
			await link(externalPath, join(repository.root, ".git", "leak"));

			await expect(
				prepareMissionWorkspace(repository.workspace, repository.expectation),
			).rejects.toMatchObject({ code: "workspace_hardlinks_unsupported" });
		});

		it("revalidates storage aliases and Git alternates after admission", async () => {
			const repository = await createRepository();
			const prepared = await prepareMissionWorkspace(repository.workspace, repository.expectation);
			const externalPath = join(repository.temporaryRoot, "post-admission-canary");
			await writeFile(externalPath, "fixture\n");
			await unlink(join(repository.root, "README.md"));
			await link(externalPath, join(repository.root, "README.md"));

			await expect(revalidateMissionWorkspaceIsolation(prepared)).rejects.toMatchObject({
				code: "workspace_hardlinks_unsupported",
			});

			await unlink(join(repository.root, "README.md"));
			await writeFile(join(repository.root, "README.md"), "fixture\n");
			const alternatesDirectory = join(repository.root, ".git", "objects", "info");
			await mkdir(alternatesDirectory, { recursive: true });
			await writeFile(join(alternatesDirectory, "alternates"), "/unapproved/objects\n");
			await expect(revalidateMissionWorkspaceIsolation(prepared)).rejects.toMatchObject({
				code: "git_alternates_unsupported",
			});
		});

		it("rejects a replaced workspace root during recovery", async () => {
			const repository = await createRepository();
			const prepared = await prepareMissionWorkspace(repository.workspace, repository.expectation);
			await rename(repository.root, join(repository.temporaryRoot, "replaced-workspace"));
			await mkdir(repository.root);

			await expect(revalidateMissionWorkspaceIsolation(prepared)).rejects.toMatchObject({
				code: "workspace_identity_changed",
			});
		});

		it.each([
			["case", "REPOSITORY"],
			["Unicode normalization", "repositóry".normalize("NFD")],
		])("rejects a %s alias even when it points at the approved root", async (_kind, alias) => {
			const repository = await createRepository();
			const aliasPath = join(repository.temporaryRoot, alias);
			await symlink(repository.root, aliasPath).catch((error: unknown) => {
				if (
					typeof error !== "object" ||
					error === null ||
					!("code" in error) ||
					error.code !== "EEXIST"
				) {
					throw error;
				}
			});

			await expect(
				prepareMissionWorkspace(
					{ ...repository.workspace, path: aliasPath },
					repository.expectation,
				),
			).rejects.toMatchObject({ code: "workspace_root_not_canonical" });
		});

		it.each([
			["group", 0o770],
			["world", 0o707],
		])("rejects a %s-writable workspace root", async (_kind, mode) => {
			const repository = await createRepository();
			await chmod(repository.root, mode);

			try {
				await expect(
					prepareMissionWorkspace(repository.workspace, repository.expectation),
				).rejects.toMatchObject({ code: "workspace_permissions_unsafe" });
			} finally {
				await chmod(repository.root, 0o700);
			}
		});

		it("rejects a nested group- or world-writable directory", async () => {
			const repository = await createRepository();
			const nested = join(repository.root, "unsafe-directory");
			await mkdir(nested, { mode: 0o777 });
			await chmod(nested, 0o777);

			await expect(
				prepareMissionWorkspace(repository.workspace, repository.expectation),
			).rejects.toMatchObject({ code: "workspace_permissions_unsafe" });
		});

		it("rejects a group- or world-writable Git metadata entry", async () => {
			const repository = await createRepository();
			await chmod(join(repository.root, ".git", "config"), 0o666);

			await expect(
				prepareMissionWorkspace(repository.workspace, repository.expectation),
			).rejects.toMatchObject({ code: "workspace_permissions_unsafe" });
		});
	},
);

interface RepositoryFixture {
	readonly temporaryRoot: string;
	readonly root: string;
	readonly head: string;
	readonly workspace: WorkspaceConfig;
	readonly expectation: {
		readonly repository_url: string;
		readonly expected_base_commit: string;
	};
}

async function createRepository(
	temporaryRoot?: string,
	directoryName = "repository",
): Promise<RepositoryFixture> {
	const fixtureRoot =
		temporaryRoot ??
		(await realpath(await mkdtemp(join(tmpdir(), "agentrelay-mission-workspace-"))));
	if (temporaryRoot === undefined) temporaryDirectories.push(fixtureRoot);

	const root = join(fixtureRoot, directoryName);
	await mkdir(root);
	await git(root, ["init", "--initial-branch=main", "."]);
	await git(root, ["config", "user.name", "AgentRelay Test"]);
	await git(root, ["config", "user.email", "test@agentrelay.invalid"]);
	await git(root, ["remote", "add", "origin", REPOSITORY_URL]);
	await writeFile(join(root, "README.md"), "fixture\n");
	await git(root, ["add", "README.md"]);
	await git(root, ["commit", "-m", "fixture"]);
	const head = (await git(root, ["rev-parse", "HEAD"])).trim();
	return {
		temporaryRoot: fixtureRoot,
		root,
		head,
		workspace: {
			path: root,
			repository_url: REPOSITORY_URL,
			allowed_base_refs: ["refs/heads/main"],
			policy_profile: "restricted",
		},
		expectation: {
			repository_url: REPOSITORY_URL,
			expected_base_commit: head,
		},
	};
}

async function git(cwd: string, argv: readonly string[]): Promise<string> {
	const result = await execFileAsync("git", [...argv], {
		cwd,
		encoding: "utf8",
		env: {
			PATH: process.env.PATH,
			TMPDIR: process.env.TMPDIR,
			TMP: process.env.TMP,
			TEMP: process.env.TEMP,
			LANG: "C",
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_CONFIG_SYSTEM: devNull,
			GIT_CONFIG_GLOBAL: devNull,
			GIT_ATTR_NOSYSTEM: "1",
			GIT_TERMINAL_PROMPT: "0",
			GIT_CONFIG_COUNT: "1",
			GIT_CONFIG_KEY_0: "core.hooksPath",
			GIT_CONFIG_VALUE_0: devNull,
		},
	});
	return result.stdout;
}
