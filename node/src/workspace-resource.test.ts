import { describe, expect, it } from "vitest";
import { workspaceResourceSha256 } from "./workspace-resource.js";

describe("workspace resource identity", () => {
	it("preserves the grant compiler's canonical digest", () => {
		expect(
			workspaceResourceSha256({
				workspaceBindingId: "97000000-0000-4000-8000-000000000004",
				workspaceAlias: "backend",
				root: "/work/backend",
				repositoryUrl: "https://example.com/backend.git",
				headCommit: "1".repeat(40),
				reachableFromRef: "refs/heads/main",
			}),
		).toBe("d684a9fdcb3f089ef81bf2b4d08598194b47b3ffe991ea735549383e5cc85e10");
	});
});
