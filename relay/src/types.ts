import type { AuthenticatedAgent } from './auth/middleware.js';
import type { AppVariables } from './middleware.js';

export type AppEnv = {
  Variables: AppVariables & {
    agent?: AuthenticatedAgent;
  };
};
