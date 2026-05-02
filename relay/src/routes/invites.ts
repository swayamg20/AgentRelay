import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { KeyEnvironment } from "../auth/keys.js";
import { adminAuth } from "../auth/middleware.js";
import type { Database } from "../db/client.js";
import { agents, invites } from "../db/schema.js";
import { RelayError } from "../errors.js";
import { registerAgentWithInitialKey } from "../services/agent-registration.js";
import { writeAudit } from "../services/audit.js";
import {
	type InvitePayload,
	hashToken,
	mintInviteToken,
	verifyInviteToken,
} from "../services/invite.js";
import type { AppEnv } from "../types.js";

type InviteRow = typeof invites.$inferSelect;

interface RedeemFailure {
	ok: false;
	status: 401 | 404 | 410;
	body: { error: string; message?: string };
}

interface RedeemSuccess {
	ok: true;
	body: {
		agent_id: string;
		handle: string;
		api_key: string;
	};
}

type RedeemResult = RedeemFailure | RedeemSuccess;

const createInviteSchema = z.object({
	inviter_handle: z.string().min(1),
	handle: z.string().min(1),
	role: z.string().min(1),
	expires_in_seconds: z.number().int().positive().default(86_400),
});

const redeemInviteSchema = z.object({
	token: z.string().min(1),
});

const inviteParamSchema = z.object({
	jti: z.string().uuid(),
});

export interface InviteRoutesOptions {
	db: Database;
	adminToken: string;
	pepper: string;
	keyEnvironment: KeyEnvironment;
	publicUrl: string;
	inviteSecret: string;
}

function redeemFailure(
	status: RedeemFailure["status"],
	error: string,
	message?: string,
): RedeemFailure {
	return { ok: false, status, body: message ? { error, message } : { error } };
}

function validateRedeemToken(token: string, jti: string, secret: string): RedeemFailure | null {
	const verified = verifyInviteToken({ token, secret });
	if (!verified.ok) {
		return redeemFailure(401, "invalid_token", verified.reason);
	}
	if (verified.payload.jti !== jti) {
		return redeemFailure(401, "jti_mismatch");
	}
	if (verified.payload.exp * 1000 < Date.now()) {
		return redeemFailure(410, "expired");
	}
	return null;
}

function validateInviteRow(invite: InviteRow, tokenHash: string, now: Date): RedeemFailure | null {
	if (invite.tokenHash !== tokenHash) {
		return redeemFailure(401, "token_mismatch");
	}
	if (invite.usedAt !== null) {
		return redeemFailure(410, "already_used");
	}
	if (invite.expiresAt.getTime() <= now.getTime()) {
		return redeemFailure(410, "expired");
	}
	return null;
}

export function createInviteRoutes(opts: InviteRoutesOptions): Hono<AppEnv> {
	const router = new Hono<AppEnv>();

	router.use("/admin/*", adminAuth({ adminToken: opts.adminToken }));

	router.post("/admin/invites", async (c) => {
		const body = await c.req.json().catch(() => null);
		const parsed = createInviteSchema.safeParse(body);
		if (!parsed.success) {
			throw new RelayError("invalid_params", "Invalid invite payload", {
				issues: parsed.error.issues,
			});
		}
		const input = parsed.data;
		const jti = randomUUID();
		const exp = Math.floor(Date.now() / 1000) + input.expires_in_seconds;
		const payload: InvitePayload = {
			relay_url: opts.publicUrl,
			handle: input.handle,
			role: input.role,
			inviter_handle: input.inviter_handle,
			jti,
			exp,
		};
		const token = mintInviteToken({ jti, payload, secret: opts.inviteSecret });
		const tokenHash = hashToken(token);
		const expiresAt = new Date(payload.exp * 1000);
		const requestId = c.get("requestId");

		await opts.db.transaction(async (tx) => {
			const [inviter] = await tx
				.select({ id: agents.id })
				.from(agents)
				.where(eq(agents.handle, input.inviter_handle));
			if (!inviter) {
				throw new RelayError(
					"recipient_not_found",
					`No agent with handle '${input.inviter_handle}'`,
				);
			}

			await tx.insert(invites).values({
				jti,
				tokenHash,
				handle: input.handle,
				role: input.role,
				inviterId: inviter.id,
				expiresAt,
			});

			await writeAudit(tx, {
				actorId: inviter.id,
				action: "invite.minted",
				resourceType: "invite",
				resourceId: jti,
				metadata: { jti, handle: input.handle, role: input.role },
				requestId,
			});
		});

		return c.json(
			{
				url: `${opts.publicUrl}/join#${token}`,
				jti,
				expires_at: expiresAt.toISOString(),
			},
			201,
		);
	});

	// TODO(issue-6 followup): per-IP rate limit on redeem.
	router.post("/invites/:jti/redeem", async (c) => {
		const params = inviteParamSchema.safeParse(c.req.param());
		if (!params.success) {
			throw new RelayError("invalid_params", "Invalid invite id");
		}

		const body = await c.req.json().catch(() => null);
		const parsed = redeemInviteSchema.safeParse(body);
		if (!parsed.success) {
			throw new RelayError("invalid_params", "Invalid invite redemption payload", {
				issues: parsed.error.issues,
			});
		}

		const tokenFailure = validateRedeemToken(parsed.data.token, params.data.jti, opts.inviteSecret);
		if (tokenFailure) return c.json(tokenFailure.body, tokenFailure.status);
		const tokenHash = hashToken(parsed.data.token);
		const requestId = c.get("requestId");
		const redeemed: RedeemResult = await opts.db.transaction(async (tx) => {
			const [invite] = await tx
				.select()
				.from(invites)
				.where(eq(invites.jti, params.data.jti))
				.for("update");
			if (!invite) {
				return redeemFailure(404, "not_found");
			}

			const now = new Date();
			const inviteFailure = validateInviteRow(invite, tokenHash, now);
			if (inviteFailure) return inviteFailure;

			const result = await registerAgentWithInitialKey(tx, {
				handle: invite.handle,
				role: invite.role,
				pepper: opts.pepper,
				keyEnvironment: opts.keyEnvironment,
			});

			await tx
				.update(invites)
				.set({ usedAt: now, usedByAgentId: result.agent.id })
				.where(eq(invites.jti, invite.jti));

			await writeAudit(tx, {
				actorId: result.agent.id,
				action: "invite.redeemed",
				resourceType: "invite",
				resourceId: invite.jti,
				metadata: { jti: invite.jti, inviter_id: invite.inviterId },
				requestId,
			});

			return {
				ok: true as const,
				body: {
					agent_id: result.agent.id,
					handle: result.agent.handle,
					api_key: result.apiKey,
				},
			};
		});

		if (!redeemed.ok) {
			return c.json(redeemed.body, redeemed.status);
		}

		return c.json(redeemed.body, 201);
	});

	return router;
}
