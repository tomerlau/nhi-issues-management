import { useCallback, useEffect, useState } from 'react';
import { restoreSession, type SafeUser } from './api/auth';
import LoginForm from './components/LoginForm';
import AuthenticatedShell from './components/AuthenticatedShell';

/**
 * Explicit authentication state for the application shell:
 * - `restoring`: the initial `GET /api/auth/session` is in flight.
 * - `unauthenticated`: no valid session — show the login screen.
 * - `authenticated`: a valid session — show the application shell.
 * - `restore_error`: restoration failed for a non-auth reason (network/server),
 *   which must NOT be treated as logged out.
 */
type AuthState =
  | { status: 'restoring' }
  | { status: 'unauthenticated' }
  | { status: 'authenticated'; user: SafeUser }
  | { status: 'restore_error' };

export default function App() {
  const [state, setState] = useState<AuthState>({ status: 'restoring' });

  const restore = useCallback((signal?: AbortSignal) => {
    setState({ status: 'restoring' });
    restoreSession(signal)
      .then((user) => {
        setState(user ? { status: 'authenticated', user } : { status: 'unauthenticated' });
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') {
          return;
        }
        // A network or unexpected server failure is distinct from being logged out.
        setState({ status: 'restore_error' });
      });
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    restore(controller.signal);
    return () => controller.abort();
  }, [restore]);

  if (state.status === 'restoring') {
    return (
      <main className="auth-card" aria-live="polite">
        <p>Checking your session…</p>
      </main>
    );
  }

  if (state.status === 'restore_error') {
    return (
      <main className="auth-card" role="alert">
        <p>We couldn&apos;t verify your session. Please check your connection and try again.</p>
        <button type="button" onClick={() => restore()}>
          Try again
        </button>
      </main>
    );
  }

  if (state.status === 'authenticated') {
    return (
      <AuthenticatedShell
        user={state.user}
        onLoggedOut={() => setState({ status: 'unauthenticated' })}
      />
    );
  }

  return <LoginForm onAuthenticated={(user) => setState({ status: 'authenticated', user })} />;
}
