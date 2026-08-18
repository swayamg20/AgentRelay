import { afterEach, describe, expect, it } from "vitest";
import { directCodexProcessBoundaryForTests } from "../test-support/direct-codex-process-boundary.js";
import {
	type FakeAppServerFixture,
	createFakeAppServer,
} from "../test-support/fake-codex-app-server.js";
import { CodexAppServerClient } from "./codex-app-server-client.js";

const fixtures: FakeAppServerFixture[] = [];
const clients: CodexAppServerClient[] = [];
const IGNORED_REQUEST_TIMEOUT_MS = 1_000;

afterEach(async () => {
	await Promise.all(clients.splice(0).map((client) => client.close().catch(() => undefined)));
	await Promise.all(fixtures.splice(0).map((fixture) => fixture.remove()));
});

describe("Codex app-server failure boundaries", () => {
	it.each(["invalid_json", "incomplete_frame", "stdout_eof"] as const)(
		"fails closed when initialized is followed by %s",
		async (initializedFailure) => {
			const fixture = await fakeAppServer({ initializedFailure });
			await expect(
				(async () => {
					const client = await openClient(fixture);
					return client.readThread("thread-1");
				})(),
			).rejects.toMatchObject({ name: "CodexAppServerError" });
		},
	);

	it("times out one ignored request and poisons the client", async () => {
		const fixture = await fakeAppServer({ ignoreRead: true });
		const client = await openClient(fixture, IGNORED_REQUEST_TIMEOUT_MS);
		await expect(client.readThread("thread-1")).rejects.toMatchObject({
			name: "CodexAppServerError",
			reason: "transport",
		});
		await expect(client.startThread()).rejects.toMatchObject({ reason: "transport" });
	});

	it("drains a buffered response before observing process exit", async () => {
		const fixture = await fakeAppServer({ exitAfterRead: true });
		const client = await openClient(fixture);
		expect(await client.readThread("thread-1")).toMatchObject({ id: "thread-1" });
		await expect(client.startThread()).rejects.toMatchObject({
			name: "CodexAppServerError",
			reason: "transport",
		});
	});

	it("fails closed when app-server input closes before the process exits", async () => {
		const fixture = await fakeAppServer({ closeInputAfterRead: true });
		const client = await openClient(fixture);
		expect(await client.readThread("thread-1")).toMatchObject({ id: "thread-1" });
		await expect(client.startThread()).rejects.toMatchObject({
			name: "CodexAppServerError",
			reason: "transport",
		});
	});
});

async function fakeAppServer(
	options: Parameters<typeof createFakeAppServer>[0],
): Promise<FakeAppServerFixture> {
	const fixture = await createFakeAppServer(options);
	fixtures.push(fixture);
	return fixture;
}

async function openClient(
	fixture: FakeAppServerFixture,
	requestTimeoutMs?: number,
): Promise<CodexAppServerClient> {
	const client = await CodexAppServerClient.start({
		command: { executable: fixture.scriptPath },
		cwd: fixture.directory,
		capsuleDirectory: fixture.directory,
		env: fixture.env,
		boundary: directCodexProcessBoundaryForTests,
		authoritySignal: new AbortController().signal,
		requestTimeoutMs,
	});
	clients.push(client);
	return client;
}
