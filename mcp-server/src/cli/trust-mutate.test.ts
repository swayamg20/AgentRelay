import yaml from "js-yaml";
import { describe, expect, it } from "vitest";
import { FALLBACK_TRUST, type TrustFile } from "../trust.js";
import {
	blockTeammate,
	listTrust,
	resetTeammate,
	serializeTrust,
	setTeammate,
	unblockTeammate,
} from "./trust-mutate.js";

const seed = (): TrustFile =>
	JSON.parse(JSON.stringify({
		...FALLBACK_TRUST,
		teammates: { "bob@acme": { auto_read: true } },
		blocked: ["mallory@external"],
	})) as TrustFile;

describe("trust-mutate.blockTeammate", () => {
	it("adds and reports changed", () => {
		const { next, changed } = blockTeammate(seed(), "stranger@x");
		expect(changed).toBe(true);
		expect(next.blocked).toContain("stranger@x");
	});

	it("is idempotent", () => {
		const { changed } = blockTeammate(seed(), "mallory@external");
		expect(changed).toBe(false);
	});

	it("does not mutate input", () => {
		const file = seed();
		const before = JSON.stringify(file);
		blockTeammate(file, "x@y");
		expect(JSON.stringify(file)).toBe(before);
	});

	it("keeps the blocked list sorted", () => {
		const { next } = blockTeammate(seed(), "alice@acme");
		expect(next.blocked).toEqual(["alice@acme", "mallory@external"]);
	});
});

describe("trust-mutate.unblockTeammate", () => {
	it("removes when present", () => {
		const { next, changed } = unblockTeammate(seed(), "mallory@external");
		expect(changed).toBe(true);
		expect(next.blocked).not.toContain("mallory@external");
	});

	it("no-ops when absent", () => {
		const { changed } = unblockTeammate(seed(), "ghost@nope");
		expect(changed).toBe(false);
	});
});

describe("trust-mutate.setTeammate", () => {
	it("creates a new teammate entry", () => {
		const next = setTeammate(seed(), "carol@acme", { auto_write_paths: ["docs/"] });
		expect(next.teammates["carol@acme"]?.auto_write_paths).toEqual(["docs/"]);
	});

	it("merges into an existing entry without dropping unspecified fields", () => {
		const next = setTeammate(seed(), "bob@acme", { auto_test: true });
		expect(next.teammates["bob@acme"]?.auto_read).toBe(true);
		expect(next.teammates["bob@acme"]?.auto_test).toBe(true);
	});
});

describe("trust-mutate.resetTeammate", () => {
	it("removes the entry", () => {
		const { next, changed } = resetTeammate(seed(), "bob@acme");
		expect(changed).toBe(true);
		expect("bob@acme" in next.teammates).toBe(false);
	});

	it("no-ops when absent", () => {
		const { changed } = resetTeammate(seed(), "nobody@nowhere");
		expect(changed).toBe(false);
	});
});

describe("trust-mutate.listTrust", () => {
	it("sorts entries deterministically", () => {
		const file = seed();
		file.teammates["alice@acme"] = { auto_read: false };
		const out = listTrust(file);
		expect(out.teammates.map((t) => t.handle)).toEqual(["alice@acme", "bob@acme"]);
	});
});

describe("trust-mutate.serializeTrust", () => {
	it("round-trips through yaml.load", () => {
		const file = seed();
		const text = serializeTrust(file);
		const parsed = yaml.load(text, { schema: yaml.JSON_SCHEMA }) as Record<string, unknown>;
		expect(parsed.version).toBe(1);
		expect((parsed.blocked as string[])).toContain("mallory@external");
	});

	it("emits stable handle ordering", () => {
		const a = seed();
		a.teammates = {
			"zach@acme": { auto_read: true },
			"alice@acme": { auto_read: true },
			"bob@acme": { auto_read: true },
		};
		const text = serializeTrust(a);
		// Should appear alphabetically.
		const idxA = text.indexOf("alice@acme");
		const idxB = text.indexOf("bob@acme");
		const idxZ = text.indexOf("zach@acme");
		expect(idxA).toBeLessThan(idxB);
		expect(idxB).toBeLessThan(idxZ);
	});
});
