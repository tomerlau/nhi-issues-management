import { useState } from 'react';
import { AuthError, logout, type SafeUser } from '../api/auth';
import JiraConnectionPanel from './JiraConnectionPanel';

interface AuthenticatedShellProps {
  user: SafeUser;
  onLoggedOut: () => void;
}

function logoutMessage(error: unknown): string {
  if (error instanceof AuthError && error.kind === 'network') {
    return 'Unable to reach the server. You are still signed in — please try again.';
  }
  return 'Sign out failed. You are still signed in — please try again.';
}

/**
 * The minimal authenticated application shell. It shows only the safe user fields
 * the backend returned (display name and email) and a logout action. Internal
 * user and tenant IDs are deliberately never rendered.
 */
export default function AuthenticatedShell({ user, onLoggedOut }: AuthenticatedShellProps) {
  const [loggingOut, setLoggingOut] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleLogout = () => {
    if (loggingOut) {
      return;
    }
    setLoggingOut(true);
    setError(null);

    logout()
      .then(() => {
        onLoggedOut();
      })
      .catch((logoutError: unknown) => {
        // A failed logout must not clear the authenticated state: the session may
        // still be live on the server, so keep the user signed in and let them retry.
        setError(logoutMessage(logoutError));
        setLoggingOut(false);
      });
  };

  return (
    <div className="app-shell">
      <header className="app-header">
        <span className="app-name">NHI Issues Management</span>
        <div className="app-user">
          <span className="user-name">{user.displayName}</span>
          <span className="user-email">{user.email}</span>
          <button type="button" onClick={handleLogout} disabled={loggingOut}>
            {loggingOut ? 'Signing out…' : 'Sign out'}
          </button>
        </div>
      </header>

      <main className="app-main">
        <h1>Welcome, {user.displayName}</h1>
        <p>You are signed in to NHI Issues Management.</p>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <JiraConnectionPanel />
      </main>
    </div>
  );
}
