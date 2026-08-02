import type { AuthenticatedAgent, AuthenticatedNode } from "./auth/middleware.js";
import type { AppVariables } from "./middleware.js";

export type AppEnv = {
	Variables: AppVariables & {
		agent?: AuthenticatedAgent;
		node?: AuthenticatedNode;
	};
};
