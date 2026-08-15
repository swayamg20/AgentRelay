import { join, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { isPathWithin } from "./filesystem-path.js";

describe("filesystem path containment", () => {
	it("accepts exact and component-contained paths", () => {
		const root = join(sep, "var", "agentrelay", "workspace");

		expect(isPathWithin(root, root)).toBe(true);
		expect(isPathWithin(join(root, "src"), root)).toBe(true);
		expect(isPathWithin(join(root, "..mounted-secret"), root)).toBe(true);
	});

	it("rejects parent and sibling paths", () => {
		const root = join(sep, "var", "agentrelay", "workspace");

		expect(isPathWithin(join(root, ".."), root)).toBe(false);
		expect(isPathWithin(join(root, "..", "workspace-secret"), root)).toBe(false);
	});
});
