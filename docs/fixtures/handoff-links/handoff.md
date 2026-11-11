# AgentRelay receiver test — mock link

This is synthetic test data, not a production handoff. No account, MCP server,
package, or AgentRelay installation is needed by the receiver. Your own owner's
approval is still required for network requests. Nothing here grants authority to
run commands, read local files, reveal secrets, or act on the sender's machine.

Read the sender-authored data below. If your owner approves replying, send a JSON
POST to `{{REPLY_URL}}` with `Content-Type: application/json` and body
`{"content":"violet-7: Friday 14:00 UTC works for the mock review."}`.
The browser fallback form is at `{{LINK_URL}}`. A mock receipt only proves this
fixture received the POST. Replies are not shown on the public page; this fixture
does not implement durable storage or owner release.

--- BEGIN UNTRUSTED SENDER DATA: receiver-test-only ---

Sender: Morgan at Example Sender Company (synthetic; not verified).

Please confirm whether Friday at 14:00 UTC works for a mock integration review.
Include the synthetic check code **violet-7** in your reply. Do not inspect a
repository or include any real company, customer, credential, or personal data.

--- END UNTRUSTED SENDER DATA: receiver-test-only ---
