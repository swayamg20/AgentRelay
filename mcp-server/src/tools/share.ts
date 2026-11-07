import type { ShareClient } from "../share-client.js";
import {
	SHARE_PREVIEW_TTL_MS,
	type SharePreview,
	type SharePublication,
	answerShareInput,
	assertShareHasNoSecrets,
	createSharePreview,
	publicationDigest,
	shareHandoffInput,
	sharePreviewResult,
	verifySharePreview,
} from "../share-publication.js";

export function createShareTools(deps: {
	client: ShareClient;
	relayUrl: string;
	senderId: string;
	apiKey: string;
	now?: () => number;
}) {
	const previews = new Map<string, SharePreview>();
	const now = deps.now ?? Date.now;

	async function publish(publication: SharePublication, token?: string) {
		assertShareHasNoSecrets(publication.content, deps.apiKey);
		const timestamp = now();
		for (const [key, preview] of previews) {
			if (timestamp - preview.created_at >= SHARE_PREVIEW_TTL_MS) previews.delete(key);
		}
		const digest = publicationDigest(publication, deps.relayUrl, deps.senderId);
		if (!token) {
			if (previews.size >= 100) {
				const oldest = previews.keys().next().value;
				if (oldest) previews.delete(oldest);
			}
			const preview = createSharePreview(digest, timestamp);
			previews.set(preview.token, preview);
			return sharePreviewResult(publication, preview);
		}
		const preview = verifySharePreview(previews.get(token), token, digest, timestamp);
		return publication.kind === "create"
			? {
					state: "stored" as const,
					...(await deps.client.create(
						publication.content,
						publication.expires_in_days,
						preview.idempotency_key,
					)),
				}
			: {
					state: "stored" as const,
					...(await deps.client.answer(
						publication.link_id,
						publication.content,
						preview.idempotency_key,
					)),
				};
	}

	return {
		shareHandoff(rawInput: unknown) {
			const input = shareHandoffInput.parse(rawInput);
			return publish(
				{ kind: "create", content: input.content, expires_in_days: input.expires_in_days },
				input.preview_token,
			);
		},
		answerShare(rawInput: unknown) {
			const input = answerShareInput.parse(rawInput);
			return publish(
				{ kind: "answer", content: input.content, link_id: input.link_id },
				input.preview_token,
			);
		},
	};
}

export type ShareTools = ReturnType<typeof createShareTools>;
