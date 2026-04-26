/**
 * Command implementations for `agentrelay`. Each command takes its
 * dependencies as parameters so they're directly testable; the bin script
 * supplies the real ones.
 */

import { readFile, stat } from "node:fs/promises";
import yaml from "js-yaml";
import { request as undiciRequest } from "undici";
import { z } from "zod";
import { loadConfig, type AgentRelayConfig } from "../config.js";
import { logger } from "../logger.js";
import { FALLBACK_TRUST, loadTrust, type TrustFile } from "../trust.js";
import { writeSecretFile } from "./io.js";
import { configPath, trustPath, clientPaths, type SupportedClient } from "./paths.js";
import {
	mergeClaudeSettings,
	renderMergeReport,
	type MergeOptions,
	type MergeReport,
} from "./install.js";
import {
	mergeCodexSettings,
	renderTomlMergeReport,
	type TomlMergeReport,
} from "./install-toml.js";
import {
	blockTeammate,
	resetTeammate,
	serializeTrust,
	setTeammate,
	unblockTeammate,
	type TrustSetUpdate,
} from "./trust-mutate.js";

const adminAgentResponseSchema = z.object({
	// Relay's POST /admin/agents response uses `agent_id` (lld §3.3).
	agent_id: z.string(),
	handle: z.string(),
	api_key: z.string(),
});

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
	httpPost?: (url: string, body: unknown, headers: Record<string, string>) => Promise<{ status: number; json: unknown }>;
	configPath?: string;
}

export async function register(opts: RegisterOptions, deps: RegisterDeps = {}): Promise<AgentRelayConfig> {
	const post = deps.httpPost ?? defaultHttpPost;
	const path = deps.configPath ?? configPath();
	const url = `${stripTrailing(opts.relay)}/admin/agents`;
	const headers: Record<string, string> = { "content-type": "application/json" };
	if (opts.adminToken) headers.authorization = `Bearer ${opts.adminToken}`;

	const res = await post(url, {
		handle: opts.handle,
		email: opts.email,
		// Relay's schema names this field display_name (lld §3.3 / §2.1).
		display_name: opts.name,
		role: opts.role,
	}, headers);
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
	await writeSecretFile(path, JSON.stringify(config, null, 2) + "\n");
	logger.info({ path }, "wrote ~/.agentrelay/config.json (mode 0600)");
	return config;
}

export interface InstallOptions {
	client: SupportedClient | "all";
	overwrite: boolean;
}

export interface InstallDeps {
	readSettings?: (path: string) => Promise<string | undefined>;
	writeSettings?: (path: string, content: string) => Promise<void>;
	clientPaths?: typeof clientPaths;
	trustPath?: string;
	writeTrust?: (path: string, content: string) => Promise<void>;
	trustExists?: (path: string) => Promise<boolean>;
}

export type ClientInstallReport =
	| { client: "claude-code"; path: string; format: "json"; report: MergeReport; written: boolean }
	| { client: "codex"; path: string; format: "toml"; report: TomlMergeReport; written: boolean };

export interface InstallResult {
	clients: ClientInstallReport[];
	trustCreated: boolean;
}

export async function install(opts: InstallOptions, deps: InstallDeps = {}): Promise<InstallResult> {
	const readSettings = deps.readSettings ?? defaultReadSettings;
	const writeSettings = deps.writeSettings ?? ((path, content) => writeSecretFile(path, content));
	const resolvePaths = deps.clientPaths ?? clientPaths;
	const trustFilePath = deps.trustPath ?? trustPath();
	const writeTrust = deps.writeTrust ?? ((path, content) => writeSecretFile(path, content));
	const trustExists = deps.trustExists ?? defaultExists;

	const clients: SupportedClient[] = opts.client === "all" ? ["claude-code", "codex"] : [opts.client];
	const out: InstallResult = { clients: [], trustCreated: false };

	for (const c of clients) {
		const { settingsPath, format } = resolvePaths(c);
		if (format === "json") {
			const raw = await readSettings(settingsPath);
			const current = raw === undefined ? {} : JSON.parse(raw);
			const mergeOpts: MergeOptions = {
				overwriteMcp: opts.overwrite,
				overwritePermissions: opts.overwrite,
			};
			const { next, report } = mergeClaudeSettings(current, mergeOpts);
			const changed =
				report.mcpServerAdded ||
				report.mcpServerOverwritten ||
				Object.values(report.permissionsAdded).some((arr) => arr.length > 0);
			if (changed) {
				await writeSettings(settingsPath, JSON.stringify(next, null, 2) + "\n");
			}
			out.clients.push({ client: "claude-code", path: settingsPath, format: "json", report, written: changed });
		} else {
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
				await writeSettings(settingsPath, tomlText.endsWith("\n") ? tomlText : tomlText + "\n");
			}
			out.clients.push({ client: "codex", path: settingsPath, format: "toml", report, written: changed });
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
	parts.push(result.trustCreated ? "[trust] created default ~/.agentrelay/trust.yaml" : "[trust] file already present");
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

export async function doctor(deps: DoctorDeps = {}): Promise<DoctorReport> {
	const readSettings = deps.readSettings ?? defaultReadSettings;
	const resolvePaths = deps.clientPaths ?? clientPaths;
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
			if (!ok) report.notes.push("API key rejected by relay /whoami");
		} catch (err) {
			report.notes.push(`relay unreachable: ${err instanceof Error ? err.message : String(err)}`);
		}
	} else {
		report.notes.push(`config: ${cfg.reason}`);
	}

	for (const client of ["claude-code", "codex"] as const) {
		const { settingsPath, format } = resolvePaths(client);
		const raw = await readSettings(settingsPath);
		if (!raw) {
			report.mcpEntryPresent[client] = false;
			report.overlayApplied[client] = false;
			continue;
		}
		try {
			const settings =
				format === "json" ? JSON.parse(raw) : (await import("smol-toml")).parse(raw);
			const mcpKey = format === "json" ? "mcpServers" : "mcp_servers";
			report.mcpEntryPresent[client] = Boolean(
				(settings as Record<string, Record<string, unknown>>)?.[mcpKey]?.agentrelay,
			);
			const allowList: string[] =
				(settings as Record<string, Record<string, unknown>>)?.permissions?.allow as string[] ?? [];
			report.overlayApplied[client] = allowList.includes("mcp__agentrelay__*");
		} catch {
			report.notes.push(`${client} settings file is malformed`);
			report.mcpEntryPresent[client] = false;
			report.overlayApplied[client] = false;
		}
	}

	if (!trust.ok) {
		report.notes.push(`trust.yaml: ${trust.reason}`);
	}

	return report;
}

export function formatDoctor(report: DoctorReport): string {
	const lines: string[] = [
		`config:           ${report.configPresent ? "OK" : "MISSING"}  (${report.configPath})`,
		`relay reachable:  ${formatTri(report.relayReachable)}`,
		`api key valid:    ${formatTri(report.apiKeyValid)}`,
	];
	for (const [k, v] of Object.entries(report.mcpEntryPresent)) {
		lines.push(`mcp[${k}]:        ${v ? "OK" : "MISSING"}`);
	}
	for (const [k, v] of Object.entries(report.overlayApplied)) {
		lines.push(`overlay[${k}]:    ${v ? "OK" : "MISSING"}`);
	}
	lines.push(`trust.yaml:       ${report.trustParseable ? "OK" : "BROKEN"}  (${report.trustPath})`);
	for (const note of report.notes) lines.push(`  note: ${note}`);
	return lines.join("\n");
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
	httpPost?: (url: string, body: unknown, headers: Record<string, string>) => Promise<{ status: number; json: unknown }>;
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
	const cfg = deps.loadConfig
		? await deps.loadConfig()
		: await loadConfigOrThrow(path);

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
		await writeSecretFile(path, JSON.stringify(updated, null, 2) + "\n");
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
	httpGet?: (url: string, headers: Record<string, string>) => Promise<{ status: number; json: unknown }>;
	loadConfig?: () => Promise<AgentRelayConfig>;
	configPath?: string;
}

const MAX_AUDIT_LIMIT = 1000;
const DEFAULT_AUDIT_LIMIT = 100;

export async function fetchAudit(filters: AuditFilters = {}, deps: AuditDeps = {}): Promise<AuditEvent[]> {
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
	if (!e.metadata) return e.resource_type === "handoff" ? "" : `${e.resource_type}${e.resource_id ? ` ${e.resource_id}` : ""}`;
	const pairs = Object.entries(e.metadata).map(([k, v]) => {
		const rendered = typeof v === "string" ? v : JSON.stringify(v);
		return `${k}=${rendered}`;
	});
	return pairs.join(" ");
}

async function loadConfigOrThrow(_path: string): Promise<AgentRelayConfig> {
	const cfg = await loadConfig();
	if (!cfg.ok) {
		throw new Error(`agentrelay config unavailable (${cfg.reason}). Run \`agentrelay register\` first.`);
	}
	return cfg.config;
}

function shortBody(json: unknown): string {
	const s = typeof json === "string" ? json : JSON.stringify(json);
	return s.length > 200 ? s.slice(0, 200) + "…" : s;
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
