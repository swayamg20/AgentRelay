export function getProfile(id, displayName = "Ada Lovelace") {
	return {
		id,
		display_name: displayName,
		avatar_url: "https://images.example.test/profiles/default.png",
	};
}
