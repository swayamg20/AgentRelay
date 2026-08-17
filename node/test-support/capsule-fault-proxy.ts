import { chmod, unlink } from "node:fs/promises";
import { type Server, type Socket, createConnection, createServer } from "node:net";
import { PersistentCapsuleServer } from "../src/capsule-server.js";
import { FakeCapsuleRuntime } from "../src/fake-capsule-runtime.js";
import { FakeCapsuleStore, readCapsuleLaunchDescriptor } from "../src/fake-capsule-store.js";
import type { CapsuleLauncher } from "../src/persistent-capsule-adapter.js";

/** Drops the first install response only after the real Capsule commits the request. */
export class DropInstallResponseLauncher implements CapsuleLauncher {
	readonly methods: string[] = [];
	#proxy: Server | null = null;
	#capsule: PersistentCapsuleServer | null = null;
	#proxyPath: string | null = null;
	#upstreamPath: string | null = null;
	#dropped = false;
	readonly #sockets = new Set<Socket>();

	async start(capsuleDirectory: string): Promise<void> {
		if (this.#proxy !== null || this.#capsule !== null) {
			throw new Error("Fault proxy launcher already owns a Capsule generation");
		}
		const descriptor = await readCapsuleLaunchDescriptor(capsuleDirectory);
		this.#proxyPath = descriptor.socket_path;
		this.#upstreamPath = `${descriptor.socket_path}.upstream`;
		this.#capsule = await PersistentCapsuleServer.start({
			identity: {
				capsuleId: descriptor.capsule_id,
				capabilityToken: descriptor.capability_token,
				socketPath: this.#upstreamPath,
			},
			openRuntime: async () =>
				new FakeCapsuleRuntime(await FakeCapsuleStore.open(capsuleDirectory)),
		});
		this.#proxy = createServer((client) => this.forward(client));
		await listen(this.#proxy, this.#proxyPath);
		await chmod(this.#proxyPath, 0o600);
		void this.#capsule.waitUntilClosed().then(() => this.closeProxy());
	}

	async closeAll(): Promise<void> {
		await Promise.allSettled([this.#capsule?.close(), this.closeProxy()]);
		this.#capsule = null;
	}

	private forward(client: Socket): void {
		const upstreamPath = this.#upstreamPath;
		if (upstreamPath === null) {
			client.destroy(new Error("Fault proxy has no Capsule upstream"));
			return;
		}
		const upstream = createConnection(upstreamPath);
		this.track(client);
		this.track(upstream);
		let request = "";
		let dropResponse = false;
		let methodRecorded = false;
		client.on("data", (chunk: Buffer) => {
			request += chunk.toString("utf8");
			const newline = request.indexOf("\n");
			if (newline >= 0 && !methodRecorded) {
				methodRecorded = true;
				const method = requestMethod(request.slice(0, newline));
				this.methods.push(method);
				dropResponse = method === "install_authority" && !this.#dropped;
			}
			upstream.write(chunk);
		});
		upstream.on("data", (chunk: Buffer) => {
			if (dropResponse && !this.#dropped) {
				this.#dropped = true;
				client.destroy();
				upstream.destroy();
				return;
			}
			client.write(chunk);
		});
		client.on("end", () => upstream.end());
		upstream.on("end", () => client.end());
		client.on("error", () => upstream.destroy());
		upstream.on("error", () => client.destroy());
	}

	private track(socket: Socket): void {
		this.#sockets.add(socket);
		socket.once("close", () => this.#sockets.delete(socket));
	}

	private async closeProxy(): Promise<void> {
		const proxy = this.#proxy;
		this.#proxy = null;
		for (const socket of this.#sockets) socket.destroy();
		if (proxy !== null) await closeServer(proxy);
		if (this.#proxyPath !== null) {
			await unlink(this.#proxyPath).catch((error) => {
				if (errorCode(error) !== "ENOENT") throw error;
			});
		}
	}
}

function requestMethod(line: string): string {
	const parsed = JSON.parse(line) as { method?: unknown };
	return typeof parsed.method === "string" ? parsed.method : "unknown";
}

function listen(server: Server, path: string): Promise<void> {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(path, () => {
			server.removeListener("error", reject);
			resolve();
		});
	});
}

function closeServer(server: Server): Promise<void> {
	return new Promise((resolve) => server.close(() => resolve()));
}

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? String(error.code)
		: undefined;
}
