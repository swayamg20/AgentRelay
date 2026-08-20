import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CapsuleAuthority } from "./capsule-authority.js";
import { AUTHORITY_IDS, AUTHORITY_NOW, authorityGrant } from "./runtime-authority.test-support.js";

const session = {
	missionId: AUTHORITY_IDS.mission,
	participantId: AUTHORITY_IDS.agent,
	workspaceAlias: "backend",
};

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(AUTHORITY_NOW);
});

afterEach(() => vi.useRealTimers());

describe("CapsuleAuthority workspace access", () => {
	it("independently denies a workspace write missing from the installed grant", async () => {
		const authority = installedAuthority(authorityGrant());
		const effect = vi.fn();

		await expect(
			authority.performSession(session, (activation) => activation.performWorkspaceWrite(effect)),
		).rejects.toMatchObject({ code: "capability_missing" });

		expect(effect).not.toHaveBeenCalled();
	});

	it("independently allows a workspace write present in the installed grant", async () => {
		const base = authorityGrant();
		const grant = authorityGrant({
			capabilities: [...base.capabilities, { action: "workspace_write", resource: "workspace" }],
		});
		const authority = installedAuthority(grant);
		const effect = vi.fn(() => "changed");

		await expect(
			authority.performSession(session, (activation) => activation.performWorkspaceWrite(effect)),
		).resolves.toBe("changed");

		expect(effect).toHaveBeenCalledOnce();
	});
});

function installedAuthority(grant: ReturnType<typeof authorityGrant>): CapsuleAuthority {
	const authority = new CapsuleAuthority({ retire: () => undefined });
	authority.install(grant, {
		grant_id: grant.grant_id,
		lease_id: grant.lease_id,
		fencing_token: grant.fencing_token,
		lease_expires_at: grant.lease_expires_at,
	});
	return authority;
}
