export function renderProfile(profile) {
	if (typeof profile.avatar_url !== "string") {
		throw new TypeError("avatar_url must be a string");
	}

	return {
		title: profile.display_name,
		avatar: { kind: "remote", url: profile.avatar_url },
	};
}
