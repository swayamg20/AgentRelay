import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	FALLBACK_TRUST,
	computeOverlay,
	isPathAutoWritable,
	loadTrust,
	resolveTrustPath,
	type TrustFile,
} from "./trust.js";

const fullTrust: TrustFile = {
	version: 1,
	teammates: {
		"bob@acme": {
			auto_read: true,
			auto_test: true,
			auto_write_paths: [],
			require_approval: ["Edit", "Write", "Bash"],
		},
		"carol@acme": {
			auto_read: true,
			auto_test: true,
			auto_write_paths: ["docs/", "README.md"],
			require_approval: ["Edit", "Write", "Bash"],
		},
	},
	unknown_teammates: { policy: "reject" },
	blocked: ["mallory@external"],
	defaults: {
		auto_read: true,
		auto_test: true,
		auto_write_paths: [],
		require_approval: ["Edit", "Write", "Bash"],
	},
};

describe("trust.computeOverlay precedence", () => {
	it("blocked entries win over teammates entries", () => {
		const trust: TrustFile = {
			...fullTrust,
			teammates: { "mallory@external": { auto_read: true } },
			blocked: ["mallory@external"],
		};
		const out = computeOverlay(trust, "mallory@external");
		expect(out).toEqual({ decision: "reject", reason: "blocked" });
	});

	it("listed teammates merge with defaults", () => {
		const out = computeOverlay(fullTrust, "carol@acme");
		expect(out.decision).toBe("allow");
		if (out.decision === "allow") {
			expect(out.source).toBe("listed");
			expect(out.overlay.auto_write_paths).toEqual(["docs/", "README.md"]);
			expect(out.overlay.auto_read).toBe(true);
		}
	});

	it("unknown teammates with reject policy → reject", () => {
		const out = computeOverlay(fullTrust, "stranger@elsewhere");
		expect(out).toEqual({ decision: "reject", reason: "unknown_rejected" });
	});

	it("unknown teammates with allow_with_default_trust → defaults", () => {
		const trust: TrustFile = {
			...fullTrust,
			unknown_teammates: { policy: "allow_with_default_trust" },
		};
		const out = computeOverlay(trust, "stranger@elsewhere");
		expect(out.decision).toBe("allow");
		if (out.decision === "allow") {
			expect(out.source).toBe("defaults");
			expect(out.overlay.auto_read).toBe(true);
		}
	});

	it("teammate-level fields override defaults field-by-field", () => {
		const trust: TrustFile = {
			...fullTrust,
			teammates: { "bob@acme": { auto_read: false } },
			defaults: { auto_read: true, auto_test: true, auto_write_paths: [], require_approval: [] },
		};
		const out = computeOverlay(trust, "bob@acme");
		expect(out.decision).toBe("allow");
		if (out.decision === "allow") {
			expect(out.overlay.auto_read).toBe(false); // overridden
			expect(out.overlay.auto_test).toBe(true); // inherited from defaults
		}
	});
});

describe("trust.isPathAutoWritable", () => {
	const overlay = {
		auto_read: true,
		auto_test: true,
		auto_write_paths: ["docs/", "README.md"],
		require_approval: [],
	};

	it("matches directory prefixes", () => {
		expect(isPathAutoWritable(overlay, "docs/api.md")).toBe(true);
		expect(isPathAutoWritable(overlay, "docs/setup/quickstart.md")).toBe(true);
	});

	it("matches the directory itself when supplied without trailing slash", () => {
		expect(isPathAutoWritable(overlay, "docs")).toBe(true);
	});

	it("matches exact files", () => {
		expect(isPathAutoWritable(overlay, "README.md")).toBe(true);
	});

	it("rejects unrelated paths", () => {
		expect(isPathAutoWritable(overlay, "src/index.ts")).toBe(false);
		expect(isPathAutoWritable(overlay, "docsite/api.md")).toBe(false);
	});
});

describe("trust.loadTrust", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "agentrelay-trust-test-"));
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("respects AGENTRELAY_TRUST_PATH override", () => {
		expect(resolveTrustPath({ AGENTRELAY_TRUST_PATH: "/tmp/t.yaml" } as NodeJS.ProcessEnv)).toBe(
			"/tmp/t.yaml",
		);
	});

	it("returns a safe fallback when missing", async () => {
		const path = join(dir, "trust.yaml");
		const out = await loadTrust({ AGENTRELAY_TRUST_PATH: path } as NodeJS.ProcessEnv);
		expect(out.ok).toBe(true);
		if (out.ok) {
			expect(out.source).toBe("fallback");
			expect(out.trust).toEqual(FALLBACK_TRUST);
			// Compute on fallback: every unknown handoff is rejected.
			const decision = computeOverlay(out.trust, "bob@acme");
			expect(decision).toEqual({ decision: "reject", reason: "unknown_rejected" });
		}
	});

	it("returns malformed for invalid YAML", async () => {
		const path = join(dir, "trust.yaml");
		await writeFile(path, "version: 1\n  teammates: [bad: yaml\n", "utf8");
		const out = await loadTrust({ AGENTRELAY_TRUST_PATH: path } as NodeJS.ProcessEnv);
		expect(out.ok).toBe(false);
		if (!out.ok) expect(out.reason).toBe("malformed");
	});

	it("returns invalid when the schema does not match", async () => {
		const path = join(dir, "trust.yaml");
		// version 2 isn't supported.
		await writeFile(path, "version: 2\n", "utf8");
		const out = await loadTrust({ AGENTRELAY_TRUST_PATH: path } as NodeJS.ProcessEnv);
		expect(out.ok).toBe(false);
		if (!out.ok) expect(out.reason).toBe("invalid");
	});

	it("loads a real trust.yaml end-to-end", async () => {
		const path = join(dir, "trust.yaml");
		const yamlText = `version: 1
teammates:
  bob@acme:
    auto_read: true
    auto_test: true
    auto_write_paths: []
    require_approval: ["Edit", "Write", "Bash"]
  carol@acme:
    auto_read: true
    auto_test: true
    auto_write_paths: ["docs/", "README.md"]
    require_approval: ["Edit", "Write", "Bash"]
unknown_teammates:
  policy: "reject"
blocked:
  - mallory@external
defaults:
  auto_read: true
  auto_test: true
  auto_write_paths: []
`;
		await writeFile(path, yamlText, "utf8");
		const out = await loadTrust({ AGENTRELAY_TRUST_PATH: path } as NodeJS.ProcessEnv);
		expect(out.ok).toBe(true);
		if (out.ok) {
			expect(out.source).toBe("file");
			const carol = computeOverlay(out.trust, "carol@acme");
			expect(carol.decision).toBe("allow");
			if (carol.decision === "allow") {
				expect(carol.overlay.auto_write_paths).toContain("docs/");
				expect(isPathAutoWritable(carol.overlay, "docs/api.md")).toBe(true);
			}
			expect(computeOverlay(out.trust, "mallory@external")).toEqual({
				decision: "reject",
				reason: "blocked",
			});
		}
	});

	it("ignores unknown top-level keys (warning, not error)", async () => {
		const path = join(dir, "trust.yaml");
		await writeFile(path, "version: 1\nfuture_field: hello\n", "utf8");
		const out = await loadTrust({ AGENTRELAY_TRUST_PATH: path } as NodeJS.ProcessEnv);
		expect(out.ok).toBe(true);
	});
});
