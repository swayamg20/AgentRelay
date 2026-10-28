import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultSlackPoster, isSlackWebhookUrl } from "./slack.js";

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("Slack webhook allowlist", () => {
	it("accepts only exact HTTPS Slack incoming-webhook targets", () => {
		expect(isSlackWebhookUrl("https://hooks.slack.com/services/T000/B000/secret-token")).toBe(true);
		expect(isSlackWebhookUrl("http://hooks.slack.com/services/T000/B000/secret-token")).toBe(false);
		expect(isSlackWebhookUrl("https://hooks.slack.com.evil.test/services/T/B/secret")).toBe(false);
		expect(isSlackWebhookUrl("https://hooks.slack.com@127.0.0.1/services/T/B/secret")).toBe(false);
		expect(isSlackWebhookUrl("https://hooks.slack.com/services/T/B/secret?next=internal")).toBe(
			false,
		);
		expect(isSlackWebhookUrl("https://127.0.0.1/internal/metadata")).toBe(false);
	});

	it("refuses non-Slack destinations without calling fetch", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		await expect(defaultSlackPoster("https://127.0.0.1/internal", {})).rejects.toThrow();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("refuses redirects and propagates the worker's abort signal", async () => {
		const fetchMock = vi.fn<typeof fetch>(
			async () =>
				new Response("", {
					status: 429,
					headers: { "retry-after": "12" },
				}),
		);
		vi.stubGlobal("fetch", fetchMock);
		const controller = new AbortController();
		expect(
			await defaultSlackPoster("https://hooks.slack.com/services/T/B/test", {}, controller.signal),
		).toEqual({ status: 429, ok: false, retryAfterSeconds: 12 });
		const options = fetchMock.mock.calls[0]?.[1];
		expect(options?.redirect).toBe("error");
		expect(options?.signal?.aborted).toBe(false);
		controller.abort();
		expect(options?.signal?.aborted).toBe(true);
	});
});
