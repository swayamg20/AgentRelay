/**
 * Detects when a user accidentally invokes the `agentrelay-mcp` stdio server
 * binary with a CLI verb (e.g. `agentrelay-mcp register …`). Pure functions —
 * import-safe, no side effects.
 */

export const CLI_VERBS = new Set([
  'register',
  'install',
  'doctor',
  'audit',
  'block',
  'unblock',
  'trust',
  'rotate-key',
  'version',
  '--help',
  '-h',
]);

export const CLI_MISUSE_HINT =
  'agentrelay-mcp is the MCP server (stdio), not the AgentRelay CLI.\n' +
  'Did you mean to run the CLI?\n' +
  '  npx -y -p agentrelay-mcp agentrelay <cmd> [...args]\n' +
  'See: agentrelay --help\n';

export function isCliMisuse(arg: string | undefined): boolean {
  return arg !== undefined && CLI_VERBS.has(arg);
}
