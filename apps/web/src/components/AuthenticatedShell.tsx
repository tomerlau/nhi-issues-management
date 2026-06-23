import { useCallback, useState } from 'react';
import { AuthError, logout, type SafeUser } from '../api/auth';
import JiraConnectionPanel from './JiraConnectionPanel';
import RecentTicketsPanel from './RecentTicketsPanel';
import TicketCreationPanel from './TicketCreationPanel';

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
 *
 * The project key is shared state owned here so both the ticket-creation form and
 * the recent-tickets panel use the same selection. A `refreshKey` counter is
 * incremented after a successful ticket creation or a successful Jira connection
 * creation or replacement so the recent-tickets panel refreshes without debounce.
 */
export default function AuthenticatedShell({ user, onLoggedOut }: AuthenticatedShellProps) {
  const [loggingOut, setLoggingOut] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [jiraConnected, setJiraConnected] = useState(false);
  const [projectKey, setProjectKey] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);

  // Stable so the connection panel's reporting effect does not re-fire on every
  // shell render.
  const handleConnectionChange = useCallback((connected: boolean) => {
    setJiraConnected(connected);
  }, []);

  // Increment refreshKey after a successful Jira connection creation or
  // replacement so the recent-tickets panel immediately invalidates its current
  // results and re-fetches against the new connection.
  const handleConnectionSaved = useCallback(() => {
    setRefreshKey((k) => k + 1);
  }, []);

  const handleProjectKeyChange = useCallback((key: string) => {
    setProjectKey(key);
  }, []);

  const handleTicketCreated = useCallback(() => {
    setRefreshKey((k) => k + 1);
  }, []);

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
        <JiraConnectionPanel
          onConnectionChange={handleConnectionChange}
          onConnectionSaved={handleConnectionSaved}
        />
        {jiraConnected && (
          <>
            <TicketCreationPanel
              projectKey={projectKey}
              onProjectKeyChange={handleProjectKeyChange}
              onTicketCreated={handleTicketCreated}
            />
            <RecentTicketsPanel
              projectKey={projectKey}
              refreshKey={refreshKey}
            />
          </>
        )}
      </main>
    </div>
  );
}
