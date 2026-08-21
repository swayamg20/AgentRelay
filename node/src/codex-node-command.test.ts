import { execFile } from "node:child_process";
import { constants, close, fstatSync, open } from "node:fs";
import { mkdtemp, open as openFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentHostAdapter } from "@agentrelay/protocol";
import { cac } from "cac";
import { describe, expect, it, vi } from "vitest";
import { createFakeCodexOwnerCredential } from "../test-support/fake-codex-owner-credential.js";
import type { DetachedCodexCapsuleLauncherOptions } from "./codex-capsule-launcher.js";
import {
	CODEX_OWNER_CREDENTIAL_FD_OPTION_CONFIG,
	configRequiresCodexWorkspaceGit,
	openCodexNodeCommandRuntime,
	ownCodexOwnerCredentialFd,
} from "./codex-node-command.js";
import type { CodexNodeRuntime } from "./codex-node-runtime.js";
import type { CodexOwnerCredentialSource } from "./codex-owner-credential.js";
import type { RuntimeAuthorityPort } from "./runtime-authority-port.js";
import type { RuntimeProvisioner } from "./runtime-provisioner.js";

const NODE_ID = "81000000-0000-4000-8000-000000000001";
const AGENT_ID = "81000000-0000-4000-8000-000000000002";
const CREDENTIAL_ID = "81000000-0000-4000-8000-000000000003";
const OWNER_CREDENTIAL_FD = 7;
const OWNER_CREDENTIAL_FD_OPTION = [String(OWNER_CREDENTIAL_FD)];
const FIFO_STATS = { isFIFO: () => true, isSocket: () => false };

describe("ownCodexOwnerCredentialFd", () => {
	it.each([
		undefined,
		null,
		true,
		"3",
		"not-a-descriptor",
		[],
		["2"],
		["03"],
		["+3"],
		["3.0"],
		["3e0"],
		["2147483648"],
		["3", "4"],
		Number.NaN,
		Number.POSITIVE_INFINITY,
		-1,
		0,
		2,
		3.5,
		0x80000000,
	])("rejects an unsafe descriptor value without touching a file descriptor: %p", (value) => {
		const readSource = vi.fn();
		const closeFd = vi.fn();
		const inspectFd = vi.fn(() => FIFO_STATS);

		expect(() => ownCodexOwnerCredentialFd(value, { readSource, closeFd, inspectFd })).toThrow(
			"--owner-credential-fd must be an integer from 3 to 2147483647",
		);
		expect(readSource).not.toHaveBeenCalled();
		expect(closeFd).not.toHaveBeenCalled();
		expect(inspectFd).not.toHaveBeenCalled();
	});

	it("closes an owned descriptor exactly once when no credential read starts", async () => {
		const readSource = vi.fn();
		const closeFd = vi.fn(async () => undefined);
		const owner = ownCodexOwnerCredentialFd(OWNER_CREDENTIAL_FD_OPTION, {
			readSource,
			closeFd,
			inspectFd: () => FIFO_STATS,
		});

		const firstClose = owner.close();
		const secondClose = owner.close();
		await Promise.all([firstClose, secondClose]);

		expect(firstClose).toBe(secondClose);
		expect(closeFd).toHaveBeenCalledOnce();
		expect(closeFd).toHaveBeenCalledWith(OWNER_CREDENTIAL_FD);
		expect(readSource).not.toHaveBeenCalled();
		await expect(owner.readSource(new AbortController().signal)).rejects.toMatchObject({
			name: "CodexOwnerCredentialError",
			reason: "unavailable",
		});
	});

	it("does not close an unopened or non-channel descriptor that failed admission", async () => {
		const directory = await mkdtemp(join(tmpdir(), "agentrelay-codex-command-fd-"));
		const handle = await openFile(join(directory, "regular-file"), "w+");
		const regularFd = handle.fd;
		const closeFd = vi.fn(async () => undefined);
		try {
			expect(() => ownCodexOwnerCredentialFd([String(regularFd)], { closeFd })).toThrowError(
				expect.objectContaining({ name: "CodexOwnerCredentialError", reason: "channel" }),
			);
			expect(closeFd).not.toHaveBeenCalled();
			expect(fstatSync(regularFd).isFile()).toBe(true);
			await handle.close();

			expect(() => ownCodexOwnerCredentialFd([String(regularFd)], { closeFd })).toThrowError(
				expect.objectContaining({ name: "CodexOwnerCredentialError", reason: "channel" }),
			);
			expect(closeFd).not.toHaveBeenCalled();
		} finally {
			await handle.close().catch(() => undefined);
			await rm(directory, { recursive: true, force: true });
		}
	});

	it.skipIf(process.platform === "win32")(
		"reserves and closes a real FIFO descriptor after an early command failure",
		async () => {
			const directory = await mkdtemp(join(tmpdir(), "agentrelay-codex-command-fifo-"));
			const path = join(directory, "owner.pipe");
			await execFilePromise("mkfifo", [path]);
			const [reader, writer] = await Promise.all([
				openFd(path, constants.O_RDONLY),
				openFd(path, constants.O_WRONLY),
			]);
			try {
				expect(fstatSync(reader).isFIFO()).toBe(true);
				const owner = ownCodexOwnerCredentialFd([String(reader)]);
				await owner.close();
				expect(() => fstatSync(reader)).toThrowError(expect.objectContaining({ code: "EBADF" }));
			} finally {
				await closeFd(writer);
				await closeFd(reader).catch(() => undefined);
				await rm(directory, { recursive: true, force: true });
			}
		},
	);

	it("hands the descriptor to the bounded reader exactly once without a later close race", async () => {
		const source = ownerCredentialSource();
		const readSource = vi.fn(async () => source);
		const closeFd = vi.fn(async () => undefined);
		const owner = ownCodexOwnerCredentialFd(OWNER_CREDENTIAL_FD_OPTION, {
			readSource,
			closeFd,
			inspectFd: () => FIFO_STATS,
		});
		const signal = new AbortController().signal;

		await expect(owner.readSource(signal)).resolves.toBe(source);
		await expect(owner.readSource(signal)).rejects.toMatchObject({
			name: "CodexOwnerCredentialError",
			reason: "unavailable",
		});
		await owner.close();

		expect(readSource).toHaveBeenCalledOnce();
		expect(readSource).toHaveBeenCalledWith(OWNER_CREDENTIAL_FD, signal);
		expect(closeFd).not.toHaveBeenCalled();
	});

	it("accepts one integer-valued CAC option and rejects duplicates or unsafe values", async () => {
		const singleton = parseCredentialFdWithCac(["--owner-credential-fd", "7"]);
		expect(singleton).toEqual(["7"]);
		const closeFd = vi.fn(async () => undefined);
		await ownCodexOwnerCredentialFd(singleton, {
			closeFd,
			inspectFd: () => FIFO_STATS,
		}).close();
		expect(closeFd).toHaveBeenCalledWith(7);

		for (const equivalent of ["03", "+3", "3.0", "3e0", "0x3"]) {
			const normalized = parseCredentialFdWithCac(["--owner-credential-fd", equivalent]);
			expect(normalized).toEqual(["3"]);
			await ownCodexOwnerCredentialFd(normalized, {
				closeFd: vi.fn(async () => undefined),
				inspectFd: () => FIFO_STATS,
			}).close();
		}
		for (const raw of ["2", "3.5", "2147483648", "not-a-fd"]) {
			expect(() =>
				ownCodexOwnerCredentialFd(parseCredentialFdWithCac(["--owner-credential-fd", raw]), {
					inspectFd: () => FIFO_STATS,
				}),
			).toThrow("--owner-credential-fd must be an integer from 3 to 2147483647");
		}
		expect(() =>
			ownCodexOwnerCredentialFd(
				parseCredentialFdWithCac(["--owner-credential-fd", "3", "--owner-credential-fd", "4"]),
				{ inspectFd: () => FIFO_STATS },
			),
		).toThrow("--owner-credential-fd must be an integer from 3 to 2147483647");
	});
});

describe("openCodexNodeCommandRuntime", () => {
	it("requires Git only for a write profile selected by a configured workspace", async () => {
		const unreferencedWrite = nodeConfig({ includeUnusedWriteProfile: true });
		expect(configRequiresCodexWorkspaceGit(unreferencedWrite)).toBe(false);
		const readHarness = commandHarness(unreferencedWrite);

		const runtime = await openCodexNodeCommandRuntime(
			readHarness.options,
			readHarness.dependencies,
		);

		expect(readHarness.openRuntime).toHaveBeenCalledWith({
			stateDirectory: "/private/node-state",
			launcher: readHarness.launcher,
			signal: readHarness.signal,
		});
		expect(readHarness.readSource).toHaveBeenCalledOnce();
		runtime.close();

		const referencedWrite = nodeConfig({ workspaceAccess: "write" });
		expect(configRequiresCodexWorkspaceGit(referencedWrite)).toBe(true);
		const writeHarness = commandHarness(referencedWrite);
		await expect(
			openCodexNodeCommandRuntime(writeHarness.options, writeHarness.dependencies),
		).rejects.toThrow(
			"--git-executable is required when a configured workspace selects write access",
		);
		expect(writeHarness.createLauncher).not.toHaveBeenCalled();
		expect(writeHarness.openRuntime).not.toHaveBeenCalled();
		expect(writeHarness.readSource).not.toHaveBeenCalled();
		await writeHarness.ownerCredentialFd.close();
		expect(writeHarness.closeFd).toHaveBeenCalledOnce();
	});

	it("passes the exact absolute Git path through passive runtime preflight before reading", async () => {
		const order: string[] = [];
		const harness = commandHarness(nodeConfig({ workspaceAccess: "write" }), {
			gitExecutable: "/owner/bin/git",
			onOpenRuntime: () => order.push("doctor"),
			onReadSource: () => order.push("credential-read"),
		});

		const runtime = await openCodexNodeCommandRuntime(harness.options, harness.dependencies);

		expect(order).toEqual(["doctor", "credential-read"]);
		expect(harness.openRuntime).toHaveBeenCalledWith({
			stateDirectory: "/private/node-state",
			launcher: harness.launcher,
			signal: harness.signal,
			gitExecutable: "/owner/bin/git",
		});
		runtime.close();
	});

	it("pins an explicitly supplied Git executable for a read-only referenced profile", async () => {
		const harness = commandHarness(nodeConfig(), { gitExecutable: "/owner/bin/git" });

		const runtime = await openCodexNodeCommandRuntime(harness.options, harness.dependencies);

		expect(harness.openRuntime).toHaveBeenCalledWith({
			stateDirectory: "/private/node-state",
			launcher: harness.launcher,
			signal: harness.signal,
			gitExecutable: "/owner/bin/git",
		});
		runtime.close();
	});

	it.each(["git", "./git", "/owner/../owner/git", "/owner/git\0ignored"])(
		"rejects a non-absolute or non-normalized Git path before doctor or credential read: %s",
		async (gitExecutable) => {
			const harness = commandHarness(nodeConfig({ workspaceAccess: "write" }), {
				gitExecutable,
			});

			await expect(
				openCodexNodeCommandRuntime(harness.options, harness.dependencies),
			).rejects.toThrow("--git-executable must be an absolute normalized path");
			expect(harness.createLauncher).not.toHaveBeenCalled();
			expect(harness.openRuntime).not.toHaveBeenCalled();
			expect(harness.readSource).not.toHaveBeenCalled();
			await harness.ownerCredentialFd.close();
			expect(harness.closeFd).toHaveBeenCalledOnce();
		},
	);

	it("leaves the secret unread and closes the still-owned fd after doctor failure", async () => {
		const order: string[] = [];
		const failure = new Error("fixed doctor failure");
		const harness = commandHarness(nodeConfig(), {
			onOpenRuntime: () => {
				order.push("doctor");
				throw failure;
			},
			onReadSource: () => order.push("credential-read"),
			onCloseFd: () => order.push("fd-close"),
		});

		await expect(openCodexNodeCommandRuntime(harness.options, harness.dependencies)).rejects.toBe(
			failure,
		);
		await harness.ownerCredentialFd.close();

		expect(order).toEqual(["doctor", "fd-close"]);
		expect(harness.readSource).not.toHaveBeenCalled();
		expect(harness.closeFd).toHaveBeenCalledOnce();
	});

	it("closes a source read just before shutdown and does not publish a runtime", async () => {
		const controller = new AbortController();
		const source = ownerCredentialSource();
		const harness = commandHarness(nodeConfig(), {
			controller,
			source,
			onReadSource: () => controller.abort(new Error("operator stopped the Node")),
		});

		await expect(
			openCodexNodeCommandRuntime(harness.options, harness.dependencies),
		).rejects.toThrow("operator stopped the Node");

		expect(source.close).toHaveBeenCalledOnce();
		expect(harness.closeFd).not.toHaveBeenCalled();
	});

	it("binds lazy fresh credential claims and closes only the source on normal shutdown", async () => {
		const source = ownerCredentialSource();
		const harness = commandHarness(nodeConfig(), { source });

		const runtime = await openCodexNodeCommandRuntime(harness.options, harness.dependencies);
		const claimOwnerCredential = harness.launcherOptions?.claimOwnerCredential;
		expect(claimOwnerCredential).toBeTypeOf("function");
		const first = await claimOwnerCredential?.(harness.signal);
		const second = await claimOwnerCredential?.(harness.signal);

		expect(first).toBeDefined();
		expect(second).toBeDefined();
		expect(first).not.toBe(second);
		expect(source.claim).toHaveBeenCalledTimes(2);
		expect(runtime.runtimeProvisioner).toBe(harness.runtime.runtimeProvisioner);
		expect(runtime.authorityPort).toBe(harness.runtime.authorityPort);
		runtime.close();
		runtime.close();
		expect(source.close).toHaveBeenCalledOnce();
		expect(harness.closeFd).not.toHaveBeenCalled();
		await expect(claimOwnerCredential?.(harness.signal)).rejects.toMatchObject({
			name: "CodexOwnerCredentialError",
			reason: "unavailable",
		});
	});
});

interface HarnessOptions {
	readonly controller?: AbortController;
	readonly gitExecutable?: unknown;
	readonly source?: CodexOwnerCredentialSource;
	readonly onOpenRuntime?: () => void;
	readonly onReadSource?: () => void;
	readonly onCloseFd?: () => void;
}

function commandHarness(config: ReturnType<typeof nodeConfig>, options: HarnessOptions = {}) {
	const controller = options.controller ?? new AbortController();
	const source = options.source ?? ownerCredentialSource();
	const readSource = vi.fn(async () => {
		options.onReadSource?.();
		return source;
	});
	const closeFd = vi.fn(async () => options.onCloseFd?.());
	const ownerCredentialFd = ownCodexOwnerCredentialFd(OWNER_CREDENTIAL_FD_OPTION, {
		readSource,
		closeFd,
		inspectFd: () => FIFO_STATS,
	});
	let launcherOptions: DetachedCodexCapsuleLauncherOptions | undefined;
	const launcher = { start: vi.fn(async () => undefined) };
	const createLauncher = vi.fn((input: DetachedCodexCapsuleLauncherOptions) => {
		launcherOptions = input;
		return launcher;
	});
	const runtime = codexRuntime();
	const openRuntime = vi.fn(async () => {
		options.onOpenRuntime?.();
		return runtime;
	});
	return {
		options: {
			config,
			stateDirectory: "/private/node-state",
			lifetimeSignal: controller.signal,
			gitExecutable: options.gitExecutable,
			capsuleCommand: { executable: "/usr/bin/node", args: ["agentrelay-capsule.js"] },
			ownerCredentialFd,
		},
		dependencies: { createLauncher, openRuntime },
		controller,
		signal: controller.signal,
		source,
		readSource,
		closeFd,
		ownerCredentialFd,
		launcher,
		get launcherOptions() {
			return launcherOptions;
		},
		createLauncher,
		openRuntime,
		runtime,
	};
}

function parseCredentialFdWithCac(args: readonly string[]): unknown {
	const cli = cac("agentrelay-node-test");
	let parsed: unknown;
	cli
		.command("run-codex")
		.option(
			"--owner-credential-fd <fd>",
			"Inherited owner credential fd",
			CODEX_OWNER_CREDENTIAL_FD_OPTION_CONFIG,
		)
		.action((options) => {
			parsed = options.ownerCredentialFd;
		});
	cli.parse(["node", "agentrelay-node-test", "run-codex", ...args], { run: false });
	cli.runMatchedCommand();
	return parsed;
}

function execFilePromise(executable: string, args: readonly string[]): Promise<void> {
	return new Promise((resolve, reject) => {
		execFile(executable, args, (error) => (error ? reject(error) : resolve()));
	});
}

function openFd(path: string, flags: number): Promise<number> {
	return new Promise((resolve, reject) => {
		open(path, flags, (error, fd) => (error ? reject(error) : resolve(fd)));
	});
}

function closeFd(fd: number): Promise<void> {
	return new Promise((resolve, reject) => {
		close(fd, (error) => (error ? reject(error) : resolve()));
	});
}

function ownerCredentialSource(): CodexOwnerCredentialSource & {
	readonly claim: ReturnType<typeof vi.fn>;
	readonly close: ReturnType<typeof vi.fn>;
} {
	let claims = 0;
	return {
		claim: vi.fn(async () => {
			claims += 1;
			return createFakeCodexOwnerCredential(`owner-credential-${claims}`);
		}),
		close: vi.fn(),
	};
}

function codexRuntime(): CodexNodeRuntime {
	const adapter = {} as AgentHostAdapter & RuntimeAuthorityPort;
	const runtimeProvisioner: RuntimeProvisioner = {
		provision: vi.fn(async () => undefined),
		recover: vi.fn(async () => undefined),
	};
	return {
		adapter,
		authorityPort: adapter,
		runtimeProvisioner,
	} as unknown as CodexNodeRuntime;
}

function nodeConfig(
	options: {
		readonly workspaceAccess?: "read" | "write";
		readonly includeUnusedWriteProfile?: boolean;
	} = {},
) {
	return {
		schema_version: 1 as const,
		relay_url: "https://relay.example.com",
		node: {
			node_id: NODE_ID,
			agent_id: AGENT_ID,
			credential_id: CREDENTIAL_ID,
			token: `ar_node_live_${"a".repeat(32)}`,
		},
		workspaces: {
			backend: {
				path: "/srv/backend",
				repository_url: "https://github.com/acme/backend.git",
				allowed_base_refs: ["refs/heads/main"],
				policy_profile: "coding",
			},
		},
		policy_profiles: {
			coding: {
				max_turn_seconds: 300,
				max_reported_tokens: 10_000,
				...(options.workspaceAccess === undefined
					? {}
					: { workspace_access: options.workspaceAccess }),
				network_access: "denied" as const,
				verification_commands: {},
			},
			...(options.includeUnusedWriteProfile
				? {
						unusedWrite: {
							max_turn_seconds: 300,
							max_reported_tokens: 10_000,
							workspace_access: "write" as const,
							network_access: "denied" as const,
							verification_commands: {},
						},
					}
				: {}),
		},
	};
}
