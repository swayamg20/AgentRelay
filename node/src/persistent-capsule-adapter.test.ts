import { chmod, lstat, mkdtemp, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { type Server, createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { HostEvent, HostSessionRef, HostTurnRef, StartTurnInput } from "@agentrelay/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { DropInstallResponseLauncher } from "../test-support/capsule-fault-proxy.js";
import {
	CAPSULE_DESCRIPTOR_FILE,
	readFakeCapsuleLaunchDescriptor,
} from "./capsule-launch-descriptor.js";
import { writeDurableJson } from "./durable-file.js";
import { PersistentFakeCapsuleServer } from "./fake-capsule-server.js";
import { CAPSULE_STATE_FILE } from "./fake-capsule-store.js";
import {
	type CapsuleLauncher,
	PersistentFakeCapsuleAdapter,
	buildCapsuleEnvironment,
} from "./persistent-capsule-adapter.js";
import type { RuntimeAuthorityPort } from "./runtime-authority-port.js";
import { NodeRuntimeAuthoritySession } from "./runtime-authority-session.js";
import type { RuntimeAuthorityGrant } from "./runtime-authority.js";
import { runtimeAuthorityRequest } from "./runtime-authority.js";
import { authorityGrant } from "./runtime-authority.test-support.js";

const IDS = {
	mission: "10000000-0000-4000-8000-000000000001",
	participant: "10000000-0000-4000-8000-000000000002",
	owner: "10000000-0000-4000-8000-000000000003",
	delivery: "10000000-0000-4000-8000-000000000004",
	secondDelivery: "10000000-0000-4000-8000-000000000005",
} as const;

const TEST_AUTHORITY = authorityGrant({
	agent_id: IDS.participant,
	mission_id: IDS.mission,
	delivery_id: IDS.delivery,
	workspace_alias: "backend-primary",
	lease_expires_at: "2099-01-01T00:01:00.000Z",
	hard_expires_at: "2099-01-01T00:05:00.000Z",
});

const temporaryDirectories: string[] = [];
const launchers: Array<{ closeAll(): Promise<void> }> = [];

afterEach(async () => {
	await Promise.all(launchers.splice(0).map((launcher) => launcher.closeAll()));
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("PersistentFakeCapsuleAdapter", () => {
	it("requires a local authority grant before activating a Mission capsule", async () => {
		const rootDirectory = await temporaryDirectory();
		const launcher = capsuleLauncher();
		const adapter = await PersistentFakeCapsuleAdapter.open(
			adapterOptions(rootDirectory, launcher),
		);

		await expect(adapter.ensureSession(sessionInput())).rejects.toMatchObject({
			name: "CapsuleRpcError",
			code: "authority_denied",
		});
		expect(launcher.startCalls).toBe(0);
	});

	it("rejects a current lease outside the installed grant scope before launch", async () => {
		const rootDirectory = await temporaryDirectory();
		const launcher = capsuleLauncher();
		const adapter = await PersistentFakeCapsuleAdapter.open(
			adapterOptions(rootDirectory, launcher),
		);
		const lease = currentLease(TEST_AUTHORITY);

		for (const mismatched of [
			{ ...lease, grant_id: "10000000-0000-4000-8000-000000000010" },
			{ ...lease, lease_id: "10000000-0000-4000-8000-000000000011" },
			{ ...lease, fencing_token: "9007199254740994" },
		]) {
			await expect(adapter.installAuthority(TEST_AUTHORITY, mismatched)).rejects.toMatchObject({
				code: "authority_denied",
				message: "Runtime authority current lease does not match its grant",
			});
		}
		await expect(
			adapter.installAuthority(TEST_AUTHORITY, {
				...lease,
				lease_expires_at: "2098-12-31T23:59:00.000Z",
			}),
		).rejects.toMatchObject({
			code: "authority_denied",
			message: "Runtime authority current lease cannot move backwards",
		});
		expect(launcher.startCalls).toBe(0);
	});

	it("carries install, assert, renewal, exact replay, and revocation over the private wire", async () => {
		const rootDirectory = await temporaryDirectory();
		const launcher = capsuleLauncher();
		const adapter = await PersistentFakeCapsuleAdapter.open(
			adapterOptions(rootDirectory, launcher),
		);

		await adapter.installAuthority(TEST_AUTHORITY, currentLease(TEST_AUTHORITY));
		await adapter.assertAuthority(
			runtimeAuthorityRequest(
				TEST_AUTHORITY,
				{ action: "outbound_publish", resource: "relay" },
				{ output_bytes: 10 },
			),
		);
		const renewedLease = {
			grant_id: TEST_AUTHORITY.grant_id,
			lease_id: TEST_AUTHORITY.lease_id,
			fencing_token: TEST_AUTHORITY.fencing_token,
			lease_expires_at: "2099-01-01T00:02:00.000Z",
		} as const;
		await adapter.renewAuthority(IDS.mission, renewedLease);
		await expect(adapter.installAuthority(TEST_AUTHORITY, renewedLease)).resolves.toBeUndefined();
		expect(await adapter.ensureSession(sessionInput())).toMatchObject(sessionInput());

		const server = launcher.onlyServer();
		await adapter.revokeAuthority(TEST_AUTHORITY, "revoked");
		await server.waitUntilClosed();
		await expect(adapter.ensureSession(sessionInput())).rejects.toMatchObject({
			code: "authority_denied",
		});

		const nextAuthority = authorityGrant({
			grant_id: "10000000-0000-4000-8000-000000000010",
			agent_id: IDS.participant,
			mission_id: IDS.mission,
			delivery_id: IDS.secondDelivery,
			lease_id: "10000000-0000-4000-8000-000000000011",
			fencing_token: "9007199254740994",
			workspace_alias: "backend-primary",
			lease_expires_at: "2099-01-01T00:01:00.000Z",
			hard_expires_at: "2099-01-01T00:05:00.000Z",
		});
		await adapter.installAuthority(nextAuthority, currentLease(nextAuthority));
		expect(await adapter.ensureSession(sessionInput())).toMatchObject(sessionInput());
		expect(launcher.startCalls).toBe(2);

		await adapter.revokeAuthority(nextAuthority, "revoked");
		await expect(
			adapter.installAuthority(TEST_AUTHORITY, currentLease(TEST_AUTHORITY)),
		).rejects.toMatchObject({
			code: "authority_denied",
			message: "Runtime authority grant has been revoked",
		});
		expect(launcher.startCalls).toBe(2);
	});

	it("retires an exact live predecessor through a fresh adapter without relaunching it", async () => {
		const rootDirectory = await temporaryDirectory();
		const launcher = capsuleLauncher();
		const options = adapterOptions(rootDirectory, launcher);
		await openAuthorizedAdapter(options);
		const predecessorServer = launcher.onlyServer();
		const recovered = await PersistentFakeCapsuleAdapter.open(options);

		await recovered.revokeAuthority(TEST_AUTHORITY, "revoked");
		await predecessorServer.waitUntilClosed();

		expect(launcher.startCalls).toBe(1);

		const successor = authorityGrant({
			grant_id: "10000000-0000-4000-8000-000000000010",
			agent_id: IDS.participant,
			mission_id: IDS.mission,
			delivery_id: IDS.secondDelivery,
			lease_id: "10000000-0000-4000-8000-000000000011",
			fencing_token: "9007199254740994",
			workspace_alias: "backend-primary",
			lease_expires_at: "2099-01-01T00:02:00.000Z",
			hard_expires_at: "2099-01-01T00:05:00.000Z",
		});
		await recovered.installAuthority(successor, currentLease(successor));

		expect(launcher.startCalls).toBe(2);
	});

	it("retires a checkpoint-only predecessor that never created a Capsule descriptor", async () => {
		const rootDirectory = await temporaryDirectory();
		const launcher = capsuleLauncher();
		const recovered = await PersistentFakeCapsuleAdapter.open(
			adapterOptions(rootDirectory, launcher),
		);

		await expect(recovered.revokeAuthority(TEST_AUTHORITY, "revoked")).resolves.toBeUndefined();
		expect(launcher.startCalls).toBe(0);
		await expect(
			readFile(join(rootDirectory, IDS.mission, CAPSULE_DESCRIPTOR_FILE), "utf8"),
		).rejects.toMatchObject({ code: "ENOENT" });

		const successor = authorityGrant({
			grant_id: "10000000-0000-4000-8000-000000000010",
			agent_id: IDS.participant,
			mission_id: IDS.mission,
			delivery_id: IDS.secondDelivery,
			lease_id: "10000000-0000-4000-8000-000000000011",
			fencing_token: "9007199254740994",
			workspace_alias: "backend-primary",
			lease_expires_at: "2099-01-01T00:02:00.000Z",
			hard_expires_at: "2099-01-01T00:05:00.000Z",
		});
		await recovered.installAuthority(successor, currentLease(successor));

		expect(launcher.startCalls).toBe(1);
		expect(await recovered.ensureSession(sessionInput())).toMatchObject(sessionInput());
	});

	it("does not mistake a malformed predecessor descriptor for absence", async () => {
		const rootDirectory = await temporaryDirectory();
		const launcher = capsuleLauncher();
		const descriptorPath = join(rootDirectory, IDS.mission, CAPSULE_DESCRIPTOR_FILE);
		await writeDurableJson(
			descriptorPath,
			{ schema_version: 1 },
			{ fileMode: 0o600, directoryMode: 0o700 },
		);
		const recovered = await PersistentFakeCapsuleAdapter.open(
			adapterOptions(rootDirectory, launcher),
		);

		await expect(recovered.revokeAuthority(TEST_AUTHORITY, "revoked")).rejects.toThrow();
		expect(launcher.startCalls).toBe(0);
	});

	it("retires a real Capsule when its committed install response is lost", async () => {
		const rootDirectory = await temporaryDirectory();
		const launcher = new DropInstallResponseLauncher();
		launchers.push(launcher);
		const adapter = await PersistentFakeCapsuleAdapter.open(
			adapterOptions(rootDirectory, launcher),
		);

		await expect(
			NodeRuntimeAuthoritySession.install({
				port: adapter,
				grant: TEST_AUTHORITY,
				currentLease: currentLease(TEST_AUTHORITY),
				evidenceSink: { record: () => undefined },
				now: () => new Date("2026-08-17T00:00:00.000Z"),
			}),
		).rejects.toMatchObject({ code: "transport" });

		const installIndex = launcher.methods.indexOf("install_authority");
		const revokeIndex = launcher.methods.indexOf("revoke_authority");
		expect(installIndex).toBeGreaterThanOrEqual(0);
		expect(revokeIndex).toBeGreaterThan(installIndex);
		await expect(adapter.ensureSession(sessionInput())).rejects.toMatchObject({
			code: "authority_denied",
		});
		await expect(
			adapter.installAuthority(TEST_AUTHORITY, currentLease(TEST_AUTHORITY)),
		).rejects.toMatchObject({
			code: "authority_denied",
			message: "Runtime authority grant has been revoked",
		});
	});

	it("relaunches an expired Capsule and installs the newer journaled lease", async () => {
		const rootDirectory = await temporaryDirectory();
		const launcher = capsuleLauncher();
		const adapter = await PersistentFakeCapsuleAdapter.open(
			adapterOptions(rootDirectory, launcher),
		);
		const now = Date.now();
		const grant = authorityGrant({
			agent_id: IDS.participant,
			mission_id: IDS.mission,
			delivery_id: IDS.delivery,
			workspace_alias: "backend-primary",
			lease_expires_at: new Date(now + 10).toISOString(),
			hard_expires_at: new Date(now + 60_000).toISOString(),
		});
		const initialLease = currentLease(grant);
		const renewedLease = {
			...initialLease,
			lease_expires_at: new Date(now + 30_000).toISOString(),
		};
		let journaledLease = initialLease;
		const installedGrants: RuntimeAuthorityGrant[] = [];
		const installedLeases: Array<ReturnType<typeof currentLease>> = [];
		const installErrors: unknown[] = [];
		const cleanupRevocations: RuntimeAuthorityGrant[] = [];
		const port: RuntimeAuthorityPort = {
			async installAuthority(candidate, lease) {
				installedGrants.push(structuredClone(candidate));
				installedLeases.push(structuredClone(lease));
				if (installedGrants.length === 1) {
					await delay(50);
					journaledLease = renewedLease;
					try {
						await adapter.installAuthority(candidate, lease);
					} catch (error) {
						installErrors.push(error);
						await launcher.onlyServer().waitUntilClosed();
						throw error;
					}
					return;
				}
				await adapter.installAuthority(candidate, lease);
			},
			assertAuthority: (request) => adapter.assertAuthority(request),
			renewAuthority: (missionId, renewal) => adapter.renewAuthority(missionId, renewal),
			async revokeAuthority(candidate, reason) {
				cleanupRevocations.push(structuredClone(candidate));
				await adapter.revokeAuthority(candidate, reason);
			},
		};

		const session = await NodeRuntimeAuthoritySession.install({
			port,
			grant,
			currentLease: initialLease,
			readCurrentLease: () => journaledLease,
			evidenceSink: { record: () => undefined },
			now: () => new Date(now),
		});

		expect(session.grant).toEqual(grant);
		expect(session.signal.aborted).toBe(false);
		expect(installedGrants).toEqual([grant, grant]);
		expect(installedLeases).toEqual([initialLease, renewedLease]);
		expect(installErrors).toEqual([
			expect.objectContaining({
				name: "CapsuleRpcError",
				code: "authority_denied",
				message: "Runtime authority denied: expired",
			}),
		]);
		expect(launcher.startCalls).toBe(2);
		expect(cleanupRevocations).toEqual([]);
		expect(await adapter.ensureSession(sessionInput())).toMatchObject(sessionInput());

		await adapter.revokeAuthority(grant, "revoked");
	});

	it("serializes replacement activation behind revocation", async () => {
		const rootDirectory = await temporaryDirectory();
		const launcher = capsuleLauncher();
		const adapter = await openAuthorizedAdapter(adapterOptions(rootDirectory, launcher));
		const nextAuthority = authorityGrant({
			grant_id: "10000000-0000-4000-8000-000000000010",
			agent_id: IDS.participant,
			mission_id: IDS.mission,
			delivery_id: IDS.secondDelivery,
			lease_id: "10000000-0000-4000-8000-000000000011",
			fencing_token: "9007199254740994",
			workspace_alias: "backend-primary",
			lease_expires_at: "2099-01-01T00:01:00.000Z",
			hard_expires_at: "2099-01-01T00:05:00.000Z",
		});

		const revoking = adapter.revokeAuthority(TEST_AUTHORITY, "revoked");
		const runtimeDuringRevocation = adapter.ensureSession(sessionInput());
		const revokedReplay = adapter.installAuthority(TEST_AUTHORITY, currentLease(TEST_AUTHORITY));
		const installing = adapter.installAuthority(nextAuthority, currentLease(nextAuthority));

		await expect(runtimeDuringRevocation).rejects.toMatchObject({
			code: "authority_denied",
			message: "Runtime authority revocation is still in progress",
		});
		const [revocation, replay, replacement] = await Promise.allSettled([
			revoking,
			revokedReplay,
			installing,
		]);
		expect(revocation).toEqual({ status: "fulfilled", value: undefined });
		expect(replay).toMatchObject({
			status: "rejected",
			reason: {
				code: "authority_denied",
				message: "Runtime authority grant has been revoked",
			},
		});
		expect(replacement).toEqual({ status: "fulfilled", value: undefined });
		expect(await adapter.ensureSession(sessionInput())).toMatchObject(sessionInput());
		expect(launcher.startCalls).toBe(2);
	});

	it("serializes lease updates without regressing the cached current lease", async () => {
		const rootDirectory = await temporaryDirectory();
		const launcher = capsuleLauncher();
		const adapter = await openAuthorizedAdapter(adapterOptions(rootDirectory, launcher));
		const newer = {
			...currentLease(TEST_AUTHORITY),
			lease_expires_at: "2099-01-01T00:03:00.000Z",
		};
		const olderReplay = {
			...currentLease(TEST_AUTHORITY),
			lease_expires_at: "2099-01-01T00:02:00.000Z",
		};

		const [renewal, replay] = await Promise.allSettled([
			adapter.renewAuthority(IDS.mission, newer),
			adapter.installAuthority(TEST_AUTHORITY, olderReplay),
		]);
		expect(renewal).toEqual({ status: "fulfilled", value: undefined });
		expect(replay).toMatchObject({
			status: "rejected",
			reason: { code: "authority_denied" },
		});

		await launcher.closeAll();
		await expect(adapter.installAuthority(TEST_AUTHORITY, olderReplay)).rejects.toMatchObject({
			code: "authority_denied",
			message: "Runtime authority current lease cannot move backwards",
		});
		expect(launcher.startCalls).toBe(1);
		expect(await adapter.ensureSession(sessionInput())).toMatchObject(sessionInput());
		await expect(
			adapter.renewAuthority(IDS.mission, {
				...currentLease(TEST_AUTHORITY),
				lease_expires_at: "2099-01-01T00:02:30.000Z",
			}),
		).rejects.toMatchObject({ code: "authority_denied" });
	});

	it("keeps durable turn lookup read-only after authority is revoked", async () => {
		const rootDirectory = await temporaryDirectory();
		const launcher = capsuleLauncher();
		const adapter = await openAuthorizedAdapter(adapterOptions(rootDirectory, launcher));
		const session = await adapter.ensureSession(sessionInput());
		const turn = acceptedTurn(await collect(adapter.startTurn(turnInput(session))));

		await adapter.revokeAuthority(TEST_AUTHORITY, "revoked");

		expect(await adapter.lookupTurn(IDS.delivery, 1)).toEqual(turn);
		await expect(adapter.ensureSession(sessionInput())).rejects.toMatchObject({
			code: "authority_denied",
		});
		expect(launcher.startCalls).toBe(2);
	});

	it("rejects a replacement before touching the active Capsule", async () => {
		const rootDirectory = await temporaryDirectory();
		const launcher = capsuleLauncher();
		const adapter = await openAuthorizedAdapter(adapterOptions(rootDirectory, launcher));

		await expect(
			adapter.installAuthority(
				{ ...TEST_AUTHORITY, policy_grant_sha256: "c".repeat(64) },
				currentLease(TEST_AUTHORITY),
			),
		).rejects.toMatchObject({
			code: "authority_denied",
			message: "Active runtime authority must be revoked before replacement",
		});

		await expect(
			adapter.installAuthority(TEST_AUTHORITY, currentLease(TEST_AUTHORITY)),
		).resolves.toBeUndefined();
		expect(await adapter.ensureSession(sessionInput())).toMatchObject(sessionInput());
		expect(launcher.startCalls).toBe(1);
	});

	it("restores the original grant with its current lease after a Capsule restart", async () => {
		const rootDirectory = await temporaryDirectory();
		const launcher = capsuleLauncher();
		const adapter = await PersistentFakeCapsuleAdapter.open(
			adapterOptions(rootDirectory, launcher),
		);
		const now = Date.now();
		const original = authorityGrant({
			agent_id: IDS.participant,
			mission_id: IDS.mission,
			delivery_id: IDS.delivery,
			workspace_alias: "backend-primary",
			lease_expires_at: new Date(now - 1_000).toISOString(),
			hard_expires_at: new Date(now + 60_000).toISOString(),
		});
		const current = {
			...currentLease(original),
			lease_expires_at: new Date(now + 30_000).toISOString(),
		};

		await adapter.installAuthority(original, current);
		expect(await adapter.ensureSession(sessionInput())).toMatchObject(sessionInput());
		await launcher.closeAll();

		expect(await adapter.ensureSession(sessionInput())).toMatchObject(sessionInput());
		expect(launcher.startCalls).toBe(2);
	});

	it("reopens durable state and replays the exact same turn reference and events", async () => {
		const rootDirectory = await temporaryDirectory();
		const launcher = capsuleLauncher();
		const options = {
			rootDirectory,
			launcher,
			outcome: "reply" as const,
			completionDelayMs: 20,
			startupTimeoutMs: 1_000,
		};
		const first = await openAuthorizedAdapter(options);
		const session = await first.ensureSession(sessionInput());
		const input = turnInput(session);

		const events = await collect(first.startTurn(input));
		const turn = acceptedTurn(events);
		expect(events.map((event) => event.kind)).toEqual(["accepted", "usage", "completed"]);

		await launcher.closeAll();
		const reopened = await openAuthorizedAdapter(options);

		expect(await reopened.ensureSession(sessionInput())).toEqual(session);
		expect(await reopened.lookupTurn(input.deliveryId, input.executionAttempt)).toEqual(turn);
		expect(await collect(reopened.recoverTurn(turn, input))).toEqual(events);
	});

	it("coalesces concurrent creation of one Mission session and capsule", async () => {
		const { adapter, launcher } = await openedAdapter();

		const sessions = await Promise.all(
			Array.from({ length: 20 }, () => adapter.ensureSession(sessionInput())),
		);

		expect(new Set(sessions.map((session) => session.sessionId))).toEqual(
			new Set([sessions[0]?.sessionId]),
		);
		expect(launcher.startCalls).toBe(1);
	});

	it("allows only one concurrent server to bind a Mission capsule socket", async () => {
		const { adapter, launcher, rootDirectory } = await openedAdapter();
		const session = await adapter.ensureSession(sessionInput());
		await launcher.closeAll();
		const directory = join(rootDirectory, IDS.mission);

		const starts = await Promise.allSettled([
			PersistentFakeCapsuleServer.start(directory),
			PersistentFakeCapsuleServer.start(directory),
		]);
		const winners = starts.filter(
			(result): result is PromiseFulfilledResult<PersistentFakeCapsuleServer> =>
				result.status === "fulfilled",
		);
		const losers = starts.filter(
			(result): result is PromiseRejectedResult => result.status === "rejected",
		);

		expect(winners).toHaveLength(1);
		expect(losers).toHaveLength(1);
		expect(await adapter.ensureSession(sessionInput())).toEqual(session);
		await winners[0]?.value.close();
	});

	it("refuses to replace a stale socket path", async () => {
		const { adapter, launcher, rootDirectory } = await openedAdapter();
		await adapter.ensureSession(sessionInput());
		await launcher.closeAll();
		const directory = join(rootDirectory, IDS.mission);
		const descriptor = await readFakeCapsuleLaunchDescriptor(directory);
		const sourcePath = descriptor.socket_path.replace(/\.sock$/, ".old");
		const staleServer = createServer();
		await listen(staleServer, sourcePath);
		await rename(sourcePath, descriptor.socket_path);
		await close(staleServer);

		try {
			const before = await lstat(descriptor.socket_path);
			await expect(PersistentFakeCapsuleServer.start(directory)).rejects.toThrow(
				/Refusing to replace existing capsule socket path/,
			);
			const after = await lstat(descriptor.socket_path);
			expect({ dev: after.dev, ino: after.ino }).toEqual({ dev: before.dev, ino: before.ino });
		} finally {
			await rm(descriptor.socket_path, { force: true });
		}
	});

	it("recovers a crashed Capsule's unchanged stale socket inode", async () => {
		const { adapter, launcher, rootDirectory } = await openedAdapter();
		const session = await adapter.ensureSession(sessionInput());
		const crashedServer = launcher.onlyServer();
		await launcher.closeAll();
		const directory = join(rootDirectory, IDS.mission);
		const descriptor = await readFakeCapsuleLaunchDescriptor(directory);
		await installStaleSocket(descriptor.socket_path);

		expect(await adapter.ensureSession(sessionInput())).toEqual(session);
		expect(launcher.startCalls).toBe(2);
		expect(launcher.liveServers).toBe(1);
		expect(launcher.onlyServer()).not.toBe(crashedServer);
	});

	it("converges concurrent stale-socket recovery on one live Capsule", async () => {
		const rootDirectory = await temporaryDirectory();
		const launcher = capsuleLauncher();
		const options = adapterOptions(rootDirectory, launcher);
		const first = await openAuthorizedAdapter(options);
		const session = await first.ensureSession(sessionInput());
		const second = await openAuthorizedAdapter(options);
		await launcher.closeAll();
		const descriptor = await readFakeCapsuleLaunchDescriptor(join(rootDirectory, IDS.mission));
		await installStaleSocket(descriptor.socket_path);

		await expect(
			Promise.all([first.ensureSession(sessionInput()), second.ensureSession(sessionInput())]),
		).resolves.toEqual([session, session]);
		expect(launcher.liveServers).toBe(1);
	});

	it("does not let an old server close unlink a replacement socket pathname", async () => {
		const { adapter, launcher, rootDirectory } = await openedAdapter();
		await adapter.ensureSession(sessionInput());
		const oldServer = launcher.onlyServer();
		const descriptor = await readFakeCapsuleLaunchDescriptor(join(rootDirectory, IDS.mission));
		await rm(descriptor.socket_path, { force: true });
		const replacementServer = createServer();
		await listen(replacementServer, descriptor.socket_path);
		await chmod(descriptor.socket_path, 0o600);
		const replacement = await lstat(descriptor.socket_path);

		try {
			await oldServer.close();
			const after = await lstat(descriptor.socket_path);
			expect({ dev: after.dev, ino: after.ino }).toEqual({
				dev: replacement.dev,
				ino: replacement.ino,
			});
		} finally {
			await close(replacementServer);
		}
	});

	it("uses the persisted socket path after TMPDIR changes", async () => {
		const rootDirectory = await temporaryDirectory();
		const firstTmp = await temporaryDirectory("/tmp", "agentrelay-capsule-a-");
		const secondTmp = await temporaryDirectory("/tmp", "agentrelay-capsule-b-");
		const launcher = capsuleLauncher();
		const options = adapterOptions(rootDirectory, launcher);
		const originalTmpDir = process.env.TMPDIR;

		try {
			process.env.TMPDIR = firstTmp;
			const first = await openAuthorizedAdapter(options);
			const session = await first.ensureSession(sessionInput());
			const directory = join(rootDirectory, IDS.mission);
			const descriptor = await readFakeCapsuleLaunchDescriptor(directory);
			expect(descriptor.socket_path.startsWith(`${firstTmp}/`)).toBe(true);

			await launcher.closeAll();
			process.env.TMPDIR = secondTmp;
			const reopened = await openAuthorizedAdapter(options);

			expect(await reopened.ensureSession(sessionInput())).toEqual(session);
			expect((await readFakeCapsuleLaunchDescriptor(directory)).socket_path).toBe(
				descriptor.socket_path,
			);
			expect(launcher.startCalls).toBe(2);
		} finally {
			if (originalTmpDir === undefined) delete process.env.TMPDIR;
			else process.env.TMPDIR = originalTmpDir;
		}
	});

	it("rejects a relative temporary directory before persisting a launch descriptor", async () => {
		const rootDirectory = await temporaryDirectory();
		const launcher = capsuleLauncher();
		const adapter = await PersistentFakeCapsuleAdapter.open(
			adapterOptions(rootDirectory, launcher),
		);
		const originalTmpDir = process.env.TMPDIR;

		try {
			process.env.TMPDIR = "relative-capsule-tmp";
			await expect(
				adapter.installAuthority(TEST_AUTHORITY, currentLease(TEST_AUTHORITY)),
			).rejects.toThrow(/Capsule descriptor contains an invalid local socket path/);
			expect(launcher.startCalls).toBe(0);
			await expect(
				readFile(join(rootDirectory, IDS.mission, CAPSULE_DESCRIPTOR_FILE), "utf8"),
			).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			if (originalTmpDir === undefined) delete process.env.TMPDIR;
			else process.env.TMPDIR = originalTmpDir;
		}
	});

	it("rejects recovery when the expected input differs from the durable start intent", async () => {
		const { adapter } = await openedAdapter();
		const session = await adapter.ensureSession(sessionInput());
		const input = turnInput(session);
		const turn = acceptedTurn(await collect(adapter.startTurn(input)));

		await expect(
			collect(
				adapter.recoverTurn(turn, {
					...input,
					assignment: { ...input.assignment, text: "Replace the accepted assignment." },
				}),
			),
		).rejects.toMatchObject({
			name: "CapsuleRpcError",
			code: "correlation_conflict",
		});
	});

	it("replays an exact duplicate start but rejects a changed input under the same execution key", async () => {
		const { adapter } = await openedAdapter();
		const session = await adapter.ensureSession(sessionInput());
		const input = turnInput(session);

		const first = await collect(adapter.startTurn(input));
		expect(await collect(adapter.startTurn(input))).toEqual(first);
		await expect(
			collect(
				adapter.startTurn({
					...input,
					objective: { ...input.objective, text: "Changed work under an accepted delivery." },
				}),
			),
		).rejects.toMatchObject({
			name: "CapsuleRpcError",
			code: "correlation_conflict",
		});
		expect(await adapter.lookupTurn(input.deliveryId, input.executionAttempt)).toEqual(
			acceptedTurn(first),
		);
	});

	it("rejects a second execution while the Mission capsule has an active turn", async () => {
		const { adapter } = await openedAdapter({ completionDelayMs: 60_000 });
		const session = await adapter.ensureSession(sessionInput());
		const firstInput = turnInput(session);
		const stream = adapter.startTurn(firstInput)[Symbol.asyncIterator]();
		const firstEvent = await stream.next();
		expect(firstEvent).toMatchObject({ done: false, value: { kind: "accepted", sequence: 1 } });
		if (firstEvent.done || firstEvent.value.kind !== "accepted") {
			throw new Error("Expected the first turn to be accepted");
		}
		await stream.return?.();

		await expect(
			collect(adapter.startTurn(turnInput(session, IDS.secondDelivery))),
		).rejects.toMatchObject({
			name: "CapsuleRpcError",
			code: "authority_denied",
		});

		await adapter.cancelTurn(firstEvent.value.turn);
		expect(
			(await collect(adapter.recoverTurn(firstEvent.value.turn, firstInput))).map(
				(event) => event.kind,
			),
		).toEqual(["accepted", "usage", "cancelled"]);
	});

	it("fails capsule authentication when the persisted capability no longer matches the server", async () => {
		const rootDirectory = await temporaryDirectory();
		const launcher = capsuleLauncher();
		const options = adapterOptions(rootDirectory, launcher);
		const adapter = await openAuthorizedAdapter(options);
		await adapter.ensureSession(sessionInput());
		const directory = join(rootDirectory, IDS.mission);
		const descriptor = await readFakeCapsuleLaunchDescriptor(directory);
		await writeDurableJson(
			join(directory, CAPSULE_DESCRIPTOR_FILE),
			{
				...descriptor,
				capability_token: `ar_capsule_${"f".repeat(64)}`,
			},
			{ fileMode: 0o600, directoryMode: 0o700 },
		);
		const reopened = await PersistentFakeCapsuleAdapter.open(options);

		await expect(
			reopened.installAuthority(TEST_AUTHORITY, currentLease(TEST_AUTHORITY)),
		).rejects.toMatchObject({
			name: "CapsuleRpcError",
			code: "authentication_failed",
		});
	});

	it("surfaces real terminate failures but ignores an unavailable capsule socket", async () => {
		const rootDirectory = await temporaryDirectory();
		const launcher = capsuleLauncher();
		const options = adapterOptions(rootDirectory, launcher);
		const adapter = await openAuthorizedAdapter(options);
		await adapter.ensureSession(sessionInput());
		const directory = join(rootDirectory, IDS.mission);
		const descriptor = await readFakeCapsuleLaunchDescriptor(directory);
		await writeDurableJson(
			join(directory, CAPSULE_DESCRIPTOR_FILE),
			{
				...descriptor,
				capability_token: `ar_capsule_${"f".repeat(64)}`,
			},
			{ fileMode: 0o600, directoryMode: 0o700 },
		);

		await expect(adapter.terminateAll()).rejects.toMatchObject({
			name: "AggregateError",
			errors: [{ name: "CapsuleRpcError", code: "authentication_failed" }],
		});

		await launcher.closeAll();
		await expect(adapter.terminateAll()).resolves.toBeUndefined();
	});

	it("surfaces an invalid launch descriptor during best-effort termination", async () => {
		const rootDirectory = await temporaryDirectory();
		const launcher = capsuleLauncher();
		const adapter = await openAuthorizedAdapter(adapterOptions(rootDirectory, launcher));
		await adapter.ensureSession(sessionInput());
		const descriptorPath = join(rootDirectory, IDS.mission, CAPSULE_DESCRIPTOR_FILE);
		const descriptor = await readFakeCapsuleLaunchDescriptor(join(rootDirectory, IDS.mission));
		await writeDurableJson(
			descriptorPath,
			{ ...descriptor, socket_path: "relative.sock" },
			{ fileMode: 0o600, directoryMode: 0o700 },
		);

		await expect(adapter.terminateAll()).rejects.toMatchObject({
			name: "AggregateError",
			errors: [
				expect.objectContaining({ message: expect.stringMatching(/invalid local socket path/) }),
			],
		});
	});

	it("rejects an invalid persisted socket path before reconnecting", async () => {
		const rootDirectory = await temporaryDirectory();
		const launcher = capsuleLauncher();
		const options = adapterOptions(rootDirectory, launcher);
		const adapter = await openAuthorizedAdapter(options);
		await adapter.ensureSession(sessionInput());
		const directory = join(rootDirectory, IDS.mission);
		const descriptorPath = join(directory, CAPSULE_DESCRIPTOR_FILE);
		const descriptor = await readFakeCapsuleLaunchDescriptor(directory);
		await writeDurableJson(
			descriptorPath,
			{ ...descriptor, socket_path: "relative.sock" },
			{ fileMode: 0o600, directoryMode: 0o700 },
		);
		const reopened = await PersistentFakeCapsuleAdapter.open(options);

		await expect(
			reopened.installAuthority(TEST_AUTHORITY, currentLease(TEST_AUTHORITY)),
		).rejects.toThrow(/Capsule descriptor contains an invalid local socket path/);
	});

	it("persists private capsule files and strips unrelated credentials from the child environment", async () => {
		const rootDirectory = await temporaryDirectory();
		const launcher = capsuleLauncher();
		const adapter = await openAuthorizedAdapter(adapterOptions(rootDirectory, launcher));
		const session = await adapter.ensureSession(sessionInput());
		await collect(adapter.startTurn(turnInput(session)));
		const directory = join(rootDirectory, IDS.mission);
		const descriptor = await readFakeCapsuleLaunchDescriptor(directory);

		for (const path of [rootDirectory, directory, dirname(descriptor.socket_path)]) {
			expect((await stat(path)).mode & 0o777).toBe(0o700);
		}
		for (const path of [
			join(rootDirectory, "registry.json"),
			join(directory, CAPSULE_DESCRIPTOR_FILE),
			join(directory, CAPSULE_STATE_FILE),
			descriptor.socket_path,
		]) {
			expect((await stat(path)).mode & 0o777).toBe(0o600);
		}

		expect(
			buildCapsuleEnvironment({
				PATH: "/test/bin",
				TMPDIR: "/test/tmp",
				LANG: "en_US.UTF-8",
				TZ: "UTC",
				AGENTRELAY_NODE_TOKEN: "must-not-cross-boundary",
				CODEX_API_KEY: "must-not-cross-boundary",
				HOME: "/must/not/cross/boundary",
			}),
		).toEqual({
			PATH: "/test/bin",
			TMPDIR: "/test/tmp",
			LANG: "en_US.UTF-8",
			TZ: "UTC",
		});
	});

	it("does not let a losing duplicate server overwrite a cancellation after its old deadline", async () => {
		const rootDirectory = await temporaryDirectory();
		const launcher = capsuleLauncher();
		const options = adapterOptions(rootDirectory, launcher, { completionDelayMs: 1_000 });
		const adapter = await openAuthorizedAdapter(options);
		const session = await adapter.ensureSession(sessionInput());
		const input = turnInput(session);
		const stream = adapter.startTurn(input)[Symbol.asyncIterator]();
		const accepted = await stream.next();
		if (accepted.done || accepted.value.kind !== "accepted") {
			throw new Error("Expected the primary capsule to accept the turn");
		}
		const turn = accepted.value.turn;
		await stream.return?.();
		const directory = join(rootDirectory, IDS.mission);
		const state = JSON.parse(await readFile(join(directory, CAPSULE_STATE_FILE), "utf8")) as {
			turns: Record<string, { completion_due_at: string | null }>;
		};
		const dueAt = state.turns[`${input.deliveryId}:${input.executionAttempt}`]?.completion_due_at;
		if (dueAt === undefined || dueAt === null)
			throw new Error("Active turn deadline was not persisted");

		await expect(PersistentFakeCapsuleServer.start(directory)).rejects.toThrow(
			/Refusing to replace existing capsule socket path/,
		);
		await adapter.cancelTurn(turn);
		await delay(Math.max(0, new Date(dueAt).getTime() - Date.now()) + 200);

		await launcher.closeAll();
		const reopened = await openAuthorizedAdapter(options);
		const persistedTurn = await reopened.lookupTurn(input.deliveryId, input.executionAttempt);
		expect(persistedTurn).toEqual(turn);
		expect((await collect(reopened.recoverTurn(turn, input))).map((event) => event.kind)).toEqual([
			"accepted",
			"usage",
			"cancelled",
		]);
	});
});

class InProcessCapsuleLauncher implements CapsuleLauncher {
	readonly #servers = new Set<PersistentFakeCapsuleServer>();
	startCalls = 0;
	get liveServers(): number {
		return this.#servers.size;
	}

	onlyServer(): PersistentFakeCapsuleServer {
		if (this.#servers.size !== 1) throw new Error("Expected exactly one live Capsule server");
		const server = this.#servers.values().next().value;
		if (server === undefined) throw new Error("Expected one live Capsule server");
		return server;
	}

	async start(capsuleDirectory: string): Promise<void> {
		this.startCalls += 1;
		this.#servers.add(await PersistentFakeCapsuleServer.start(capsuleDirectory));
	}

	async closeAll(): Promise<void> {
		const servers = [...this.#servers];
		this.#servers.clear();
		await Promise.all(servers.map((server) => server.close()));
	}
}

function capsuleLauncher(): InProcessCapsuleLauncher {
	const launcher = new InProcessCapsuleLauncher();
	launchers.push(launcher);
	return launcher;
}

async function openAuthorizedAdapter(
	options: Parameters<typeof PersistentFakeCapsuleAdapter.open>[0],
): Promise<PersistentFakeCapsuleAdapter> {
	const adapter = await PersistentFakeCapsuleAdapter.open(options);
	await adapter.installAuthority(TEST_AUTHORITY, currentLease(TEST_AUTHORITY));
	return adapter;
}

async function openedAdapter(overrides: { completionDelayMs?: number } = {}) {
	const rootDirectory = await temporaryDirectory();
	const launcher = capsuleLauncher();
	return {
		adapter: await openAuthorizedAdapter(adapterOptions(rootDirectory, launcher, overrides)),
		launcher,
		rootDirectory,
	};
}

function adapterOptions(
	rootDirectory: string,
	launcher: CapsuleLauncher,
	overrides: { completionDelayMs?: number } = {},
) {
	return {
		rootDirectory,
		launcher,
		outcome: "reply" as const,
		completionDelayMs: overrides.completionDelayMs ?? 20,
		startupTimeoutMs: 1_000,
	};
}

function sessionInput() {
	return {
		missionId: IDS.mission,
		participantId: IDS.participant,
		workspaceAlias: "backend-primary",
	};
}

function turnInput(session: HostSessionRef, deliveryId = IDS.delivery): StartTurnInput {
	return {
		session,
		missionId: session.missionId,
		deliveryId,
		executionAttempt: 1,
		contractVersion: 1,
		missionSequence: 3,
		objective: {
			text: "Ship the compatible backend and Android changes.",
			authorPrincipalId: IDS.owner,
			provenance: "mission_manifest",
		},
		assignment: {
			text: "Implement the backend half of the shared contract.",
			authorPrincipalId: IDS.owner,
			provenance: "mission_manifest",
		},
		acceptanceCriteria: [
			{
				text: "The contract fixture passes.",
				authorPrincipalId: IDS.owner,
				provenance: "mission_manifest",
			},
		],
		peerMessages: [],
		artifacts: [],
	};
}

function currentLease(grant: RuntimeAuthorityGrant) {
	return {
		grant_id: grant.grant_id,
		lease_id: grant.lease_id,
		fencing_token: grant.fencing_token,
		lease_expires_at: grant.lease_expires_at,
	};
}

function acceptedTurn(events: readonly HostEvent[]): HostTurnRef {
	const accepted = events[0];
	if (accepted?.kind !== "accepted") throw new Error("Expected an accepted host event");
	return accepted.turn;
}

async function collect(events: AsyncIterable<HostEvent>): Promise<HostEvent[]> {
	const collected: HostEvent[] = [];
	for await (const event of events) collected.push(event);
	return collected;
}

function listen(server: Server, path: string): Promise<void> {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(path, resolve);
	});
}

function close(server: Server): Promise<void> {
	return new Promise((resolve, reject) => {
		server.close((error) => (error ? reject(error) : resolve()));
	});
}

async function installStaleSocket(path: string): Promise<void> {
	const sourcePath = join(dirname(path), `.s-${process.pid}.sock`);
	await rm(sourcePath, { force: true });
	const server = createServer();
	await listen(server, sourcePath);
	await chmod(sourcePath, 0o600);
	await rename(sourcePath, path);
	await close(server);
}

async function temporaryDirectory(
	parent = tmpdir(),
	prefix = "agentrelay-node-capsule-",
): Promise<string> {
	const path = await realpath(await mkdtemp(join(parent, prefix)));
	temporaryDirectories.push(path);
	return path;
}
