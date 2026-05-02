import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const KEY_BYTES = 20; // 20 bytes → 32 base32 chars
const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

export type KeyEnvironment = "live" | "test";

export interface GeneratedKey {
	raw: string; // returned to caller exactly once
	hash: Buffer; // sha256(pepper || raw)
	salt: Buffer; // per-row salt; unused in v0.1 lookup but kept per lld §7.1
}

function base32(bytes: Buffer): string {
	// RFC 4648 base32, lowercase, no padding. 5 bits per char.
	let bits = 0;
	let value = 0;
	let out = "";
	for (const byte of bytes) {
		value = (value << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			bits -= 5;
			const idx = (value >> bits) & 31;
			out += BASE32_ALPHABET[idx];
		}
	}
	if (bits > 0) {
		const idx = (value << (5 - bits)) & 31;
		out += BASE32_ALPHABET[idx];
	}
	return out;
}

const KEY_REGEX = /^ah_(live|test)_[a-z2-7]{32}$/;

export function isWellFormedKey(key: string): boolean {
	return KEY_REGEX.test(key);
}

export function generateKey(env: KeyEnvironment, pepper: string): GeneratedKey {
	const raw = `ah_${env}_${base32(randomBytes(KEY_BYTES))}`;
	return {
		raw,
		hash: hashKey(raw, pepper),
		salt: randomBytes(16),
	};
}

export function hashKey(rawKey: string, pepper: string): Buffer {
	return createHash("sha256").update(pepper).update(rawKey).digest();
}

export function constantTimeEqual(a: Buffer, b: Buffer): boolean {
	if (a.length !== b.length) return false;
	return timingSafeEqual(a, b);
}
