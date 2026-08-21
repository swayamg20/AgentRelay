import { chmod, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostSessionRef, StartTurnInput } from "@agentrelay/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CapsuleRuntimeActivation } from "./capsule-runtime.js";
import type { CodexDynamicToolCallItem, CodexTurn } from "./codex-app-server-protocol.js";
import { CODEX_CAPSULE_STATE_FILE, CodexCapsuleStore } from "./codex-capsule-store.js";
import {
	CODEX_DYNAMIC_PATCH_TOOL_CONTRACT,
	codexDynamicPatchToolResponse,
} from "./codex-dynamic-patch-tool-contract.js";
import {
	CodexDynamicPatchToolCoordinator,
	CodexDynamicPatchToolCoordinatorError,
	CodexTerminalPatchPolicyMismatchError,
} from "./codex-dynamic-patch-tool.js";
import {
	type CodexPatchResult,
	type CodexPatchToolCall,
	CodexWorkspacePatchError,
	codexPatchKey,
	codexPatchSha256,
	codexPatchTransactionId,
} from "./codex-workspace-patch-contract.js";
import {
	type CodexWorkspacePatchMediator,
	codexPatchAuthorityRecord,
} from "./codex-workspace-patch-transaction.js";
import { authorityGrant } from "./runtime-authority.test-support.js";

const IDS = {
	capsule: "71000000-0000-4000-8000-000000000001",
	mission: "71000000-0000-4000-8000-000000000002",
	participant: "71000000-0000-4000-8000-000000000003",
	delivery: "71000000-0000-4000-8000-000000000004",
	owner: "71000000-0000-4000-8000-000000000005",
};

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("CodexDynamicPatchToolCoordinator", () => {
	it("persists the request before apply and the receipt before returning", async () => {
		const fixture = await activeTurnFixture();
		const apply = vi.fn(async (value: unknown) => {
			const call = value as CodexPatchToolCall;
			const record = await onlyPatchRecord(fixture.directory);
			expect(record).toMatchObject({ patch: call.patch, receipt: null });
			return appliedResult(call);
		});
		const mediator = fakeMediator({ apply });
		const coordinator = coordinatorFor(fixture.store, mediator);
		const call = dynamicCall("call-1", "diff --git a/a b/a\n");

		expect(await coordinator.handle(call, new AbortController().signal)).toBe("applied");
		expect(await coordinator.handle(call, new AbortController().signal)).toBe("applied");
		expect(apply).toHaveBeenCalledTimes(1);
		expect(await fixture.store.inspectTurn(fixture.turn, fixture.input)).toMatchObject({
			phase: "accepted",
			codexTurnId: call.turnId,
		});
		const terminal = await onlyPatchRecord(fixture.directory);
		expect(terminal).toMatchObject({
			patch: null,
			receipt: { outcome: "applied", result: appliedResult(apply.mock.calls[0]![0] as never) },
		});
		expect(JSON.stringify(terminal)).not.toContain(call.patch);

		await expect(
			coordinator.handle({ ...call, patch: "changed raw patch" }, new AbortController().signal),
		).rejects.toEqual(new CodexDynamicPatchToolCoordinatorError());
		expect(apply).toHaveBeenCalledTimes(1);
		await coordinator.close();
		expect(mediator.close).toHaveBeenCalledTimes(1);
	});

	it("reconciles a crash after mediator commit before the Capsule receipt", async () => {
		const fixture = await activeTurnFixture();
		let durableCall: CodexPatchToolCall | null = null;
		let inspections = 0;
		const inspect = vi.fn(async (value: unknown) => {
			const call = value as CodexPatchToolCall;
			durableCall = call;
			inspections += 1;
			return inspections === 1
				? ({ state: "absent" } as const)
				: ({ state: "committed", result: appliedResult(call) } as const);
		});
		const apply = vi.fn(async () => {
			throw new Error("simulated lost receipt");
		});
		const mediator = fakeMediator({ apply, inspect });
		const coordinator = coordinatorFor(fixture.store, mediator);

		expect(
			await coordinator.handle(dynamicCall("lost-receipt"), new AbortController().signal),
		).toBe("applied");
		expect(durableCall).not.toBeNull();
		expect(mediator.recover).toHaveBeenCalledTimes(2);
		expect(inspect).toHaveBeenCalledTimes(2);
		expect(await onlyPatchRecord(fixture.directory)).toMatchObject({
			patch: null,
			receipt: { outcome: "applied" },
		});
		await coordinator.close();
	});

	it("persists a redacted fatal receipt after a proven pre-intent failure", async () => {
		const fixture = await activeTurnFixture();
		const apply = vi.fn(async () => {
			throw new Error("private compiler failure");
		});
		const inspect = vi.fn(async () => ({ state: "absent" as const }));
		const mediator = fakeMediator({ apply, inspect });
		const coordinator = coordinatorFor(fixture.store, mediator);
		const call = dynamicCall("fatal-pre-intent", "sensitive raw patch");

		await expect(coordinator.handle(call, new AbortController().signal)).resolves.toBe(
			"fatal_rejected",
		);
		expect(await onlyPatchRecord(fixture.directory)).toMatchObject({
			patch: null,
			receipt: { outcome: "failed", classification: "fatal" },
		});
		await coordinator.close();
		const replayMediator = fakeMediator();
		const replay = coordinatorFor(fixture.store, replayMediator);
		await expect(replay.handle(call, new AbortController().signal)).resolves.toBe("fatal_rejected");
		expect(replayMediator.recover).not.toHaveBeenCalled();
		expect(replayMediator.inspect).not.toHaveBeenCalled();
		expect(replayMediator.apply).not.toHaveBeenCalled();
		expect(JSON.stringify(await onlyPatchRecord(fixture.directory))).not.toContain(call.patch);
		await replay.close();
	});

	it("reconciles pending durable requests before admitting a new provider call", async () => {
		const fixture = await activeTurnFixture();
		const pending = await fixture.store.claimPatchCall({
			providerThreadId: "provider-thread-private-1",
			providerTurnId: "provider-turn-private-1",
			callId: "pending-before-restart",
			patch: "pending patch",
			authority: codexPatchAuthorityRecord(testAuthority()),
		});
		if (pending.kind !== "pending") throw new Error("Expected pending request barrier");
		const inspect = vi.fn(async () => ({
			state: "committed" as const,
			result: appliedResult(pending.call),
		}));
		const apply = vi.fn(async () => appliedResult(pending.call));
		const mediator = fakeMediator({ apply, inspect });
		const coordinator = coordinatorFor(fixture.store, mediator);

		await coordinator.recover();
		expect(apply).not.toHaveBeenCalled();
		expect(
			await fixture.store.claimPatchCall(dynamicRequest("pending-before-restart", "pending patch")),
		).toEqual({
			kind: "terminal",
			receipt: { outcome: "applied", result: appliedResult(pending.call) },
			replayed: true,
		});
		expect(await onlyPatchRecord(fixture.directory)).toMatchObject({ patch: null });
		await coordinator.close();
	});

	it("rejects successor authority before mediator recovery or inspection", async () => {
		const fixture = await activeTurnFixture();
		await fixture.store.claimPatchCall(dynamicRequest("successor-fence", "sensitive patch"));
		const mediator = fakeMediator();
		const successor = testAuthority({
			grant_id: "71000000-0000-4000-8000-000000000006",
			lease_id: "71000000-0000-4000-8000-000000000007",
			fencing_token: "9007199254740994",
		});
		const coordinator = coordinatorFor(fixture.store, mediator, successor);

		await expect(coordinator.recover()).rejects.toEqual(
			new CodexDynamicPatchToolCoordinatorError(),
		);
		expect(mediator.recover).not.toHaveBeenCalled();
		expect(mediator.inspect).not.toHaveBeenCalled();
		expect(mediator.apply).not.toHaveBeenCalled();
		expect(await onlyPatchRecord(fixture.directory)).toMatchObject({
			patch: "sensitive patch",
			receipt: null,
		});
		await coordinator.close();
	});

	it("does not inspect or scrub after an untyped recovery failure", async () => {
		const fixture = await activeTurnFixture();
		await fixture.store.claimPatchCall(dynamicRequest("recovery-failure", "retained raw patch"));
		const mediator = fakeMediator({
			recover: vi.fn(async () => {
				throw new Error("private recovery failure");
			}),
		});
		const coordinator = coordinatorFor(fixture.store, mediator);

		await expect(coordinator.recover()).rejects.toEqual(
			new CodexDynamicPatchToolCoordinatorError(),
		);
		expect(mediator.inspect).not.toHaveBeenCalled();
		expect(await onlyPatchRecord(fixture.directory)).toMatchObject({
			patch: "retained raw patch",
			receipt: null,
		});
		await coordinator.close();
	});

	it("retains only a redacted terminal marker for rejected and indeterminate recovery", async () => {
		const rejectedFixture = await activeTurnFixture();
		await rejectedFixture.store.claimPatchCall(dynamicRequest("rejected-call"));
		const rejectedMediator = fakeMediator({
			inspect: vi.fn(async () => ({ state: "rejected" as const })),
		});
		const rejected = coordinatorFor(rejectedFixture.store, rejectedMediator);
		await rejected.recover();
		expect(await onlyPatchRecord(rejectedFixture.directory)).toMatchObject({
			patch: null,
			receipt: { outcome: "rejected", source: "mediator" },
		});
		await rejected.close();

		const indeterminateFixture = await activeTurnFixture();
		const indeterminateCall = await indeterminateFixture.store.claimPatchCall(
			dynamicRequest("indeterminate-call"),
		);
		if (indeterminateCall.kind !== "pending") throw new Error("Expected pending request");
		const transactionId = codexPatchTransactionId(codexPatchKey(indeterminateCall.call));
		const indeterminateMediator = fakeMediator({
			recover: vi.fn(async () => {
				throw new CodexWorkspacePatchError(
					"indeterminate",
					true,
					"private indeterminate detail",
					transactionId,
				);
			}),
			inspect: vi.fn(async () => ({ state: "indeterminate" as const })),
		});
		const indeterminate = coordinatorFor(indeterminateFixture.store, indeterminateMediator);
		await expect(indeterminate.recover()).rejects.toEqual(
			new CodexDynamicPatchToolCoordinatorError(),
		);
		expect(await onlyPatchRecord(indeterminateFixture.directory)).toMatchObject({
			patch: null,
			receipt: { outcome: "indeterminate" },
		});
		await expect(indeterminate.recover()).rejects.toEqual(
			new CodexDynamicPatchToolCoordinatorError(),
		);
		await expect(
			indeterminate.handle(dynamicCall("different-call"), new AbortController().signal),
		).rejects.toEqual(new CodexDynamicPatchToolCoordinatorError());
		expect(indeterminateMediator.recover).toHaveBeenCalledTimes(3);
		expect(indeterminateMediator.inspect).toHaveBeenCalledTimes(1);
		expect(indeterminateMediator.apply).not.toHaveBeenCalled();
		expect(await onlyPatchRecord(indeterminateFixture.directory)).toMatchObject({
			call_id: "indeterminate-call",
			patch: null,
			receipt: { outcome: "indeterminate" },
		});
		await indeterminate.close();
	});

	it("lets an admitted patch finish across later cancellation and waits for it on close", async () => {
		const fixture = await activeTurnFixture();
		let release!: () => void;
		let started!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const applying = new Promise<void>((resolve) => {
			started = resolve;
		});
		const apply = vi.fn(async (value: unknown) => {
			const call = value as CodexPatchToolCall;
			started();
			await gate;
			return appliedResult(call);
		});
		const mediator = fakeMediator({ apply });
		const coordinator = coordinatorFor(fixture.store, mediator);
		const handling = coordinator.handle(
			dynamicCall("cancellation-race"),
			new AbortController().signal,
		);
		await applying;
		await fixture.store.requestCancellation(fixture.turn);
		const closing = coordinator.close();
		expect(mediator.close).not.toHaveBeenCalled();
		release();

		await expect(handling).resolves.toBe("applied");
		await closing;
		expect(mediator.close).toHaveBeenCalledTimes(1);
		expect(await fixture.store.inspectTurn(fixture.turn, fixture.input)).toMatchObject({
			phase: "cancelling",
			cancellationRequested: true,
		});
	});

	it("emits no outcome when an applied receipt cannot become durable, then recovers it", async () => {
		const fixture = await activeTurnFixture();
		let committedCall: CodexPatchToolCall | null = null;
		const firstMediator = fakeMediator({
			inspect: vi.fn(async (value) =>
				committedCall === null
					? ({ state: "absent" } as const)
					: ({
							state: "committed",
							result: appliedResult(value as CodexPatchToolCall),
						} as const),
			),
			apply: vi.fn(async (value) => {
				committedCall = value as CodexPatchToolCall;
				await chmod(fixture.directory, 0o500);
				return appliedResult(committedCall);
			}),
		});
		const first = coordinatorFor(fixture.store, firstMediator);

		await expect(
			first.handle(dynamicCall("receipt-write-failure"), new AbortController().signal),
		).rejects.toEqual(new CodexDynamicPatchToolCoordinatorError());
		await chmod(fixture.directory, 0o700);
		expect(await onlyPatchRecord(fixture.directory)).toMatchObject({
			patch: "diff --git a/a b/a\n",
			receipt: null,
		});
		await first.close();

		if (committedCall === null) throw new Error("Expected committed call");
		const recoveredMediator = fakeMediator({
			inspect: vi.fn(async () => ({
				state: "committed" as const,
				result: appliedResult(committedCall!),
			})),
		});
		const recovered = coordinatorFor(fixture.store, recoveredMediator);
		await expect(
			recovered.handle(dynamicCall("receipt-write-failure"), new AbortController().signal),
		).resolves.toBe("applied");
		expect(await onlyPatchRecord(fixture.directory)).toMatchObject({
			patch: null,
			receipt: { outcome: "applied" },
		});
		await recovered.close();
	});

	it("does not publish a request when the handler signal is already cancelled", async () => {
		const fixture = await activeTurnFixture();
		const mediator = fakeMediator();
		const coordinator = coordinatorFor(fixture.store, mediator);
		const abort = new AbortController();
		abort.abort(new Error("provider closed"));

		await expect(coordinator.handle(dynamicCall("aborted"), abort.signal)).rejects.toEqual(
			new CodexDynamicPatchToolCoordinatorError(),
		);
		expect(
			await fixture.store.pendingPatchCalls(codexPatchAuthorityRecord(testAuthority())),
		).toEqual([]);
		expect(mediator.recover).not.toHaveBeenCalled();
		expect(mediator.inspect).not.toHaveBeenCalled();
		expect(mediator.apply).not.toHaveBeenCalled();
		await coordinator.close();
	});

	it("attests one exact applied provider item against its durable receipt and committed core", async () => {
		const fixture = await activeTurnFixture();
		const call = dynamicCall("attested-applied");
		let committed: CodexPatchToolCall | null = null;
		const mediator = fakeMediator({
			inspect: vi.fn(async (value) =>
				committed === null
					? ({ state: "absent" } as const)
					: ({ state: "committed", result: appliedResult(value as CodexPatchToolCall) } as const),
			),
			apply: vi.fn(async (value) => {
				committed = value as CodexPatchToolCall;
				return appliedResult(committed);
			}),
		});
		const coordinator = coordinatorFor(fixture.store, mediator);
		expect(await coordinator.handle(call, new AbortController().signal)).toBe("applied");

		const proof = await coordinator.attestTerminal(
			fixture.turn,
			call.threadId,
			terminalPatchTurn([dynamicPatchItem(call, "applied")]),
		);

		expect(proof).toMatchObject({
			providerTurnId: call.turnId,
			fatalPatchFailure: false,
			calls: [{ callId: call.callId, itemSha256: expect.stringMatching(/^[a-f0-9]{64}$/) }],
		});
		expect(Object.isFrozen(proof)).toBe(true);
		expect(Object.isFrozen(proof.calls)).toBe(true);
		expect(Object.isFrozen(proof.calls[0])).toBe(true);
		expect(mediator.inspect).toHaveBeenCalledTimes(2);
		await coordinator.close();
	});

	it("attests capsule-policy and mediator rejections only against their exact no-effect state", async () => {
		const policyFixture = await activeTurnFixture();
		await policyFixture.store.requestCancellation(policyFixture.turn);
		const policyCall = dynamicCall("policy-rejected");
		const policyMediator = fakeMediator();
		const policy = coordinatorFor(policyFixture.store, policyMediator);
		expect(await policy.handle(policyCall, new AbortController().signal)).toBe("rejected");
		await expect(
			policy.attestTerminal(
				policyFixture.turn,
				policyCall.threadId,
				terminalPatchTurn([dynamicPatchItem(policyCall, "rejected")], "interrupted"),
			),
		).resolves.toMatchObject({ calls: [{ callId: policyCall.callId }] });
		await policy.close();

		const mediatorFixture = await activeTurnFixture();
		const mediatorCall = dynamicCall("mediator-rejected");
		const claim = await mediatorFixture.store.claimPatchCall(
			dynamicRequest(mediatorCall.callId, mediatorCall.patch),
		);
		if (claim.kind !== "pending") throw new Error("Expected a pending mediator call");
		await mediatorFixture.store.recordPatchCallReceipt(
			claim.call,
			codexPatchAuthorityRecord(testAuthority()),
			{ outcome: "rejected", source: "mediator" },
		);
		const mediator = fakeMediator({
			inspect: vi.fn(async () => ({ state: "rejected" as const })),
		});
		const coordinator = coordinatorFor(mediatorFixture.store, mediator);
		await expect(
			coordinator.attestTerminal(
				mediatorFixture.turn,
				mediatorCall.threadId,
				terminalPatchTurn([dynamicPatchItem(mediatorCall, "rejected")]),
			),
		).resolves.toMatchObject({ calls: [{ callId: mediatorCall.callId }] });
		await coordinator.close();
	});

	it("fails closed when durable rejection provenance and mediator state cross", async () => {
		for (const scenario of [
			{ source: "capsule_policy" as const, core: "rejected" as const },
			{ source: "mediator" as const, core: "absent" as const },
		]) {
			const fixture = await activeTurnFixture();
			const call = dynamicCall(`cross-${scenario.source}`);
			const claim = await fixture.store.claimPatchCall(dynamicRequest(call.callId, call.patch));
			if (claim.kind !== "pending") throw new Error("Expected a pending rejection call");
			await fixture.store.recordPatchCallReceipt(
				claim.call,
				codexPatchAuthorityRecord(testAuthority()),
				{ outcome: "rejected", source: scenario.source },
			);
			const coordinator = coordinatorFor(
				fixture.store,
				fakeMediator({ inspect: vi.fn(async () => ({ state: scenario.core })) }),
			);
			await expect(
				coordinator.attestTerminal(
					fixture.turn,
					call.threadId,
					terminalPatchTurn([dynamicPatchItem(call, "rejected")]),
				),
			).rejects.toEqual(new CodexDynamicPatchToolCoordinatorError());
			await coordinator.close();
		}
	});

	it("classifies only provider response and forbidden-item mismatches after exact core proof", async () => {
		const fixture = await appliedCoordinatorFixture("provider-mismatch");
		const exact = dynamicPatchItem(fixture.call, "applied");
		const fallback = {
			...exact,
			status: "failed" as const,
			contentItems: [],
			success: false,
		};
		await expect(
			fixture.coordinator.attestTerminal(
				fixture.turn,
				fixture.call.threadId,
				terminalPatchTurn([fallback]),
			),
		).rejects.toEqual(new CodexTerminalPatchPolicyMismatchError());
		await expect(
			fixture.coordinator.attestTerminal(
				fixture.turn,
				fixture.call.threadId,
				terminalPatchTurn([exact, { type: "fileChange", id: "native-write" }]),
			),
		).rejects.toEqual(new CodexTerminalPatchPolicyMismatchError());
		for (const status of ["failed", "interrupted"] as const) {
			await expect(
				fixture.coordinator.attestTerminal(
					fixture.turn,
					fixture.call.threadId,
					terminalPatchTurn([fallback], status),
				),
			).resolves.toMatchObject({ calls: [{ callId: fixture.call.callId }] });
		}
		await expect(
			fixture.coordinator.attestTerminal(
				fixture.turn,
				fixture.call.threadId,
				terminalPatchTurn([{ ...exact, arguments: { patch: "altered duplicate" } }, exact]),
			),
		).rejects.toEqual(new CodexTerminalPatchPolicyMismatchError());

		// With raw patch scrubbed at receipt, a missing/altered call cannot be re-inspected exactly.
		await expect(
			fixture.coordinator.attestTerminal(
				fixture.turn,
				fixture.call.threadId,
				terminalPatchTurn([]),
			),
		).rejects.toEqual(new CodexDynamicPatchToolCoordinatorError());
		await fixture.coordinator.close();
	});

	it("keeps mediator inspection failure and indeterminate receipts unproven", async () => {
		const inspectionFailure = await appliedCoordinatorFixture("inspection-failure");
		vi.mocked(inspectionFailure.mediator.inspect).mockRejectedValueOnce(
			new Error("core inspection unavailable"),
		);
		await expect(
			inspectionFailure.coordinator.attestTerminal(
				inspectionFailure.turn,
				inspectionFailure.call.threadId,
				terminalPatchTurn([dynamicPatchItem(inspectionFailure.call, "applied")]),
			),
		).rejects.toEqual(new CodexDynamicPatchToolCoordinatorError());
		await inspectionFailure.coordinator.close();

		const fixture = await activeTurnFixture();
		const call = dynamicCall("unattestable-indeterminate");
		const claim = await fixture.store.claimPatchCall(dynamicRequest(call.callId, call.patch));
		if (claim.kind !== "pending") throw new Error("Expected a pending receipt call");
		await fixture.store.recordPatchCallReceipt(
			claim.call,
			codexPatchAuthorityRecord(testAuthority()),
			{ outcome: "indeterminate" },
		);
		const mediator = fakeMediator();
		const coordinator = coordinatorFor(fixture.store, mediator);
		await expect(
			coordinator.attestTerminal(
				fixture.turn,
				call.threadId,
				terminalPatchTurn([dynamicPatchItem(call, "rejected")]),
			),
		).rejects.toEqual(new CodexDynamicPatchToolCoordinatorError());
		expect(mediator.inspect).not.toHaveBeenCalled();
		await coordinator.close();
	});

	it("attests a fatal pre-effect receipt only against exact absent core state", async () => {
		const fixture = await activeTurnFixture();
		const call = dynamicCall("fatal-no-effect");
		const claim = await fixture.store.claimPatchCall(dynamicRequest(call.callId, call.patch));
		if (claim.kind !== "pending") throw new Error("Expected a pending fatal call");
		await fixture.store.recordPatchCallReceipt(
			claim.call,
			codexPatchAuthorityRecord(testAuthority()),
			{ outcome: "failed", classification: "fatal" },
		);
		const mediator = fakeMediator();
		const coordinator = coordinatorFor(fixture.store, mediator);
		await expect(
			coordinator.attestTerminal(
				fixture.turn,
				call.threadId,
				terminalPatchTurn([dynamicPatchItem(call, "rejected")], "interrupted"),
			),
		).resolves.toMatchObject({
			fatalPatchFailure: true,
			calls: [{ callId: call.callId }],
		});
		expect(mediator.inspect).toHaveBeenCalledTimes(1);
		vi.mocked(mediator.inspect).mockResolvedValueOnce({ state: "rejected" });
		await expect(
			coordinator.attestTerminal(
				fixture.turn,
				call.threadId,
				terminalPatchTurn([dynamicPatchItem(call, "rejected")], "interrupted"),
			),
		).rejects.toEqual(new CodexDynamicPatchToolCoordinatorError());
		await coordinator.close();
	});

	it("forces failure when a fatal call follows an earlier committed patch", async () => {
		const fixture = await activeTurnFixture();
		const applied = dynamicCall("mixed-applied", "first patch");
		const fatal = dynamicCall("mixed-fatal", "second patch");
		const appliedClaim = await fixture.store.claimPatchCall(
			dynamicRequest(applied.callId, applied.patch),
		);
		if (appliedClaim.kind !== "pending") throw new Error("Expected an applied request");
		await fixture.store.recordPatchCallReceipt(
			appliedClaim.call,
			codexPatchAuthorityRecord(testAuthority()),
			{ outcome: "applied", result: appliedResult(appliedClaim.call) },
		);
		const fatalClaim = await fixture.store.claimPatchCall(
			dynamicRequest(fatal.callId, fatal.patch),
		);
		if (fatalClaim.kind !== "pending") throw new Error("Expected a fatal request");
		await fixture.store.recordPatchCallReceipt(
			fatalClaim.call,
			codexPatchAuthorityRecord(testAuthority()),
			{ outcome: "failed", classification: "fatal" },
		);
		const mediator = fakeMediator({
			inspect: vi.fn(async (value) => {
				const call = value as CodexPatchToolCall;
				return call.callId === applied.callId
					? ({ state: "committed", result: appliedResult(call) } as const)
					: ({ state: "absent" } as const);
			}),
		});
		const coordinator = coordinatorFor(fixture.store, mediator);

		const proof = await coordinator.attestTerminal(
			fixture.turn,
			applied.threadId,
			terminalPatchTurn(
				[dynamicPatchItem(applied, "applied"), dynamicPatchItem(fatal, "rejected")],
				"interrupted",
			),
		);
		expect(proof.fatalPatchFailure).toBe(true);
		expect(proof.calls.map((call) => call.callId)).toEqual([applied.callId, fatal.callId]);
		expect(mediator.inspect).toHaveBeenCalledTimes(2);
		await coordinator.close();
	});

	it("proves cold abandonment only for an authority-bound turn with zero durable calls", async () => {
		const empty = await activeTurnFixture();
		await empty.store.acceptTurn(empty.input, "provider-turn-private-1");
		const emptyCoordinator = coordinatorFor(empty.store, fakeMediator());
		await expect(
			emptyCoordinator.assertNoPatchCallsForAbandonment(
				empty.turn,
				"provider-thread-private-1",
				"provider-turn-private-1",
			),
		).resolves.toBeUndefined();
		await emptyCoordinator.close();

		const receipted = await appliedCoordinatorFixture("cold-receipt");
		await expect(
			receipted.coordinator.assertNoPatchCallsForAbandonment(
				receipted.turn,
				receipted.call.threadId,
				receipted.call.turnId,
			),
		).rejects.toEqual(new CodexDynamicPatchToolCoordinatorError());
		expect(receipted.mediator.apply).toHaveBeenCalledTimes(1);
		await receipted.coordinator.close();
	});

	it("refuses terminal and cold-abandonment proof after runtime authority revocation", async () => {
		const fixture = await activeTurnFixture();
		await fixture.store.acceptTurn(fixture.input, "provider-turn-private-1");
		const abort = new AbortController();
		const authority = { ...testAuthority(), signal: abort.signal };
		const mediator = fakeMediator();
		const coordinator = coordinatorFor(fixture.store, mediator, authority);
		abort.abort(new Error("authority revoked"));

		await expect(
			coordinator.assertNoPatchCallsForAbandonment(
				fixture.turn,
				"provider-thread-private-1",
				"provider-turn-private-1",
			),
		).rejects.toEqual(new CodexDynamicPatchToolCoordinatorError());
		await expect(
			coordinator.attestTerminal(fixture.turn, "provider-thread-private-1", terminalPatchTurn([])),
		).rejects.toEqual(new CodexDynamicPatchToolCoordinatorError());
		expect(mediator.recover).not.toHaveBeenCalled();
		await coordinator.close();
	});
});

async function appliedCoordinatorFixture(callId: string) {
	const fixture = await activeTurnFixture();
	const call = dynamicCall(callId);
	let committed = false;
	const mediator = fakeMediator({
		inspect: vi.fn(async (value) =>
			committed
				? ({
						state: "committed",
						result: appliedResult(value as CodexPatchToolCall),
					} as const)
				: ({ state: "absent" } as const),
		),
		apply: vi.fn(async (value) => {
			committed = true;
			return appliedResult(value as CodexPatchToolCall);
		}),
	});
	const coordinator = coordinatorFor(fixture.store, mediator);
	expect(await coordinator.handle(call, new AbortController().signal)).toBe("applied");
	return { ...fixture, call, mediator, coordinator };
}

function terminalPatchTurn(
	items: CodexTurn["items"],
	status: Exclude<CodexTurn["status"], "inProgress"> = "completed",
): CodexTurn {
	return {
		id: "provider-turn-private-1",
		items,
		itemsView: "full",
		status,
		error: null,
		startedAt: 1,
		completedAt: 2,
		durationMs: 1,
	};
}

function dynamicPatchItem(
	call: ReturnType<typeof dynamicCall>,
	outcome: "applied" | "rejected",
): CodexDynamicToolCallItem {
	const response = codexDynamicPatchToolResponse(outcome);
	return {
		type: "dynamicToolCall",
		id: call.callId,
		namespace: "agentrelay",
		tool: "apply_patch",
		arguments: { patch: call.patch },
		status: outcome === "applied" ? "completed" : "failed",
		contentItems: [...response.contentItems],
		success: response.success,
		durationMs: 1,
	};
}

function coordinatorFor(
	store: CodexCapsuleStore,
	mediator: CodexWorkspacePatchMediator,
	authority = testAuthority(),
) {
	return new CodexDynamicPatchToolCoordinator({
		capsuleId: IDS.capsule,
		store,
		mediator,
		authority,
	});
}

function fakeMediator(
	overrides: Partial<CodexWorkspacePatchMediator> = {},
): CodexWorkspacePatchMediator {
	return {
		recover: vi.fn(async () => []),
		apply: vi.fn(async (value) => appliedResult(value as CodexPatchToolCall)),
		inspect: vi.fn(async () => ({ state: "absent" as const })),
		close: vi.fn(async () => undefined),
		...overrides,
	};
}

function testAuthority(
	overrides: Partial<Parameters<typeof authorityGrant>[0]> = {},
): CapsuleRuntimeActivation {
	const base = authorityGrant();
	return {
		grant: authorityGrant({
			mission_id: IDS.mission,
			delivery_id: IDS.delivery,
			workspace_alias: "backend-primary",
			capabilities: [...base.capabilities, { action: "workspace_write", resource: "workspace" }],
			...overrides,
		}),
		signal: new AbortController().signal,
		performWorkspaceRead: async (effect) => effect(),
		performWorkspaceWrite: async (effect) => effect(),
	};
}

async function activeTurnFixture() {
	const directory = await realpath(await mkdtemp(join(tmpdir(), "agentrelay-patch-tool-")));
	directories.push(directory);
	const store = await CodexCapsuleStore.open(directory, {
		capsuleId: IDS.capsule,
		session: {
			missionId: IDS.mission,
			participantId: IDS.participant,
			workspaceAlias: "backend-primary",
		},
	});
	await store.claimSessionStart();
	const session = await store.acceptSession("provider-thread-private-1");
	const input = turnInput(session);
	const turn = await store.prepareTurn(input, CODEX_DYNAMIC_PATCH_TOOL_CONTRACT);
	await store.claimTurnStart(input);
	return { directory, store, input, turn };
}

async function onlyPatchRecord(directory: string): Promise<Record<string, unknown>> {
	const state = JSON.parse(await readFile(join(directory, CODEX_CAPSULE_STATE_FILE), "utf8")) as {
		turns: Record<string, { patch_calls: Record<string, Record<string, unknown>> }>;
	};
	const records = Object.values(state.turns[`${IDS.delivery}:1`]!.patch_calls);
	expect(records).toHaveLength(1);
	return records[0]!;
}

function dynamicCall(callId: string, patch = "diff --git a/a b/a\n") {
	return {
		threadId: "provider-thread-private-1",
		turnId: "provider-turn-private-1",
		callId,
		patch,
	};
}

function dynamicRequest(callId: string, patch = "diff --git a/a b/a\n") {
	const call = dynamicCall(callId, patch);
	return {
		providerThreadId: call.threadId,
		providerTurnId: call.turnId,
		callId: call.callId,
		patch: call.patch,
		authority: codexPatchAuthorityRecord(testAuthority()),
	};
}

function appliedResult(call: CodexPatchToolCall): CodexPatchResult {
	return {
		transactionId: codexPatchTransactionId(codexPatchKey(call)),
		patchSha256: codexPatchSha256(call.patch),
		planSha256: "b".repeat(64),
		filesChanged: 1,
	};
}

function turnInput(session: HostSessionRef): StartTurnInput {
	return {
		session,
		missionId: IDS.mission,
		deliveryId: IDS.delivery,
		executionAttempt: 1,
		contractVersion: 1,
		missionSequence: 2,
		objective: {
			text: "Build the compatible backend changes.",
			authorPrincipalId: IDS.owner,
			provenance: "mission_manifest",
		},
		assignment: {
			text: "Apply the bounded patch.",
			authorPrincipalId: IDS.owner,
			provenance: "mission_manifest",
		},
		acceptanceCriteria: [
			{
				text: "Return one compatible implementation.",
				authorPrincipalId: IDS.owner,
				provenance: "mission_manifest",
			},
		],
		peerMessages: [],
		artifacts: [],
	};
}
