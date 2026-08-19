import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { directCodexProcessBoundaryForTests } from "../test-support/direct-codex-process-boundary.js";
import {
	type FakeAppServerFixture,
	createFakeAppServer,
} from "../test-support/fake-codex-app-server.js";
import { createFakeCodexOwnerCredential } from "../test-support/fake-codex-owner-credential.js";
import { CodexAppServerClient } from "./codex-app-server-client.js";
import type { CodexProcessBoundary, CodexProcessRequest } from "./codex-process-boundary.js";

const fixtures: FakeAppServerFixture[] = [];
const clients: CodexAppServerClient[] = [];
const TEST_OWNER_API_KEY = "containment-owner-key";

afterEach(async () => {
	await Promise.all(clients.splice(0).map((client) => client.close().catch(() => undefined)));
	await Promise.all(fixtures.splice(0).map((fixture) => fixture.remove()));
});

describe("Codex app-server containment gate", () => {
	it("routes both the version probe and app-server through the required boundary", async () => {
		const fixture = await fakeAppServer();
		const requests: CodexProcessRequest[] = [];
		const boundary: CodexProcessBoundary = {
			prepare: async (request, signal) => {
				requests.push(request);
				return directCodexProcessBoundaryForTests.prepare(request, signal);
			},
		};
		const client = await openClient(fixture, boundary);

		expect(requests).toHaveLength(2);
		expect(requests[0]?.argv).toEqual(["--version"]);
		expect(requests[1]?.argv).toContain("app-server");
		await client.close();
		clients.splice(clients.indexOf(client), 1);
	});

	it("starts no provider process when containment preparation fails", async () => {
		const fixture = await fakeAppServer();
		const boundary: CodexProcessBoundary = {
			prepare: async () => {
				throw new Error("containment unavailable");
			},
		};

		await expect(openClient(fixture, boundary)).rejects.toMatchObject({
			name: "CodexAppServerError",
			reason: "policy",
		});
		await expect(readFile(fixture.argvPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
	});
});

async function fakeAppServer(): Promise<FakeAppServerFixture> {
	const fixture = await createFakeAppServer();
	fixtures.push(fixture);
	return fixture;
}

async function openClient(
	fixture: FakeAppServerFixture,
	boundary: CodexProcessBoundary,
): Promise<CodexAppServerClient> {
	const client = await CodexAppServerClient.start(
		{
			command: { executable: fixture.scriptPath },
			cwd: fixture.directory,
			capsuleDirectory: fixture.directory,
			env: fixture.env,
			boundary,
			authoritySignal: new AbortController().signal,
		},
		createFakeCodexOwnerCredential(TEST_OWNER_API_KEY),
	);
	clients.push(client);
	return client;
}
