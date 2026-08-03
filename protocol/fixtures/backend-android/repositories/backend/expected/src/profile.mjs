export function getProfile(id, { displayName = "Ada Lovelace", avatarUrl = null } = {}) {
	return {
		id,
		display_name: displayName,
		avatar_url: avatarUrl,
	};
}
