import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { access } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { beforeAll, describe, expect, it } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const require = createRequire(import.meta.url);
const pkg = require("../../package.json") as { version: string };
const PACKAGE_ROOT = pathResolve(__dirname, "../..");
const AGENTRELAY_BIN_PATH = pathResolve(PACKAGE_ROOT, "dist/bin/agentrelay.js");

const describeIfBuilt = existsSync(AGENTRELAY_BIN_PATH) ? describe : describe.skip;

describeIfBuilt("agentrelay CLI mcp subcommand", () => {
	beforeAll(async () => {
		await access(AGENTRELAY_BIN_PATH);
	});

	it("lists the mcp subcommand in help output", () => {
		const result = spawnSync("node", [AGENTRELAY_BIN_PATH, "--help"], {
			cwd: PACKAGE_ROOT,
			encoding: "utf8",
			stdio: "pipe",
		});

		if (result.error !== undefined) {
			throw result.error;
		}

		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toMatch(/mcp\s+Start the AgentRelay MCP server/);
		expect(result.stdout).toMatch(/watch\s+Keep a live, replayable connection/);
	});

	it("reports the package version", () => {
		const result = spawnSync("node", [AGENTRELAY_BIN_PATH, "--version"], {
			cwd: PACKAGE_ROOT,
			encoding: "utf8",
			stdio: "pipe",
		});

		if (result.error !== undefined) {
			throw result.error;
		}

		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout.trim()).toContain(`agentrelay/${pkg.version}`);
	});

	it("reports the package version during MCP initialization", async () => {
		const transport = new StdioClientTransport({
			command: "node",
			args: [AGENTRELAY_BIN_PATH, "mcp"],
			cwd: PACKAGE_ROOT,
			stderr: "pipe",
		});
		const client = new Client({ name: "agentrelay-version-test", version: "1.0.0" });

		try {
			await client.connect(transport);
			expect(client.getServerVersion()).toEqual({
				name: "agentrelay-mcp",
				version: pkg.version,
			});
		} finally {
			await client.close();
		}
	});
});
