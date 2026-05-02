// AES-256-GCM symmetric encryption for notification_webhook_url at rest.
// Key derived from RELAY_ENCRYPTION_KEY via SHA-256 to normalize length.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const ALGO = "aes-256-gcm";
const IV_LEN = 12;

function deriveKey(secret: string): Buffer {
	return createHash("sha256").update(secret).digest();
}

export function encryptWebhook(plaintext: string, secret: string): string {
	const key = deriveKey(secret);
	const iv = randomBytes(IV_LEN);
	const cipher = createCipheriv(ALGO, key, iv);
	const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
	const tag = cipher.getAuthTag();
	// payload format: <iv><tag><ciphertext>, base64-encoded with marker
	return `enc:v1:${Buffer.concat([iv, tag, enc]).toString("base64")}`;
}

export function decryptWebhook(payload: string, secret: string): string {
	if (!payload.startsWith("enc:v1:")) {
		throw new Error("webhook payload is not encrypted with v1");
	}
	const buf = Buffer.from(payload.slice("enc:v1:".length), "base64");
	const iv = buf.subarray(0, IV_LEN);
	const tag = buf.subarray(IV_LEN, IV_LEN + 16);
	const ciphertext = buf.subarray(IV_LEN + 16);
	const decipher = createDecipheriv(ALGO, deriveKey(secret), iv);
	decipher.setAuthTag(tag);
	return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
