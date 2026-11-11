import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { SHARE_PREVIEW_TTL_MS } from "../share-publication.js";
import { FALLBACK_TRUST } from "../trust.js";
import { dispatchTool, registerTools } from "./index.js";
import { createShareTools } from "./share.js";

const LINK = "a".repeat(43);

function fixture() {
	let timestamp = 1000;
	const client = {
		create: vi.fn().mockResolvedValue({
			link_id: LINK,
			url: `https://relay.example/l/${LINK}`,
			replayed: false,
		}),
		answer: vi.fn().mockResolvedValue({ link_id: LINK, answer_id: randomUUID(), replayed: false }),
		replies: vi.fn(),
	};
	const options = {
		client,
		relayUrl: "https://relay.example",
		senderId: "sender-id",
		apiKey: "opaque-local-key",
		now: () => timestamp,
	};
	const tools = createShareTools(options);
	return {
		client,
		tools,
		options,
		advance: (milliseconds: number) => {
			timestamp += milliseconds;
		},
	};
}

describe("MCP share publication tools", () => {
	it("previews without network effects, then publishes exact selected text with stable retry identity", async () => {
		const { tools, client } = fixture();
		const input = { content: "selected text" };
		const preview = await tools.shareHandoff(input);
		expect(preview).toMatchObject({ state: "preview", content: input.content, expires_in_days: 7 });
		expect(client.create).not.toHaveBeenCalled();
		if (!("preview_token" in preview)) throw new Error("expected preview");
		expect(
			await tools.shareHandoff({ ...input, preview_token: preview.preview_token }),
		).toMatchObject({ state: "stored", link_id: LINK });
		await tools.shareHandoff({ ...input, preview_token: preview.preview_token });
		expect(client.create).toHaveBeenCalledTimes(2);
		expect(client.create.mock.calls[0]).toEqual(client.create.mock.calls[1]);
		expect(client.create.mock.calls[0]?.slice(0, 2)).toEqual([input.content, 7]);
	});

	it("requires an issued preview with unchanged content/expiry, surviving no server restart", async () => {
		const { tools, client, options } = fixture();
		const preview = await tools.shareHandoff({ content: "body" });
		if (!("preview_token" in preview)) throw new Error("expected preview");
		for (const changed of [{ content: "changed" }, { content: "body", expires_in_days: 8 }])
			await expect(
				tools.shareHandoff({ ...changed, preview_token: preview.preview_token }),
			).rejects.toThrow("preview missing");
		await expect(
			createShareTools(options).shareHandoff({
				content: "body",
				preview_token: preview.preview_token,
			}),
		).rejects.toThrow("preview missing");
		await expect(
			tools.shareHandoff({ content: "body", preview_token: randomUUID() }),
		).rejects.toThrow("preview missing");
		expect(client.create).not.toHaveBeenCalled();
	});

	it("previews sender answers independently and never fetches or quotes external replies", async () => {
		const { tools, client } = fixture();
		const input = { link_id: LINK, content: "sender selected answer" };
		const preview = await tools.answerShare(input);
		if (!("preview_token" in preview)) throw new Error("expected preview");
		expect(client.answer).not.toHaveBeenCalled();
		await expect(
			tools.answerShare({
				...input,
				link_id: "b".repeat(43),
				preview_token: preview.preview_token,
			}),
		).rejects.toThrow("preview missing");
		await expect(
			tools.shareHandoff({ content: input.content, preview_token: preview.preview_token }),
		).rejects.toThrow("preview missing");
		expect(
			await tools.answerShare({ ...input, preview_token: preview.preview_token }),
		).toMatchObject({ state: "stored", link_id: LINK });
		expect(client.answer).toHaveBeenCalledWith(LINK, input.content, expect.any(String));
		expect(client.replies).not.toHaveBeenCalled();
	});

	it("scans both phases before returning text or making requests", async () => {
		const { tools, client } = fixture();
		for (const content of ["opaque-local-key", `sk-proj-${"a".repeat(30)}`]) {
			await expect(tools.shareHandoff({ content })).rejects.toThrow("secret scan blocked");
			await expect(tools.answerShare({ content, link_id: LINK })).rejects.toThrow(
				"secret scan blocked",
			);
			await expect(tools.shareHandoff({ content, preview_token: randomUUID() })).rejects.toThrow(
				"secret scan blocked",
			);
		}
		expect(client.create).not.toHaveBeenCalled();
		expect(client.answer).not.toHaveBeenCalled();
	});

	it("expires previews and bounds pending state without issuing a new mutation identity on a retry", async () => {
		const { tools, advance, client } = fixture();
		const oldest = await tools.shareHandoff({ content: "oldest" });
		if (!("preview_token" in oldest)) throw new Error("expected preview");
		for (let index = 0; index < 100; index++)
			await tools.shareHandoff({ content: `body ${index}` });
		await expect(
			tools.shareHandoff({ content: "oldest", preview_token: oldest.preview_token }),
		).rejects.toThrow("preview missing");
		const fresh = await tools.shareHandoff({ content: "fresh" });
		if (!("preview_token" in fresh)) throw new Error("expected preview");
		advance(SHARE_PREVIEW_TTL_MS);
		await expect(
			tools.shareHandoff({ content: "fresh", preview_token: fresh.preview_token }),
		).rejects.toThrow("preview missing");
		expect(client.create).not.toHaveBeenCalled();
	});

	it("registers share/answer inputs and no release tool, and dispatches both handlers", async () => {
		const { tools } = fixture();
		const deps = {
			client: { request: vi.fn(), newIdempotencyKey: randomUUID },
			senderHandle: "sender@acme",
			trust: FALLBACK_TRUST,
			shareTools: tools,
		};
		const registered: ((...args: any[]) => any)[] = [];
		registerTools(
			{
				setRequestHandler: (_schema: unknown, handler: (...args: any[]) => any) =>
					registered.push(handler),
			} as any,
			deps,
		);
		const list = await registered[0]?.();
		expect(list.tools.map((tool: { name: string }) => tool.name)).toContain("share_handoff");
		expect(list.tools.map((tool: { name: string }) => tool.name)).toContain("answer_share");
		expect(list.tools.some((tool: { name: string }) => tool.name.includes("release"))).toBe(false);
		for (const name of ["share_handoff", "answer_share"]) {
			const result = await dispatchTool(deps, name, {
				content: "selected body",
				...(name === "answer_share" ? { link_id: LINK } : {}),
			});
			expect(result.isError).toBeUndefined();
			expect(JSON.parse(result.content[0]!.text).state).toBe("preview");
		}
		const invalid = await dispatchTool(deps, "answer_share", { content: "body" });
		expect(invalid.isError).toBe(true);
		expect(invalid.content[0]?.text).toContain("invalid_params");
	});
});
