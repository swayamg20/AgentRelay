import { execFile } from "node:child_process";
import {
	chmod,
	link,
	lstat,
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	realpath,
	rename,
	rm,
	symlink,
	unlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { CapsuleRuntimeActivation } from "./capsule-runtime.js";
import {
	type CodexPatchToolCall,
	CodexWorkspacePatchError,
} from "./codex-workspace-patch-contract.js";
import {
	type CodexWorkspacePatchFaultPoint,
	openCodexWorkspacePatchMediator,
} from "./codex-workspace-patch-transaction.js";
import {
	LocalReferenceMonitor,
	type RuntimeAuthorityGrant,
	runtimeAuthorityRequest,
} from "./runtime-authority.js";
import { AUTHORITY_NOW, authorityGrant } from "./runtime-authority.test-support.js";

const execFileAsync = promisify(execFile);
const GIT_EXECUTABLE = "/usr/bin/git";
const CAPSULE_ID = "98000000-0000-4000-8000-000000000001";
const WORKSPACE_RESOURCE = "c".repeat(64);
const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("CodexWorkspacePatchMediator", () => {
	it("compiles and commits text, executable, rename, copy, delete, and Git binary changes", async () => {
		const binaryBefore = Buffer.alloc(32 * 1_024);
		for (let index = 0; index < binaryBefore.length; index += 1) {
			binaryBefore[index] = index % 251;
		}
		const binaryAfter = Buffer.from(binaryBefore);
		binaryAfter.fill(0xff, 12_000, 12_128);
		const binaryLiteral = Buffer.from([0, 255, 1, 254, 2, 253]);
		const fixture = await workspaceFixture({
			"alpha.txt": "old alpha\n",
			"rename-old.txt": "rename body long enough for detection\n",
			"copy-source.txt": "copy body long enough for detection\n",
			"delete.txt": "delete me\n",
			"space name.txt": "space old\n",
			"binary.dat": binaryBefore,
		});
		await writeFile(join(fixture.workspace, "alpha.txt"), "new alpha\n");
		await rename(
			join(fixture.workspace, "rename-old.txt"),
			join(fixture.workspace, "rename-new.txt"),
		);
		await writeFile(
			join(fixture.workspace, "copy-new.txt"),
			await readFile(join(fixture.workspace, "copy-source.txt")),
		);
		await unlink(join(fixture.workspace, "delete.txt"));
		await writeFile(join(fixture.workspace, "space name.txt"), "space new\n");
		await writeFile(join(fixture.workspace, "script.sh"), "#!/bin/sh\necho safe\n", {
			mode: 0o755,
		});
		await writeFile(join(fixture.workspace, "binary.dat"), binaryAfter);
		await writeFile(join(fixture.workspace, "literal.dat"), binaryLiteral);
		await git(fixture.workspace, ["add", "--all", "--"]);
		const patch = await gitOutput(fixture.workspace, [
			"diff",
			"--cached",
			"--binary",
			"--find-renames",
			"--find-copies-harder",
			"HEAD",
		]);
		expect(patch).toContain("GIT binary patch");
		expect(patch).toMatch(/\ndelta [0-9]+\n/);
		expect(patch).toMatch(/\nliteral [0-9]+\n/);
		expect(patch).toContain("similarity index 100%");
		await git(fixture.workspace, ["restore", "--staged", "--", "."]);

		await restoreFixture(fixture.workspace, {
			"alpha.txt": "old alpha\n",
			"rename-old.txt": "rename body long enough for detection\n",
			"copy-source.txt": "copy body long enough for detection\n",
			"delete.txt": "delete me\n",
			"space name.txt": "space old\n",
			"binary.dat": binaryBefore,
		});
		const grant = writeGrant();
		const mediator = await openMediator(fixture);
		try {
			expect(await mediator.inspect(toolCall(patch), activation(grant))).toEqual({
				state: "absent",
			});
			const result = await mediator.apply(toolCall(patch), activation(grant));
			expect(result).toMatchObject({
				patchSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
				planSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
				filesChanged: 9,
			});
			expect(await readFile(join(fixture.workspace, "alpha.txt"), "utf8")).toBe("new alpha\n");
			expect(await readFile(join(fixture.workspace, "rename-new.txt"), "utf8")).toContain(
				"rename body",
			);
			await expect(lstat(join(fixture.workspace, "rename-old.txt"))).rejects.toMatchObject({
				code: "ENOENT",
			});
			expect(await readFile(join(fixture.workspace, "copy-new.txt"), "utf8")).toContain(
				"copy body",
			);
			expect(await readFile(join(fixture.workspace, "copy-source.txt"), "utf8")).toContain(
				"copy body",
			);
			expect(await readFile(join(fixture.workspace, "space name.txt"), "utf8")).toBe("space new\n");
			await expect(lstat(join(fixture.workspace, "delete.txt"))).rejects.toMatchObject({
				code: "ENOENT",
			});
			expect((await lstat(join(fixture.workspace, "script.sh"))).mode & 0o777).toBe(0o755);
			expect(await readFile(join(fixture.workspace, "binary.dat"))).toEqual(binaryAfter);
			expect(await readFile(join(fixture.workspace, "literal.dat"))).toEqual(binaryLiteral);

			const replay = await mediator.apply(toolCall(patch), activation(grant));
			expect(replay).toEqual(result);
			expect(await mediator.inspect(toolCall(patch), activation(grant))).toEqual({
				state: "committed",
				result,
			});
			await expect(mediator.apply(toolCall(`${patch}\n`), activation(grant))).rejects.toMatchObject(
				{
					name: "CodexWorkspacePatchError",
					code: "idempotency_conflict",
					fatal: true,
				},
			);
		} finally {
			await mediator.close();
		}
	});

	it("applies a full-index binary delta in a SHA-256 repository", async () => {
		const before = Buffer.alloc(16 * 1_024);
		for (let index = 0; index < before.length; index += 1) before[index] = index % 239;
		const after = Buffer.from(before);
		after.fill(0, 4_000, 4_256);
		const fixture = await workspaceFixture({ "binary.dat": before }, "sha256");
		await writeFile(join(fixture.workspace, "binary.dat"), after);
		await git(fixture.workspace, ["add", "--all", "--"]);
		const patch = await gitOutput(fixture.workspace, ["diff", "--cached", "--binary", "HEAD"]);
		expect(patch).toMatch(/\nindex [a-f0-9]{64}\.\.[a-f0-9]{64} 100644\n/);
		expect(patch).toMatch(/\ndelta [0-9]+\n/);
		await git(fixture.workspace, ["restore", "--staged", "--", "."]);
		await writeFile(join(fixture.workspace, "binary.dat"), before);

		const mediator = await openMediator(fixture);
		try {
			await mediator.apply(toolCall(patch), activation(writeGrant()));
			expect(await readFile(join(fixture.workspace, "binary.dat"))).toEqual(after);
		} finally {
			await mediator.close();
		}
	});

	it("rejects aggregate binary expansion before creating compiler scratch", async () => {
		const fixture = await workspaceFixture({ "existing.txt": "existing\n" });
		const expanded = Buffer.alloc(4 * 1_024 * 1_024);
		const paths = Array.from({ length: 9 }, (_, index) => `large-${index}.bin`);
		for (const path of paths) await writeFile(join(fixture.workspace, path), expanded);
		await git(fixture.workspace, ["add", "--all", "--"]);
		const patch = await gitOutput(fixture.workspace, ["diff", "--cached", "--binary", "HEAD"]);
		expect(Buffer.byteLength(patch, "utf8")).toBeLessThan(1_048_576);
		expect(patch.match(/\nliteral 4194304\n/g)).toHaveLength(paths.length);
		await git(fixture.workspace, ["restore", "--staged", "--", "."]);
		for (const path of paths) await unlink(join(fixture.workspace, path));

		const mediator = await openMediator(fixture);
		try {
			await expect(mediator.apply(toolCall(patch), activation(writeGrant()))).rejects.toMatchObject(
				{
					code: "unsupported_patch",
					fatal: true,
				},
			);
			const patchRoot = join(fixture.control, ".workspace-patches");
			const identity = (await readdir(patchRoot))[0];
			expect(identity).toBeDefined();
			expect(await readdir(join(patchRoot, identity ?? "", "compiler"))).toEqual([]);
		} finally {
			await mediator.close();
		}
	});

	it("rejects excess binary blocks before creating compiler scratch", async () => {
		const fixture = await workspaceFixture({ "existing.txt": "existing\n" });
		const binaryPath = join(fixture.workspace, "binary.dat");
		await writeFile(binaryPath, Buffer.from([0, 1, 2, 3, 0, 255]));
		await git(fixture.workspace, ["add", "--all", "--"]);
		const valid = await gitOutput(fixture.workspace, ["diff", "--cached", "--binary", "HEAD"]);
		const marker = "GIT binary patch\n";
		const markerOffset = valid.indexOf(marker);
		expect(markerOffset).toBeGreaterThan(0);
		const prefix = valid.slice(0, markerOffset + marker.length);
		const blocks = valid
			.slice(markerOffset + marker.length)
			.trimEnd()
			.split("\n\n");
		const firstBlock = blocks[0];
		expect(firstBlock).toBeDefined();
		const malformed = `${prefix}${[...blocks, firstBlock, firstBlock].join("\n\n")}\n`;
		await git(fixture.workspace, ["restore", "--staged", "--", "."]);
		await unlink(binaryPath);

		const mediator = await openMediator(fixture);
		try {
			await expect(
				mediator.apply(toolCall(malformed), activation(writeGrant())),
			).rejects.toMatchObject({ code: "unsupported_patch", fatal: true });
			const patchRoot = join(fixture.control, ".workspace-patches");
			const identity = (await readdir(patchRoot))[0];
			expect(identity).toBeDefined();
			expect(await readdir(join(patchRoot, identity ?? "", "compiler"))).toEqual([]);
		} finally {
			await mediator.close();
		}
	});

	it("rolls a mixed post-intent workspace forward after a process cut", async () => {
		const fixture = await workspaceFixture({ "one.txt": "one old\n", "two.txt": "two old\n" });
		const patch = twoFilePatch();
		const grant = writeGrant();
		let cut = false;
		const first = await openMediator(fixture, (point) => {
			if (!cut && point.kind === "after_target_effect") {
				cut = true;
				throw new Error("simulated process cut");
			}
		});
		await expect(first.apply(toolCall(patch), activation(grant))).rejects.toMatchObject({
			code: "post_intent_failure",
			fatal: true,
		});
		await first.close();

		const beforeStaleRecovery = await Promise.all([
			readFile(join(fixture.workspace, "one.txt"), "utf8"),
			readFile(join(fixture.workspace, "two.txt"), "utf8"),
		]);
		const recovered = await openMediator(fixture);
		const stale = writeGrant({
			grant_id: "98000000-0000-4000-8000-000000000009",
			fencing_token: "9007199254740994",
		});
		await expect(recovered.recover(activation(stale))).rejects.toMatchObject({
			code: "authority_mismatch",
			fatal: true,
		});
		expect(
			await Promise.all([
				readFile(join(fixture.workspace, "one.txt"), "utf8"),
				readFile(join(fixture.workspace, "two.txt"), "utf8"),
			]),
		).toEqual(beforeStaleRecovery);

		const results = await recovered.recover(activation(grant));
		expect(results).toHaveLength(1);
		expect(await readFile(join(fixture.workspace, "one.txt"), "utf8")).toBe("one new\n");
		expect(await readFile(join(fixture.workspace, "two.txt"), "utf8")).toBe("two new\n");
		await recovered.close();
	});

	it("rejects a same-key different-patch retry before recovering its pending intent", async () => {
		const fixture = await workspaceFixture({ "one.txt": "one old\n", "two.txt": "two old\n" });
		const grant = writeGrant();
		const patch = twoFilePatch();
		const first = await openMediator(fixture, (point) => {
			if (point.kind === "after_commit_intent") throw new Error("cut before writes");
		});
		await expect(first.apply(toolCall(patch), activation(grant))).rejects.toMatchObject({
			code: "post_intent_failure",
		});
		await first.close();

		const recovered = await openMediator(fixture);
		try {
			await expect(
				recovered.apply(toolCall(`${patch}\n`), activation(grant)),
			).rejects.toMatchObject({ code: "idempotency_conflict", fatal: true });
			expect(await readFile(join(fixture.workspace, "one.txt"), "utf8")).toBe("one old\n");
			expect(await readFile(join(fixture.workspace, "two.txt"), "utf8")).toBe("two old\n");
			expect(await recovered.recover(activation(grant))).toHaveLength(1);
		} finally {
			await recovered.close();
		}
	});

	it("durably marks a divergent post-intent target indeterminate without overwriting it", async () => {
		const fixture = await workspaceFixture({ "one.txt": "one old\n", "two.txt": "two old\n" });
		const grant = writeGrant();
		const first = await openMediator(fixture, (point) => {
			if (point.kind === "after_commit_intent") throw new Error("cut before writes");
		});
		await expect(first.apply(toolCall(twoFilePatch()), activation(grant))).rejects.toMatchObject({
			code: "post_intent_failure",
		});
		await first.close();
		await writeFile(join(fixture.workspace, "one.txt"), "owner changed\n");

		const recovered = await openMediator(fixture);
		await expect(recovered.recover(activation(grant))).rejects.toMatchObject({
			code: "indeterminate",
			fatal: true,
		});
		expect(await readFile(join(fixture.workspace, "one.txt"), "utf8")).toBe("owner changed\n");
		expect(await readFile(join(fixture.workspace, "two.txt"), "utf8")).toBe("two old\n");
		await expect(recovered.recover(activation(grant))).rejects.toMatchObject({
			code: "indeterminate",
		});
		await recovered.close();
	});

	it("preflights every journaled directory before creating any of them", async () => {
		const fixture = await workspaceFixture({ "existing.txt": "existing\n" });
		const grant = writeGrant();
		const patch = [
			"diff --git a/a/file.txt b/a/file.txt",
			"new file mode 100644",
			"--- /dev/null",
			"+++ b/a/file.txt",
			"@@ -0,0 +1 @@",
			"+a",
			"diff --git a/z/file.txt b/z/file.txt",
			"new file mode 100644",
			"--- /dev/null",
			"+++ b/z/file.txt",
			"@@ -0,0 +1 @@",
			"+z",
			"",
		].join("\n");
		const first = await openMediator(fixture, (point) => {
			if (point.kind === "after_commit_intent") throw new Error("cut before writes");
		});
		await expect(first.apply(toolCall(patch), activation(grant))).rejects.toMatchObject({
			code: "post_intent_failure",
		});
		await first.close();
		await mkdir(join(fixture.workspace, "z"), { mode: 0o700 });
		await chmod(join(fixture.workspace, "z"), 0o700);

		const recovered = await openMediator(fixture);
		try {
			await expect(recovered.recover(activation(grant))).rejects.toMatchObject({
				code: "indeterminate",
				fatal: true,
			});
			await expect(lstat(join(fixture.workspace, "a"))).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			await recovered.close();
		}
	});

	it("retains commit intent after a transient post-intent read failure", async () => {
		const fixture = await workspaceFixture({ "one.txt": "one old\n", "two.txt": "two old\n" });
		const grant = writeGrant();
		let failNextRead = false;
		const authority = activation(grant);
		const transientAuthority: CapsuleRuntimeActivation = {
			...authority,
			performWorkspaceRead: async (effect) => {
				if (failNextRead) {
					failNextRead = false;
					throw Object.assign(new Error("transient descriptor exhaustion"), { code: "EMFILE" });
				}
				return effect();
			},
		};
		const first = await openMediator(fixture, (point) => {
			if (point.kind === "after_commit_intent") failNextRead = true;
		});
		await expect(first.apply(toolCall(twoFilePatch()), transientAuthority)).rejects.toMatchObject({
			code: "post_intent_failure",
			fatal: true,
		});
		await first.close();
		expect(await readFile(join(fixture.workspace, "one.txt"), "utf8")).toBe("one old\n");

		const recovered = await openMediator(fixture);
		try {
			expect(await recovered.recover(activation(grant))).toHaveLength(1);
			expect(await readFile(join(fixture.workspace, "one.txt"), "utf8")).toBe("one new\n");
		} finally {
			await recovered.close();
		}
	});

	it("does not classify a transient target-read failure as workspace divergence", async () => {
		const fixture = await workspaceFixture({ "one.txt": "one old\n" });
		const grant = writeGrant();
		let failTargetRead = true;
		const first = await openMediator(fixture, (point) => {
			if (point.kind === "before_target_read" && failTargetRead) {
				failTargetRead = false;
				throw new CodexWorkspacePatchError(
					"compiler_failure",
					true,
					"injected transient target read failure",
				);
			}
		});
		await expect(first.apply(toolCall(oneFilePatch()), activation(grant))).rejects.toMatchObject({
			code: "post_intent_failure",
			fatal: true,
		});
		await first.close();
		expect(await readFile(join(fixture.workspace, "one.txt"), "utf8")).toBe("one old\n");

		const recovered = await openMediator(fixture);
		try {
			expect(await recovered.recover(activation(grant))).toHaveLength(1);
			expect(await readFile(join(fixture.workspace, "one.txt"), "utf8")).toBe("one new\n");
		} finally {
			await recovered.close();
		}
	});

	it("does not create temporary staging after write authority is revoked at admission", async () => {
		await expectRevokedMutationRecoverable({
			files: { "one.txt": "one old\n" },
			patch: oneFilePatch(),
			faultKind: "before_temporary_staging_create",
			assertBeforeRecovery: async (workspace) => {
				expect(await readFile(join(workspace, "one.txt"), "utf8")).toBe("one old\n");
				expect(
					(await readdir(workspace)).filter((name) => name.startsWith(".agentrelay-patch-")),
				).toEqual([]);
			},
			assertAfterRecovery: async (workspace) => {
				expect(await readFile(join(workspace, "one.txt"), "utf8")).toBe("one new\n");
			},
		});
	});

	it("does not publish a staged directory after write authority is revoked at admission", async () => {
		await expectRevokedMutationRecoverable({
			files: { "existing.txt": "existing\n" },
			patch: newNestedFilePatch(),
			faultKind: "before_directory_publish",
			assertBeforeRecovery: async (workspace) => {
				await expect(lstat(join(workspace, "new"))).rejects.toMatchObject({ code: "ENOENT" });
				expect(
					(await readdir(workspace)).some((name) => name.startsWith(".agentrelay-patch-")),
				).toBe(true);
			},
			assertAfterRecovery: async (workspace) => {
				expect(await readFile(join(workspace, "new/deep/file.txt"), "utf8")).toBe("created\n");
			},
		});
	});

	it("does not publish a target after write authority is revoked at admission", async () => {
		await expectRevokedMutationRecoverable({
			files: { "one.txt": "one old\n" },
			patch: oneFilePatch(),
			faultKind: "before_target_publish",
			assertBeforeRecovery: async (workspace) => {
				expect(await readFile(join(workspace, "one.txt"), "utf8")).toBe("one old\n");
				expect(
					(await readdir(workspace)).some(
						(name) => name.startsWith(".agentrelay-patch-") && !name.endsWith(".stage"),
					),
				).toBe(true);
			},
			assertAfterRecovery: async (workspace) => {
				expect(await readFile(join(workspace, "one.txt"), "utf8")).toBe("one new\n");
			},
		});
	});

	it("does not delete a target after write authority is revoked at admission", async () => {
		await expectRevokedMutationRecoverable({
			files: { "delete.txt": "delete me\n" },
			patch: deleteFilePatch(),
			faultKind: "before_target_delete",
			assertBeforeRecovery: async (workspace) => {
				expect(await readFile(join(workspace, "delete.txt"), "utf8")).toBe("delete me\n");
			},
			assertAfterRecovery: async (workspace) => {
				await expect(lstat(join(workspace, "delete.txt"))).rejects.toMatchObject({
					code: "ENOENT",
				});
			},
		});
	});

	it("does not clean a durable temporary after write authority is revoked at admission", async () => {
		const fixture = await workspaceFixture({ "one.txt": "one old\n" });
		const patch = oneFilePatch();
		const grant = writeGrant();
		const first = await openMediator(fixture, (point) => {
			if (point.kind === "after_temporary_write") {
				throw new Error("cut after durable temporary publication");
			}
		});
		await expect(first.apply(toolCall(patch), activation(grant))).rejects.toMatchObject({
			code: "post_intent_failure",
			fatal: true,
		});
		await first.close();

		const temporaryName = (await readdir(fixture.workspace)).find(
			(name) => name.startsWith(".agentrelay-patch-") && !name.endsWith(".stage"),
		);
		expect(temporaryName).toBeDefined();
		const temporaryPath = join(fixture.workspace, temporaryName ?? "missing");
		await writeFile(join(fixture.workspace, "one.txt"), await readFile(temporaryPath));
		await chmod(join(fixture.workspace, "one.txt"), 0o644);

		const revocable = revocableActivation(grant);
		let armed = false;
		const revokedRecovery = await openMediator(fixture, (point) => {
			if (!armed && point.kind === "before_temporary_cleanup") {
				armed = true;
				revocable.abortBeforeNextWrite();
			}
		});
		await expect(revokedRecovery.recover(revocable.activation)).rejects.toMatchObject({
			code: "post_intent_failure",
			fatal: true,
		});
		expect(armed).toBe(true);
		await revokedRecovery.close();
		expect(await readFile(join(fixture.workspace, "one.txt"), "utf8")).toBe("one new\n");
		expect(await readFile(temporaryPath, "utf8")).toBe("one new\n");

		const recovered = await openMediator(fixture);
		try {
			expect(await recovered.recover(activation(grant))).toHaveLength(1);
			await expect(lstat(temporaryPath)).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			await recovered.close();
		}
	});

	it("recovers an incomplete private file staging write without exposing it as the journal temp", async () => {
		const fixture = await workspaceFixture({ "one.txt": "one old\n" });
		const grant = writeGrant();
		let cut = true;
		let previousUmask: number | undefined;
		const first = await openMediator(fixture, (point) => {
			if (point.kind === "before_temporary_staging_create") {
				previousUmask = process.umask(0o777);
			}
			if (point.kind === "after_temporary_staging_create" && cut) {
				cut = false;
				throw new Error("simulated cut during temporary preparation");
			}
		});
		try {
			await expect(first.apply(toolCall(oneFilePatch()), activation(grant))).rejects.toMatchObject({
				code: "post_intent_failure",
				fatal: true,
			});
		} finally {
			if (previousUmask !== undefined) process.umask(previousUmask);
		}
		await first.close();
		expect(await readFile(join(fixture.workspace, "one.txt"), "utf8")).toBe("one old\n");
		const reserved = (await readdir(fixture.workspace)).filter((name) =>
			name.startsWith(".agentrelay-patch-"),
		);
		expect(reserved).toHaveLength(1);
		expect(reserved[0]).toMatch(/\.stage$/);
		const stagingStats = await lstat(join(fixture.workspace, reserved[0] ?? ""));
		expect(stagingStats.size).toBe(0);
		expect(stagingStats.mode & 0o777).toBe(0);

		const recovered = await openMediator(fixture);
		try {
			expect(await recovered.recover(activation(grant))).toHaveLength(1);
			expect(await readFile(join(fixture.workspace, "one.txt"), "utf8")).toBe("one new\n");
			expect(
				(await readdir(fixture.workspace)).filter((name) => name.startsWith(".agentrelay-patch-")),
			).toEqual([]);
		} finally {
			await recovered.close();
		}
	});

	it("durably rejects non-applicable patches before any workspace mutation", async () => {
		const fixture = await workspaceFixture({ "one.txt": "one old\n" });
		const mediator = await openMediator(fixture);
		try {
			const call = toolCall(
				"diff --git a/one.txt b/one.txt\n--- a/one.txt\n+++ b/one.txt\n@@ -1 +1 @@\n-not present\n+replacement\n",
			);
			const authority = activation(writeGrant());
			await expect(mediator.apply(call, authority)).rejects.toMatchObject({
				code: "patch_not_applicable",
				fatal: false,
			});
			expect(await mediator.inspect(call, authority)).toEqual({ state: "rejected" });
			await expect(mediator.apply(call, authority)).rejects.toMatchObject({
				code: "patch_not_applicable",
				fatal: false,
			});
			expect(await readFile(join(fixture.workspace, "one.txt"), "utf8")).toBe("one old\n");
		} finally {
			await mediator.close();
		}

		const reopened = await openMediator(fixture);
		try {
			const authority = activation(writeGrant());
			const call = toolCall(
				"diff --git a/one.txt b/one.txt\n--- a/one.txt\n+++ b/one.txt\n@@ -1 +1 @@\n-not present\n+replacement\n",
			);
			expect(await reopened.inspect(call, authority)).toEqual({ state: "rejected" });
			await expect(
				reopened.apply({ ...call, patch: `${call.patch}\n` }, authority),
			).rejects.toMatchObject({ code: "idempotency_conflict", fatal: true });
		} finally {
			await reopened.close();
		}
	});

	it("creates nested directories durably and leaves no reserved temporary paths", async () => {
		const fixture = await workspaceFixture({ "existing.txt": "existing\n" });
		const patch = [
			"diff --git a/new/deep/file.txt b/new/deep/file.txt",
			"new file mode 100644",
			"--- /dev/null",
			"+++ b/new/deep/file.txt",
			"@@ -0,0 +1 @@",
			"+created",
			"",
		].join("\n");
		const mediator = await openMediator(fixture);
		try {
			const previousUmask = process.umask(0o077);
			try {
				await mediator.apply(toolCall(patch), activation(writeGrant()));
			} finally {
				process.umask(previousUmask);
			}
			expect(await readFile(join(fixture.workspace, "new/deep/file.txt"), "utf8")).toBe(
				"created\n",
			);
			expect((await lstat(join(fixture.workspace, "new"))).mode & 0o777).toBe(0o755);
			expect((await lstat(join(fixture.workspace, "new/deep"))).mode & 0o777).toBe(0o755);
			expect(
				(await readdir(join(fixture.workspace, "new/deep"))).filter((name) =>
					name.startsWith(".agentrelay-patch-"),
				),
			).toEqual([]);
		} finally {
			await mediator.close();
		}
	});

	it("recovers a staged directory after a process cut before publication", async () => {
		const fixture = await workspaceFixture({ "existing.txt": "existing\n" });
		const patch = newNestedFilePatch();
		const grant = writeGrant();
		let cut = true;
		let previousUmask: number | undefined;
		const first = await openMediator(fixture, (point) => {
			if (point.kind === "before_directory_staging_create") {
				previousUmask = process.umask(0o777);
			}
			if (point.kind === "after_directory_staging_create" && cut) {
				cut = false;
				throw new Error("simulated cut during directory preparation");
			}
		});
		try {
			await expect(first.apply(toolCall(patch), activation(grant))).rejects.toMatchObject({
				code: "post_intent_failure",
				fatal: true,
			});
		} finally {
			if (previousUmask !== undefined) process.umask(previousUmask);
		}
		await first.close();
		await expect(lstat(join(fixture.workspace, "new"))).rejects.toMatchObject({ code: "ENOENT" });
		const reserved = (await readdir(fixture.workspace)).filter((name) =>
			name.startsWith(".agentrelay-patch-"),
		);
		expect(reserved).toHaveLength(1);
		expect((await lstat(join(fixture.workspace, reserved[0] ?? ""))).mode & 0o777).toBe(0);

		const recovered = await openMediator(fixture);
		try {
			expect(await recovered.recover(activation(grant))).toHaveLength(1);
			expect(await readFile(join(fixture.workspace, "new/deep/file.txt"), "utf8")).toBe(
				"created\n",
			);
			expect(
				(await readdir(fixture.workspace)).filter((name) => name.startsWith(".agentrelay-patch-")),
			).toEqual([]);
		} finally {
			await recovered.close();
		}
	});

	it("does not commit when a created directory changes after its file effect", async () => {
		const fixture = await workspaceFixture({ "existing.txt": "existing\n" });
		const patch = [
			"diff --git a/new/file.txt b/new/file.txt",
			"new file mode 100644",
			"--- /dev/null",
			"+++ b/new/file.txt",
			"@@ -0,0 +1 @@",
			"+created",
			"",
		].join("\n");
		const mediator = await openMediator(fixture, async (point) => {
			if (point.kind === "after_target_effect") {
				await chmod(join(fixture.workspace, "new"), 0o700);
			}
		});
		try {
			await expect(mediator.apply(toolCall(patch), activation(writeGrant()))).rejects.toMatchObject(
				{
					code: "indeterminate",
					fatal: true,
				},
			);
			expect(await mediator.inspect(toolCall(patch), activation(writeGrant()))).toEqual({
				state: "indeterminate",
			});
		} finally {
			await mediator.close();
		}
	});

	it("does not commit against a HEAD changed after workspace effects", async () => {
		const fixture = await workspaceFixture({
			"one.txt": "one old\n",
			"unrelated.txt": "unrelated old\n",
		});
		let changedHead = false;
		const mediator = await openMediator(fixture, async (point) => {
			if (point.kind !== "after_target_effect" || changedHead) return;
			changedHead = true;
			await writeFile(join(fixture.workspace, "unrelated.txt"), "unrelated new\n");
			await git(fixture.workspace, ["add", "--", "unrelated.txt"]);
			await git(fixture.workspace, ["commit", "-m", "concurrent unrelated commit"]);
		});
		try {
			await expect(
				mediator.apply(toolCall(oneFilePatch()), activation(writeGrant())),
			).rejects.toMatchObject({
				code: "indeterminate",
				fatal: true,
			});
			expect(await readFile(join(fixture.workspace, "one.txt"), "utf8")).toBe("one new\n");
		} finally {
			await mediator.close();
		}
	});

	it("preserves NFC Unicode paths from Git-quoted rename headers", async () => {
		const oldPath = "café old.txt";
		const newPath = "café new.txt";
		const quotedOldPath = "safe.txt";
		const quotedNewPath = 'quote"name.txt';
		const fixture = await workspaceFixture({
			[oldPath]: "unicode rename body\n",
			[quotedOldPath]: "quoted rename body\n",
		});
		await rename(join(fixture.workspace, oldPath), join(fixture.workspace, newPath));
		await rename(join(fixture.workspace, quotedOldPath), join(fixture.workspace, quotedNewPath));
		await git(fixture.workspace, ["add", "--all", "--"]);
		const patch = await gitOutput(fixture.workspace, [
			"diff",
			"--cached",
			"--find-renames",
			"HEAD",
		]);
		expect(patch).toContain("rename from");
		await git(fixture.workspace, ["restore", "--staged", "--", "."]);
		await rename(join(fixture.workspace, newPath), join(fixture.workspace, oldPath));
		await rename(join(fixture.workspace, quotedNewPath), join(fixture.workspace, quotedOldPath));

		const mediator = await openMediator(fixture);
		try {
			await mediator.apply(toolCall(patch), activation(writeGrant()));
			expect(await readFile(join(fixture.workspace, newPath), "utf8")).toBe(
				"unicode rename body\n",
			);
			expect(await readFile(join(fixture.workspace, quotedNewPath), "utf8")).toBe(
				"quoted rename body\n",
			);
			await expect(lstat(join(fixture.workspace, oldPath))).rejects.toMatchObject({
				code: "ENOENT",
			});
			await expect(lstat(join(fixture.workspace, quotedOldPath))).rejects.toMatchObject({
				code: "ENOENT",
			});
		} finally {
			await mediator.close();
		}
	});

	it("rejects symbolic-link ancestors and multiply linked targets before intent", async () => {
		const symlinkFixture = await workspaceFixture({ "one.txt": "one old\n" });
		await mkdir(join(symlinkFixture.workspace, "real"));
		await symlink("real", join(symlinkFixture.workspace, "alias"));
		const symlinkMediator = await openMediator(symlinkFixture);
		try {
			await expect(
				symlinkMediator.apply(
					toolCall(
						"diff --git a/alias/new.txt b/alias/new.txt\nnew file mode 100644\n--- /dev/null\n+++ b/alias/new.txt\n@@ -0,0 +1 @@\n+unsafe\n",
					),
					activation(writeGrant()),
				),
			).rejects.toMatchObject({ fatal: true });
		} finally {
			await symlinkMediator.close();
		}

		const hardlinkFixture = await workspaceFixture({ "one.txt": "one old\n" });
		await link(
			join(hardlinkFixture.workspace, "one.txt"),
			join(hardlinkFixture.workspace, "alias.txt"),
		);
		const hardlinkMediator = await openMediator(hardlinkFixture);
		try {
			await expect(
				hardlinkMediator.apply(
					toolCall(
						"diff --git a/one.txt b/one.txt\n--- a/one.txt\n+++ b/one.txt\n@@ -1 +1 @@\n-one old\n+one new\n",
					),
					activation(writeGrant()),
				),
			).rejects.toMatchObject({ fatal: true });
			expect(await readFile(join(hardlinkFixture.workspace, "one.txt"), "utf8")).toBe("one old\n");
		} finally {
			await hardlinkMediator.close();
		}
	});

	it("rejects absolute headers, special-bit inputs, file-directory transitions, and special outputs", async () => {
		const fixture = await workspaceFixture({ "one.txt": "one old\n" });
		const mediator = await openMediator(fixture);
		try {
			await expect(
				mediator.apply(
					toolCall(
						"diff --git /tmp/escape /tmp/escape\nnew file mode 100644\n--- /dev/null\n+++ /tmp/escape\n@@ -0,0 +1 @@\n+escape\n",
					),
					activation(writeGrant()),
				),
			).rejects.toMatchObject({ code: "unsafe_path", fatal: true });

			await chmod(join(fixture.workspace, "one.txt"), 0o4644);
			await expect(
				mediator.apply(
					toolCall(
						"diff --git a/one.txt b/one.txt\n--- a/one.txt\n+++ b/one.txt\n@@ -1 +1 @@\n-one old\n+one new\n",
					),
					activation(writeGrant()),
				),
			).rejects.toMatchObject({ code: "unsupported_patch", fatal: true });

			await mkdir(join(fixture.workspace, "directory"));
			await expect(
				mediator.apply(
					toolCall(
						"diff --git a/directory b/directory\nnew file mode 100644\n--- /dev/null\n+++ b/directory\n@@ -0,0 +1 @@\n+file\n",
					),
					activation(writeGrant()),
				),
			).rejects.toMatchObject({ code: "unsupported_patch", fatal: true });

			for (const mode of ["120000", "160000"]) {
				await expect(
					mediator.apply(
						toolCall(
							`diff --git a/special b/special\nnew file mode ${mode}\n--- /dev/null\n+++ b/special\n@@ -0,0 +1 @@\n+special\n`,
						),
						activation(writeGrant()),
					),
				).rejects.toMatchObject({ code: "unsupported_patch", fatal: true });
			}
		} finally {
			await mediator.close();
		}
	});

	it("rejects unsafe paths in later unframed raw-diff sections", async () => {
		const fixture = await workspaceFixture({ "existing.txt": "existing\n" });
		const mediator = await openMediator(fixture);
		try {
			for (const unsafeNewPath of ["/tmp/evil.txt", "b/../evil.txt"]) {
				const patch = [
					"--- /dev/null",
					"+++ b/safe.txt",
					"@@ -0,0 +1 @@",
					"+safe",
					"--- /dev/null",
					`+++ ${unsafeNewPath}`,
					"@@ -0,0 +1 @@",
					"+unsafe",
					"",
				].join("\n");
				await expect(
					mediator.apply(toolCall(patch), activation(writeGrant())),
				).rejects.toMatchObject({
					code: "unsafe_path",
					fatal: true,
				});
			}
			await expect(lstat(join(fixture.workspace, "safe.txt"))).rejects.toMatchObject({
				code: "ENOENT",
			});
		} finally {
			await mediator.close();
		}
	});

	it("does not mistake a header-shaped deleted line for a later raw path", async () => {
		const fixture = await workspaceFixture({ "one.txt": "-- /tmp/content\n" });
		const patch = [
			"diff --git a/one.txt b/one.txt",
			"--- a/one.txt",
			"+++ b/one.txt",
			"@@ -1 +1 @@",
			"--- /tmp/content",
			"+safe replacement",
			"",
		].join("\n");
		const mediator = await openMediator(fixture);
		try {
			await mediator.apply(toolCall(patch), activation(writeGrant()));
			expect(await readFile(join(fixture.workspace, "one.txt"), "utf8")).toBe("safe replacement\n");
		} finally {
			await mediator.close();
		}
	});

	it("detects a tampered durable blob before recovery writes", async () => {
		const fixture = await workspaceFixture({ "one.txt": "one old\n", "two.txt": "two old\n" });
		const grant = writeGrant();
		const first = await openMediator(fixture, (point) => {
			if (point.kind === "after_commit_intent") throw new Error("cut before writes");
		});
		await expect(first.apply(toolCall(twoFilePatch()), activation(grant))).rejects.toMatchObject({
			code: "post_intent_failure",
		});
		await first.close();

		const patchRoot = join(fixture.control, ".workspace-patches");
		const identity = (await readdir(patchRoot))[0];
		expect(identity).toBeDefined();
		const transaction = (await readdir(join(patchRoot, identity ?? "", "transactions")))[0];
		expect(transaction).toBeDefined();
		const blobsDirectory = join(
			patchRoot,
			identity ?? "",
			"transactions",
			transaction ?? "",
			"blobs",
		);
		const blob = (await readdir(blobsDirectory))[0];
		expect(blob).toBeDefined();
		const blobPath = join(blobsDirectory, blob ?? "");
		const existing = await readFile(blobPath);
		await writeFile(blobPath, Buffer.alloc(existing.length, 0), { mode: 0o600 });

		const recovered = await openMediator(fixture);
		try {
			await expect(recovered.recover(activation(grant))).rejects.toMatchObject({
				code: "state_corrupt",
				fatal: true,
			});
			expect(await readFile(join(fixture.workspace, "one.txt"), "utf8")).toBe("one old\n");
			expect(await readFile(join(fixture.workspace, "two.txt"), "utf8")).toBe("two old\n");
		} finally {
			await recovered.close();
		}
	});

	it("holds one workspace-global kernel lock until close", async () => {
		const fixture = await workspaceFixture({ "one.txt": "one old\n" });
		const first = await openMediator(fixture);
		await expect(openMediator(fixture)).rejects.toMatchObject({
			name: "ProcessLockError",
			reason: "already_running",
		});
		await first.close();
		const second = await openMediator(fixture);
		await second.close();
	});

	it("rejects a trusted-looking Git executable inside writable workspace state", async () => {
		const fixture = await workspaceFixture({ "one.txt": "one old\n" });
		const localGit = join(fixture.workspace, "local-git");
		await writeFile(localGit, await readFile(GIT_EXECUTABLE), { mode: 0o755 });
		await chmod(localGit, 0o755);
		await expect(
			openCodexWorkspacePatchMediator({
				capsuleId: CAPSULE_ID,
				workspaceRoot: fixture.workspace,
				workspaceResourceSha256: WORKSPACE_RESOURCE,
				workspaceGlobalControlRoot: fixture.control,
				gitExecutable: localGit,
			}),
		).rejects.toMatchObject({
			name: "CodexWorkspacePatchError",
			code: "invalid_request",
			fatal: true,
		});
	});
});

interface WorkspaceFixture {
	readonly workspace: string;
	readonly control: string;
}

async function workspaceFixture(
	files: Readonly<Record<string, string | Buffer>>,
	objectFormat: "sha1" | "sha256" = "sha1",
): Promise<WorkspaceFixture> {
	const workspace = await canonicalTemporaryDirectory("agentrelay-patch-workspace-");
	const control = await canonicalTemporaryDirectory("agentrelay-patch-control-");
	await git(workspace, ["init", `--object-format=${objectFormat}`, "--template="]);
	await git(workspace, ["config", "user.name", "AgentRelay Test"]);
	await git(workspace, ["config", "user.email", "agentrelay@example.test"]);
	for (const [path, value] of Object.entries(files)) await writeFile(join(workspace, path), value);
	await git(workspace, ["add", "--all", "--"]);
	await git(workspace, ["commit", "-m", "fixture"]);
	return { workspace, control };
}

async function restoreFixture(
	workspace: string,
	files: Readonly<Record<string, string | Buffer>>,
): Promise<void> {
	for (const path of ["rename-new.txt", "copy-new.txt", "script.sh", "literal.dat"]) {
		await unlink(join(workspace, path)).catch(() => undefined);
	}
	for (const [path, value] of Object.entries(files)) {
		await writeFile(join(workspace, path), value, { mode: 0o644 });
		await chmod(join(workspace, path), 0o644);
	}
}

async function openMediator(
	fixture: WorkspaceFixture,
	fault?: (point: CodexWorkspacePatchFaultPoint) => void | Promise<void>,
) {
	return openCodexWorkspacePatchMediator({
		capsuleId: CAPSULE_ID,
		workspaceRoot: fixture.workspace,
		workspaceResourceSha256: WORKSPACE_RESOURCE,
		workspaceGlobalControlRoot: fixture.control,
		gitExecutable: GIT_EXECUTABLE,
		fault,
	});
}

function writeGrant(overrides: Partial<Parameters<typeof authorityGrant>[0]> = {}) {
	const base = authorityGrant();
	return authorityGrant({
		workspace_resource_sha256: WORKSPACE_RESOURCE,
		capabilities: [...base.capabilities, { action: "workspace_write", resource: "workspace" }],
		...overrides,
	});
}

function activation(grant: RuntimeAuthorityGrant): CapsuleRuntimeActivation {
	return {
		grant,
		signal: new AbortController().signal,
		performWorkspaceRead: async (effect) => effect(),
		performWorkspaceWrite: async (effect) => effect(),
	};
}

function revocableActivation(grant: RuntimeAuthorityGrant): {
	readonly activation: CapsuleRuntimeActivation;
	abortBeforeNextWrite(): void;
} {
	const monitor = new LocalReferenceMonitor(
		grant,
		{ record: () => undefined },
		{
			now: () => new Date(AUTHORITY_NOW),
		},
	);
	let abortBeforeNextWrite = false;
	return {
		activation: {
			grant,
			signal: monitor.signal,
			performWorkspaceRead: (effect) =>
				monitor.perform(
					runtimeAuthorityRequest(grant, {
						action: "workspace_read",
						resource: "workspace",
					}),
					effect,
				),
			performWorkspaceWrite: (effect) =>
				monitor.perform(
					runtimeAuthorityRequest(grant, {
						action: "workspace_write",
						resource: "workspace",
					}),
					() => {
						if (abortBeforeNextWrite) {
							abortBeforeNextWrite = false;
							monitor.revoke("revoked");
						}
						return effect();
					},
				),
		},
		abortBeforeNextWrite() {
			abortBeforeNextWrite = true;
		},
	};
}

async function expectRevokedMutationRecoverable(input: {
	readonly files: Readonly<Record<string, string | Buffer>>;
	readonly patch: string;
	readonly faultKind: CodexWorkspacePatchFaultPoint["kind"];
	readonly assertBeforeRecovery: (workspace: string) => void | Promise<void>;
	readonly assertAfterRecovery: (workspace: string) => void | Promise<void>;
}): Promise<void> {
	const fixture = await workspaceFixture(input.files);
	const grant = writeGrant();
	const revocable = revocableActivation(grant);
	let armed = false;
	const first = await openMediator(fixture, (point) => {
		if (!armed && point.kind === input.faultKind) {
			armed = true;
			revocable.abortBeforeNextWrite();
		}
	});
	await expect(first.apply(toolCall(input.patch), revocable.activation)).rejects.toMatchObject({
		code: "post_intent_failure",
		fatal: true,
	});
	expect(armed).toBe(true);
	await first.close();
	await input.assertBeforeRecovery(fixture.workspace);

	const recovered = await openMediator(fixture);
	try {
		await expect(recovered.inspect(toolCall(input.patch), activation(grant))).rejects.toMatchObject(
			{
				code: "post_intent_failure",
				fatal: true,
			},
		);
		expect(await recovered.recover(activation(grant))).toHaveLength(1);
		await input.assertAfterRecovery(fixture.workspace);
	} finally {
		await recovered.close();
	}
}

function toolCall(patch: string): CodexPatchToolCall {
	return {
		capsuleId: CAPSULE_ID,
		providerThreadId: "provider-thread",
		providerTurnId: "provider-turn",
		callId: "provider-call",
		hostTurn: {
			turnId: "logical-turn",
			sessionId: "session",
			missionId: "97000000-0000-4000-8000-000000000005",
			deliveryId: "97000000-0000-4000-8000-000000000006",
			executionAttempt: 1,
			contractVersion: 1,
		},
		patch,
	};
}

function twoFilePatch(): string {
	return [
		"diff --git a/one.txt b/one.txt",
		"--- a/one.txt",
		"+++ b/one.txt",
		"@@ -1 +1 @@",
		"-one old",
		"+one new",
		"diff --git a/two.txt b/two.txt",
		"--- a/two.txt",
		"+++ b/two.txt",
		"@@ -1 +1 @@",
		"-two old",
		"+two new",
		"",
	].join("\n");
}

function oneFilePatch(): string {
	return [
		"diff --git a/one.txt b/one.txt",
		"--- a/one.txt",
		"+++ b/one.txt",
		"@@ -1 +1 @@",
		"-one old",
		"+one new",
		"",
	].join("\n");
}

function deleteFilePatch(): string {
	return [
		"diff --git a/delete.txt b/delete.txt",
		"deleted file mode 100644",
		"--- a/delete.txt",
		"+++ /dev/null",
		"@@ -1 +0,0 @@",
		"-delete me",
		"",
	].join("\n");
}

function newNestedFilePatch(): string {
	return [
		"diff --git a/new/deep/file.txt b/new/deep/file.txt",
		"new file mode 100644",
		"--- /dev/null",
		"+++ b/new/deep/file.txt",
		"@@ -0,0 +1 @@",
		"+created",
		"",
	].join("\n");
}

async function canonicalTemporaryDirectory(prefix: string): Promise<string> {
	const created = await mkdtemp(join(tmpdir(), prefix));
	temporaryDirectories.push(created);
	await chmod(created, 0o700);
	return realpath(created);
}

async function git(cwd: string, args: readonly string[]): Promise<void> {
	await execFileAsync(GIT_EXECUTABLE, [...args], { cwd });
}

async function gitOutput(cwd: string, args: readonly string[]): Promise<string> {
	const result = await execFileAsync(GIT_EXECUTABLE, [...args], {
		cwd,
		encoding: "utf8",
		maxBuffer: 2 * 1_048_576,
	});
	return result.stdout;
}
