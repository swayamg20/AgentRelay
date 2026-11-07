import { constants } from "node:fs";
import { open, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { type LoadConfigResult, loadConfig } from "../config.js";
import { markExternalValue, wrapExternalReply } from "../provenance.js";
import { type ShareClient, createShareClient } from "../share-client.js";
import {
	type SharePublication,
	answerShareInput,
	assertShareHasNoSecrets,
	createSharePreview,
	publicationDigest,
	shareHandoffInput,
	shareLinkId,
	sharePreviewResult,
	sharePreviewSchema,
	verifySharePreview,
} from "../share-publication.js";
import { writeSecretFile } from "./io.js";

const cliInput = z
	.object({
		action: z.enum(["answer", "replies"]).optional(),
		linkId: shareLinkId.optional(),
		file: z
			.string()
			.min(1)
			.refine((value) => !value.includes("\u0000"))
			.optional(),
		expiresInDays: z.coerce.number().int().min(1).max(30).optional(),
		confirm: z.string().uuid().optional(),
	})
	.strict()
	.superRefine((input, context) => {
		if (
			(input.action === undefined) !== (input.linkId === undefined) ||
			(input.action !== "replies" && !input.file) ||
			(input.action === "replies" && (input.file || input.confirm)) ||
			(input.action !== undefined && input.expiresInDays !== undefined)
		) {
			context.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid share command options" });
		}
	});

export interface ShareCommandDeps {
	loadConfig?: () => Promise<LoadConfigResult>;
	client?: ShareClient;
	now?: () => number;
}

async function readContent(path: string, maxBytes: number): Promise<string> {
	let file: Awaited<ReturnType<typeof open>>;
	try {
		file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
	} catch {
		throw new Error("share: cannot read the content file.");
	}
	try {
		const stat = await file.stat();
		if (!stat.isFile() || stat.size > maxBytes)
			throw new Error("share: content must be a regular file within the UTF-8 byte limit.");
		const buffer = Buffer.alloc(maxBytes + 1);
		let size = 0;
		while (size < buffer.length) {
			const { bytesRead } = await file.read(buffer, size, buffer.length - size, null);
			if (!bytesRead) break;
			size += bytesRead;
		}
		if (size > maxBytes) throw new Error("share: content exceeds the UTF-8 byte limit.");
		try {
			return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, size));
		} catch {
			throw new Error("share: content must be valid UTF-8.");
		}
	} finally {
		await file.close();
	}
}

export async function shareCommand(rawInput: unknown, deps: ShareCommandDeps = {}) {
	const parsed = cliInput.safeParse(rawInput);
	if (!parsed.success)
		throw new Error(
			"share: use --file <path>, answer <link-id> --file <path>, or replies <link-id>; --confirm requires a preview token.",
		);
	const input = parsed.data;
	const result = await (deps.loadConfig ?? loadConfig)();
	if (!result.ok)
		throw new Error("share: valid local Relay configuration is required; run agentrelay doctor.");
	const { config } = result;
	const client =
		deps.client ?? createShareClient({ relayUrl: config.relay_url, apiKey: config.api_key });
	if (input.action === "replies") {
		const receipt = await client.replies(input.linkId!);
		return {
			...receipt,
			replies: receipt.replies.map((reply) =>
				markExternalValue({
					...reply,
					content: reply.content === null ? null : wrapExternalReply(reply.content),
				}),
			),
		};
	}
	const content = await readContent(input.file!, input.action === "answer" ? 16 * 1024 : 64 * 1024);
	let publication: SharePublication;
	if (input.action === "answer") {
		const answer = answerShareInput.safeParse({ content, link_id: input.linkId });
		if (!answer.success) throw new Error("share: invalid answer content.");
		publication = { kind: "answer", content: answer.data.content, link_id: answer.data.link_id };
	} else {
		const handoff = shareHandoffInput.safeParse({ content, expires_in_days: input.expiresInDays });
		if (!handoff.success) throw new Error("share: invalid handoff content.");
		publication = {
			kind: "create",
			content: handoff.data.content,
			expires_in_days: handoff.data.expires_in_days,
		};
	}
	assertShareHasNoSecrets(publication.content, config.api_key);
	const digest = publicationDigest(publication, config.relay_url, config.agent_id);
	const timestamp = (deps.now ?? Date.now)();
	const previewPath = join(dirname(result.path), "share-preview.json");
	if (!input.confirm) {
		const preview = createSharePreview(digest, timestamp);
		await writeSecretFile(previewPath, `${JSON.stringify(preview)}\n`);
		return sharePreviewResult(publication, preview);
	}
	let saved: unknown;
	try {
		saved = JSON.parse(await readFile(previewPath, "utf8"));
	} catch {
		throw new Error("share: preview missing or unreadable; preview the exact content again.");
	}
	const stored = sharePreviewSchema.safeParse(saved);
	const preview = verifySharePreview(
		stored.success ? stored.data : undefined,
		input.confirm,
		digest,
		timestamp,
	);
	return publication.kind === "create"
		? {
				state: "stored" as const,
				...(await client.create(
					publication.content,
					publication.expires_in_days,
					preview.idempotency_key,
				)),
			}
		: {
				state: "stored" as const,
				...(await client.answer(publication.link_id, publication.content, preview.idempotency_key)),
			};
}
