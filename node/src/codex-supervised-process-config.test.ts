import { describe, expect, it } from "vitest";
import { buildCodexAppServerArguments } from "./codex-app-server-command.js";
import type { CodexAppServerProcessOptions } from "./codex-app-server-process.js";
import type { CodexProcessBoundary } from "./codex-process-boundary.js";
import { prepareProviderCommands } from "./codex-supervised-process-config.js";

const WORKSPACE = "/srv/agentrelay/workspace";
const PROCESS_CWD = "/srv/agentrelay/runtime/codex-home";

describe("Codex supervised process configuration", () => {
	it("threads the logical workspace separately from the private process directory", async () => {
		const requests: Parameters<CodexProcessBoundary["prepare"]>[0][] = [];
		const options = processOptions({
			prepare: async (request, signal) => {
				signal.throwIfAborted();
				requests.push(request);
				return { ...request, argv: [...request.argv], env: { ...request.env } };
			},
		});

		const commands = await prepareProviderCommands(options);

		expect(requests).toEqual([
			expect.objectContaining({ workspaceCwd: WORKSPACE, cwd: PROCESS_CWD, argv: ["--version"] }),
			expect.objectContaining({
				workspaceCwd: WORKSPACE,
				cwd: PROCESS_CWD,
				argv: buildCodexAppServerArguments(WORKSPACE),
			}),
		]);
		expect(commands.versionProbe).toMatchObject({
			workspace_cwd: WORKSPACE,
			cwd: PROCESS_CWD,
			argv: ["--version"],
		});
		expect(commands.appServer).toMatchObject({
			workspace_cwd: WORKSPACE,
			cwd: PROCESS_CWD,
			argv: buildCodexAppServerArguments(WORKSPACE),
		});
	});

	it.each([
		["workspace", { workspaceCwd: "/srv/agentrelay/other" }],
		["process cwd", { cwd: "/srv/agentrelay/runtime/other" }],
	] as const)("rejects a boundary that changes the bound %s", async (_name, changed) => {
		const options = processOptions({
			prepare: async (request) => ({
				...request,
				...changed,
				argv: [...request.argv],
				env: { ...request.env },
			}),
		});

		await expect(prepareProviderCommands(options)).rejects.toThrow(
			"Codex containment changed its bound working directories",
		);
	});
});

function processOptions(boundary: CodexProcessBoundary): CodexAppServerProcessOptions {
	return {
		command: { executable: "/opt/agentrelay/codex" },
		workspaceCwd: WORKSPACE,
		processCwd: PROCESS_CWD,
		env: { HOME: PROCESS_CWD, CODEX_HOME: PROCESS_CWD },
		boundary,
		authoritySignal: new AbortController().signal,
	};
}
