import { digestCanonicalJson } from "./capsule-correlation.js";

export interface WorkspaceResourceIdentity {
	readonly workspaceBindingId: string;
	readonly workspaceAlias: string;
	readonly root: string;
	readonly repositoryUrl: string;
	readonly headCommit: string;
	readonly reachableFromRef: string;
}

/** Stable identity shared by Node grant compilation and Capsule containment recovery. */
export function workspaceResourceSha256(input: WorkspaceResourceIdentity): string {
	return digestCanonicalJson({
		workspace_binding_id: input.workspaceBindingId,
		workspace_alias: input.workspaceAlias,
		root: input.root,
		repository_url: input.repositoryUrl,
		head_commit: input.headCommit,
		reachable_from_ref: input.reachableFromRef,
	});
}
