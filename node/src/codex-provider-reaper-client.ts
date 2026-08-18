import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import type { CodexProviderStopCause } from "./codex-provider-generation-state.js";
import { INHERITED_PROVIDER_LOCK_FD } from "./codex-provider-lock.js";
import {
	type CodexProviderReaperCommand,
	heartbeatReaperCommand,
	initializeReaperCommand,
	parseCodexProviderReaperEvent,
	stopReaperCommand,
} from "./codex-provider-reaper-protocol.js";
import type { CodexPreparedProcess } from "./codex-provider-supervisor-protocol.js";
import {
	childClose,
	childExit,
	stopSupervisorProcessGroup,
	waitForChildSpawn,
} from "./codex-supervisor-owner.js";

const REAPER_STARTUP_TIMEOUT_MS = 5_000;

export interface CodexProviderReaperOptions {
	readonly command: CodexPreparedProcess;
	readonly capsuleId: string;
	readonly generationId: string;
	readonly lockPath: string;
	readonly stateDirectory: string;
	readonly deadlineAtMs: number;
	readonly heartbeatTimeoutMs: number;
}

export class CodexProviderReaperTeardownError extends AggregateError {
	constructor(teardownError: unknown, startupError: unknown) {
		super(
			[teardownError, startupError],
			"Codex provider reaper startup teardown could not be proven",
		);
		this.name = "CodexProviderReaperTeardownError";
	}
}

/** Guardian-side handle for the detached teardown witness. */
export class CodexProviderReaperClient {
	readonly termination: Promise<void>;
	readonly #generationId: string;
	readonly #child: ChildProcessWithoutNullStreams;

	private constructor(
		generationId: string,
		child: ChildProcessWithoutNullStreams,
		termination: Promise<void>,
	) {
		this.#generationId = generationId;
		this.#child = child;
		this.termination = termination;
	}

	static async start(options: CodexProviderReaperOptions): Promise<CodexProviderReaperClient> {
		const child = spawn(options.command.executable, [...options.command.argv], {
			cwd: options.command.cwd,
			detached: true,
			env: { ...options.command.env },
			stdio: ["ignore", "ignore", "ignore", "ipc", INHERITED_PROVIDER_LOCK_FD],
			shell: false,
		}) as ChildProcessWithoutNullStreams;
		const exited = childExit(child);
		const closed = childClose(child).then(() => undefined);
		try {
			await waitForChildSpawn(child);
			const ready = waitForReady(child, options.generationId, closed);
			await sendReaperCommand(
				child,
				initializeReaperCommand({
					capsuleId: options.capsuleId,
					generationId: options.generationId,
					lockPath: options.lockPath,
					stateDirectory: options.stateDirectory,
					targetProcessGroupId: process.pid,
					deadlineAtMs: options.deadlineAtMs,
					heartbeatTimeoutMs: options.heartbeatTimeoutMs,
				}),
			);
			await ready;
			return new CodexProviderReaperClient(options.generationId, child, closed);
		} catch (error) {
			try {
				await stopSupervisorProcessGroup(child, exited, closed);
			} catch (teardownError) {
				throw new CodexProviderReaperTeardownError(teardownError, error);
			}
			throw error;
		}
	}

	heartbeat(): Promise<void> {
		return sendReaperCommand(this.#child, heartbeatReaperCommand(this.#generationId));
	}

	escalate(cause: CodexProviderStopCause): Promise<void> {
		return sendReaperCommand(this.#child, stopReaperCommand(this.#generationId, cause));
	}

	async stop(cause: CodexProviderStopCause): Promise<never> {
		await this.escalate(cause);
		await this.termination;
		throw new Error("Codex provider reaper exited before terminating its process group");
	}
}

function sendReaperCommand(
	child: ChildProcessWithoutNullStreams,
	command: CodexProviderReaperCommand,
): Promise<void> {
	return new Promise((resolve, reject) => {
		if (!child.connected || child.send === undefined) {
			reject(new Error("Codex provider reaper control channel is closed"));
			return;
		}
		child.send(command, (error) => (error === null ? resolve() : reject(error)));
	});
}

function waitForReady(
	child: ChildProcessWithoutNullStreams,
	generationId: string,
	closed: Promise<void>,
): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			cleanup();
			reject(new Error("Codex provider reaper timed out during startup"));
		}, REAPER_STARTUP_TIMEOUT_MS);
		const onMessage = (value: unknown) => {
			try {
				const event = parseCodexProviderReaperEvent(value);
				if (event.generation_id !== generationId) return;
				cleanup();
				resolve();
			} catch {
				cleanup();
				reject(new Error("Codex provider reaper returned an invalid control event"));
			}
		};
		const cleanup = () => {
			clearTimeout(timer);
			child.removeListener("message", onMessage);
		};
		child.on("message", onMessage);
		void closed.then(() => {
			cleanup();
			reject(new Error("Codex provider reaper exited during startup"));
		});
	});
}
