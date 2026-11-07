import { describe, expect, it, vi } from "vitest";
import { createReceiverTestApp } from "../tests/handoff-receiver.js";

describe("handoff receiver test kit", () => {
	it("serves sender-only Markdown for agents and minimal HTML for browsers", async () => {
		const app = await createReceiverTestApp(vi.fn());
		const agent = await app.request("/l/receiver-fixture");
		expect(agent.headers.get("content-type")).toContain("text/markdown");
		expect(await agent.text()).toContain("http://localhost/l/receiver-fixture/replies");
		const browser = await app.request("/l/receiver-fixture", {
			headers: { "User-Agent": "Mozilla/5.0", Accept: "text/html" },
		});
		expect(browser.headers.get("content-type")).toContain("text/html");
		expect(browser.headers.get("content-security-policy")).toContain("default-src 'none'");
		expect(browser.headers.get("x-robots-tag")).toContain("noindex");
		expect(await browser.text()).toContain('action="/l/receiver-fixture/replies"');
		const explicit = await app.request("/l/receiver-fixture", {
			headers: { "User-Agent": "Mozilla/5.0", Accept: "text/markdown" },
		});
		expect(explicit.headers.get("content-type")).toContain("text/markdown");
		expect(await (await app.request("/l/receiver-fixture/handoff.md")).text()).not.toContain("{{");
	});
	it("receives JSON and form replies without publishing or logging their content", async () => {
		const onReply = vi.fn();
		const app = await createReceiverTestApp(onReply);
		const api = await app.request("/l/receiver-fixture/replies", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ content: "violet-7: private synthetic reply" }),
		});
		expect(api.status).toBe(201);
		expect(await api.json()).toMatchObject({ mock: true, durable: false, code_matched: true });
		const form = await app.request("/l/receiver-fixture/replies", {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: "content=violet-7%3A+another+private+reply",
		});
		expect(form.status).toBe(201);
		expect(onReply).toHaveBeenCalledTimes(2);
		expect(JSON.stringify(onReply.mock.calls)).not.toContain("private");
		expect(await (await app.request("/l/receiver-fixture")).text()).not.toContain("private");
	});
	it("rejects invalid, oversized, and eleventh replies", async () => {
		const app = await createReceiverTestApp(vi.fn());
		const post = (body: string) =>
			app.request("/l/receiver-fixture/replies", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body,
			});
		expect((await post("bad json")).status).toBe(400);
		expect((await post(JSON.stringify({ content: "" }))).status).toBe(400);
		expect((await post(JSON.stringify({ content: "é".repeat(8193) }))).status).toBe(400);
		expect((await post(JSON.stringify({ content: "x".repeat(70_000) }))).status).toBe(413);
		for (let replyNumber = 0; replyNumber < 10; replyNumber += 1) {
			expect((await post(JSON.stringify({ content: "violet-7" }))).status).toBe(201);
		}
		expect((await post(JSON.stringify({ content: "violet-7" }))).status).toBe(429);
	});
});
