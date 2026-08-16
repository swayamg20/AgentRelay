import { buildCodexAppServerArguments } from "./codex-app-server-command.js";
import type { CodexAppServerProcessOptions } from "./codex-app-server-process.js";
import type { CodexProviderGenerationStore } from "./codex-provider-generation-state.js";
import {
	type CodexPreparedProcess,
	codexPreparedProcessSchema,
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
	"startupTimeoutMs" | "heartbeatIntervalMs" | "heartbeatTimeoutMs" | "heartbeatRecordMs"
> & {
	readonly startupTimeoutMs: number;
	readonly heartbeatIntervalMs: number;
	readonly heartbeatTimeoutMs: number;
	readonly heartbeatRecordMs: number;
};

export async function prepareProviderCommands(options: CodexAppServerProcessOptions): Promise<{
	readonly versionProbe: CodexPreparedProcess;
	readonly appServer: CodexPreparedProcess;
}> {
	const base = {
		executable: options.command.executable,
		cwd: options.cwd,
		env: options.env,
	};
	const versionProbe = await options.boundary.prepare({ ...base, argv: ["--version"] });
	const appServer = await options.boundary.prepare({
		...base,
		argv: buildCodexAppServerArguments(),
	});
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
	readonly cwd: string;
	readonly env: NodeJS.ProcessEnv;
}): CodexPreparedProcess {
	return codexPreparedProcessSchema.parse({
		executable: value.executable,
		argv: [...value.argv],
		cwd: value.cwd,
		env: sanitizePreparedEnvironment(value.env),
	});
}

function boundedMilliseconds(value: number, minimum: number, maximum: number): number {
	if (!Number.isInteger(value) || value < minimum || value > maximum) {
		throw new Error("Codex provider guardian timing is outside its bound");
	}
	return value;
}
