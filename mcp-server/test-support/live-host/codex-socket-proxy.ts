import { createConnection } from "node:net";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { Agent, WebSocket } from "undici";
import { z } from "zod";
import { nativeCodexHeaders } from "./codex-socket-host.js";

const { values } = parseArgs({ options: { socket: { type: "string" } }, strict: true });
const socketPath = z.string().startsWith("/").parse(values.socket);
const dispatcher = new Agent({
	connect: (_options, callback) => {
		const stream = createConnection(socketPath);
		const onError = (error: Error) => callback(error, null);
		stream.once("error", onError);
		stream.once("connect", () => {
			stream.removeListener("error", onError);
			callback(null, stream);
		});
		return stream;
	},
}).compose(
	(dispatch) => (options, handler) =>
		dispatch({ ...options, headers: nativeCodexHeaders(options.headers) }, handler),
);
// The HTTP Upgrade goes through the private Unix socket, not a TCP listener.
const socket = new WebSocket("ws://localhost", { dispatcher });
const input = createInterface({ input: process.stdin, terminal: false });
const buffered: string[] = [];
let opened = false;
const deadline = setTimeout(() => {
	console.error("Codex probe WebSocket handshake timed out");
	process.exit(1);
}, 10_000);
input.on("line", (line) => {
	if (opened) socket.send(line);
	else buffered.push(line);
});
socket.addEventListener("open", () => {
	clearTimeout(deadline);
	opened = true;
	for (const line of buffered.splice(0)) socket.send(line);
});
socket.addEventListener("message", (event) => {
	if (typeof event.data !== "string") {
		console.error("Codex probe received a non-text WebSocket frame");
		process.exit(1);
	}
	process.stdout.write(`${event.data}\n`);
});
socket.addEventListener("error", () => {
	console.error("Codex probe WebSocket failed");
	process.exit(1);
});
socket.addEventListener("close", () => {
	clearTimeout(deadline);
	input.close();
	void dispatcher.destroy();
});
input.on("close", () => socket.close());
