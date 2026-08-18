import { Buffer } from "node:buffer";
import type {
	ArtifactRef,
	HostEvent,
	HostEventStreamState,
	HostTurnRef,
	SessionInput,
	StartTurnInput,
} from "@agentrelay/protocol";
import { CapsuleOperationError } from "./capsule-operation-error.js";
import type { CapsuleRuntimeActivation } from "./capsule-runtime.js";
import {
	LocalReferenceMonitor,
	RuntimeAuthorityDeniedError,
	type RuntimeAuthorityDenyCode,
	type RuntimeAuthorityEvidenceSink,
	type RuntimeAuthorityGrant,
	type RuntimeAuthorityRenewal,
	type RuntimeAuthorityRequest,
	parseRuntimeAuthorityGrant,
	runtimeAuthorityDenyCodeSchema,
	runtimeAuthorityGrantSha256,
	runtimeAuthorityRequest,
} from "./runtime-authority.js";

type RuntimeOperation = "runtime_start" | "runtime_recover" | "runtime_cancel";

// Evidence persistence is the audit-store work in #99. Until a sink is injected,
// the monitor still makes the same decision but retains no process-local payload.
const NOOP_EVIDENCE: RuntimeAuthorityEvidenceSink = { record: () => undefined };

/** Owns the one fenced delivery authority admitted into a Capsule generation. */
export class CapsuleAuthority {
	readonly #evidenceSink: RuntimeAuthorityEvidenceSink;
	readonly #retire: () => void;
	#monitor: LocalReferenceMonitor | null = null;
	#turnTimer: ReturnType<typeof setTimeout> | null = null;
	#retirementScheduled = false;

	constructor(options: {
		readonly evidenceSink?: RuntimeAuthorityEvidenceSink;
		readonly retire: () => void;
	}) {
		this.#evidenceSink = options.evidenceSink ?? NOOP_EVIDENCE;
		this.#retire = options.retire;
	}

	install(grantValue: RuntimeAuthorityGrant, currentLease: RuntimeAuthorityRenewal): void {
		const grant = parseRuntimeAuthorityGrant(grantValue);
		if (this.#monitor !== null) {
			if (runtimeAuthorityGrantSha256(this.#monitor.grant) === runtimeAuthorityGrantSha256(grant)) {
				this.#monitor.renew(currentLease);
				this.assertMonitorLive(this.#monitor);
				return;
			}
			const code = installConflictCode(this.#monitor.grant, grant);
			this.#monitor.revoke("revoked");
			throw new RuntimeAuthorityDeniedError(code);
		}

		let monitor: LocalReferenceMonitor;
		try {
			monitor = new LocalReferenceMonitor(grant, this.#evidenceSink, { currentLease });
		} catch (error) {
			this.scheduleRetirement();
			throw error;
		}
		this.#monitor = monitor;
		monitor.signal.addEventListener("abort", () => this.scheduleRetirement(), { once: true });
		try {
			this.assertMonitorLive(monitor);
		} catch (error) {
			this.scheduleRetirement();
			throw error;
		}
	}

	renew(missionId: string, renewal: RuntimeAuthorityRenewal): void {
		const monitor = this.requireMonitor();
		if (missionId !== monitor.grant.mission_id) {
			throw new RuntimeAuthorityDeniedError("wrong_mission");
		}
		monitor.renew(renewal);
	}

	async assert(request: RuntimeAuthorityRequest): Promise<void> {
		await this.requireMonitor().perform(request, () => undefined);
	}

	revoke(missionId: string, grantId: string, reason: RuntimeAuthorityDenyCode): void {
		const monitor = this.requireMonitor();
		if (missionId !== monitor.grant.mission_id) {
			throw new RuntimeAuthorityDeniedError("wrong_mission");
		}
		if (grantId !== monitor.grant.grant_id) {
			throw new RuntimeAuthorityDeniedError("wrong_grant");
		}
		monitor.revoke(reason);
	}

	performSession<T>(
		input: SessionInput,
		effect: (authority: CapsuleRuntimeActivation) => T | Promise<T>,
	): Promise<T> {
		const monitor = this.requireMonitor();
		return monitor.perform(this.requestForSession(monitor.grant, input), () =>
			effect(this.activationFor(monitor)),
		);
	}

	performStart<T>(
		input: StartTurnInput,
		effect: (authority: CapsuleRuntimeActivation) => T | Promise<T>,
	): Promise<T> {
		return this.performInput("runtime_start", input, effect);
	}

	performRecovery<T>(
		turn: HostTurnRef,
		input: StartTurnInput,
		effect: (authority: CapsuleRuntimeActivation) => T | Promise<T>,
	): Promise<T> {
		const monitor = this.requireMonitor();
		return monitor.perform(this.requestForInput(monitor.grant, "runtime_recover", input), () =>
			monitor.perform(this.requestForTurn(monitor.grant, "runtime_recover", turn), () =>
				effect(this.activationFor(monitor)),
			),
		);
	}

	performCancel<T>(
		turn: HostTurnRef,
		effect: (authority: CapsuleRuntimeActivation) => T | Promise<T>,
	): Promise<T> {
		const monitor = this.requireMonitor();
		return monitor.perform(this.requestForTurn(monitor.grant, "runtime_cancel", turn), () =>
			effect(this.activationFor(monitor)),
		);
	}

	beginTurn(): void {
		if (this.#turnTimer !== null) return;
		const monitor = this.requireMonitor();
		this.#turnTimer = setTimeout(() => {
			monitor.revoke("budget_exceeded");
		}, monitor.effectiveLimits.turn_ms);
		this.#turnTimer.unref?.();
	}

	streamSignal(socketSignal: AbortSignal): AbortSignal {
		return AbortSignal.any([socketSignal, this.requireMonitor().signal]);
	}

	async gateEvent(
		event: HostEvent,
		state: HostEventStreamState,
		operation: RuntimeOperation,
		effect: () => void | Promise<void>,
	): Promise<void> {
		const monitor = this.requireMonitor();
		const requests: RuntimeAuthorityRequest[] = [
			this.requestForTurn(monitor.grant, operation, event.turn),
		];

		if (textBytesInHostEvent(event) > 0) {
			requests.push(
				runtimeAuthorityRequest(
					monitor.grant,
					{ action: "outbound_publish", resource: "relay" },
					{ output_bytes: state.outputBytes },
				),
			);
		}
		if (event.kind === "usage") {
			requests.push(
				runtimeAuthorityRequest(
					monitor.grant,
					{ action: "usage_report", resource: "usage" },
					{
						reported_tokens: event.usage.available
							? event.usage.inputTokens + event.usage.outputTokens
							: 0,
					},
				),
			);
		}
		for (const artifact of artifactsInHostEvent(event)) {
			requests.push(
				runtimeAuthorityRequest(
					monitor.grant,
					{ action: "artifact_publish", resource: "artifact" },
					{
						artifact_count: state.artifactCount,
						artifact_bytes: state.artifactBytes,
						artifact_type: artifact.type,
					},
				),
			);
		}

		try {
			await performAll(monitor, requests, effect);
		} catch (error) {
			if (error instanceof RuntimeAuthorityDeniedError) monitor.revoke(error.code);
			throw error;
		}
	}

	dispose(): void {
		if (this.#turnTimer !== null) clearTimeout(this.#turnTimer);
		this.#turnTimer = null;
		this.#monitor?.revoke("revoked");
	}

	private performInput<T>(
		action: "runtime_start" | "runtime_recover",
		input: StartTurnInput,
		effect: (authority: CapsuleRuntimeActivation) => T | Promise<T>,
	): Promise<T> {
		const monitor = this.requireMonitor();
		return monitor.perform(this.requestForInput(monitor.grant, action, input), () =>
			effect(this.activationFor(monitor)),
		);
	}

	private activationFor(monitor: LocalReferenceMonitor): CapsuleRuntimeActivation {
		return Object.freeze({
			grant: monitor.grant,
			signal: monitor.signal,
			performWorkspaceRead: <T>(effect: () => T | Promise<T>) =>
				monitor.perform(
					runtimeAuthorityRequest(monitor.grant, {
						action: "workspace_read",
						resource: "workspace",
					}),
					effect,
				),
		});
	}

	private requestForSession(grant: RuntimeAuthorityGrant, input: SessionInput) {
		return {
			...runtimeAuthorityRequest(grant, { action: "runtime_start", resource: "runtime" }),
			agent_id: input.participantId,
			workspace_alias: input.workspaceAlias,
			mission_id: input.missionId,
		};
	}

	private requestForInput(
		grant: RuntimeAuthorityGrant,
		action: "runtime_start" | "runtime_recover",
		input: StartTurnInput,
	) {
		return {
			...runtimeAuthorityRequest(grant, { action, resource: "runtime" }),
			agent_id: input.session.participantId,
			workspace_alias: input.session.workspaceAlias,
			mission_id: input.missionId,
			delivery_id: input.deliveryId,
			execution_attempt: input.executionAttempt,
		};
	}

	private requestForTurn(
		grant: RuntimeAuthorityGrant,
		action: RuntimeOperation,
		turn: HostTurnRef,
	) {
		return {
			...runtimeAuthorityRequest(grant, { action, resource: "runtime" }),
			mission_id: turn.missionId,
			delivery_id: turn.deliveryId,
			execution_attempt: turn.executionAttempt,
		};
	}

	private requireMonitor(): LocalReferenceMonitor {
		if (this.#monitor === null) {
			throw new CapsuleOperationError("authority_denied", "Runtime authority is not installed");
		}
		this.assertMonitorLive(this.#monitor);
		return this.#monitor;
	}

	private assertMonitorLive(monitor: LocalReferenceMonitor): void {
		if (!monitor.signal.aborted) return;
		const parsed = runtimeAuthorityDenyCodeSchema.safeParse(monitor.signal.reason);
		throw new RuntimeAuthorityDeniedError(parsed.success ? parsed.data : "revoked");
	}

	private scheduleRetirement(): void {
		if (this.#retirementScheduled) return;
		this.#retirementScheduled = true;
		setImmediate(this.#retire);
	}
}

async function performAll<T>(
	monitor: LocalReferenceMonitor,
	requests: readonly RuntimeAuthorityRequest[],
	effect: () => T | Promise<T>,
	index = 0,
): Promise<T> {
	const request = requests[index];
	if (request === undefined) return effect();
	return monitor.perform(request, () => performAll(monitor, requests, effect, index + 1));
}

function installConflictCode(
	current: RuntimeAuthorityGrant,
	next: RuntimeAuthorityGrant,
): RuntimeAuthorityDenyCode {
	if (current.grant_id !== next.grant_id) return "wrong_grant";
	if (current.fencing_token !== next.fencing_token) return "stale_fence";
	return "policy_changed";
}

function artifactsInHostEvent(event: HostEvent): readonly ArtifactRef[] {
	if (event.kind === "artifact") return [event.artifact];
	if (event.kind !== "completed") return [];
	if (event.disposition.kind === "reply") return event.disposition.artifacts ?? [];
	if (event.disposition.kind === "propose_contract") return [event.disposition.artifact];
	if (event.disposition.kind === "ready") {
		return event.disposition.evidence.flatMap((evidence) => evidence.artifacts);
	}
	return [];
}

function textBytesInHostEvent(event: HostEvent): number {
	if (event.kind === "output") return Buffer.byteLength(event.text, "utf8");
	if (event.kind === "failed") return Buffer.byteLength(event.failure.message, "utf8");
	if (event.kind !== "completed") return 0;
	const disposition = event.disposition;
	if (disposition.kind === "reply") return Buffer.byteLength(disposition.message, "utf8");
	if (disposition.kind === "blocked") {
		return Buffer.byteLength(
			disposition.requested_input === undefined
				? disposition.reason
				: `${disposition.reason}${disposition.requested_input}`,
			"utf8",
		);
	}
	if (disposition.kind === "ready") {
		return disposition.evidence.reduce(
			(total, evidence) => total + Buffer.byteLength(evidence.summary, "utf8"),
			0,
		);
	}
	return 0;
}
