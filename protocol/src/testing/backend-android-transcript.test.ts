import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	type InvalidMissionCoordinatorEventError,
	type MissionCoordinatorEvent,
	reduceMissionCoordinatorEvent,
	replayMissionCoordinatorEvents,
} from "../mission-coordinator.js";
import {
	type BackendAndroidFixtureEnvironment,
	backendAndroidContracts,
	backendAndroidCoordinatorConfig,
	backendAndroidFixtureRoot,
	backendAndroidIds,
	backendAndroidMissionFixture,
} from "./fixtures/backend-android.js";
import { runFixedCommand } from "./frozen-repository.js";
import { runMissionFixture } from "./mission-fixture-runner.js";

describe("backend-Android deterministic Mission", () => {
	it("completes one revised contract with no human action after kickoff", async () => {
		const expectedTranscript = JSON.parse(
			readFileSync(`${backendAndroidFixtureRoot}/expected-transcript.json`, "utf8"),
		);
		const result = await runMissionFixture(backendAndroidMissionFixture);
		try {
			expect(result.state.status).toBe("completed");
			expect(result.state.sequence_no).toBe(14);
			expect(result.state.turn_count).toBe(7);
			expect(result.state.contract_version).toBe(2);
			expect(result.state.pending_revision).toBeNull();
			expect(result.state.current_participant_agent_id).toBeNull();
			expect(result.state.ready_agent_ids).toEqual([
				backendAndroidIds.androidAgent,
				backendAndroidIds.backendAgent,
			]);
			expect(result.state.messages.map((message) => message.type)).toEqual([
				"question",
				"answer",
				"progress",
				"progress",
			]);
			expect(result.state.accepted_revisions).toHaveLength(1);
			expect(result.state.accepted_revisions[0]).toMatchObject({
				previous_version: 1,
				version: 2,
				proposed_by_agent_id: backendAndroidIds.backendAgent,
				acknowledged_by_agent_ids: [backendAndroidIds.backendAgent, backendAndroidIds.androidAgent],
			});
			expect(result.duplicateDeliveriesSuppressed).toBe(1);
			expect(result.duplicateAcknowledgementsSuppressed).toBe(1);
			expect(result.recoveredHostTurns).toBe(1);
			expect(result.humanInterventions).toBe(0);
			expect(result.events.map(projectEvent)).toEqual(expectedTranscript.events);
			expect(
				result.hostTurns
					.filter((turn) => turn.replayMode !== "none")
					.map((turn) => ({
						delivery_id: turn.input.deliveryId,
						mode: turn.replayMode,
					})),
			).toEqual(expectedTranscript.delivery_replays);

			const verificationCommandIds = result.state.verification_records.map(
				(record) => record.evidence.command_id,
			);
			expect(verificationCommandIds).toEqual([
				"backend-test",
				"contract-test",
				"android-test",
				"public-user-scenario",
			]);
			expect(verificationCommandIds).not.toContain("hidden-user-scenario");

			const secondAcknowledgement = result.events
				.filter((event) => event.type === "contract_acknowledged")
				.at(-1);
			expect(secondAcknowledgement).toBeDefined();
			const turnsAfterRevision = result.events.filter(
				(event) =>
					event.type === "turn_completed" &&
					event.sequence_no > (secondAcknowledgement?.sequence_no ?? Number.MAX_SAFE_INTEGER),
			);
			expect(turnsAfterRevision).toHaveLength(4);
			expect(turnsAfterRevision.every((event) => event.contract_version === 2)).toBe(true);

			expect(result.hostTurns.map((turn) => turn.input.contractVersion)).toEqual([
				1, 1, 1, 2, 2, 2, 2,
			]);
			expect(result.hostTurns.map((turn) => turn.input.executionAttempt)).toEqual([
				1, 1, 1, 1, 1, 1, 1,
			]);
			for (const turn of result.hostTurns) {
				expect(turn.input.objective).toMatchObject({
					authorPrincipalId: backendAndroidIds.owner,
					provenance: "mission_manifest",
				});
				expect(turn.input.artifacts).toHaveLength(1);
				expect(turn.input.artifacts[0]).toEqual(
					turn.input.contractVersion === 1
						? backendAndroidContracts.v1
						: backendAndroidContracts.v2,
				);
				expect(turn.events.map((event) => event.sequence)).toEqual(
					turn.events.map((_, index) => index + 1),
				);
				expect(turn.events.at(-1)?.kind).toBe("completed");
			}

			expect(result.adapterCounters[backendAndroidIds.backendAgent]).toMatchObject({
				ensureSessionCalls: 1,
				startTurnCalls: 4,
				turnsCreated: 4,
				recoverTurnCalls: 0,
			});
			expect(result.adapterCounters[backendAndroidIds.androidAgent]).toMatchObject({
				ensureSessionCalls: 1,
				startTurnCalls: 4,
				turnsCreated: 3,
				recoverTurnCalls: 1,
			});

			const replayed = replayMissionCoordinatorEvents(
				backendAndroidCoordinatorConfig,
				result.events,
			);
			expect(replayed).toEqual(result.state);
			let duplicateReplay = result.state;
			for (const event of result.events) {
				duplicateReplay = reduceMissionCoordinatorEvent(duplicateReplay, event);
			}
			expect(duplicateReplay).toEqual(result.state);

			const lastTurn = result.events.findLast((event) => event.type === "turn_completed");
			expect(lastTurn).toBeDefined();
			if (lastTurn?.type === "turn_completed") {
				expect(() =>
					reduceMissionCoordinatorEvent(result.state, {
						...lastTurn,
						event_id: "90000000-0000-4000-8000-000000000001",
						idempotency_key: "fixture:event:delayed",
						sequence_no: result.state.sequence_no + 1,
						created_at: "2026-08-02T10:01:00.000Z",
						delivery_id: "90000000-0000-4000-8000-000000000002",
					}),
				).toThrowError(
					expect.objectContaining<Partial<InvalidMissionCoordinatorEventError>>({
						reason: "terminal",
					}),
				);
			}

			await expect(runFixedCommand(result.environment.hiddenUserScenario)).resolves.toBe("");
			expect({
				status: result.state.status,
				contract_version: result.state.contract_version,
				turn_count: result.state.turn_count,
				message_count: result.state.messages.length,
				accepted_revision_count: result.state.accepted_revisions.length,
				human_interventions: result.humanInterventions,
				hidden_user_scenario: "passed_after_completion",
			}).toEqual(expectedTranscript.expected);
		} finally {
			await result.dispose();
		}
	}, 15_000);

	it("delivers exact peer artifacts with teammate provenance", async () => {
		const backendTurns =
			backendAndroidMissionFixture.turnsByParticipant[backendAndroidIds.backendAgent] ?? [];
		const [firstBackendTurn, ...remainingBackendTurns] = backendTurns;
		if (firstBackendTurn?.disposition.kind !== "reply") {
			throw new Error("Expected the backend fixture to begin with a reply");
		}
		const fixture = {
			...backendAndroidMissionFixture,
			turnsByParticipant: {
				...backendAndroidMissionFixture.turnsByParticipant,
				[backendAndroidIds.backendAgent]: [
					{
						...firstBackendTurn,
						disposition: {
							...firstBackendTurn.disposition,
							artifacts: [backendAndroidContracts.v2.artifact],
						},
					},
					...remainingBackendTurns,
				],
			},
		};

		const result = await runMissionFixture(fixture);
		try {
			const androidTurn = result.hostTurns.find(
				(turn) => turn.input.deliveryId === backendAndroidIds.androidAnswerDelivery,
			);
			expect(androidTurn?.input.artifacts).toEqual([
				backendAndroidContracts.v1,
				backendAndroidContracts.v2,
			]);
		} finally {
			await result.dispose();
		}
	}, 15_000);

	it("disposes the prepared fixture when a registered verification command fails", async () => {
		let disposed = false;
		const fixture = {
			...backendAndroidMissionFixture,
			async prepareEnvironment() {
				const environment = await backendAndroidMissionFixture.prepareEnvironment();
				return {
					...environment,
					verificationCommands: {
						...environment.verificationCommands,
						[backendAndroidIds.backendAgent]: {
							...environment.verificationCommands[backendAndroidIds.backendAgent],
							"backend-test": {
								command: {
									executable: process.execPath,
									args: ["-e", "process.exit(9)"],
									cwd: environment.backend.expectedPath,
								},
								summary: "Intentional fixture failure.",
								durationMs: 1,
							},
						},
					},
				};
			},
			async disposeEnvironment(environment: BackendAndroidFixtureEnvironment) {
				disposed = true;
				await backendAndroidMissionFixture.disposeEnvironment(environment);
			},
		};

		await expect(runMissionFixture(fixture)).rejects.toThrow(
			/Local verification command failed: backend-test/,
		);
		expect(disposed).toBe(true);
	}, 15_000);

	it("rejects a required verification command that local policy did not register", async () => {
		let disposed = false;
		const fixture = {
			...backendAndroidMissionFixture,
			coordinatorConfig: {
				...backendAndroidCoordinatorConfig,
				required_verification_commands: {
					...backendAndroidCoordinatorConfig.required_verification_commands,
					[backendAndroidIds.backendAgent]: [
						...(backendAndroidCoordinatorConfig.required_verification_commands[
							backendAndroidIds.backendAgent
						] ?? []),
						"missing-command",
					],
				},
			},
			async disposeEnvironment(environment: BackendAndroidFixtureEnvironment) {
				disposed = true;
				await backendAndroidMissionFixture.disposeEnvironment(environment);
			},
		};

		await expect(runMissionFixture(fixture)).rejects.toThrow(
			/No local verification command is registered for missing-command/,
		);
		expect(disposed).toBe(true);
	}, 15_000);

	it("rejects contract payload provenance that is not owned by the expected Mission actor", async () => {
		const fixture = {
			...backendAndroidMissionFixture,
			artifacts: [
				{
					...backendAndroidContracts.v1,
					source: {
						principal_id: "90000000-0000-4000-8000-000000000001",
						kind: "agent" as const,
					},
				},
				backendAndroidContracts.v2,
			],
		};

		await expect(runMissionFixture(fixture)).rejects.toThrow(/Fixture provenance mismatch/);
	}, 15_000);
});

function projectEvent(event: MissionCoordinatorEvent): Record<string, unknown> {
	if (event.type === "participants_accepted") {
		return {
			sequence_no: event.sequence_no,
			type: event.type,
			contract_version: event.contract.version,
		};
	}
	if (event.type === "contract_acknowledged") {
		return {
			sequence_no: event.sequence_no,
			type: event.type,
			participant_agent_id: event.participant_agent_id,
			contract_version: event.contract_version,
		};
	}
	if (event.type === "verification_recorded") {
		return {
			sequence_no: event.sequence_no,
			type: event.type,
			participant_agent_id: event.participant_agent_id,
			contract_version: event.contract_version,
			verification_round: event.verification_round,
			command_id: event.evidence.command_id,
		};
	}

	const projected: Record<string, unknown> = {
		sequence_no: event.sequence_no,
		type: event.type,
		participant_agent_id: event.participant_agent_id,
		contract_version: event.contract_version,
		disposition_kind: event.disposition.kind,
	};
	if (event.disposition.kind === "reply") {
		projected.message_type = event.disposition.message_type;
	}
	if (event.disposition.kind === "propose_contract") {
		projected.proposed_contract_version = event.disposition.artifact.version;
	}
	return projected;
}
