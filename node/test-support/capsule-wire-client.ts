import { randomUUID } from "node:crypto";
import { type Socket, createConnection } from "node:net";
import {
	type CapsuleRequest,
	type CapsuleResponse,
	capsuleRequestSchema,
	capsuleResponseSchema,
} from "../src/capsule-protocol.js";
import type { CapsuleServerIdentity } from "../src/capsule-runtime.js";

export async function sendCapsuleRequest(
	identity: CapsuleServerIdentity,
	method: CapsuleRequest["method"],
	params: unknown,
): Promise<CapsuleResponse[]> {
	const socket = await connectCapsule(identity.socketPath);
	socket.write(`${JSON.stringify(buildCapsuleRequest(identity, method, params))}\n`);
	return readCapsuleFrames(socket);
}

export async function readCapsuleFrames(socket: Socket): Promise<CapsuleResponse[]> {
	let raw = "";
	for await (const chunk of socket) raw += String(chunk);
	return raw
		.split("\n")
		.filter(Boolean)
		.map((line) => capsuleResponseSchema.parse(JSON.parse(line)));
}

export async function capsuleResultValue(
	identity: CapsuleServerIdentity,
	method: CapsuleRequest["method"],
	params: unknown,
) {
	const frames = await sendCapsuleRequest(identity, method, params);
	if (frames[0]?.kind !== "result") throw new Error("Expected Capsule result frame");
	return frames[0].value;
}

export function buildCapsuleRequest(
	identity: CapsuleServerIdentity,
	method: CapsuleRequest["method"],
	params: unknown,
): CapsuleRequest {
	return capsuleRequestSchema.parse({
		version: 1,
		capsule_id: identity.capsuleId,
		capability_token: identity.capabilityToken,
		request_id: randomUUID(),
		method,
		params,
	});
}

export function connectCapsule(path: string): Promise<Socket> {
	return new Promise((resolve, reject) => {
		const socket = createConnection(path);
		socket.once("connect", () => resolve(socket));
		socket.once("error", reject);
	});
}

export function readFirstCapsuleFrame(socket: Socket): Promise<CapsuleResponse> {
	return new Promise((resolve, reject) => {
		let raw = "";
		socket.setEncoding("utf8");
		socket.on("data", (chunk: string) => {
			raw += chunk;
			const newline = raw.indexOf("\n");
			if (newline >= 0) resolve(capsuleResponseSchema.parse(JSON.parse(raw.slice(0, newline))));
		});
		socket.once("error", reject);
	});
}
