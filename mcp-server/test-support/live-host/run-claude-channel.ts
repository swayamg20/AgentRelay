import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

if (!process.stdin.isTTY) {
	throw new Error(
		"Run this probe in a terminal: Claude's development-channel consent is interactive",
	);
}

const version = execFileSync("claude", ["--version"], { encoding: "utf8", timeout: 10_000 }).trim();
const directory = mkdtempSync(join(tmpdir(), "agentrelay-claude-channel-"));
const eventsPath = join(directory, "events.jsonl");
const configPath = join(directory, "mcp.json");
writeFileSync(eventsPath, "", { mode: 0o600 });
writeFileSync(
	configPath,
	JSON.stringify({
		mcpServers: {
			agentrelay_probe: {
				command: process.execPath,
				args: [
					"--import",
					import.meta.resolve("tsx"),
					fileURLToPath(new URL("serve-claude-probe.ts", import.meta.url)),
					"--events",
					eventsPath,
				],
			},
		},
	}),
	{ mode: 0o600 },
);

console.log(`Testing ${version}; synthetic receipt log: ${eventsPath}`);
console.log("Approve the local development channel when Claude asks. Do not enter a chat prompt.");

const eventSchema = z.object({ stage: z.string(), sequence: z.number().optional() });
function readEvents() {
	return readFileSync(eventsPath, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => eventSchema.parse(JSON.parse(line)));
}

const env: NodeJS.ProcessEnv = {};
for (const name of [
	"PATH",
	"HOME",
	"USER",
	"LOGNAME",
	"TMPDIR",
	"TERM",
	"LANG",
	"LC_ALL",
	"ANTHROPIC_API_KEY",
]) {
	if (process.env[name] !== undefined) env[name] = process.env[name];
}
const child = spawn(
	"claude",
	[
		"--name",
		"agentrelay-channel-probe",
		"--setting-sources",
		"",
		"--settings",
		JSON.stringify({ disableAllHooks: true }),
		"--strict-mcp-config",
		"--mcp-config",
		configPath,
		"--dangerously-load-development-channels",
		"server:agentrelay_probe",
		"--tools",
		"",
		"--disable-slash-commands",
		"--permission-mode",
		"dontAsk",
		"--allowedTools",
		"mcp__agentrelay_probe__receive_live_turn",
		"mcp__agentrelay_probe__reply_live_turn",
		"--effort",
		"low",
	],
	{ cwd: directory, env, stdio: "inherit" },
);
let stopping = false;
let killTimer: ReturnType<typeof setTimeout> | undefined;
function stop() {
	if (stopping) return;
	stopping = true;
	child.kill("SIGTERM");
	killTimer = setTimeout(() => child.kill("SIGKILL"), 3_000);
}
const deadline = setTimeout(stop, 120_000);
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
const watcher = watch(eventsPath, () => {
	try {
		if (readEvents().filter((event) => event.stage === "reply_recorded").length === 3) stop();
	} catch {
		// A partial final line is retried on the next filesystem event or at exit.
	}
});
let launchFailed = false;
child.on("error", () => {
	launchFailed = true;
});
child.on("close", () => {
	clearTimeout(deadline);
	clearTimeout(killTimer);
	watcher.close();
	process.removeListener("SIGINT", stop);
	process.removeListener("SIGTERM", stop);
	const events = readEvents();
	const replies = events.filter((event) => event.stage === "reply_recorded").length;
	console.log(
		JSON.stringify(
			{
				probe: "claude-channel",
				version,
				passed: replies === 3,
				launchFailed,
				replies,
				stages: events.map((event) => event.stage),
				eventsPath,
				claim: "Synthetic open-session activation and tool replies only; no Relay durability proof",
			},
			null,
			2,
		),
	);
	process.exitCode = replies === 3 ? 0 : 1;
});
