export const DEPRECATION_NOTICE =
	"agentrelay-mcp is deprecated; use 'agentrelay mcp' (this bin still works for backwards compatibility).\n";

export function shouldEmitDeprecationNotice(
	env: NodeJS.ProcessEnv,
	isStdinTTY: boolean,
): boolean {
	return env.AGENTRELAY_SUPPRESS_DEPRECATION !== "1" && !isStdinTTY;
}
