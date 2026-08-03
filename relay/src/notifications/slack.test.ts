import { describe, expect, it } from "vitest";
import { isSlackWebhookUrl } from "./slack.js";

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
});
