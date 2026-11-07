import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";

const linkPath = "/l/receiver-fixture";
const replySchema = z.object({
	content: z
		.string()
		.min(1)
		.refine((content) => Buffer.byteLength(content, "utf8") <= 16_384),
});

export async function createReceiverTestApp(
	onReply: (receipt: { id: string; channel: "api" | "form"; code_matched: boolean }) => void,
) {
	const fixtures = new URL("../../docs/fixtures/handoff-links/", import.meta.url);
	const markdown = await readFile(new URL("handoff.md", fixtures), "utf8");
	const html = await readFile(new URL("index.html", fixtures), "utf8");
	const app = new Hono();
	let replyCount = 0;

	app.use("*", async (context, next) => {
		context.header("X-Robots-Tag", "noindex, nofollow");
		context.header("Cache-Control", "no-store");
		context.header("X-Content-Type-Options", "nosniff");
		context.header(
			"Content-Security-Policy",
			"default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
		);
		await next();
	});
	app.use("*", bodyLimit({ maxSize: 65_536 }));
	app.get(linkPath, (context) => {
		const wantsMarkdown =
			context.req.header("Accept")?.includes("text/markdown") ||
			!context.req.header("User-Agent")?.includes("Mozilla/");
		const content = (wantsMarkdown ? markdown : html)
			.replaceAll("{{REPLY_URL}}", `${new URL(context.req.url).origin}${linkPath}/replies`)
			.replaceAll("{{LINK_URL}}", `${new URL(context.req.url).origin}${linkPath}`)
			.replaceAll("{{MARKDOWN_URL}}", `${linkPath}/handoff.md`)
			.replaceAll("{{REPLY_PATH}}", `${linkPath}/replies`);
		return context.body(content, 200, {
			"Content-Type": wantsMarkdown ? "text/markdown; charset=utf-8" : "text/html; charset=utf-8",
			Vary: "Accept, User-Agent",
		});
	});
	app.get(`${linkPath}/handoff.md`, (context) =>
		app.fetch(
			new Request(new URL(linkPath, context.req.url), { headers: { Accept: "text/markdown" } }),
		),
	);
	app.post(`${linkPath}/replies`, async (context) => {
		const channel: "api" | "form" = context.req
			.header("Content-Type")
			?.startsWith("application/json")
			? "api"
			: "form";
		const body = await (channel === "api" ? context.req.json() : context.req.parseBody()).catch(
			() => null,
		);
		const parsed = replySchema.safeParse(body);
		if (!parsed.success) return context.json({ error: "invalid_mock_reply" }, 400);
		if (replyCount >= 10) return context.json({ error: "mock_reply_limit" }, 429);
		replyCount += 1;
		const receipt = {
			id: randomUUID(),
			channel,
			code_matched: parsed.data.content.includes("violet-7"),
		};
		onReply(receipt);
		if (channel === "form") {
			return context.html(
				"<!doctype html><title>Mock receipt</title><p>Mock reply received.</p>",
				201,
			);
		}
		return context.json({ ...receipt, mock: true, durable: false }, 201);
	});
	return app;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	const app = await createReceiverTestApp((receipt) => {
		process.stdout.write(`${JSON.stringify({ event: "mock.reply_received", ...receipt })}\n`);
	});
	serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 8799 });
	process.stdout.write("Receiver fixture ready: http://127.0.0.1:8799/l/receiver-fixture\n");
}
