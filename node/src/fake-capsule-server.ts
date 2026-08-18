import { dirname } from "node:path";
import { readFakeCapsuleLaunchDescriptor } from "./capsule-launch-descriptor.js";
import { ensurePrivateCapsuleDirectory } from "./capsule-server-io.js";
import { PersistentCapsuleServer } from "./capsule-server.js";
import { FakeCapsuleRuntimeController } from "./fake-capsule-runtime.js";
import { FakeCapsuleStore } from "./fake-capsule-store.js";

/** Compatibility factory for the still fake-only Capsule command and Node adapter. */
export class PersistentFakeCapsuleServer {
	readonly #server: PersistentCapsuleServer;

	private constructor(server: PersistentCapsuleServer) {
		this.#server = server;
	}

	static async start(directory: string): Promise<PersistentFakeCapsuleServer> {
		await ensurePrivateCapsuleDirectory(directory);
		const descriptor = await readFakeCapsuleLaunchDescriptor(directory);
		await ensurePrivateCapsuleDirectory(dirname(descriptor.socket_path));
		const server = await PersistentCapsuleServer.start({
			identity: {
				capsuleId: descriptor.capsule_id,
				capabilityToken: descriptor.capability_token,
				socketPath: descriptor.socket_path,
			},
			openController: async () =>
				new FakeCapsuleRuntimeController(await FakeCapsuleStore.open(directory)),
		});
		return new PersistentFakeCapsuleServer(server);
	}

	get socketPath(): string {
		return this.#server.socketPath;
	}

	waitUntilClosed(): Promise<void> {
		return this.#server.waitUntilClosed();
	}

	close(): Promise<void> {
		return this.#server.close();
	}
}
