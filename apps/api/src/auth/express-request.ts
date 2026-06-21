import 'express';
import type { AuthContext, SafeUser } from './auth-context.js';

/**
 * The state the authentication middleware attaches to a request once a session
 * has been resolved. Routes behind the middleware can rely on it being present.
 */
export interface AuthenticatedState {
  context: AuthContext;
  user: SafeUser;
}

declare module 'express-serve-static-core' {
  interface Request {
    auth?: AuthenticatedState;
  }
}
