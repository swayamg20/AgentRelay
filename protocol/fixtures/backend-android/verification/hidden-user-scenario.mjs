import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [backendRoot, androidRoot] = process.argv.slice(2);
assert.ok(backendRoot, "backend workspace is required");
assert.ok(androidRoot, "Android workspace is required");

const { getProfile } = await import(pathToFileURL(join(backendRoot, "src/profile.mjs")).href);
const { renderProfile } = await import(
	pathToFileURL(join(androidRoot, "src/profile-client.mjs")).href
);

const rendered = renderProfile(
	getProfile("hidden-user", { displayName: "  Grace   Brewster   Hopper  " }),
);
assert.deepEqual(rendered, {
	title: "  Grace   Brewster   Hopper  ",
	avatar: { kind: "initials", value: "GH" },
});
