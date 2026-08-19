import { CODEX_SANDBOX_PROFILE_NAME } from "./codex-sandbox-contract.js";

/** Fixed provider-only egress admitted by the retained Codex containment policy. */
export const CODEX_PROVIDER_EGRESS_POLICY = Object.freeze({
	policyId: "openai_api_key_managed_connect_v1",
	providerId: "openai",
	baseUrl: "https://api.openai.com/v1",
	allowedHosts: Object.freeze(["api.openai.com"] as const),
	proxyMode: "full",
	workspaceNetwork: "denied",
} as const);

export const CODEX_PROVIDER_CONFIG = `model_provider=${JSON.stringify(
	CODEX_PROVIDER_EGRESS_POLICY.providerId,
)}`;
export const CODEX_PROVIDER_BASE_URL_CONFIG = `openai_base_url=${JSON.stringify(
	CODEX_PROVIDER_EGRESS_POLICY.baseUrl,
)}`;

/** Exact managed CONNECT proxy policy loaded only by the outer Codex sandbox launcher. */
export function buildCodexProviderEgressToml(): string {
	return [
		`[permissions.${CODEX_SANDBOX_PROFILE_NAME}.network]`,
		"enabled = true",
		// The pinned outer Codex owns and selects its managed-proxy listener. An external proxy URL
		// would turn local environment or configuration into egress authority.
		"enable_socks5 = false",
		"enable_socks5_udp = false",
		"allow_upstream_proxy = false",
		"dangerously_allow_non_loopback_proxy = false",
		"dangerously_allow_all_unix_sockets = false",
		"allow_local_binding = false",
		`mode = ${JSON.stringify(CODEX_PROVIDER_EGRESS_POLICY.proxyMode)}`,
		"",
		`[permissions.${CODEX_SANDBOX_PROFILE_NAME}.network.domains]`,
		...CODEX_PROVIDER_EGRESS_POLICY.allowedHosts.map((host) => `${JSON.stringify(host)} = "allow"`),
		"",
	].join("\n");
}

export interface CodexProviderEgressBinding {
	readonly policy_id: typeof CODEX_PROVIDER_EGRESS_POLICY.policyId;
	readonly provider_id: typeof CODEX_PROVIDER_EGRESS_POLICY.providerId;
	readonly base_url: typeof CODEX_PROVIDER_EGRESS_POLICY.baseUrl;
	readonly allowed_hosts: [(typeof CODEX_PROVIDER_EGRESS_POLICY.allowedHosts)[0]];
	readonly proxy_mode: typeof CODEX_PROVIDER_EGRESS_POLICY.proxyMode;
	readonly workspace_network: typeof CODEX_PROVIDER_EGRESS_POLICY.workspaceNetwork;
}

export function codexProviderEgressBinding(): CodexProviderEgressBinding {
	return {
		policy_id: CODEX_PROVIDER_EGRESS_POLICY.policyId,
		provider_id: CODEX_PROVIDER_EGRESS_POLICY.providerId,
		base_url: CODEX_PROVIDER_EGRESS_POLICY.baseUrl,
		allowed_hosts: [CODEX_PROVIDER_EGRESS_POLICY.allowedHosts[0]],
		proxy_mode: CODEX_PROVIDER_EGRESS_POLICY.proxyMode,
		workspace_network: CODEX_PROVIDER_EGRESS_POLICY.workspaceNetwork,
	};
}
