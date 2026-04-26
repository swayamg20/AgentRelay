#!/usr/bin/env node
/**
 * `agentrelay` CLI entry point. Per docs/lld.md §5. Each subcommand
 * delegates to a pure function in src/cli/commands.ts so behaviour is
 * exercised directly by the test suite.
 */

import { cac } from "cac";
import { logger } from "../logger.js";
import {
	blockCmd,
	doctor,
	fetchAudit,
	formatDoctor,
	install,
	register,
	renderAudit,
	rotateKey,
	summarizeInstall,
	trustResetCmd,
	trustSetCmd,
	unblockCmd,
} from "../cli/commands.js";
import { listTrust } from "../cli/trust-mutate.js";
import { loadTrust, FALLBACK_TRUST } from "../trust.js";

const cli = cac("agentrelay");

cli
	.command("register", "Register this developer with a relay and persist credentials")
	.option("--relay <url>", "Relay base URL")
	.option("--admin-token <token>", "Admin token (only for first registration)")
	.option("--handle <handle>", "Your handle, e.g. frank@acme")
	.option("--email <email>", "Your email")
	.option("--name <name>", "Display name")
	.option("--role <role>", "Role (e.g. backend, frontend)")
	.action(async (opts: Record<string, unknown>) => {
		const required = ["relay", "handle", "email", "name", "role"] as const;
		for (const k of required) {
			if (!opts[k] || typeof opts[k] !== "string") {
				process.stderr.write(`agentrelay register: --${k} is required\n`);
				process.exit(2);
			}
		}
		const cfg = await register({
			relay: opts.relay as string,
			handle: opts.handle as string,
			email: opts.email as string,
			name: opts.name as string,
			role: opts.role as string,
			// cac auto-camelCases dashed flags: --admin-token → opts.adminToken
			adminToken: opts.adminToken as string | undefined,
		});
		process.stdout.write(`registered ${cfg.agent_handle} (id ${cfg.agent_id})\n`);
	});

cli
	.command("install", "Write the MCP entry + recommended permission overlay")
	.option("--client <name>", "claude-code | codex | all", { default: "claude-code" })
	.option("--overwrite", "Overwrite existing entries without prompting", { default: false })
	.action(async (opts: Record<string, unknown>) => {
		const client = opts.client as string;
		if (!["claude-code", "codex", "all"].includes(client)) {
			process.stderr.write(`agentrelay install: invalid --client ${client}\n`);
			process.exit(2);
		}
		const result = await install({
			client: client as "claude-code" | "codex" | "all",
			overwrite: Boolean(opts.overwrite),
		});
		process.stdout.write(summarizeInstall(result) + "\n");
	});

cli
	.command("rotate-key", "Rotate this agent's API key")
	.action(async () => {
		try {
			const r = await rotateKey();
			process.stdout.write(`rotated key for agent ${r.agent_id} (key_id ${r.key_id})\n`);
			process.stdout.write(`updated ${r.configPath}\n`);
		} catch (err) {
			process.stderr.write((err instanceof Error ? err.message : String(err)) + "\n");
			process.exit(1);
		}
	});

cli
	.command("doctor", "Diagnose local config + connectivity")
	.action(async () => {
		const report = await doctor();
		process.stdout.write(formatDoctor(report) + "\n");
	});

cli
	.command("audit", "Stream local + relay audit ledger entries")
	.option("--since <ts>", "ISO 8601 timestamp")
	.option("--from <handle>", "Filter by sender handle")
	.option("--action <symbol>", "Filter by action symbol")
	.option("--limit <n>", "Max entries (default 100, max 1000)")
	.option("--format <fmt>", "Output format: tsv | jsonl (default: tsv if TTY, else jsonl)")
	.action(async (opts: Record<string, unknown>) => {
		try {
			const events = await fetchAudit({
				since: typeof opts.since === "string" ? opts.since : undefined,
				from: typeof opts.from === "string" ? opts.from : undefined,
				action: typeof opts.action === "string" ? opts.action : undefined,
				limit: typeof opts.limit === "number" ? opts.limit : opts.limit ? Number(opts.limit) : undefined,
			});
			const fmt =
				opts.format === "tsv" || opts.format === "jsonl"
					? (opts.format as "tsv" | "jsonl")
					: process.stdout.isTTY
						? "tsv"
						: "jsonl";
			const out = renderAudit(events, fmt);
			if (out.length > 0) process.stdout.write(out + "\n");
		} catch (err) {
			process.stderr.write((err instanceof Error ? err.message : String(err)) + "\n");
			process.exit(1);
		}
	});

cli
	.command("block <handle>", "Block a teammate; syncs to ~/.agentrelay/trust.yaml")
	.option("--list", "List blocked handles")
	.action(async (handle: string | undefined, opts: Record<string, unknown>) => {
		if (opts.list) {
			const t = await loadTrust();
			const file = t.ok ? t.trust : FALLBACK_TRUST;
			const out = listTrust(file);
			process.stdout.write(out.blocked.length === 0 ? "(none)\n" : out.blocked.join("\n") + "\n");
			return;
		}
		if (!handle) {
			process.stderr.write("agentrelay block: handle required\n");
			process.exit(2);
		}
		const changed = await blockCmd(handle);
		process.stdout.write(changed ? `blocked ${handle}\n` : `${handle} was already blocked\n`);
	});

cli
	.command("unblock <handle>", "Unblock a previously blocked teammate")
	.action(async (handle: string) => {
		const changed = await unblockCmd(handle);
		process.stdout.write(changed ? `unblocked ${handle}\n` : `${handle} was not blocked\n`);
	});

cli
	.command("trust list", "List per-teammate trust entries")
	.action(async () => {
		const t = await loadTrust();
		const file = t.ok ? t.trust : FALLBACK_TRUST;
		const out = listTrust(file);
		process.stdout.write(`unknown_teammates.policy: ${out.unknownPolicy}\n`);
		for (const { handle, entry } of out.teammates) {
			process.stdout.write(`  ${handle}: ${JSON.stringify(entry)}\n`);
		}
	});

cli
	.command("trust set <handle>", "Set trust overlay for a teammate")
	.option("--auto-read <bool>", "true|false")
	.option("--auto-test <bool>", "true|false")
	.option("--auto-write-paths <list>", "comma-separated globs (e.g. docs/,README.md)")
	.option("--require-approval <list>", "comma-separated tool names")
	.action(async (handle: string, opts: Record<string, unknown>) => {
		const update = parseTrustSetOptions(opts);
		await trustSetCmd(handle, update);
		process.stdout.write(`updated trust entry for ${handle}\n`);
	});

cli
	.command("trust reset <handle>", "Remove a teammate's trust overlay")
	.action(async (handle: string) => {
		const changed = await trustResetCmd(handle);
		process.stdout.write(changed ? `reset ${handle}\n` : `${handle} had no entry\n`);
	});

cli.help();
cli.version("0.0.1");

try {
	cli.parse(process.argv, { run: false });
	if (process.argv.slice(2).length === 0) {
		cli.outputHelp();
		process.exit(0);
	}
	void cli.runMatchedCommand();
} catch (err) {
	logger.error({ err }, "agentrelay CLI error");
	process.exit(1);
}

function parseTrustSetOptions(opts: Record<string, unknown>): {
	auto_read?: boolean;
	auto_test?: boolean;
	auto_write_paths?: string[];
	require_approval?: string[];
} {
	const out: ReturnType<typeof parseTrustSetOptions> = {};
	// cac auto-camelCases dashed flags: --auto-read → opts.autoRead, etc.
	if (opts.autoRead !== undefined) out.auto_read = parseBool(opts.autoRead);
	if (opts.autoTest !== undefined) out.auto_test = parseBool(opts.autoTest);
	if (opts.autoWritePaths !== undefined) out.auto_write_paths = parseList(opts.autoWritePaths);
	if (opts.requireApproval !== undefined) out.require_approval = parseList(opts.requireApproval);
	return out;
}

function parseBool(v: unknown): boolean {
	if (typeof v === "boolean") return v;
	if (typeof v === "string") {
		if (v === "true") return true;
		if (v === "false") return false;
	}
	throw new Error(`expected boolean, got ${String(v)}`);
}

function parseList(v: unknown): string[] {
	if (Array.isArray(v)) return v.map(String);
	if (typeof v === "string") return v.split(",").map((s) => s.trim()).filter(Boolean);
	throw new Error(`expected comma-separated list, got ${String(v)}`);
}
