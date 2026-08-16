export interface CodexProcessRequest {
	readonly executable: string;
	readonly argv: readonly string[];
	readonly cwd: string;
	readonly env: NodeJS.ProcessEnv;
}

export interface PreparedCodexProcess {
	readonly executable: string;
	readonly argv: readonly string[];
	readonly cwd: string;
	readonly env: NodeJS.ProcessEnv;
}

/** A required, external process boundary for both the version probe and app-server. */
export interface CodexProcessBoundary {
	prepare(request: CodexProcessRequest): Promise<PreparedCodexProcess>;
}
