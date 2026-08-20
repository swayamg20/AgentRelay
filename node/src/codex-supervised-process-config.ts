import { buildCodexAppServerArguments } from "./codex-app-server-command.js";
import type { CodexAppServerProcessOptions } from "./codex-app-server-process.js";
import type { CodexProviderGenerationStore } from "./codex-provider-generation-state.js";
import {
	type CodexProviderPreparedProcess,
	codexProviderPreparedProcessSchema,
	sanitizePreparedEnvironment,
} from "./codex-provider-supervisor-protocol.js";
import type { ProcessLock } from "./process-lock.js";

const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 500;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 3_000;
const DEFAULT_HEARTBEAT_RECORD_MS = 5_000;

export interface CodexSupervisorCommand {
	readonly executable: string;
	readonly args: readonly string[];
	readonly env?: NodeJS.ProcessEnv;
}

export interface CodexSupervisedProcessOptions {
	readonly capsuleId: string;
	readonly capsuleDirectory: string;
	readonly generationId: string;
	readonly supervisor: CodexSupervisorCommand;
	readonly reaper?: CodexSupervisorCommand;
	readonly process: CodexAppServerProcessOptions;
	readonly lock: ProcessLock;
	readonly store: CodexProviderGenerationStore;
	readonly deadlineAtMs: number;
	readonly startupTimeoutMs?: number;
	readonly heartbeatIntervalMs?: number;
	readonly heartbeatTimeoutMs?: number;
	readonly heartbeatRecordMs?: number;
}

export type ResolvedCodexSupervisedProcessOptions = Omit<
	CodexSupervisedProcessOptions,
	"reaper" | "startupTimeoutMs" | "heartbeatIntervalMs" | "heartbeatTimeoutMs" | "heartbeatRecordMs"
> & {
	readonly reaper: CodexSupervisorCommand;
	readonly startupTimeoutMs: number;
	readonly heartbeatIntervalMs: number;
	readonly heartbeatTimeoutMs: number;
	readonly heartbeatRecordMs: number;
};

export async function prepareProviderCommands(options: CodexAppServerProcessOptions): Promise<{
	readonly versionProbe: CodexProviderPreparedProcess;
	readonly appServer: CodexProviderPreparedProcess;
}> {
	options.authoritySignal.throwIfAborted();
	const base = {
		executable: options.command.executable,
		workspaceCwd: options.workspaceCwd,
		cwd: options.processCwd,
		env: options.env,
	};
	const versionProbe = await options.boundary.prepare(
		{ ...base, argv: ["--version"] },
		options.authoritySignal,
	);
	assertPreparedScope(versionProbe, options);
	options.authoritySignal.throwIfAborted();
	const appServer = await options.boundary.prepare(
		{
			...base,
			argv: buildCodexAppServerArguments(options.workspaceCwd),
		},
		options.authoritySignal,
	);
	assertPreparedScope(appServer, options);
	options.authoritySignal.throwIfAborted();
	return { versionProbe: preparedProcess(versionProbe), appServer: preparedProcess(appServer) };
}

export function resolveSupervisedProcessOptions(
	options: CodexSupervisedProcessOptions,
): ResolvedCodexSupervisedProcessOptions {
	const heartbeatTimeoutMs = boundedMilliseconds(
		options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS,
		250,
		60_000,
	);
	return {
		...options,
		reaper: options.reaper ?? {
			executable: options.supervisor.executable,
			args: [...options.supervisor.args, "--reaper"],
		},
		deadlineAtMs: deadlineMilliseconds(options.deadlineAtMs),
		startupTimeoutMs: boundedMilliseconds(
			options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
			500,
			120_000,
		),
		heartbeatIntervalMs: boundedMilliseconds(
			options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
			50,
			Math.floor(heartbeatTimeoutMs / 2),
		),
		heartbeatTimeoutMs,
		heartbeatRecordMs: boundedMilliseconds(
			options.heartbeatRecordMs ?? DEFAULT_HEARTBEAT_RECORD_MS,
			100,
			60_000,
		),
	};
}

function deadlineMilliseconds(value: number): number {
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new Error("Codex provider guardian deadline is invalid");
	}
	return value;
}

export function supervisorEnvironment(extra: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const name of ["LANG", "LC_ALL", "TZ"]) {
		if (process.env[name] !== undefined) env[name] = process.env[name];
	}
	for (const [name, value] of Object.entries(extra ?? {})) {
		if (value !== undefined) env[name] = value;
	}
	return env;
}

function preparedProcess(value: {
	readonly executable: string;
	readonly argv: readonly string[];
	readonly workspaceCwd: string;
	readonly cwd: string;
	readonly env: NodeJS.ProcessEnv;
}): CodexProviderPreparedProcess {
	return codexProviderPreparedProcessSchema.parse({
		executable: value.executable,
		argv: [...value.argv],
		workspace_cwd: value.workspaceCwd,
		cwd: value.cwd,
		env: sanitizePreparedEnvironment(value.env),
	});
}

function assertPreparedScope(
	value: { readonly workspaceCwd: string; readonly cwd: string },
	options: CodexAppServerProcessOptions,
): void {
	if (value.workspaceCwd !== options.workspaceCwd || value.cwd !== options.processCwd) {
		throw new Error("Codex containment changed its bound working directories");
	}
}

function boundedMilliseconds(value: number, minimum: number, maximum: number): number {
	if (!Number.isInteger(value) || value < minimum || value > maximum) {
		throw new Error("Codex provider guardian timing is outside its bound");
	}
	return value;
}
