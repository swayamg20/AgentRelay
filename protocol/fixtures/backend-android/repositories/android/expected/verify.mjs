import assert from "node:assert/strict";
import { renderProfile } from "./src/profile-client.mjs";

assert.deepEqual(
	renderProfile({
		id: "user-42",
		display_name: "Ada Lovelace",
		avatar_url: null,
	}),
	{
		title: "Ada Lovelace",
		avatar: { kind: "initials", value: "AL" },
	},
);
