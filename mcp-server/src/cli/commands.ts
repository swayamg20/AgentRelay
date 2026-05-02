/**
 * Command implementations for `agentrelay`. Each command takes its
 * dependencies as parameters so they're directly testable; the bin script
 * supplies the real ones.
 */

import { readFile, stat } from "node:fs/promises";
import yaml from "js-yaml";
import { request as undiciRequest } from "undici";
import { z } from "zod";
import { type AgentRelayConfig, loadConfig } from "../config.js";
import { logger } from "../logger.js";
import { FALLBACK_TRUST, type TrustFile, loadTrust } from "../trust.js";
import { type TomlMergeReport, mergeCodexSettings, renderTomlMergeReport } from "./install-toml.js";
import {
	type MergeReport,
	mergeClaudeJsonMcp,
	mergeClaudeOverlay,
	renderMergeReport,
} from "./install.js";
import { writeSecretFile } from "./io.js";
import { type SupportedClient, clientPaths, configPath, mcpPath, trustPath } from "./paths.js";
import {
	type TrustSetUpdate,
	blockTeammate,
	resetTeammate,
	serializeTrust,
	setTeammate,
	unblockTeammate,
} from "./trust-mutate.js";

const adminAgentResponseSchema = z.object({
	// Relay's POST /admin/agents response uses `agent_id` (lld §3.3).
	agent_id: z.string(),
	handle: z.string(),
	api_key: z.string(),
});

const inviteResponseSchema = z
	.object({
		url: z.string(),
		jti: z.string(),
		expiresAt: z.string().optional(),
		expires_at: z.string().optional(),
	})
	.transform(({ url, jti, expiresAt, expires_at }, ctx) => {
		const normalizedExpiresAt = expiresAt ?? expires_at;
		if (!normalizedExpiresAt) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "invite response missing expiresAt",
			});
			return z.NEVER;
		}
		return { url, jti, expiresAt: normalizedExpiresAt };
	});

const inviteTokenPayloadSchema = z
	.object({
		jti: z.string().min(1),
		inviter_handle: z.string().min(1),
	})
	.passthrough();

export interface RegisterOptions {
	relay: string;
	adminToken?: string;
	handle: string;
	email: string;
	name: string;
	role: string;
}

export interface RegisterDeps {
	now?: () => Date;
	httpPost?: (
		url: string,
		body: unknown,
		headers: Record<string, string>,
	) => Promise<{ status: number; json: unknown }>;
	configPath?: string;
}

export async function register(
	opts: RegisterOptions,
	deps: RegisterDeps = {},
): Promise<AgentRelayConfig> {
	const post = deps.httpPost ?? defaultHttpPost;
	const path = deps.configPath ?? configPath();
	const url = `${stripTrailing(opts.relay)}/admin/agents`;
	const headers: Record<string, string> = { "content-type": "application/json" };
	if (opts.adminToken) headers.authorization = `Bearer ${opts.adminToken}`;

	const res = await post(
		url,
		{
			handle: opts.handle,
			email: opts.email,
			// Relay's schema names this field display_name (lld §3.3 / §2.1).
			display_name: opts.name,
			role: opts.role,
		},
		headers,
	);
	if (res.status >= 400) {
		throw new Error(`relay ${url} returned ${res.status}: ${JSON.stringify(res.json)}`);
	}
	const parsed = adminAgentResponseSchema.parse(res.json);

	const config: AgentRelayConfig = {
		relay_url: stripTrailing(opts.relay),
		agent_handle: parsed.handle,
		agent_id: parsed.agent_id,
		api_key: parsed.api_key,
		default_session_id: null,
	};
	await writeSecretFile(path, `${JSON.stringify(config, null, 2)}\n`);
	logger.info({ path }, "wrote ~/.agentrelay/config.json (mode 0600)");
	return config;
}

export interface InviteOptions {
	handle: string;
	role: string;
	expiresInSeconds: number;
	adminToken: string;
	relayUrl?: string;
}

export interface InviteResult {
	url: string;
	jti: string;
	expiresAt: string;
}

type InviteLoadConfigResult =
	| {
			ok: true;
			config: Partial<Pick<AgentRelayConfig, "relay_url" | "agent_handle">>;
	  }
	| {
			ok: false;
			reason: string;
			path: string;
			detail?: string;
	  };

export interface InviteDeps {
	httpPost?: (
		url: string,
		body: unknown,
		headers: Record<string, string>,
	) => Promise<{ status: number; json: unknown }>;
	loadConfig?: () => Promise<InviteLoadConfigResult>;
}

export async function invite(opts: InviteOptions, deps: InviteDeps = {}): Promise<InviteResult> {
	const post = deps.httpPost ?? defaultHttpPost;
	const load = deps.loadConfig ?? loadConfig;
	const cfg = await load();
	const localConfig = cfg.ok ? cfg.config : undefined;
	const relayUrl = opts.relayUrl ?? localConfig?.relay_url;
	if (!relayUrl) {
		throw new Error("no relay URL — pass --relay or run agentrelay register first");
	}
	const inviterHandle = localConfig?.agent_handle;
	if (!inviterHandle) {
		throw new Error(
			"agentrelay invite must be run from a registered machine (no agent_handle in config)",
		);
	}

	const url = `${stripTrailing(relayUrl)}/admin/invites`;
	const res = await post(
		url,
		{
			handle: opts.handle,
			role: opts.role,
			inviter_handle: inviterHandle,
			expires_in_seconds: opts.expiresInSeconds ?? 86_400,
		},
		{
			"content-type": "application/json",
			authorization: `Bearer ${opts.adminToken}`,
		},
	);
	if (res.status < 200 || res.status >= 300) {
		throw new Error(relayErrorMessage(res.status, res.json));
	}
	return inviteResponseSchema.parse(res.json);
}

export interface JoinDeps {
	httpPost?: (
		url: string,
		body: unknown,
		headers: Record<string, string>,
	) => Promise<{ status: number; json: unknown }>;
	configPath?: string;
	trustPath?: string;
	installFn?: (opts: InstallOptions) => Promise<InstallResult>;
}

export async function join(
	opts: {
		url: string;
	},
	deps: JoinDeps = {},
): Promise<{ handle: string; agentId: string; relayUrl: string }> {
	const post = deps.httpPost ?? defaultHttpPost;
	const path = deps.configPath ?? configPath();
	const trustFilePath = deps.trustPath ?? trustPath();
	const runInstall = deps.installFn ?? install;
	const { relayUrl, token } = parseInviteUrl(opts.url);
	const payload = decodeInvitePayload(token);
	const url = `${relayUrl}/invites/${encodeURIComponent(payload.jti)}/redeem`;

	const res = await post(
		url,
		{ token },
		{
			"content-type": "application/json",
		},
	);
	if (res.status < 200 || res.status >= 300) {
		throw new Error(relayErrorMessage(res.status, res.json));
	}
	const parsed = adminAgentResponseSchema.parse(res.json);

	const config: AgentRelayConfig = {
		relay_url: relayUrl,
		agent_handle: parsed.handle,
		agent_id: parsed.agent_id,
		api_key: parsed.api_key,
		default_session_id: null,
	};
	await writeSecretFile(path, `${JSON.stringify(config, null, 2)}\n`);

	const trust = await readOrFallback(trustFilePath);
	const nextTrust = setTeammate(trust, payload.inviter_handle, {});
	await writeSecretFile(trustFilePath, serializeTrust(nextTrust));

	await runInstall({ client: "all", overwrite: false });

	return { handle: parsed.handle, agentId: parsed.agent_id, relayUrl };
}

export interface InstallOptions {
	client: SupportedClient | "all";
	overwrite: boolean;
}

export interface InstallDeps {
	readSettings?: (path: string) => Promise<string | undefined>;
	writeSettings?: (path: string, content: string) => Promise<void>;
	clientPaths?: typeof clientPaths;
	mcpPath?: typeof mcpPath;
	trustPath?: string;
	writeTrust?: (path: string, content: string) => Promise<void>;
	trustExists?: (path: string) => Promise<boolean>;
}

export type ClientInstallReport =
	| {
			client: "claude-code";
			// Where the permission overlay was written.
			path: string;
			// Where the MCP server entry was written (Claude Code reads from a
			// different file than the permission overlay).
			mcpPath: string;
			format: "json";
			report: MergeReport;
			written: boolean;
	  }
	| { client: "codex"; path: string; format: "toml"; report: TomlMergeReport; written: boolean };

export interface InstallResult {
	clients: ClientInstallReport[];
	trustCreated: boolean;
}

export async function install(
	opts: InstallOptions,
	deps: InstallDeps = {},
): Promise<InstallResult> {
	const readSettings = deps.readSettings ?? defaultReadSettings;
	const writeSettings = deps.writeSettings ?? ((path, content) => writeSecretFile(path, content));
	const resolvePaths = deps.clientPaths ?? clientPaths;
	const resolveMcpPath = deps.mcpPath ?? mcpPath;
	const trustFilePath = deps.trustPath ?? trustPath();
	const writeTrust = deps.writeTrust ?? ((path, content) => writeSecretFile(path, content));
	const trustExists = deps.trustExists ?? defaultExists;

	const clients: SupportedClient[] =
		opts.client === "all" ? ["claude-code", "codex"] : [opts.client];
	const out: InstallResult = { clients: [], trustCreated: false };

	for (const c of clients) {
		if (c === "claude-code") {
			// Claude Code reads MCP entries from `~/.claude.json` (user-scope) and
			// permission overlay from `~/.claude/settings.json`. Two different
			// files — write each side separately. (Issue #1: writing the MCP entry
			// to settings.json is the bug we're fixing.)
			const overlayPath = resolvePaths(c).settingsPath;
			const claudeJsonPath = resolveMcpPath(c);

			// 1) MCP entry → ~/.claude.json
			const rawJson = await readSettings(claudeJsonPath);
			const currentJson = rawJson === undefined ? {} : JSON.parse(rawJson);
			const mcpResult = mergeClaudeJsonMcp(currentJson, { overwriteMcp: opts.overwrite });
			if (mcpResult.mcpServerAdded || mcpResult.mcpServerOverwritten) {
				await writeSettings(claudeJsonPath, `${JSON.stringify(mcpResult.next, null, 2)}\n`);
			}

			// 2) Permission overlay → ~/.claude/settings.json
			const rawOverlay = await readSettings(overlayPath);
			const currentOverlay = rawOverlay === undefined ? {} : JSON.parse(rawOverlay);
			const overlayResult = mergeClaudeOverlay(currentOverlay, {
				overwritePermissions: opts.overwrite,
			});
			const overlayHasChanges = Object.values(overlayResult.permissionsAdded).some(
				(arr) => arr.length > 0,
			);
			if (overlayHasChanges) {
				await writeSettings(overlayPath, `${JSON.stringify(overlayResult.next, null, 2)}\n`);
			}

			// Synthesize a MergeReport-compatible report so summarizeInstall +
			// existing render logic keep working.
			const report: MergeReport = {
				mcpServerAdded: mcpResult.mcpServerAdded,
				mcpServerOverwritten: mcpResult.mcpServerOverwritten,
				permissionsAdded: overlayResult.permissionsAdded,
				permissionsRemovedFromOtherBuckets: overlayResult.permissionsRemovedFromOtherBuckets,
			};
			const written =
				mcpResult.mcpServerAdded || mcpResult.mcpServerOverwritten || overlayHasChanges;
			out.clients.push({
				client: "claude-code",
				path: overlayPath,
				mcpPath: claudeJsonPath,
				format: "json",
				report,
				written,
			});
		} else {
			const { settingsPath } = resolvePaths(c);
			const raw = await readSettings(settingsPath);
			const { tomlText, report } = mergeCodexSettings(raw, {
				overwriteMcp: opts.overwrite,
				overwritePermissions: opts.overwrite,
			});
			const changed =
				report.mcpServerAdded ||
				report.mcpServerOverwritten ||
				Object.values(report.permissionsAdded).some((arr) => arr.length > 0);
			if (changed) {
				await writeSettings(settingsPath, tomlText.endsWith("\n") ? tomlText : `${tomlText}\n`);
			}
			out.clients.push({
				client: "codex",
				path: settingsPath,
				format: "toml",
				report,
				written: changed,
			});
		}
	}

	if (!(await trustExists(trustFilePath))) {
		await writeTrust(trustFilePath, serializeTrust(FALLBACK_TRUST));
		out.trustCreated = true;
	}

	return out;
}

export function summarizeInstall(result: InstallResult): string {
	const parts: string[] = [];
	for (const c of result.clients) {
		parts.push(`[${c.client}] ${c.path}`);
		parts.push(c.format === "json" ? renderMergeReport(c.report) : renderTomlMergeReport(c.report));
		parts.push(c.written ? "  → wrote settings" : "  → no changes");
	}
	parts.push(
		result.trustCreated
			? "[trust] created default ~/.agentrelay/trust.yaml"
			: "[trust] file already present",
	);
	return parts.join("\n");
}

export interface DoctorReport {
	configPresent: boolean;
	configPath: string;
	relayReachable: boolean | "skipped";
	apiKeyValid: boolean | "skipped";
	mcpEntryPresent: Record<string, boolean>;
	overlayApplied: Record<string, boolean>;
	trustParseable: boolean;
	trustPath: string;
	notes: string[];
}

export interface DoctorDeps {
	readSettings?: (path: string) => Promise<string | undefined>;
	clientPaths?: typeof clientPaths;
	whoami?: (relay: string, apiKey: string) => Promise<boolean>;
}

export async function doctor(
	deps: DoctorDeps & { mcpPath?: typeof mcpPath } = {},
): Promise<DoctorReport> {
	const readSettings = deps.readSettings ?? defaultReadSettings;
	const resolvePaths = deps.clientPaths ?? clientPaths;
	const resolveMcpPath = deps.mcpPath ?? mcpPath;
	const whoami = deps.whoami ?? defaultWhoami;

	const cfg = await loadConfig();
	const trust = await loadTrust();

	const report: DoctorReport = {
		configPresent: cfg.ok,
		configPath: cfg.path,
		relayReachable: cfg.ok ? false : "skipped",
		apiKeyValid: cfg.ok ? false : "skipped",
		mcpEntryPresent: {},
		overlayApplied: {},
		trustParseable: trust.ok,
		trustPath: trust.path,
		notes: [],
	};

	if (cfg.ok) {
		try {
			const ok = await whoami(cfg.config.relay_url, cfg.config.api_key);
			report.relayReachable = true;
			report.apiKeyValid = ok;
			if (!ok) {
				// Most common cause we hit during local dev: someone restarted the
				// relay with a freshly-generated `RELAY_PEPPER` (e.g. via `openssl
				// rand`), so the relay can no longer verify keys hashed with the
				// old pepper. The key isn't "revoked" — it just hashes differently.
				// Surface this explicitly so users don't go hunting for the wrong
				// thing first.
				report.notes.push(
					"API key rejected by relay. Likely causes (in order):\n" +
						"  1. Relay's RELAY_PEPPER changed since you registered (use a stable\n" +
						"     env file across restarts, then re-register).\n" +
						"  2. Your key was rotated or revoked — check the relay's api_keys table.\n" +
						"  3. relay_url in ~/.agentrelay/config.json points at a different relay\n" +
						"     than the one verifying you now.",
				);
			}
		} catch (err) {
			report.notes.push(`relay unreachable: ${err instanceof Error ? err.message : String(err)}`);
		}
	} else {
		report.notes.push(`config: ${cfg.reason}`);
	}

	for (const client of ["claude-code", "codex"] as const) {
		const { settingsPath, format } = resolvePaths(client);
		const mcpFilePath = resolveMcpPath(client);

		// MCP entry — for claude-code this is in ~/.claude.json (NOT settings.json).
		// For codex it's the same file as the overlay so we read it once below.
		if (mcpFilePath === settingsPath) {
			report.mcpEntryPresent[client] = false; // filled in by overlay block below
		} else {
			const rawMcp = await readSettings(mcpFilePath);
			if (!rawMcp) {
				report.mcpEntryPresent[client] = false;
			} else {
				try {
					const mcpJson = JSON.parse(rawMcp) as Record<string, Record<string, unknown> | undefined>;
					report.mcpEntryPresent[client] = Boolean(mcpJson?.mcpServers?.agentrelay);
				} catch {
					report.notes.push(`${client} mcp config (${mcpFilePath}) is malformed`);
					report.mcpEntryPresent[client] = false;
				}
			}
		}

		// Overlay (permissions) — always lives in `settingsPath`.
		const raw = await readSettings(settingsPath);
		if (!raw) {
			if (mcpFilePath === settingsPath) {
				report.mcpEntryPresent[client] = false;
			}
			report.overlayApplied[client] = false;
			continue;
		}
		try {
			const settings = format === "json" ? JSON.parse(raw) : (await import("smol-toml")).parse(raw);
			if (mcpFilePath === settingsPath) {
				const mcpKey = format === "json" ? "mcpServers" : "mcp_servers";
				report.mcpEntryPresent[client] = Boolean(
					(settings as Record<string, Record<string, unknown>>)?.[mcpKey]?.agentrelay,
				);
			}
			const allowList: string[] =
				((settings as Record<string, Record<string, unknown>>)?.permissions?.allow as string[]) ??
				[];
			report.overlayApplied[client] = allowList.includes("mcp__agentrelay__*");
		} catch {
			report.notes.push(`${client} settings file is malformed`);
			if (mcpFilePath === settingsPath) {
				report.mcpEntryPresent[client] = false;
			}
			report.overlayApplied[client] = false;
		}
	}

	if (!trust.ok) {
		report.notes.push(`trust.yaml: ${trust.reason}`);
	}

	return report;
}

/**
 * Remediation commands a user can copy-paste to fix a MISSING / BROKEN
 * doctor check. Pure mapping — no I/O. `command` is the rendered hint, and
 * `auto` controls whether `doctor --fix` can safely run it in-process.
 */
export type RemediationKind =
	| { type: "config-missing" }
	| { type: "mcp-missing"; client: string }
	| { type: "overlay-missing"; client: string }
	| { type: "trust-broken" };

export interface Remediation {
	command: string;
	auto: boolean;
}

export function remediationFor(kind: RemediationKind): Remediation {
	switch (kind.type) {
		case "config-missing":
			return {
				command:
					'agentrelay register --relay <url> --admin-token <token> --handle <you>@<team> --email <you>@example.com --name "<Your Name>" --role <role>',
				auto: false,
			};
		case "mcp-missing":
			return { command: `agentrelay install --client ${kind.client}`, auto: true };
		case "overlay-missing":
			return { command: `agentrelay install --client ${kind.client}`, auto: true };
		case "trust-broken":
			return {
				command: "rm ~/.agentrelay/trust.yaml && agentrelay install --client all",
				auto: false,
			};
	}
}

export function doctorReportToJson(r: DoctorReport): string {
	return JSON.stringify(r, null, 2);
}

export interface DoctorFixResult {
	before: DoctorReport;
	after: DoctorReport;
	fixed: Array<{ kind: RemediationKind; command: string }>;
	skippedManual: Array<{ kind: RemediationKind; command: string }>;
}

export interface DoctorFixDeps extends DoctorDeps {
	mcpPath?: typeof mcpPath;
	install?: (opts: InstallOptions) => Promise<InstallResult>;
}

export async function doctorFix(deps: DoctorFixDeps = {}): Promise<DoctorFixResult> {
	const installFn = deps.install ?? install;
	const before = await doctor(deps);
	const fixed: DoctorFixResult["fixed"] = [];
	const skippedManual: DoctorFixResult["skippedManual"] = [];
	const installedClients = new Set<SupportedClient>();

	const handleRemediation = async (kind: RemediationKind): Promise<void> => {
		const remediation = remediationFor(kind);
		if (!remediation.auto) {
			skippedManual.push({ kind, command: remediation.command });
			return;
		}

		if (
			(kind.type === "mcp-missing" || kind.type === "overlay-missing") &&
			isSupportedClient(kind.client)
		) {
			if (!installedClients.has(kind.client)) {
				await installFn({ client: kind.client, overwrite: false });
				installedClients.add(kind.client);
				fixed.push({ kind, command: remediation.command });
			}
		}
	};

	if (!before.configPresent) {
		await handleRemediation({ type: "config-missing" });
	}
	for (const [client, present] of Object.entries(before.mcpEntryPresent)) {
		if (!present) {
			await handleRemediation({ type: "mcp-missing", client });
		}
	}
	for (const [client, applied] of Object.entries(before.overlayApplied)) {
		if (!applied) {
			await handleRemediation({ type: "overlay-missing", client });
		}
	}
	if (!before.trustParseable) {
		await handleRemediation({ type: "trust-broken" });
	}

	const after = await doctor(deps);
	return { before, after, fixed, skippedManual };
}

export function doctorHasMissing(r: DoctorReport): boolean {
	return (
		!r.configPresent ||
		Object.values(r.mcpEntryPresent).some((present) => !present) ||
		Object.values(r.overlayApplied).some((applied) => !applied) ||
		!r.trustParseable ||
		r.relayReachable === false ||
		r.apiKeyValid === false
	);
}

export function formatDoctor(report: DoctorReport): string {
	const renderLine = (label: string, ok: boolean, kind: RemediationKind, suffix = ""): string => {
		const status = ok ? "OK" : "MISSING";
		const hint = ok ? "" : `  → run: ${remediationFor(kind).command}`;
		return `${label}${status}${suffix}${hint}`;
	};

	const lines: string[] = [
		renderLine(
			"config:           ",
			report.configPresent,
			{ type: "config-missing" },
			`  (${report.configPath})`,
		),
		`relay reachable:  ${formatTri(report.relayReachable)}`,
		`api key valid:    ${formatTri(report.apiKeyValid)}`,
	];
	for (const [k, v] of Object.entries(report.mcpEntryPresent)) {
		lines.push(renderLine(`mcp[${k}]:        `, v, { type: "mcp-missing", client: k }));
	}
	for (const [k, v] of Object.entries(report.overlayApplied)) {
		lines.push(renderLine(`overlay[${k}]:    `, v, { type: "overlay-missing", client: k }));
	}
	const trustLabel = `trust.yaml:       ${report.trustParseable ? "OK" : "BROKEN"}  (${report.trustPath})`;
	lines.push(
		report.trustParseable
			? trustLabel
			: `${trustLabel}  → run: ${remediationFor({ type: "trust-broken" }).command}`,
	);
	for (const note of report.notes) lines.push(`  note: ${note}`);
	return lines.join("\n");
}

function isSupportedClient(client: string): client is SupportedClient {
	return client === "claude-code" || client === "codex";
}

export interface MutateTrustDeps {
	readTrust?: () => Promise<TrustFile>;
	writeTrust?: (file: TrustFile) => Promise<void>;
}

async function readOrFallback(path: string): Promise<TrustFile> {
	try {
		const raw = await readFile(path, "utf8");
		const parsed = yaml.load(raw, { schema: yaml.JSON_SCHEMA });
		if (parsed && typeof parsed === "object") return parsed as TrustFile;
	} catch {
		// fall through
	}
	return JSON.parse(JSON.stringify(FALLBACK_TRUST)) as TrustFile;
}

function defaultMutateDeps(): Required<MutateTrustDeps> {
	const path = trustPath();
	return {
		readTrust: () => readOrFallback(path),
		writeTrust: async (file) => {
			await writeSecretFile(path, serializeTrust(file));
		},
	};
}

export async function blockCmd(handle: string, deps: MutateTrustDeps = {}): Promise<boolean> {
	const d = { ...defaultMutateDeps(), ...deps };
	const file = await d.readTrust();
	const { next, changed } = blockTeammate(file, handle);
	if (changed) await d.writeTrust(next);
	return changed;
}

export async function unblockCmd(handle: string, deps: MutateTrustDeps = {}): Promise<boolean> {
	const d = { ...defaultMutateDeps(), ...deps };
	const file = await d.readTrust();
	const { next, changed } = unblockTeammate(file, handle);
	if (changed) await d.writeTrust(next);
	return changed;
}

export async function trustSetCmd(
	handle: string,
	update: TrustSetUpdate,
	deps: MutateTrustDeps = {},
): Promise<TrustFile> {
	const d = { ...defaultMutateDeps(), ...deps };
	const file = await d.readTrust();
	const next = setTeammate(file, handle, update);
	await d.writeTrust(next);
	return next;
}

export async function trustResetCmd(handle: string, deps: MutateTrustDeps = {}): Promise<boolean> {
	const d = { ...defaultMutateDeps(), ...deps };
	const file = await d.readTrust();
	const { next, changed } = resetTeammate(file, handle);
	if (changed) await d.writeTrust(next);
	return changed;
}

// ---------- rotate-key ----------

const rotateKeyResponseSchema = z.object({
	agent_id: z.string(),
	api_key: z.string(),
	key_id: z.string(),
});

export interface RotateKeyResult {
	agent_id: string;
	key_id: string;
	configPath: string;
}

export interface RotateKeyDeps {
	httpPost?: (
		url: string,
		body: unknown,
		headers: Record<string, string>,
	) => Promise<{ status: number; json: unknown }>;
	configPath?: string;
	loadConfig?: () => Promise<AgentRelayConfig>;
}

/**
 * Rotate the local agent's API key. Two-phase:
 *   1. POST /agents/me/keys/rotate with the *current* bearer.
 *   2. On success, atomically rewrite ~/.agentrelay/config.json with the
 *      new api_key (writeSecretFile = tempfile + rename + 0600).
 *
 * On any error before step 2 succeeds, the on-disk config is untouched —
 * the user can retry with the same bearer. If step 2 fails after step 1
 * succeeds, we surface the new key in the thrown error so the user can
 * recover manually rather than losing access.
 */
export async function rotateKey(deps: RotateKeyDeps = {}): Promise<RotateKeyResult> {
	const post = deps.httpPost ?? defaultHttpPost;
	const path = deps.configPath ?? configPath();
	const cfg = deps.loadConfig ? await deps.loadConfig() : await loadConfigOrThrow(path);

	const url = `${stripTrailing(cfg.relay_url)}/agents/me/keys/rotate`;
	const headers = {
		"content-type": "application/json",
		authorization: `Bearer ${cfg.api_key}`,
	};
	const res = await post(url, {}, headers);
	if (res.status >= 400) {
		throw new Error(
			`rotate-key: relay returned ${res.status} — config left untouched (${shortBody(res.json)})`,
		);
	}
	const parsed = rotateKeyResponseSchema.parse(res.json);

	const updated: AgentRelayConfig = { ...cfg, api_key: parsed.api_key };
	try {
		await writeSecretFile(path, `${JSON.stringify(updated, null, 2)}\n`);
	} catch (err) {
		throw new Error(
			`rotate-key: relay accepted the rotation but writing ${path} failed: ${
				err instanceof Error ? err.message : String(err)
			}. Your NEW api_key is: ${parsed.api_key} — save it manually before retrying.`,
		);
	}
	logger.info({ path, key_id: parsed.key_id }, "rotated api key");
	return { agent_id: parsed.agent_id, key_id: parsed.key_id, configPath: path };
}

// ---------- audit ----------

export const auditEventSchema = z.object({
	timestamp: z.string(),
	actor_handle: z.string(),
	action: z.string(),
	resource_type: z.string(),
	resource_id: z.string().optional(),
	request_id: z.string().optional(),
	metadata: z.record(z.string(), z.unknown()).optional(),
});

const auditResponseSchema = z.object({
	events: z.array(auditEventSchema),
});

export type AuditEvent = z.infer<typeof auditEventSchema>;

export interface AuditFilters {
	since?: string;
	from?: string;
	action?: string;
	limit?: number;
}

export interface AuditDeps {
	httpGet?: (
		url: string,
		headers: Record<string, string>,
	) => Promise<{ status: number; json: unknown }>;
	loadConfig?: () => Promise<AgentRelayConfig>;
	configPath?: string;
}

const MAX_AUDIT_LIMIT = 1000;
const DEFAULT_AUDIT_LIMIT = 100;

export async function fetchAudit(
	filters: AuditFilters = {},
	deps: AuditDeps = {},
): Promise<AuditEvent[]> {
	const get = deps.httpGet ?? defaultHttpGet;
	const cfg = deps.loadConfig
		? await deps.loadConfig()
		: await loadConfigOrThrow(deps.configPath ?? configPath());

	const limit = Math.min(filters.limit ?? DEFAULT_AUDIT_LIMIT, MAX_AUDIT_LIMIT);
	const params = new URLSearchParams();
	if (filters.since) params.set("since", filters.since);
	if (filters.from) params.set("from", filters.from);
	if (filters.action) params.set("action", filters.action);
	params.set("limit", String(limit));

	const url = `${stripTrailing(cfg.relay_url)}/agents/me/audit?${params.toString()}`;
	const headers = { authorization: `Bearer ${cfg.api_key}` };
	const res = await get(url, headers);
	if (res.status >= 400) {
		throw new Error(`audit: relay returned ${res.status} (${shortBody(res.json)})`);
	}
	const parsed = auditResponseSchema.parse(res.json);
	return parsed.events;
}

export type AuditFormat = "tsv" | "jsonl";

/**
 * Pure renderer. lld §5.5 — TSV when stdout is a TTY (humans),
 * JSON-lines otherwise (pipelines, log shippers). The bin script picks
 * the format from `process.stdout.isTTY`.
 */
export function renderAudit(events: AuditEvent[], format: AuditFormat): string {
	if (format === "jsonl") {
		return events.map((e) => JSON.stringify(e)).join("\n");
	}
	const header = ["timestamp", "handoff_id", "from", "action", "details"].join("\t");
	const rows = events.map((e) => {
		const handoff = e.resource_type === "handoff" && e.resource_id ? e.resource_id : "";
		const details = formatAuditDetails(e);
		return [e.timestamp, handoff, e.actor_handle, e.action, details].join("\t");
	});
	return [header, ...rows].join("\n");
}

function formatAuditDetails(e: AuditEvent): string {
	if (!e.metadata)
		return e.resource_type === "handoff"
			? ""
			: `${e.resource_type}${e.resource_id ? ` ${e.resource_id}` : ""}`;
	const pairs = Object.entries(e.metadata).map(([k, v]) => {
		const rendered = typeof v === "string" ? v : JSON.stringify(v);
		return `${k}=${rendered}`;
	});
	return pairs.join(" ");
}

async function loadConfigOrThrow(_path: string): Promise<AgentRelayConfig> {
	const cfg = await loadConfig();
	if (!cfg.ok) {
		throw new Error(
			`agentrelay config unavailable (${cfg.reason}). Run \`agentrelay register\` first.`,
		);
	}
	return cfg.config;
}

function shortBody(json: unknown): string {
	const s = typeof json === "string" ? json : JSON.stringify(json);
	return s.length > 200 ? `${s.slice(0, 200)}…` : s;
}

function relayErrorMessage(status: number, json: unknown): string {
	if (json && typeof json === "object" && !Array.isArray(json)) {
		const body = json as Record<string, unknown>;
		if (typeof body.message === "string") return body.message;
		if (typeof body.error === "string") return body.error;
	}
	return `relay returned ${status}`;
}

function parseInviteUrl(value: string): { relayUrl: string; token: string } {
	const hashIndex = value.indexOf("#");
	if (hashIndex <= 0 || hashIndex === value.length - 1) {
		throw new Error("invalid invite URL");
	}

	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		throw new Error("invalid invite URL");
	}

	const token = value.slice(hashIndex + 1);
	parsed.hash = "";
	stripJoinLandingPath(parsed);
	const relayUrl = stripTrailing(parsed.toString());
	if (!relayUrl) {
		throw new Error("invalid invite URL");
	}
	return { relayUrl, token };
}

function stripJoinLandingPath(url: URL): void {
	const normalizedPath = url.pathname.replace(/\/+$/, "");
	if (normalizedPath === "/join" || normalizedPath.endsWith("/join")) {
		const relayPath = normalizedPath.slice(0, -"/join".length);
		url.pathname = relayPath.length > 0 ? relayPath : "/";
	}
}

function decodeInvitePayload(token: string): { jti: string; inviter_handle: string } {
	const parts = token.split(".");
	const encodedPayload = parts[1];
	if (parts.length !== 3 || !encodedPayload) {
		throw new Error("malformed invite token");
	}

	try {
		const payloadJson: unknown = JSON.parse(
			Buffer.from(encodedPayload, "base64url").toString("utf8"),
		);
		const parsed = inviteTokenPayloadSchema.safeParse(payloadJson);
		if (!parsed.success) {
			throw new Error("invalid payload");
		}
		return {
			jti: parsed.data.jti,
			inviter_handle: parsed.data.inviter_handle,
		};
	} catch {
		throw new Error("malformed invite token");
	}
}

// ---------- defaults ----------

async function defaultReadSettings(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, "utf8");
	} catch {
		return undefined;
	}
}

async function defaultExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

async function defaultHttpPost(
	url: string,
	body: unknown,
	headers: Record<string, string>,
): Promise<{ status: number; json: unknown }> {
	const res = await undiciRequest(url, {
		method: "POST",
		headers,
		body: JSON.stringify(body),
	});
	const text = await res.body.text();
	let json: unknown;
	try {
		json = text.length > 0 ? JSON.parse(text) : undefined;
	} catch {
		json = { raw: text };
	}
	return { status: res.statusCode, json };
}

async function defaultWhoami(relay: string, apiKey: string): Promise<boolean> {
	const res = await undiciRequest(`${stripTrailing(relay)}/agents/me`, {
		method: "GET",
		headers: { authorization: `Bearer ${apiKey}` },
	});
	await res.body.dump();
	return res.statusCode >= 200 && res.statusCode < 300;
}

async function defaultHttpGet(
	url: string,
	headers: Record<string, string>,
): Promise<{ status: number; json: unknown }> {
	const res = await undiciRequest(url, { method: "GET", headers });
	const text = await res.body.text();
	let json: unknown;
	try {
		json = text.length > 0 ? JSON.parse(text) : undefined;
	} catch {
		json = { raw: text };
	}
	return { status: res.statusCode, json };
}

function stripTrailing(s: string): string {
	return s.endsWith("/") ? s.slice(0, -1) : s;
}

function formatTri(v: boolean | "skipped"): string {
	if (v === "skipped") return "SKIPPED";
	return v ? "OK" : "FAIL";
}
