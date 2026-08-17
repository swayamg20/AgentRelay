import { setTimeout as delay } from "node:timers/promises";
import {
	type DeliveryClaimInput,
	type DeliveryClaimResult,
	type DeliveryCompleteInput,
	type DeliveryCompleteResult,
	type DeliveryReleaseInput,
	type DeliveryReleaseResult,
	type DeliveryRenewInput,
	type DeliveryRenewResult,
	type DeliveryStartInput,
	type DeliveryStartResult,
	type MissionParticipantAcceptanceInput,
	type MissionParticipantAcceptanceResult,
	type MissionStatus,
	type NodeMissionAssignment,
	type NodeMissionAssignmentList,
	type NodeSelfResult,
	type RecoverableMissionDeliveryPage,
	type StoredMissionDeliveryCursorPage,
	type WorkspaceBindingList,
	type WorkspaceRegistrationInput,
	type WorkspaceRegistrationResult,
	deliveryClaimResultSchema,
	deliveryCompleteResultSchema,
	deliveryReleaseResultSchema,
	deliveryRenewResultSchema,
	deliveryStartResultSchema,
	missionParticipantAcceptanceResultSchema,
	nodeMissionAssignmentListSchema,
	nodeMissionAssignmentResultSchema,
	nodeSelfResultSchema,
	recoverableMissionDeliveryPageSchema,
	storedMissionDeliveryCursorPageSchema,
	uuidSchema,
	workspaceBindingListSchema,
	workspaceRegistrationResultSchema,
} from "@agentrelay/protocol";
import { fetch as undiciFetch } from "undici";
import { z } from "zod";
import { relayUrlSchema } from "./config.js";

const errorEnvelopeSchema = z
	.object({
		code: z.string().min(1),
		message: z.string().min(1),
		request_id: z.string().min(1),
		details: z.record(z.unknown()).optional(),
	})
	.strict();

const requestOptionsSchema = z.object({
	relayUrl: relayUrlSchema,
	credential: z.string().min(1),
	maxAttempts: z.number().int().min(1).max(10).optional(),
	backoffBaseMs: z.number().int().min(0).max(60_000).optional(),
	timeoutMs: z.number().int().min(1).max(120_000).optional(),
});

type Fetch = typeof undiciFetch;

export interface NodeRelayClientOptions {
	readonly relayUrl: string;
	readonly credential: string;
	readonly fetch?: Fetch;
	readonly maxAttempts?: number;
	readonly backoffBaseMs?: number;
	readonly timeoutMs?: number;
	readonly sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

export class RelayHttpError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
		readonly requestId: string | null,
		readonly details: Readonly<Record<string, unknown>>,
	) {
		super(`Relay ${status} ${code}: ${message}`);
		this.name = "RelayHttpError";
	}
}

export interface NodeRelayClient {
	me(): Promise<NodeSelfResult>;
	registerWorkspace(input: WorkspaceRegistrationInput): Promise<WorkspaceRegistrationResult>;
	listWorkspaces(): Promise<WorkspaceBindingList>;
	listAssignments(
		status?: MissionStatus,
		afterCursor?: string | null,
		limit?: number,
	): Promise<NodeMissionAssignmentList>;
	getAssignment(missionId: string): Promise<NodeMissionAssignment>;
	acceptAssignment(
		missionId: string,
		input: MissionParticipantAcceptanceInput,
	): Promise<MissionParticipantAcceptanceResult>;
	pollDeliveries(
		afterCursor: string | null,
		limit?: number,
	): Promise<StoredMissionDeliveryCursorPage>;
	recoverDeliveries(limit?: number): Promise<RecoverableMissionDeliveryPage>;
	claim(deliveryId: string, input: DeliveryClaimInput): Promise<DeliveryClaimResult>;
	start(deliveryId: string, input: DeliveryStartInput): Promise<DeliveryStartResult>;
	renew(deliveryId: string, input: DeliveryRenewInput): Promise<DeliveryRenewResult>;
	complete(
		deliveryId: string,
		input: DeliveryCompleteInput,
		signal?: AbortSignal,
	): Promise<DeliveryCompleteResult>;
	release(deliveryId: string, input: DeliveryReleaseInput): Promise<DeliveryReleaseResult>;
}

export function createNodeRelayClient(options: NodeRelayClientOptions): NodeRelayClient {
	const parsed = requestOptionsSchema.parse(options);
	const fetchImpl = options.fetch ?? undiciFetch;
	const maxAttempts = parsed.maxAttempts ?? 3;
	const backoffBaseMs = parsed.backoffBaseMs ?? 100;
	const timeoutMs = parsed.timeoutMs ?? 15_000;
	const sleep =
		options.sleep ??
		((milliseconds: number, signal?: AbortSignal) => delay(milliseconds, undefined, { signal }));
	const baseUrl = `${parsed.relayUrl}/node/v1`;

	async function request<TSchema extends z.ZodTypeAny>(
		method: "GET" | "POST",
		path: string,
		schema: TSchema,
		body?: unknown,
		signal?: AbortSignal,
	): Promise<z.output<TSchema>> {
		let lastError: unknown;
		for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
			signal?.throwIfAborted();
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), timeoutMs);
			const requestSignal =
				signal === undefined ? controller.signal : AbortSignal.any([signal, controller.signal]);
			try {
				const response = await fetchImpl(`${baseUrl}${path}`, {
					method,
					headers: {
						authorization: `Bearer ${parsed.credential}`,
						accept: "application/json",
						...(body === undefined ? {} : { "content-type": "application/json" }),
					},
					body: body === undefined ? undefined : JSON.stringify(body),
					signal: requestSignal,
				});
				if (response.ok) {
					return schema.parse(await response.json());
				}
				const error = await relayError(response.status, response);
				if (response.status < 500 || attempt === maxAttempts) throw error;
				lastError = error;
			} catch (error) {
				if (signal?.aborted) throw signal.reason;
				if (error instanceof RelayHttpError && error.status < 500) throw error;
				lastError = error;
				if (attempt === maxAttempts) throw error;
			} finally {
				clearTimeout(timeout);
			}
			await sleep(backoffBaseMs * 4 ** (attempt - 1), signal);
		}
		throw lastError instanceof Error ? lastError : new Error("Relay request exhausted retries");
	}

	return {
		me: () => request("GET", "/me", nodeSelfResultSchema),
		registerWorkspace: (input) =>
			request("POST", "/workspaces", workspaceRegistrationResultSchema, input),
		listWorkspaces: () => request("GET", "/workspaces", workspaceBindingListSchema),
		listAssignments: (status, afterCursor = null, limit = 50) => {
			const query = new URLSearchParams({ limit: String(limit) });
			if (status !== undefined) query.set("status", status);
			if (afterCursor !== null) query.set("after_cursor", afterCursor);
			return request("GET", `/missions?${query.toString()}`, nodeMissionAssignmentListSchema);
		},
		getAssignment: async (missionId) => {
			const id = uuidSchema.parse(missionId);
			const result = await request("GET", `/missions/${id}`, nodeMissionAssignmentResultSchema);
			return result.mission;
		},
		acceptAssignment: (missionId, input) =>
			request(
				"POST",
				`/missions/${uuidSchema.parse(missionId)}/accept`,
				missionParticipantAcceptanceResultSchema,
				input,
			),
		pollDeliveries: (afterCursor, limit = 50) => {
			const query = new URLSearchParams({ limit: String(limit) });
			if (afterCursor !== null) query.set("after_cursor", afterCursor);
			return request(
				"GET",
				`/deliveries?${query.toString()}`,
				storedMissionDeliveryCursorPageSchema,
			);
		},
		recoverDeliveries: (limit = 50) =>
			request(
				"GET",
				`/deliveries/recoverable?limit=${encodeURIComponent(String(limit))}`,
				recoverableMissionDeliveryPageSchema,
			),
		claim: (deliveryId, input) =>
			request(
				"POST",
				`/deliveries/${uuidSchema.parse(deliveryId)}/claim`,
				deliveryClaimResultSchema,
				input,
			),
		start: (deliveryId, input) =>
			request(
				"POST",
				`/deliveries/${uuidSchema.parse(deliveryId)}/start`,
				deliveryStartResultSchema,
				input,
			),
		renew: (deliveryId, input) =>
			request(
				"POST",
				`/deliveries/${uuidSchema.parse(deliveryId)}/renew`,
				deliveryRenewResultSchema,
				input,
			),
		complete: (deliveryId, input, signal) =>
			request(
				"POST",
				`/deliveries/${uuidSchema.parse(deliveryId)}/complete`,
				deliveryCompleteResultSchema,
				input,
				signal,
			),
		release: (deliveryId, input) =>
			request(
				"POST",
				`/deliveries/${uuidSchema.parse(deliveryId)}/release`,
				deliveryReleaseResultSchema,
				input,
			),
	};
}

async function relayError(
	status: number,
	response: { text(): Promise<string> },
): Promise<RelayHttpError> {
	let text = "";
	try {
		text = await response.text();
		const parsed = errorEnvelopeSchema.parse(JSON.parse(text));
		return new RelayHttpError(
			status,
			parsed.code,
			parsed.message,
			parsed.request_id,
			parsed.details ?? {},
		);
	} catch {
		return new RelayHttpError(status, "invalid_response", text.slice(0, 200), null, {});
	}
}
