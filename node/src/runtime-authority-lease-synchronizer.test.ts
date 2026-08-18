import type { DeliveryLease } from "@agentrelay/protocol";
import { describe, expect, it, vi } from "vitest";
import {
	RuntimeAuthorityLeaseSynchronizer,
	RuntimeAuthoritySyncError,
} from "./runtime-authority-lease-synchronizer.js";
import {
	type NodeRuntimeAuthoritySession,
	RuntimeAuthorityRetirementError,
} from "./runtime-authority-session.js";

describe("RuntimeAuthorityLeaseSynchronizer", () => {
	it("preserves the exact retirement failure behind a renewal sync error", async () => {
		const teardownFailure = new Error("Capsule retirement timed out");
		const authorityFailure = new Error("Capsule renewal response lost");
		const retirementFailure = new RuntimeAuthorityRetirementError(
			teardownFailure,
			authorityFailure,
		);
		const renew = vi.fn().mockRejectedValue(retirementFailure);
		const session = {
			grant: { grant_id: "50000000-0000-4000-8000-000000000001" },
			renew,
		} as unknown as NodeRuntimeAuthoritySession;
		const lease: DeliveryLease = {
			lease_id: "60000000-0000-4000-8000-000000000001",
			fencing_token: "1",
			expires_at: "2026-08-02T00:20:00.000Z",
		};
		const synchronizer = new RuntimeAuthorityLeaseSynchronizer();
		await synchronizer.bind(session);

		let failure: unknown;
		try {
			await synchronizer.forward(lease);
		} catch (error) {
			failure = error;
		}

		expect(failure).toBeInstanceOf(RuntimeAuthoritySyncError);
		if (!(failure instanceof RuntimeAuthoritySyncError)) return;
		expect(failure.cause).toBe(retirementFailure);
		expect(retirementFailure.cause).toBe(teardownFailure);
		expect(renew).toHaveBeenCalledOnce();
	});
});
