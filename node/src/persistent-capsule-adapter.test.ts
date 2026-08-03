import { chmod, lstat, mkdtemp, readFile, rename, rm, stat } from "node:fs/promises";
import { type Server, createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { HostEvent, HostSessionRef, HostTurnRef, StartTurnInput } from "@agentrelay/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { writeDurableJson } from "./durable-file.js";
import { PersistentFakeCapsuleServer } from "./fake-capsule-server.js";
import {
	CAPSULE_DESCRIPTOR_FILE,
	CAPSULE_STATE_FILE,
	readCapsuleLaunchDescriptor,
} from "./fake-capsule-store.js";
import {
	type CapsuleLauncher,
	PersistentFakeCapsuleAdapter,
	buildCapsuleEnvironment,
} from "./persistent-capsule-adapter.js";

const IDS = {
	mission: "10000000-0000-4000-8000-000000000001",
	participant: "10000000-0000-4000-8000-000000000002",
	owner: "10000000-0000-4000-8000-000000000003",
	delivery: "10000000-0000-4000-8000-000000000004",
	secondDelivery: "10000000-0000-4000-8000-000000000005",
} as const;

const temporaryDirectories: string[] = [];
const launchers: InProcessCapsuleLauncher[] = [];

afterEach(async () => {
	await Promise.all(launchers.splice(0).map((launcher) => launcher.closeAll()));
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("PersistentFakeCapsuleAdapter", () => {
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
		const first = await PersistentFakeCapsuleAdapter.open(options);
		const session = await first.ensureSession(sessionInput());
		const input = turnInput(session);

		const events = await collect(first.startTurn(input));
		const turn = acceptedTurn(events);
		expect(events.map((event) => event.kind)).toEqual(["accepted", "usage", "completed"]);

		await launcher.closeAll();
		const reopened = await PersistentFakeCapsuleAdapter.open(options);

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
		const descriptor = await readCapsuleLaunchDescriptor(directory);
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
		await launcher.closeAll();
		const directory = join(rootDirectory, IDS.mission);
		const descriptor = await readCapsuleLaunchDescriptor(directory);
		await installStaleSocket(descriptor.socket_path);
		const stale = await lstat(descriptor.socket_path);

		expect(await adapter.ensureSession(sessionInput())).toEqual(session);
		const replacement = await lstat(descriptor.socket_path);
		expect({ dev: replacement.dev, ino: replacement.ino }).not.toEqual({
			dev: stale.dev,
			ino: stale.ino,
		});
		expect(launcher.startCalls).toBe(2);
	});

	it("converges concurrent stale-socket recovery on one live Capsule", async () => {
		const rootDirectory = await temporaryDirectory();
		const launcher = capsuleLauncher();
		const options = adapterOptions(rootDirectory, launcher);
		const first = await PersistentFakeCapsuleAdapter.open(options);
		const session = await first.ensureSession(sessionInput());
		const second = await PersistentFakeCapsuleAdapter.open(options);
		await launcher.closeAll();
		const descriptor = await readCapsuleLaunchDescriptor(join(rootDirectory, IDS.mission));
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
		const descriptor = await readCapsuleLaunchDescriptor(join(rootDirectory, IDS.mission));
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
			const first = await PersistentFakeCapsuleAdapter.open(options);
			const session = await first.ensureSession(sessionInput());
			const directory = join(rootDirectory, IDS.mission);
			const descriptor = await readCapsuleLaunchDescriptor(directory);
			expect(descriptor.socket_path.startsWith(`${firstTmp}/`)).toBe(true);

			await launcher.closeAll();
			process.env.TMPDIR = secondTmp;
			const reopened = await PersistentFakeCapsuleAdapter.open(options);

			expect(await reopened.ensureSession(sessionInput())).toEqual(session);
			expect((await readCapsuleLaunchDescriptor(directory)).socket_path).toBe(
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
			await expect(adapter.ensureSession(sessionInput())).rejects.toThrow(
				/Capsule descriptor contains an invalid local socket path/,
			);
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
			code: "correlation_conflict",
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
		const adapter = await PersistentFakeCapsuleAdapter.open(options);
		await adapter.ensureSession(sessionInput());
		const directory = join(rootDirectory, IDS.mission);
		const descriptor = await readCapsuleLaunchDescriptor(directory);
		await writeDurableJson(
			join(directory, CAPSULE_DESCRIPTOR_FILE),
			{
				...descriptor,
				capability_token: `ar_capsule_${"f".repeat(64)}`,
			},
			{ fileMode: 0o600, directoryMode: 0o700 },
		);
		const reopened = await PersistentFakeCapsuleAdapter.open(options);

		await expect(reopened.ensureSession(sessionInput())).rejects.toMatchObject({
			name: "CapsuleRpcError",
			code: "authentication_failed",
		});
	});

	it("surfaces real terminate failures but ignores an unavailable capsule socket", async () => {
		const rootDirectory = await temporaryDirectory();
		const launcher = capsuleLauncher();
		const options = adapterOptions(rootDirectory, launcher);
		const adapter = await PersistentFakeCapsuleAdapter.open(options);
		await adapter.ensureSession(sessionInput());
		const directory = join(rootDirectory, IDS.mission);
		const descriptor = await readCapsuleLaunchDescriptor(directory);
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
		const adapter = await PersistentFakeCapsuleAdapter.open(
			adapterOptions(rootDirectory, launcher),
		);
		await adapter.ensureSession(sessionInput());
		const descriptorPath = join(rootDirectory, IDS.mission, CAPSULE_DESCRIPTOR_FILE);
		const descriptor = await readCapsuleLaunchDescriptor(join(rootDirectory, IDS.mission));
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
		const adapter = await PersistentFakeCapsuleAdapter.open(options);
		await adapter.ensureSession(sessionInput());
		const directory = join(rootDirectory, IDS.mission);
		const descriptorPath = join(directory, CAPSULE_DESCRIPTOR_FILE);
		const descriptor = await readCapsuleLaunchDescriptor(directory);
		await writeDurableJson(
			descriptorPath,
			{ ...descriptor, socket_path: "relative.sock" },
			{ fileMode: 0o600, directoryMode: 0o700 },
		);
		const reopened = await PersistentFakeCapsuleAdapter.open(options);

		await expect(reopened.ensureSession(sessionInput())).rejects.toThrow(
			/Capsule descriptor contains an invalid local socket path/,
		);
	});

	it("persists private capsule files and strips unrelated credentials from the child environment", async () => {
		const rootDirectory = await temporaryDirectory();
		const launcher = capsuleLauncher();
		const adapter = await PersistentFakeCapsuleAdapter.open(
			adapterOptions(rootDirectory, launcher),
		);
		const session = await adapter.ensureSession(sessionInput());
		await collect(adapter.startTurn(turnInput(session)));
		const directory = join(rootDirectory, IDS.mission);
		const descriptor = await readCapsuleLaunchDescriptor(directory);

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
		const adapter = await PersistentFakeCapsuleAdapter.open(options);
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
		const reopened = await PersistentFakeCapsuleAdapter.open(options);
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

async function openedAdapter(overrides: { completionDelayMs?: number } = {}) {
	const rootDirectory = await temporaryDirectory();
	const launcher = capsuleLauncher();
	return {
		adapter: await PersistentFakeCapsuleAdapter.open(
			adapterOptions(rootDirectory, launcher, overrides),
		),
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
	const path = await mkdtemp(join(parent, prefix));
	temporaryDirectories.push(path);
	return path;
}
