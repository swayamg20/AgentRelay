import { describe, expect, it } from "vitest";
import {
	DISABLED_CODEX_FEATURES,
	buildCodexAppServerArguments,
	classifyAdmittedCodexProcessArguments,
	isAdmittedCodexProcessArguments,
} from "./codex-app-server-command.js";
import {
	CODEX_PROVIDER_BASE_URL_CONFIG,
	CODEX_PROVIDER_CONFIG,
	CODEX_PROVIDER_EGRESS_POLICY,
	buildCodexProviderEgressToml,
	codexProviderEgressBinding,
} from "./codex-provider-egress-policy.js";

const WORKSPACE = "/srv/agentrelay/workspace";

describe("Codex provider egress policy", () => {
	it("renders the exact outer managed CONNECT proxy policy", () => {
		expect(CODEX_PROVIDER_EGRESS_POLICY).toEqual({
			policyId: "openai_api_key_managed_connect_v1",
			providerId: "openai",
			baseUrl: "https://api.openai.com/v1",
			allowedHosts: ["api.openai.com"],
			proxyMode: "full",
			workspaceNetwork: "denied",
		});
		expect(buildCodexProviderEgressToml()).toBe(
			[
				"[permissions.agentrelay-runtime.network]",
				"enabled = true",
				"enable_socks5 = false",
				"enable_socks5_udp = false",
				"allow_upstream_proxy = false",
				"dangerously_allow_non_loopback_proxy = false",
				"dangerously_allow_all_unix_sockets = false",
				"allow_local_binding = false",
				'mode = "full"',
				"",
				"[permissions.agentrelay-runtime.network.domains]",
				'"api.openai.com" = "allow"',
				"",
			].join("\n"),
		);
		expect(codexProviderEgressBinding()).toEqual({
			policy_id: "openai_api_key_managed_connect_v1",
			provider_id: "openai",
			base_url: "https://api.openai.com/v1",
			allowed_hosts: ["api.openai.com"],
			proxy_mode: "full",
			workspace_network: "denied",
		});
	});

	it("pins the inner provider while keeping its nested network proxy disabled", () => {
		const argv = buildCodexAppServerArguments(WORKSPACE);

		expect(CODEX_PROVIDER_CONFIG).toBe('model_provider="openai"');
		expect(CODEX_PROVIDER_BASE_URL_CONFIG).toBe('openai_base_url="https://api.openai.com/v1"');
		expect(argv).toContain(CODEX_PROVIDER_CONFIG);
		expect(argv).toContain(CODEX_PROVIDER_BASE_URL_CONFIG);
		expect(DISABLED_CODEX_FEATURES).toContain("network_proxy");
		expect(argv).toContain("network_proxy");
	});

	it.each([
		["version suffix", ["--version", "--config", 'model_provider="other"']],
		[
			"alternate base URL",
			withChangedConfig(CODEX_PROVIDER_BASE_URL_CONFIG, 'openai_base_url="https://evil.test"'),
		],
		["alternate provider", withChangedConfig(CODEX_PROVIDER_CONFIG, 'model_provider="other"')],
		["extra app-server argument", [...buildCodexAppServerArguments(WORKSPACE), "--help"]],
		["missing app-server argument", buildCodexAppServerArguments(WORKSPACE).slice(0, -1)],
	] as const)("rejects a %s containment argv", (_name, argv) => {
		expect(isAdmittedCodexProcessArguments(argv, WORKSPACE)).toBe(false);
	});

	it("admits only the exact version probe and pinned app-server commands", () => {
		expect(classifyAdmittedCodexProcessArguments(["--version"], WORKSPACE)).toBe("version_probe");
		expect(
			classifyAdmittedCodexProcessArguments(buildCodexAppServerArguments(WORKSPACE), WORKSPACE),
		).toBe("app_server");
		expect(isAdmittedCodexProcessArguments(["--version"], WORKSPACE)).toBe(true);
	});
});

function withChangedConfig(current: string, replacement: string): string[] {
	return buildCodexAppServerArguments(WORKSPACE).map((value) =>
		value === current ? replacement : value,
	);
}
