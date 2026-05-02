/**
 * Thin A2A JSON-RPC client.
 *
 * The official `a2a-js` SDK was not available at the time this file was
 * authored — we hand-roll the JSON-RPC envelope here. The wire format matches
 * `docs/lld.md` §3.1: a single `POST /a2a` endpoint that multiplexes by
 * `method`, with `Authorization: Bearer <api_key>` per call.
 *
 * Idempotency: every state-mutating call carries a UUIDv4 generated client
 * side, threaded through `params.metadata.client_idempotency_key` per
 * `lld.md` §10. The caller can override the key to retry safely.
 *
 * Retries: the client retries 5xx and network errors with exponential
 * backoff (default 3 attempts: 0ms, 100ms, 400ms). 4xx responses are
 * surfaced immediately — they indicate caller error.
 */

import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { fetch as undiciFetch } from "undici";
import { z } from "zod";

const jsonRpcErrorSchema = z.object({
	code: z.number(),
	message: z.string(),
	data: z.unknown().optional(),
});

const jsonRpcResponseSchema = z.object({
	jsonrpc: z.literal("2.0"),
	id: z.union([z.string(), z.number(), z.null()]),
	result: z.unknown().optional(),
	error: jsonRpcErrorSchema.optional(),
});

export type JsonRpcError = z.infer<typeof jsonRpcErrorSchema>;

export class A2AHttpError extends Error {
	constructor(
		public readonly status: number,
		public readonly body: string,
	) {
		super(`A2A HTTP ${status}: ${body.slice(0, 200)}`);
		this.name = "A2AHttpError";
	}
}

export class A2ARpcError extends Error {
	constructor(public readonly rpc: JsonRpcError) {
		super(`A2A RPC ${rpc.code}: ${rpc.message}`);
		this.name = "A2ARpcError";
	}
}

export interface A2AClientOptions {
	relayUrl: string;
	apiKey: string;
	/** Override fetch for tests. Defaults to undici's fetch. */
	fetch?: typeof undiciFetch;
	/** Total attempts including the first try. Default 3. */
	maxAttempts?: number;
	/** Base backoff in ms. Default 100. Each retry waits base * 4^(attempt-1). */
	backoffBaseMs?: number;
	/** Total request timeout in ms. Default 15_000. */
	timeoutMs?: number;
	/** Sleep impl, swappable in tests. */
	sleep?: (ms: number) => Promise<void>;
	/** UUID factory, swappable in tests. */
	uuid?: () => string;
}

export interface RequestOptions {
	/**
	 * Override the auto-generated idempotency key. State-mutating methods
	 * should pass a stable key when retrying at a higher level.
	 */
	idempotencyKey?: string;
	/** Per-call timeout override. */
	timeoutMs?: number;
}

export interface A2AClient {
	request<T>(method: string, params: Record<string, unknown>, options?: RequestOptions): Promise<T>;
	newIdempotencyKey(): string;
}

const optionsSchema = z.object({
	relayUrl: z.string().url(),
	apiKey: z.string().min(1),
	maxAttempts: z.number().int().min(1).max(10).optional(),
	backoffBaseMs: z.number().int().min(0).max(60_000).optional(),
	timeoutMs: z.number().int().min(1).max(120_000).optional(),
});

export function createA2AClient(opts: A2AClientOptions): A2AClient {
	optionsSchema.parse({
		relayUrl: opts.relayUrl,
		apiKey: opts.apiKey,
		maxAttempts: opts.maxAttempts,
		backoffBaseMs: opts.backoffBaseMs,
		timeoutMs: opts.timeoutMs,
	});

	const fetchImpl = opts.fetch ?? undiciFetch;
	const maxAttempts = opts.maxAttempts ?? 3;
	const backoffBaseMs = opts.backoffBaseMs ?? 100;
	const timeoutMs = opts.timeoutMs ?? 15_000;
	const sleep = opts.sleep ?? ((ms: number) => delay(ms));
	const uuid = opts.uuid ?? randomUUID;

	const endpoint = `${stripTrailingSlash(opts.relayUrl)}/a2a`;

	async function request<T>(
		method: string,
		params: Record<string, unknown>,
		options: RequestOptions = {},
	): Promise<T> {
		// Thread the idempotency key into params.metadata for state-mutating
		// methods. Read-only methods ignore it, so this is harmless either way.
		const idempotencyKey = options.idempotencyKey ?? uuid();
		const metadata = mergeMetadata(params.metadata, idempotencyKey);
		const finalParams = { ...params, metadata };

		const body = JSON.stringify({
			jsonrpc: "2.0",
			id: uuid(),
			method,
			params: finalParams,
		});

		let lastErr: unknown;
		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? timeoutMs);
			try {
				const res = await fetchImpl(endpoint, {
					method: "POST",
					headers: {
						"content-type": "application/json",
						authorization: `Bearer ${opts.apiKey}`,
						"idempotency-key": idempotencyKey,
					},
					body,
					signal: controller.signal,
				});

				if (res.status >= 500) {
					const text = await safeText(res);
					lastErr = new A2AHttpError(res.status, text);
					if (attempt < maxAttempts) {
						await sleep(backoffBaseMs * 4 ** (attempt - 1));
						continue;
					}
					throw lastErr;
				}

				if (!res.ok) {
					const text = await safeText(res);
					throw new A2AHttpError(res.status, text);
				}

				const json = (await res.json()) as unknown;
				const parsed = jsonRpcResponseSchema.parse(json);
				if (parsed.error) {
					throw new A2ARpcError(parsed.error);
				}
				return parsed.result as T;
			} catch (err) {
				if (err instanceof A2ARpcError || err instanceof A2AHttpError) {
					if (err instanceof A2AHttpError && err.status >= 500 && attempt < maxAttempts) {
						lastErr = err;
						await sleep(backoffBaseMs * 4 ** (attempt - 1));
						continue;
					}
					throw err;
				}
				// Network / abort / parse error → retry like a 5xx.
				lastErr = err;
				if (attempt < maxAttempts) {
					await sleep(backoffBaseMs * 4 ** (attempt - 1));
					continue;
				}
				throw err;
			} finally {
				clearTimeout(timeout);
			}
		}
		// Unreachable, but TS wants a return.
		throw lastErr instanceof Error ? lastErr : new Error("a2a-client: exhausted attempts");
	}

	return {
		request,
		newIdempotencyKey: () => uuid(),
	};
}

function mergeMetadata(existing: unknown, idempotencyKey: string): Record<string, unknown> {
	const base: Record<string, unknown> =
		existing && typeof existing === "object" && !Array.isArray(existing)
			? { ...(existing as Record<string, unknown>) }
			: {};
	if (!("client_idempotency_key" in base)) {
		base.client_idempotency_key = idempotencyKey;
	}
	return base;
}

function stripTrailingSlash(s: string): string {
	return s.endsWith("/") ? s.slice(0, -1) : s;
}

async function safeText(res: { text: () => Promise<string> }): Promise<string> {
	try {
		return await res.text();
	} catch {
		return "";
	}
}
