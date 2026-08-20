import { createHash, randomUUID } from "node:crypto";
import { access, chmod, readFile } from "node:fs/promises";
import { inspect } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { directCodexProcessBoundaryForTests } from "../test-support/direct-codex-process-boundary.js";
import {
	type FakeAppServerFixture,
	type FakeAppServerOptions,
	createFakeAppServer,
	waitForArgv,
	waitForEnvironment,
	waitForMessages,
	waitForPid,
	waitForProcessExit,
} from "../test-support/fake-codex-app-server.js";
import {
	type FakeCodexOwnerCredential,
	createFakeCodexOwnerCredential,
} from "../test-support/fake-codex-owner-credential.js";
import {
	CodexAppServerClient,
	type CodexAppServerClientOptions,
} from "./codex-app-server-client.js";
import { startCodexAppServerProcess } from "./codex-app-server-process.js";
import type { CodexOwnerCredential } from "./codex-owner-credential.js";

const fixtures: FakeAppServerFixture[] = [];
const clients: CodexAppServerClient[] = [];

afterEach(async () => {
	await Promise.all(clients.splice(0).map((client) => client.close().catch(() => undefined)));
	await Promise.all(fixtures.splice(0).map((fixture) => fixture.remove()));
});

describe("Codex app-server owner authentication", () => {
	it("logs in once, proves the account, and keeps the credential out of ambient surfaces", async () => {
		const fixture = await fakeAppServer();
		const apiKey = `opaque owner key ${randomUUID()}`;
		const credential = createFakeCodexOwnerCredential(apiKey);
		const client = await startClient(fixture, credential);

		expect(credential.useCount).toBe(1);
		expect(credential.disposeCount).toBe(1);
		expect((await waitForMessages(fixture.logPath, 4)).slice(0, 4)).toEqual([
			expect.objectContaining({ method: "initialize" }),
			{ method: "initialized" },
			expect.objectContaining({
				method: "account/login/start",
				params: { type: "apiKey", apiKey: "[redacted]" },
			}),
			expect.objectContaining({
				method: "account/read",
				params: { refreshToken: false },
			}),
		]);
		expect(await credentialDigest(fixture)).toBe(sha256(apiKey));
		expect(await readFile(fixture.logPath, "utf8")).not.toContain(apiKey);
		expect(JSON.stringify(await waitForArgv(fixture.argvPath))).not.toContain(apiKey);
		expect(JSON.stringify(await waitForEnvironment(fixture.environmentPath))).not.toContain(apiKey);
		expect(client.identity.platformFamily).toBe("unix");
	});

	it.each(["echo_error", "malformed"] as const)(
		"redacts an adversarial %s login failure and proves provider closure",
		async (loginMode) => {
			const fixture = await fakeAppServer({ loginMode });
			const apiKey = `login-error-canary-${randomUUID()}`;
			const credential = createFakeCodexOwnerCredential(apiKey);
			const failure = rejectedValue(CodexAppServerClient.start(clientOptions(fixture), credential));
			const error = await failure;
			const pid = await waitForPid(fixture.appServerPidPath);

			expect(error).toMatchObject({
				name: "CodexAppServerError",
				reason: "authentication",
				message: "Codex owner authentication failed",
			});
			expect("cause" in asObject(error)).toBe(false);
			expect("data" in asObject(error)).toBe(false);
			for (const rendered of [String(error), inspect(error), JSON.stringify(error)]) {
				expect(rendered).not.toContain(apiKey);
			}
			expect(await readFile(fixture.logPath, "utf8")).not.toContain(apiKey);
			expect(await credentialDigest(fixture)).toBe(sha256(apiKey));
			expect(credential.useCount).toBe(1);
			expect(credential.disposeCount).toBe(1);
			await waitForProcessExit(pid);
		},
	);

	it.each(["error", "malformed"] as const)(
		"fails closed when the post-login account proof returns %s",
		async (accountMode) => {
			const fixture = await fakeAppServer({ accountMode });
			const apiKey = `account-proof-canary-${randomUUID()}`;
			const credential = createFakeCodexOwnerCredential(apiKey);
			const failure = rejectedValue(CodexAppServerClient.start(clientOptions(fixture), credential));
			const error = await failure;
			const pid = await waitForPid(fixture.appServerPidPath);

			expect(error).toMatchObject({
				name: "CodexAppServerError",
				reason: "authentication",
				message: "Codex owner authentication failed",
			});
			expect(inspect(error)).not.toContain(apiKey);
			expect((await waitForMessages(fixture.logPath, 4)).map((message) => message.method)).toEqual([
				"initialize",
				"initialized",
				"account/login/start",
				"account/read",
			]);
			expect(credential.useCount).toBe(1);
			expect(credential.disposeCount).toBe(1);
			await waitForProcessExit(pid);
		},
	);

	it("rechecks authority after login before reading the account", async () => {
		const fixture = await fakeAppServer();
		const authority = new AbortController();
		const delegate = createFakeCodexOwnerCredential("authority-race-owner-key");
		const credential = abortAfterUse(delegate, authority, "expired");
		const failure = rejectedValue(
			CodexAppServerClient.start(
				clientOptions(fixture, { authoritySignal: authority.signal }),
				credential,
			),
		);
		expect(await failure).toBe("expired");
		const pid = await waitForPid(fixture.appServerPidPath);
		const messages = await waitForMessages(fixture.logPath, 3);
		expect(messages.map((message) => message.method)).toEqual([
			"initialize",
			"initialized",
			"account/login/start",
		]);
		expect(messages).not.toContainEqual(expect.objectContaining({ method: "account/read" }));
		expect(delegate.useCount).toBe(1);
		expect(delegate.disposeCount).toBe(1);
		await waitForProcessExit(pid);
	});

	it("disposes without using the credential when authority is already revoked", async () => {
		const fixture = await fakeAppServer();
		const authority = new AbortController();
		authority.abort("expired");
		const credential = createFakeCodexOwnerCredential("pre-aborted-owner-key");

		await expect(
			CodexAppServerClient.start(
				clientOptions(fixture, { authoritySignal: authority.signal }),
				credential,
			),
		).rejects.toBe("expired");

		expect(credential.useCount).toBe(0);
		expect(credential.disposeCount).toBe(1);
		await expect(access(fixture.appServerPidPath)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("disposes without using the credential when private-home preparation fails", async () => {
		const fixture = await fakeAppServer();
		const credential = createFakeCodexOwnerCredential("pre-spawn-owner-key");
		await chmod(fixture.directory, 0o500);
		try {
			await expect(
				CodexAppServerClient.start(clientOptions(fixture), credential),
			).rejects.toMatchObject({ name: "CodexAppServerError", reason: "policy" });
			expect(credential.useCount).toBe(0);
			expect(credential.disposeCount).toBe(1);
		} finally {
			await chmod(fixture.directory, 0o700);
		}
	});

	it("keeps teardown-proof failure ahead of a sanitized login failure", async () => {
		const fixture = await fakeAppServer({ loginMode: "error" });
		const credential = createFakeCodexOwnerCredential("teardown-precedence-owner-key");
		const cleanupFailure = new Error("authentication teardown proof failed");
		const failure = rejectedValue(
			CodexAppServerClient.start(
				clientOptions(fixture, {
					processFactory: async (options) => {
						const processRef = await startCodexAppServerProcess(options);
						return {
							...processRef,
							stop: async (reason) => {
								await processRef.stop?.(reason);
								throw cleanupFailure;
							},
						};
					},
				}),
				credential,
			),
		);
		expect(await failure).toBe(cleanupFailure);
		const pid = await waitForPid(fixture.appServerPidPath);
		expect(credential.useCount).toBe(1);
		expect(credential.disposeCount).toBe(1);
		await waitForProcessExit(pid);
	});
});

async function fakeAppServer(options: FakeAppServerOptions = {}): Promise<FakeAppServerFixture> {
	const fixture = await createFakeAppServer(options);
	fixtures.push(fixture);
	return fixture;
}

async function startClient(
	fixture: FakeAppServerFixture,
	credential: CodexOwnerCredential,
): Promise<CodexAppServerClient> {
	const client = await CodexAppServerClient.start(clientOptions(fixture), credential);
	clients.push(client);
	return client;
}

function clientOptions(
	fixture: FakeAppServerFixture,
	overrides: Partial<
		Pick<CodexAppServerClientOptions, "authoritySignal" | "processFactory" | "requestTimeoutMs">
	> = {},
): CodexAppServerClientOptions {
	return {
		command: { executable: fixture.scriptPath },
		workspaceCwd: fixture.directory,
		capsuleDirectory: fixture.directory,
		env: fixture.env,
		boundary: directCodexProcessBoundaryForTests,
		authoritySignal: new AbortController().signal,
		...overrides,
	};
}

function abortAfterUse(
	delegate: FakeCodexOwnerCredential,
	authority: AbortController,
	reason: string,
): CodexOwnerCredential {
	return {
		use: (operation) =>
			delegate.use(async (apiKey) => {
				await operation(apiKey);
				authority.abort(reason);
			}),
		writeTo: (destination) => delegate.writeTo(destination),
		dispose: () => delegate.dispose(),
	};
}

async function credentialDigest(fixture: FakeAppServerFixture): Promise<string> {
	return (await readFile(fixture.credentialDigestPath, "utf8")).trim();
}

function sha256(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

async function rejectedValue(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise;
		throw new Error("Expected Codex app-server startup to fail");
	} catch (error) {
		return error;
	}
}

function asObject(value: unknown): object {
	if (typeof value !== "object" || value === null) throw new Error("Expected an object failure");
	return value;
}
