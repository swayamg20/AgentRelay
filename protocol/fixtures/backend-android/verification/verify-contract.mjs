import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [contractPath] = process.argv.slice(2);
assert.ok(contractPath, "contract path is required");

const contract = JSON.parse(await readFile(contractPath, "utf8"));
assert.deepEqual(contract.required, ["id", "display_name", "avatar_url"]);
assert.deepEqual(contract.properties.avatar_url.oneOf, [
	{ type: "string", format: "uri" },
	{ type: "null" },
]);
assert.match(contract["x-avatar-fallback"], /first and last non-empty/u);
