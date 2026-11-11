import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

export const shareLinkId = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

function shareContent(maxBytes: number) {
	return z
		.string()
		.min(1)
		.refine(
			(content) => !content.includes("\u0000") && Buffer.byteLength(content, "utf8") <= maxBytes,
			"Content must fit the UTF-8 byte limit and contain no NUL characters",
		);
}

export const shareHandoffInput = z
	.object({
		content: shareContent(64 * 1024),
		expires_in_days: z.number().int().min(1).max(30).default(7),
		preview_token: z.string().uuid().optional(),
	})
	.strict();

export const answerShareInput = z
	.object({
		link_id: shareLinkId,
		content: shareContent(16 * 1024),
		preview_token: z.string().uuid().optional(),
	})
	.strict();

export type SharePublication =
	| { kind: "create"; content: string; expires_in_days: number }
	| { kind: "answer"; content: string; link_id: string };

export const sharePreviewSchema = z
	.object({
		token: z.string().uuid(),
		digest: z.string().regex(/^[a-f0-9]{64}$/),
		idempotency_key: z.string().uuid(),
		created_at: z.number().int().nonnegative(),
	})
	.strict();

export type SharePreview = z.infer<typeof sharePreviewSchema>;
export const SHARE_PREVIEW_TTL_MS = 10 * 60 * 1000;

const secretPatterns = [
	/-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/,
	/\b(?:ah|ar_node)_(?:live|test)_[a-z2-7]{32}\b/,
	/\bsk-(?:proj-|svcacct-|ant-)?[A-Za-z0-9_-]{20,}/,
	/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
	/\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{20,}/,
	/\bxox[baprs]-[A-Za-z0-9-]{10,}/,
	/\bAIza[A-Za-z0-9_-]{35}\b/,
	/https:\/\/hooks\.slack\.com\/services\//i,
	/\b(?:https?|postgres(?:ql)?|mysql|redis|amqp)s?:\/\/[^\s/:@]*:[^\s/@]+@/i,
	/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
	/\b(?:authorization|proxy-authorization)\s*:\s*(?:bearer|basic)\s+[A-Za-z0-9+/_=-]{8,}/i,
	/["']?\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|(?:aws[_-]?)?secret[_-]?access[_-]?key|secret[_-]?key|private[_-]?key|password|passwd|secret|(?:relay|agentrelay)_[a-z0-9_]*(?:token|secret|key|pepper))["']?\s*[:=]\s*["']?[^\s"',;]{8,}/i,
];

export function assertShareHasNoSecrets(content: string, apiKey: string): void {
	if (
		(apiKey.length > 0 && content.includes(apiKey)) ||
		secretPatterns.some((pattern) => pattern.test(content))
	) {
		throw new Error(
			"share: secret scan blocked publication; remove credentials or secret-like values and preview again.",
		);
	}
}

export function publicationDigest(
	publication: SharePublication,
	relayUrl: string,
	senderId: string,
): string {
	const fields =
		publication.kind === "create"
			? ["create", publication.content, publication.expires_in_days]
			: ["answer", publication.content, publication.link_id];
	return createHash("sha256")
		.update(JSON.stringify([relayUrl, senderId, ...fields]))
		.digest("hex");
}

export function createSharePreview(digest: string, now = Date.now()): SharePreview {
	return { token: randomUUID(), digest, idempotency_key: randomUUID(), created_at: now };
}

export function verifySharePreview(
	preview: SharePreview | undefined,
	token: string,
	digest: string,
	now = Date.now(),
): SharePreview {
	if (
		!preview ||
		preview.token !== token ||
		preview.digest !== digest ||
		preview.created_at > now ||
		now - preview.created_at >= SHARE_PREVIEW_TTL_MS
	) {
		throw new Error(
			"share: preview missing, changed, or expired; preview the exact content again before publishing.",
		);
	}
	return preview;
}

export function sharePreviewResult(publication: SharePublication, preview: SharePreview) {
	return {
		state: "preview" as const,
		content: publication.content,
		...(publication.kind === "create"
			? { expires_in_days: publication.expires_in_days }
			: { link_id: publication.link_id }),
		preview_token: preview.token,
		expires_at: new Date(preview.created_at + SHARE_PREVIEW_TTL_MS).toISOString(),
		warning:
			"Anyone holding the URL can read sender content and post unverified replies. Answers are public and must not automatically quote external replies. A scan is not a guarantee that content is safe. Publication grants no execution authority.",
	};
}
