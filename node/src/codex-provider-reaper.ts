import { closeSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { CodexProviderGenerationStore } from "./codex-provider-generation-state.js";
import type { CodexProviderStopCause } from "./codex-provider-generation-state.js";
import { assertInheritedProviderLock } from "./codex-provider-lock.js";
import { INHERITED_PROVIDER_LOCK_FD } from "./codex-provider-lock.js";
import {
	type CodexProviderReaperInit,
	parseCodexProviderReaperCommand,
	readyReaperEvent,
} from "./codex-provider-reaper-protocol.js";
import { isSupervisorProcessGroupAlive, signalProcessGroup } from "./codex-supervisor-owner.js";

const STARTUP_TIMEOUT_MS = 5_000;
const STOP_GRACE_MS = 2_000;
const GROUP_POLL_MS = 10;

/** Survives outside the provider group and finalizes only after proving group absence. */
export class CodexProviderReaper {
	#init: CodexProviderReaperInit | null = null;
	#store: CodexProviderGenerationStore | null = null;
	#lastHeartbeat = performance.now();
	#heartbeatTimer: NodeJS.Timeout | null = null;
	#deadlineTimer: NodeJS.Timeout | null = null;
	#reaping: Promise<void> | null = null;
	#failClosedTimer: NodeJS.Timeout | null = null;

	run(): void {
		const startupTimer = setTimeout(() => process.exit(1), STARTUP_TIMEOUT_MS);
		startupTimer.unref();
		process.on("message", (value) => {
			void this.handleMessage(value, startupTimer).catch(() =>
				this.reap("provider_failure").catch(() => this.failClosed()),
			);
		});
		process.once("disconnect", () => {
			if (this.#init === null) {
				process.exit(1);
				return;
			}
			void this.reap("provider_failure").catch(() => this.failClosed());
		});
	}

	private async handleMessage(value: unknown, startupTimer: NodeJS.Timeout): Promise<void> {
		const command = parseCodexProviderReaperCommand(value);
		if (command.kind === "initialize") {
			if (this.#init !== null) throw new Error("Codex provider reaper initialized twice");
			if (command.target_process_group_id === process.pid) {
				throw new Error("Codex provider reaper cannot target its own process group");
			}
			assertInheritedProviderLock(command.lock_path);
			this.#store = await CodexProviderGenerationStore.open(
				command.state_directory,
				command.capsule_id,
			);
			this.#init = command;
			clearTimeout(startupTimer);
			this.armWatchdogs(command);
			await this.sendReady(command.generation_id);
			return;
		}
		if (this.#init === null || command.generation_id !== this.#init.generation_id) return;
		if (command.kind === "heartbeat") {
			this.#lastHeartbeat = performance.now();
			return;
		}
		await this.reap(command.cause);
	}

	private armWatchdogs(command: CodexProviderReaperInit): void {
		this.#lastHeartbeat = performance.now();
		const intervalMs = Math.max(50, Math.floor(command.heartbeat_timeout_ms / 4));
		this.#heartbeatTimer = setInterval(() => {
			if (performance.now() - this.#lastHeartbeat >= command.heartbeat_timeout_ms) {
				void this.reap("heartbeat_timeout").catch(() => this.failClosed());
			}
		}, intervalMs);
		this.#heartbeatTimer.unref();
		this.armDeadline(command.deadline_at_ms);
	}

	private armDeadline(deadlineAtMs: number): void {
		const remainingMs = deadlineAtMs - Date.now();
		if (remainingMs <= 0) {
			void this.reap("deadline_exceeded").catch(() => this.failClosed());
			return;
		}
		this.#deadlineTimer = setTimeout(
			() => this.armDeadline(deadlineAtMs),
			Math.min(remainingMs, 2_147_483_647),
		);
		this.#deadlineTimer.unref();
	}

	private reap(cause: CodexProviderStopCause): Promise<void> {
		this.#reaping ??= this.performReap(cause);
		return this.#reaping;
	}

	private async performReap(cause: CodexProviderStopCause): Promise<void> {
		if (this.#heartbeatTimer !== null) clearInterval(this.#heartbeatTimer);
		if (this.#deadlineTimer !== null) clearTimeout(this.#deadlineTimer);
		const init = this.#init;
		const store = this.#store;
		if (init === null || store === null) throw new Error("Codex provider reaper is not armed");

		await store.requestStop(init.generation_id, cause).catch(() => undefined);
		signalProcessGroup(init.target_process_group_id, "SIGTERM");
		await delay(STOP_GRACE_MS);
		if (isSupervisorProcessGroupAlive(init.target_process_group_id)) {
			signalProcessGroup(init.target_process_group_id, "SIGKILL");
		}
		while (isSupervisorProcessGroupAlive(init.target_process_group_id)) {
			await delay(GROUP_POLL_MS);
		}
		await store.finalizeQuiescentAsCurrent(init.generation_id, cause);
		closeSync(INHERITED_PROVIDER_LOCK_FD);
		if (process.connected) process.disconnect();
	}

	private failClosed(): void {
		if (this.#heartbeatTimer !== null) clearInterval(this.#heartbeatTimer);
		if (this.#deadlineTimer !== null) clearTimeout(this.#deadlineTimer);
		this.#failClosedTimer ??= setInterval(() => undefined, 60_000);
	}

	private sendReady(generationId: string): Promise<void> {
		return new Promise((resolve, reject) => {
			if (!process.connected || process.send === undefined) {
				reject(new Error("Codex provider reaper control channel is closed"));
				return;
			}
			process.send(readyReaperEvent(generationId), (error) =>
				error === null ? resolve() : reject(error),
			);
		});
	}
}
