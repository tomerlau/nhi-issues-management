import { useCallback, useRef, useState } from 'react';
import { AuthError, logout, type SafeUser } from '../api/auth';
import type { JiraConnectionStatus } from '../api/jira';
import JiraConnectionPanel from './JiraConnectionPanel';
import JiraInlineConnectForm from './JiraInlineConnectForm';
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
 * - Header: product name, Jira status bar (left of user area), user email,
 *   sign-out. User display name is not shown in the header.
 * - Main: varies by Jira connection state:
 *   - Loading: nothing extra (Jira status shows "Loading…" in header).
 *   - Disconnected: JiraInlineConnectForm (full inline connect form).
 *   - Connected: ProjectSelector → no-project prompt or RecentTicketsPanel.
 * - TicketCreationModal: floating modal for Mode A ticket creation.
 *
 * One authoritative Jira connection state lives here: `jiraConnected`
 * (whether connected) and `jiraLoading` (whether the status is being fetched).
 * Both are reported by JiraConnectionPanel via callbacks. JiraInlineConnectForm
 * calls saveJiraConnection directly and on success increments
 * `jiraRefreshSignal`, which tells JiraConnectionPanel to re-fetch so the
 * header updates.
 */
export default function AuthenticatedShell({ user, onLoggedOut }: AuthenticatedShellProps) {
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const [jiraConnected, setJiraConnected] = useState(false);
  const [jiraLoading, setJiraLoading] = useState(true);
  const [jiraRefreshSignal, setJiraRefreshSignal] = useState(0);
  const [projectKey, setProjectKey] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const [creationModalOpen, setCreationModalOpen] = useState(false);
  const [ticketCreationSubmitting, setTicketCreationSubmitting] = useState(false);

  const createTicketTriggerRef = useRef<HTMLButtonElement>(null);

  const handleConnectionChange = useCallback((connected: boolean) => {
    setJiraConnected(connected);
  }, []);

  const handleJiraLoading = useCallback((loading: boolean) => {
    setJiraLoading(loading);
  }, []);

  const handleConnectionSaved = useCallback(() => {
    setRefreshKey((k) => k + 1);
  }, []);

  const handleInlineConnectSuccess = useCallback((_connection: JiraConnectionStatus) => {
    // Tell the panel to re-fetch so the header reflects the new connected state.
    setJiraRefreshSignal((s) => s + 1);
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

  const handleTicketCreationSubmittingChange = useCallback((submitting: boolean) => {
    setTicketCreationSubmitting(submitting);
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
            onLoadingChange={handleJiraLoading}
            externalRefreshSignal={jiraRefreshSignal}
          />
          <div className="app-user">
            <span className="user-email">{user.email}</span>
            <button type="button" onClick={handleLogout} disabled={loggingOut}>
              {loggingOut ? 'Signing out…' : 'Sign out'}
            </button>
          </div>
        </div>
      </header>

      <main className="app-main">
        <h1>Welcome, {user.displayName}</h1>

        {logoutError && (
          <p className="form-error" role="alert">
            {logoutError}
          </p>
        )}

        {!jiraConnected && !jiraLoading && (
          <JiraInlineConnectForm onSuccess={handleInlineConnectSuccess} />
        )}

        {jiraConnected && (
          <>
            <ProjectSelector
              value={projectKey}
              onChange={setProjectKey}
              disabled={creationModalOpen || ticketCreationSubmitting}
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
                triggerRef={createTicketTriggerRef}
                onSubmittingChange={handleTicketCreationSubmittingChange}
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
          onSubmittingChange={handleTicketCreationSubmittingChange}
        />
      )}
    </div>
  );
}
