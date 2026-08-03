function initials(displayName) {
	const segments = displayName.trim().split(/\s+/u).filter(Boolean);
	const selected = segments.length <= 1 ? segments : [segments[0], segments.at(-1)];
	return selected
		.map((segment) => Array.from(segment ?? "")[0] ?? "")
		.join("")
		.toUpperCase();
}

export function renderProfile(profile) {
	if (typeof profile.avatar_url !== "string" && profile.avatar_url !== null) {
		throw new TypeError("avatar_url must be a string or null");
	}

	return {
		title: profile.display_name,
		avatar:
			profile.avatar_url === null
				? { kind: "initials", value: initials(profile.display_name) }
				: { kind: "remote", url: profile.avatar_url },
	};
}
