import { describe, expect, it } from "vitest";
import {
	InvitePayload,
	type InvitePayload as InvitePayloadType,
	hashToken,
	mintInviteToken,
	verifyInviteToken,
} from "./invite.js";

describe("invite token utilities", () => {
	const secret = "test-invite-secret";
	const payload: InvitePayloadType = {
		relay_url: "https://relay.example.com",
		handle: "agent-a",
		role: "builder",
		inviter_handle: "team-lead",
		jti: "018f0a4a-0481-7a2d-b279-4f456d50cdee",
		exp: 1_893_456_000,
	};

	it("round-trips a minted invite token", () => {
		const token = mintInviteToken({ payload, secret });
		const verified = verifyInviteToken({ token, secret });

		expect(verified).toEqual({ ok: true, jti: payload.jti, payload });
	});

	it("embeds a separately provided jti before signing", () => {
		const jti = "018f0a4a-0481-7a2d-b279-4f456d50cdef";
		const token = mintInviteToken({
			jti,
			payload: { ...payload, jti: "018f0a4a-0481-7a2d-b279-4f456d50cde0" },
			secret,
		});
		const verified = verifyInviteToken({ token, secret });

		expect(verified).toEqual({ ok: true, jti, payload: { ...payload, jti } });
	});

	it("rejects a token with a tampered payload section", () => {
		const token = mintInviteToken({ payload, secret });
		const [version, encodedPayload, encodedSignature] = token.split(".") as [
			string,
			string,
			string,
		];
		const tamperedToken = `${version}.${flipBase64UrlChar(encodedPayload)}.${encodedSignature}`;

		expect(verifyInviteToken({ token: tamperedToken, secret }).ok).toBe(false);
	});

	it("rejects a token with a tampered signature section", () => {
		const token = mintInviteToken({ payload, secret });
		const [version, encodedPayload, encodedSignature] = token.split(".") as [
			string,
			string,
			string,
		];
		const tamperedToken = `${version}.${encodedPayload}.${flipBase64UrlChar(encodedSignature)}`;

		expect(verifyInviteToken({ token: tamperedToken, secret }).ok).toBe(false);
	});

	it("rejects a token verified with the wrong secret", () => {
		const token = mintInviteToken({ payload, secret });

		expect(verifyInviteToken({ token, secret: "wrong-secret" }).ok).toBe(false);
	});

	it("rejects malformed tokens without throwing", () => {
		const token = mintInviteToken({ payload, secret });
		const [, encodedPayload, encodedSignature] = token.split(".") as [string, string, string];
		const malformedTokens = [
			"not-a-token",
			`v2.${encodedPayload}.${encodedSignature}`,
			`v1.${encodedPayload}`,
			`v1.${encodedPayload}.${encodedSignature}.extra`,
			`v1.$$$.${encodedSignature}`,
			`v1.${encodedPayload}.$$$`,
			`v1..${encodedSignature}`,
			`v1.${encodedPayload}.`,
		];

		for (const malformedToken of malformedTokens) {
			expect(() => verifyInviteToken({ token: malformedToken, secret })).not.toThrow();
			expect(verifyInviteToken({ token: malformedToken, secret }).ok).toBe(false);
		}
	});

	it("hashes tokens deterministically with sha256 hex", () => {
		expect(hashToken("abc")).toBe(
			"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
		);
		expect(hashToken("abc")).toBe(hashToken("abc"));
		expect(hashToken("abc")).not.toBe(hashToken("abcd"));
	});

	it("round-trips payloads whose standard base64 form would need padding", () => {
		const paddedPayload = payloadWithJsonLengthNotDivisibleByThree(payload);
		const token = mintInviteToken({ payload: paddedPayload, secret });
		const [version, encodedPayload, encodedSignature] = token.split(".") as [
			string,
			string,
			string,
		];
		const jsonLength = Buffer.byteLength(
			JSON.stringify(InvitePayload.parse(paddedPayload)),
			"utf8",
		);
		const paddedToken = `${version}.${padBase64Url(encodedPayload)}.${padBase64Url(encodedSignature)}`;

		expect(jsonLength % 3).not.toBe(0);
		expect(encodedPayload).not.toContain("=");
		expect(encodedSignature).not.toContain("=");
		expect(verifyInviteToken({ token: paddedToken, secret })).toEqual({
			ok: true,
			jti: paddedPayload.jti,
			payload: paddedPayload,
		});
	});
});

function flipBase64UrlChar(value: string): string {
	const replacement = value[0] === "A" ? "B" : "A";
	return `${replacement}${value.slice(1)}`;
}

function padBase64Url(value: string): string {
	const paddingLength = (4 - (value.length % 4)) % 4;
	return `${value}${"=".repeat(paddingLength)}`;
}

function payloadWithJsonLengthNotDivisibleByThree(payload: InvitePayloadType): InvitePayloadType {
	for (let handleLength = 1; handleLength <= 12; handleLength += 1) {
		const candidate = { ...payload, handle: "a".repeat(handleLength) };
		const jsonLength = Buffer.byteLength(JSON.stringify(InvitePayload.parse(candidate)), "utf8");
		if (jsonLength % 3 !== 0) {
			return candidate;
		}
	}

	throw new Error("could not find payload length requiring base64 padding");
}
