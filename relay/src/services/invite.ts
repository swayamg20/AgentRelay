import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export const InvitePayload = z.object({
	relay_url: z.string().url(),
	handle: z.string().min(1),
	role: z.string().min(1),
	inviter_handle: z.string().min(1),
	jti: z.string().uuid(),
	exp: z.number().int().positive(),
});

export type InvitePayload = z.infer<typeof InvitePayload>;

type MintInviteTokenArgs = {
	jti?: string;
	payload: Omit<InvitePayload, "jti"> & { jti?: string };
	secret: string;
};

type VerifyInviteTokenArgs = {
	token: string;
	secret: string;
};

type VerifyInviteTokenResult =
	| { ok: true; jti: string; payload: InvitePayload }
	| { ok: false; reason: string };

const TOKEN_VERSION = "v1";
const BASE64URL_RE = /^[A-Za-z0-9_-]+={0,2}$/;

export function mintInviteToken({ jti, payload, secret }: MintInviteTokenArgs): string {
	const parsedPayload = InvitePayload.parse({ ...payload, jti: jti ?? payload.jti });
	const encodedPayload = encodeBase64Url(Buffer.from(JSON.stringify(parsedPayload), "utf8"));
	const signature = encodeBase64Url(signPayload(encodedPayload, secret));
	return `${TOKEN_VERSION}.${encodedPayload}.${signature}`;
}

export function verifyInviteToken({
	token,
	secret,
}: VerifyInviteTokenArgs): VerifyInviteTokenResult {
	const parts = token.split(".");
	if (parts.length !== 3) {
		return { ok: false, reason: "malformed token" };
	}

	const [version, encodedPayload, encodedSignature] = parts as [string, string, string];
	if (version !== TOKEN_VERSION) {
		return { ok: false, reason: "unsupported token version" };
	}

	const normalizedPayload = normalizeBase64Url(encodedPayload);
	if (normalizedPayload === null) {
		return { ok: false, reason: "malformed payload" };
	}

	const signature = decodeBase64Url(encodedSignature);
	if (signature === null) {
		return { ok: false, reason: "malformed signature" };
	}

	const expectedSignature = signPayload(normalizedPayload, secret);
	if (signature.length !== expectedSignature.length) {
		return { ok: false, reason: "invalid signature" };
	}

	if (!timingSafeEqual(signature, expectedSignature)) {
		return { ok: false, reason: "invalid signature" };
	}

	const payloadBuffer = decodeBase64Url(normalizedPayload);
	if (payloadBuffer === null) {
		return { ok: false, reason: "malformed payload" };
	}

	const payloadJson = parseJson(payloadBuffer);
	if (payloadJson === null) {
		return { ok: false, reason: "invalid payload json" };
	}

	const parsedPayload = InvitePayload.safeParse(payloadJson);
	if (!parsedPayload.success) {
		return { ok: false, reason: "invalid payload" };
	}

	return { ok: true, jti: parsedPayload.data.jti, payload: parsedPayload.data };
}

export function hashToken(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}

function signPayload(encodedPayload: string, secret: string): Buffer {
	return createHmac("sha256", secret).update(encodedPayload).digest();
}

function encodeBase64Url(buffer: Buffer): string {
	return buffer.toString("base64url");
}

function decodeBase64Url(value: string): Buffer | null {
	const normalized = normalizeBase64Url(value);
	if (normalized === null) {
		return null;
	}

	return Buffer.from(padBase64Url(normalized), "base64url");
}

function normalizeBase64Url(value: string | undefined): string | null {
	if (value === undefined || value.length === 0 || !BASE64URL_RE.test(value)) {
		return null;
	}

	const paddingIndex = value.indexOf("=");
	if (paddingIndex !== -1 && !/^=+$/.test(value.slice(paddingIndex))) {
		return null;
	}

	const normalized = value.replace(/=+$/, "");
	const paddingLength = value.length - normalized.length;
	if (paddingLength > 2 || normalized.length % 4 === 1) {
		return null;
	}

	return normalized;
}

function padBase64Url(value: string): string {
	const paddingLength = (4 - (value.length % 4)) % 4;
	return `${value}${"=".repeat(paddingLength)}`;
}

function parseJson(buffer: Buffer): unknown | null {
	try {
		return JSON.parse(buffer.toString("utf8")) as unknown;
	} catch {
		return null;
	}
}
