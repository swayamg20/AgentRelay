import assert from "node:assert/strict";
import { getProfile } from "./src/profile.mjs";

const profile = getProfile("user-42");
assert.deepEqual(profile, {
	id: "user-42",
	display_name: "Ada Lovelace",
	avatar_url: null,
});
