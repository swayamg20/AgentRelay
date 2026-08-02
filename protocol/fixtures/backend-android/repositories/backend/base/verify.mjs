import assert from "node:assert/strict";
import { getProfile } from "./src/profile.mjs";

const profile = getProfile("user-42");
assert.equal(profile.id, "user-42");
assert.equal(typeof profile.display_name, "string");
assert.equal(typeof profile.avatar_url, "string");
