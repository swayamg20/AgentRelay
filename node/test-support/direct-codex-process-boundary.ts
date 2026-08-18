import type { CodexProcessBoundary } from "../src/codex-process-boundary.js";

/** Test-only escape hatch for protocol fixtures that are not exercising OS containment. */
export const directCodexProcessBoundaryForTests: CodexProcessBoundary = {
	prepare: async (request, signal) => {
		signal.throwIfAborted();
		return { ...request, argv: [...request.argv], env: { ...request.env } };
	},
};
