import { useCallback, useRef, useState } from 'react';
import { AuthError, logout, type SafeUser } from '../api/auth';
import JiraConnectionPanel from './JiraConnectionPanel';
import ProjectSelector from './ProjectSelector';
import RecentTicketsPanel from './RecentTicketsPanel';
import TicketCreationModal from './TicketCreationModal';
import { isValidProjectKey, normalizeProjectKey } from '../utils/project-key';

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
 * Authenticated application shell.
 *
 * Layout:
 * - Header: product name, user info, sign-out, compact Jira connection status.
 * - Main: page-level ProjectSelector (when Jira connected), then one of:
 *   - No valid project: compact prompt.
 *   - Valid project: RecentTicketsPanel (Mode A or Mode B depending on tickets).
 * - TicketCreationModal: floating modal for Mode A ticket creation.
 *
 * Internal user and tenant IDs are never rendered. The project key is shared
 * state: ProjectSelector owns the input; RecentTicketsPanel and
 * TicketCreationModal read it as a prop.
 */
export default function AuthenticatedShell({ user, onLoggedOut }: AuthenticatedShellProps) {
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const [jiraConnected, setJiraConnected] = useState(false);
  const [projectKey, setProjectKey] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const [creationModalOpen, setCreationModalOpen] = useState(false);

  const createTicketTriggerRef = useRef<HTMLButtonElement>(null);

  const handleConnectionChange = useCallback((connected: boolean) => {
    setJiraConnected(connected);
  }, []);

  const handleConnectionSaved = useCallback(() => {
    setRefreshKey((k) => k + 1);
  }, []);

  const handleTicketCreated = useCallback(() => {
    setRefreshKey((k) => k + 1);
  }, []);

  const handleOpenCreationModal = useCallback(() => {
    setCreationModalOpen(true);
  }, []);

  const handleCloseCreationModal = useCallback(() => {
    setCreationModalOpen(false);
  }, []);

  const handleLogout = () => {
    if (loggingOut) return;
    setLoggingOut(true);
    setLogoutError(null);

    logout()
      .then(() => onLoggedOut())
      .catch((err: unknown) => {
        setLogoutError(logoutMessage(err));
        setLoggingOut(false);
      });
  };

  const normalizedKey = normalizeProjectKey(projectKey);
  const hasValidProject = isValidProjectKey(normalizedKey);

  return (
    <div className="app-shell">
      <header className="app-header">
        <span className="app-name">NHI Issues Management</span>
        <div className="app-header-right">
          <JiraConnectionPanel
            onConnectionChange={handleConnectionChange}
            onConnectionSaved={handleConnectionSaved}
          />
          <div className="app-user">
            <span className="user-name">{user.displayName}</span>
            <span className="user-email">{user.email}</span>
            <button type="button" onClick={handleLogout} disabled={loggingOut}>
              {loggingOut ? 'Signing out…' : 'Sign out'}
            </button>
          </div>
        </div>
      </header>

      <main className="app-main">
        <h1>Welcome, {user.displayName}</h1>
        <p>You are signed in to NHI Issues Management.</p>

        {logoutError && (
          <p className="form-error" role="alert">
            {logoutError}
          </p>
        )}

        {jiraConnected && (
          <>
            <ProjectSelector
              value={projectKey}
              onChange={setProjectKey}
            />

            {!hasValidProject ? (
              <p className="no-project-prompt">
                Enter a Jira project key to view or create tickets.
              </p>
            ) : (
              <RecentTicketsPanel
                projectKey={projectKey}
                refreshKey={refreshKey}
                onOpenCreationModal={handleOpenCreationModal}
                onTicketCreated={handleTicketCreated}
              />
            )}
          </>
        )}
      </main>

      {jiraConnected && hasValidProject && (
        <TicketCreationModal
          projectKey={normalizedKey}
          open={creationModalOpen}
          onClose={handleCloseCreationModal}
          onTicketCreated={handleTicketCreated}
          triggerRef={createTicketTriggerRef}
        />
      )}
    </div>
  );
}
