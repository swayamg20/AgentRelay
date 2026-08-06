#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { constants, accessSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const tarballArg = process.argv[2];
if (!tarballArg) {
	throw new Error("usage: smoke-packed-artifact.mjs <agentrelay-mcp.tgz>");
}

const tarball = resolve(tarballArg);
const packageMetadata = JSON.parse(
	readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
const expectedVersion = packageMetadata.version;
const consumerDir = mkdtempSync(join(tmpdir(), "agentrelay-mcp-consumer-"));

try {
	writeFileSync(join(consumerDir, "package.json"), '{"private":true,"type":"module"}\n');
	execFileSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball], {
		cwd: consumerDir,
		stdio: "pipe",
	});

	const packageRoot = join(consumerDir, "node_modules", "agentrelay-mcp");
	const cliPath = join(packageRoot, "dist", "bin", "agentrelay.js");
	for (const bin of ["agentrelay", "agentrelay-mcp"]) {
		accessSync(join(consumerDir, "node_modules", ".bin", bin), constants.X_OK);
	}

	const cliVersion = execFileSync(process.execPath, [cliPath, "--version"], {
		cwd: consumerDir,
		encoding: "utf8",
	}).trim();
	assert.equal(cliVersion.split(" ")[0], `agentrelay/${expectedVersion}`);

	const consumerRequire = createRequire(join(consumerDir, "package.json"));
	const clientModule = await import(
		pathToFileURL(consumerRequire.resolve("@modelcontextprotocol/sdk/client/index.js")).href
	);
	const transportModule = await import(
		pathToFileURL(consumerRequire.resolve("@modelcontextprotocol/sdk/client/stdio.js")).href
	);
	const client = new clientModule.Client({ name: "package-smoke", version: "1.0.0" });
	const transport = new transportModule.StdioClientTransport({
		command: process.execPath,
		args: [cliPath, "mcp"],
		cwd: consumerDir,
		stderr: "pipe",
	});

	try {
		await client.connect(transport);
		assert.deepEqual(client.getServerVersion(), {
			name: "agentrelay-mcp",
			version: expectedVersion,
		});
	} finally {
		await client.close().catch(() => undefined);
	}

	process.stdout.write(`packed artifact smoke passed for agentrelay-mcp@${expectedVersion}\n`);
} finally {
	rmSync(consumerDir, { recursive: true, force: true });
}
