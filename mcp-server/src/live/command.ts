import { type FSWatcher, watch } from "node:fs";
import { dirname } from "node:path";
import { fetch as relayFetch } from "undici";
import { z } from "zod";
import { createA2AClient } from "../a2a-client.js";
import { type AgentRelayConfig, loadConfig, unavailableMessage } from "../config.js";
import { createMailboxEventClient } from "../connector/event-client.js";
import { type LoadTrustResult, computeOverlay, loadTrust, resolveTrustPath } from "../trust.js";
import { runLiveBridge } from "./bridge.js";
import { createCodexLiveRuntime } from "./codex.js";
import { LiveSessionError, liveScopeSchema } from "./contracts.js";
import { createLiveMailbox } from "./mailbox.js";
import { liveStatePath, openLiveStore } from "./store.js";

export const liveCommandSchema = z.object({
	peer: z.string().min(1).max(120),
	handoff: z.string().uuid(),
	allowReplies: z.literal(true),
	maxTurns: z.coerce.number().int().min(1).max(12).default(6),
	ttlSeconds: z.coerce.number().int().min(30).max(1_800).default(900),
	show: z.boolean().default(false),
	once: z.boolean().default(false),
});

export function assertLiveConsent(result: LoadTrustResult, peer: string): void {
	if (!result.ok)
		throw new LiveSessionError(
			"trust_unavailable",
			"Local trust policy is unavailable; live communication stopped",
		);
	const decision = computeOverlay(result.trust, peer);
	if (
		decision.decision !== "allow" ||
		decision.source !== "listed" ||
		!decision.overlay.auto_pickup ||
		!decision.overlay.auto_read
	) {
		throw new LiveSessionError(
			"consent_required",
			"Live communication requires an unblocked, explicitly listed peer with auto_pickup and auto_read enabled",
		);
	}
}

export function assertLiveConfig(expected: AgentRelayConfig, actual: AgentRelayConfig): void {
	if (
		expected.relay_url !== actual.relay_url ||
		expected.agent_id !== actual.agent_id ||
		expected.agent_handle !== actual.agent_handle ||
		expected.api_key !== actual.api_key
	) {
		throw new LiveSessionError(
			"config_changed",
			"Relay identity or credential changed; restart the live session after checking configuration",
		);
	}
}

export async function runLiveCommand(
	raw: unknown,
	options: { signal: AbortSignal; write?: (line: string) => void },
): Promise<void> {
	const parsed = liveCommandSchema.safeParse(raw);
	if (!parsed.success)
		throw new LiveSessionError(
			"invalid_options",
			"Use live codex --peer <handle> --handoff <Relay-thread-uuid> --allow-replies; max-turns must be 1..12 and ttl-seconds 30..1800",
		);
	if (process.platform !== "darwin" && process.platform !== "linux")
		throw new LiveSessionError(
			"platform",
			"The live preview currently supports macOS and glibc Linux",
		);
	const input = parsed.data;
	const loaded = await loadConfig();
	if (!loaded.ok) throw new LiveSessionError("config_missing", unavailableMessage(loaded));
	const config = loaded.config;
	const url = new URL(config.relay_url);
	if (
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		(url.protocol !== "https:" &&
			!(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
	) {
		throw new LiveSessionError(
			"relay_url",
			"Live communication requires HTTPS, or HTTP on localhost for development",
		);
	}
	const scope = liveScopeSchema.parse({
		relayUrl: url.toString().replace(/\/$/, ""),
		agentId: config.agent_id,
		localHandle: config.agent_handle,
		peerHandle: input.peer,
		threadId: input.handoff,
	});
	const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
	const revoked = new AbortController();
	const signal = AbortSignal.any([options.signal, revoked.signal]);
	const assertAuthority = async () => {
		signal.throwIfAborted();
		const current = await loadConfig();
		if (!current.ok)
			throw new LiveSessionError(
				"config_unavailable",
				"Local Relay configuration became unavailable",
			);
		assertLiveConfig(config, current.config);
		assertLiveConsent(await loadTrust(), scope.peerHandle);
		signal.throwIfAborted();
	};
	await assertAuthority();
	const store = await openLiveStore({
		path: liveStatePath(scope),
		scope,
		maxTurns: input.maxTurns,
		expiresAt: Date.now() + input.ttlSeconds * 1_000,
	});
	const watchers: FSWatcher[] = [];
	const runtime = createCodexLiveRuntime({
		show: input.show,
		onStop: (error) => revoked.abort(error),
		onSession: (threadId) => write(`Codex communication session: ${threadId}`),
		onAccepted: (messageId) => write(`runtime_accepted ${messageId}`),
	});
	try {
		// Watch directories so an atomic trust/config replacement revokes this run too.
		for (const path of new Set([dirname(loaded.path), dirname(resolveTrustPath())])) {
			const watcher = watch(path, () => {
				void assertAuthority().catch(() =>
					revoked.abort(
						new LiveSessionError(
							"authority_changed",
							"Local configuration or trust changed; live communication stopped",
						),
					),
				);
			});
			watcher.on("error", () =>
				revoked.abort(
					new LiveSessionError(
						"policy_watch_failed",
						"Local policy monitoring failed; live communication stopped",
					),
				),
			);
			watchers.push(watcher);
		}
		await assertAuthority();
		const fetch: typeof relayFetch = (target, init) =>
			relayFetch(target, { ...init, redirect: "error" });
		const identityResponse = await fetch(`${scope.relayUrl}/agents/me`, {
			headers: { authorization: `Bearer ${config.api_key}` },
			signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
		});
		if (!identityResponse.ok) {
			await identityResponse.body?.cancel();
			throw new LiveSessionError("identity_rejected", "The Relay refused this agent credential");
		}
		const identity = z
			.object({ id: z.literal(scope.agentId), handle: z.literal(scope.localHandle) })
			.safeParse(await identityResponse.json());
		if (!identity.success)
			throw new LiveSessionError(
				"identity_mismatch",
				"The Relay credential does not match the configured agent identity",
			);
		const client = createA2AClient({
			relayUrl: scope.relayUrl,
			apiKey: config.api_key,
			maxAttempts: 1,
			fetch,
		});
		write(
			`Communication-only live session: ${JSON.stringify(scope.peerHandle)} / Relay thread ${scope.threadId}`,
		);
		write(
			`Limit: ${store.read().maxTurns} received turns total; expires ${new Date(store.read().expiresAt).toISOString()}. Ctrl+C stops this run.`,
		);
		if (input.show)
			write(
				"The dedicated Codex chat is a live viewer; leave its input empty. Existing chats are not attached.",
			);
		await runLiveBridge({
			store,
			mailbox: createLiveMailbox(client, scope),
			events: createMailboxEventClient({ relayUrl: scope.relayUrl, apiKey: config.api_key, fetch }),
			runtime,
			signal,
			assertAuthority,
			once: input.once,
			onStatus: (status) =>
				write(`${status.type}${status.messageId ? ` ${status.messageId}` : ""}`),
		});
		if (revoked.signal.aborted && !options.signal.aborted) throw revoked.signal.reason;
		const state = store.read();
		write(
			`Live session stopped. Completed: ${state.receipts.length}; pending: ${state.pending?.phase ?? "none"}. Journal: ${liveStatePath(scope)}`,
		);
	} finally {
		for (const watcher of watchers) watcher.close();
		try {
			await runtime.close();
		} finally {
			await store.close();
		}
	}
}
