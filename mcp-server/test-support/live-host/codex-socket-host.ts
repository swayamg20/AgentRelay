import { spawn } from "node:child_process";
import { existsSync, watch } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

export function nativeCodexHeaders(input: unknown): Record<string, string> {
	const headers = z.record(z.string()).parse(input);
	// Codex 0.154.0 closes the Unix handshake when compression is offered.
	// Its native client does not request this optional WebSocket extension.
	return Object.fromEntries(
		Object.entries(headers).filter(([name]) => name.toLowerCase() !== "sec-websocket-extensions"),
	);
}

/** Private Unix listener for the probe's own proxy, TUI and queue command. */
export async function startCodexSocketHost(
	configArgs: string[],
	directory: string,
	env: NodeJS.ProcessEnv,
) {
	const socketPath = join(directory, "rpc.sock");
	if (process.platform === "win32" || Buffer.byteLength(socketPath) >= 104) {
		throw new Error("The queue probe requires a short local Unix socket path");
	}
	const host = spawn("codex", ["app-server", "--listen", `unix://${socketPath}`, ...configArgs], {
		cwd: directory,
		env,
		stdio: ["pipe", "pipe", "pipe"],
	});
	host.stdout.resume();
	host.stderr.resume();
	const closed = new Promise<void>((resolve) => host.once("close", () => resolve()));
	async function stop() {
		host.kill("SIGTERM");
		const timer = setTimeout(() => host.kill("SIGKILL"), 3_000);
		await closed;
		clearTimeout(timer);
	}
	try {
		await new Promise<void>((resolve, reject) => {
			const finish = (error?: Error) => {
				clearTimeout(timer);
				watcher.close();
				host.removeListener("error", onError);
				host.removeListener("close", onClose);
				if (error) reject(error);
				else resolve();
			};
			const onError = () => finish(new Error("Codex socket host could not start"));
			const onClose = () => finish(new Error("Codex socket host closed before readiness"));
			const watcher = watch(directory, () => {
				if (existsSync(socketPath)) finish();
			});
			const timer = setTimeout(
				() => finish(new Error("Codex socket did not become ready")),
				10_000,
			);
			host.once("error", onError);
			host.once("close", onClose);
			if (existsSync(socketPath)) finish();
		});
	} catch (error) {
		await stop();
		throw error;
	}
	return { socketPath, endpoint: `unix://${socketPath}`, stop };
}
