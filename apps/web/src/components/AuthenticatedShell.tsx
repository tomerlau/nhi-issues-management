import { useCallback, useEffect, useRef, useState } from 'react';
import { AuthError, logout, type SafeUser } from '../api/auth';
import type { JiraConnectionStatus } from '../api/jira';
import JiraConnectionPanel, { type JiraStatusUpdate } from './JiraConnectionPanel';
import JiraInlineConnectForm from './JiraInlineConnectForm';
import ProjectSelector from './ProjectSelector';
import RecentTicketsPanel from './RecentTicketsPanel';
import TicketCreationModal from './TicketCreationModal';
import { isValidProjectKey, normalizeProjectKey } from '../utils/project-key';
import { loadLastProject, saveLastProject } from '../utils/project-preference';

interface AuthenticatedShellProps {
  user: SafeUser;
  onLoggedOut: () => void;
}

type JiraShellState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'disconnected' }
  | { status: 'connected'; connection: JiraConnectionStatus };

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
 *   - loading: nothing extra (panel shows "Loading…" in header).
 *   - error: nothing extra (panel shows safe error + Retry in header).
 *   - disconnected: JiraInlineConnectForm (full inline connect form).
 *   - connected: ProjectSelector → no-project prompt or RecentTicketsPanel.
 * - TicketCreationModal: floating modal for Mode A ticket creation.
 *
 * One authoritative Jira connection state: `jiraState` (JiraShellState), driven
 * by `JiraConnectionPanel`'s `onStatusChange` callback. The inline form is shown
 * ONLY when the panel has confirmed `{ connected: false }` from a GET response —
 * never on a load error. On inline form POST success, the shell immediately
 * transitions to `connected` using the POST result, before any follow-up GET.
 * If the follow-up GET fails, `jiraState` stays `connected` (the guard in
 * `handleJiraStatusChange` prevents demotion by transient loading/error phases).
 */
export default function AuthenticatedShell({ user, onLoggedOut }: AuthenticatedShellProps) {
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const [jiraState, setJiraState] = useState<JiraShellState>({ status: 'loading' });
  const [jiraRefreshSignal, setJiraRefreshSignal] = useState(0);
  // Initialize the project selector lazily from the user-and-tenant-scoped
  // browser preference. Invalid, missing, or inaccessible storage falls back
  // to an empty string (see project-preference.ts). The value is bound to the
  // current SafeUser, so a different user starts with their own preference.
  const [projectKey, setProjectKey] = useState<string>(() => loadLastProject(user));
  const [refreshKey, setRefreshKey] = useState(0);
  const [creationModalOpen, setCreationModalOpen] = useState(false);
  const [ticketCreationSubmitting, setTicketCreationSubmitting] = useState(false);

  const createTicketTriggerRef = useRef<HTMLButtonElement>(null);

  // Reset the selector to the new user's saved preference when the
  // authenticated user changes (e.g. a different user signs in within the
  // same browser session). React reuses this component instance only when its
  // key matches; the shell is mounted fresh per session in App.tsx, but the
  // explicit effect makes the user/tenant-scoping guarantee robust to future
  // refactors and to any in-place user swap a parent might perform.
  useEffect(() => {
    setProjectKey(loadLastProject(user));
  }, [user]);

  // Persist a newly-typed valid project key. Empty, partial, or invalid input
  // is a deliberate no-op inside saveLastProject so the previous saved value
  // is never overwritten by clearing the field or by transient invalid text.
  useEffect(() => {
    saveLastProject(user, projectKey);
  }, [user, projectKey]);

  const handleJiraStatusChange = useCallback((update: JiraStatusUpdate) => {
    setJiraState((current) => {
      // After a successful inline POST confirms a connection, loading and error
      // from the follow-up GET must not demote the known connected state.
      // A GET returning disconnected is authoritative and always accepted.
      if (
        current.status === 'connected' &&
        (update.status === 'loading' || update.status === 'error')
      ) {
        return current;
      }
      return update;
    });
  }, []);

  const handleConnectionSaved = useCallback(() => {
    setRefreshKey((k) => k + 1);
  }, []);

  const handleInlineConnectSuccess = useCallback((connection: JiraConnectionStatus) => {
    // Immediately transition to connected using the POST result — do not wait
    // for the follow-up GET. This ensures the inline form is removed even if
    // the subsequent GET fails.
    setJiraState({ status: 'connected', connection });
    // Trigger a follow-up GET so the panel header reconciles server state.
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
        <JiraConnectionPanel
          onStatusChange={handleJiraStatusChange}
          onConnectionSaved={handleConnectionSaved}
          externalRefreshSignal={jiraRefreshSignal}
        />
        <div className="app-user">
          <span className="user-email">{user.email}</span>
          <button type="button" onClick={handleLogout} disabled={loggingOut}>
            {loggingOut ? 'Signing out…' : 'Sign out'}
          </button>
        </div>
      </header>

      <main className="app-main">
        <h1>Welcome, {user.displayName}</h1>

        {logoutError && (
          <p className="form-error" role="alert">
            {logoutError}
          </p>
        )}

        {jiraState.status === 'disconnected' && (
          <JiraInlineConnectForm onSuccess={handleInlineConnectSuccess} />
        )}

        {jiraState.status === 'connected' && (
          <>
            <ProjectSelector
              value={projectKey}
              onChange={setProjectKey}
              disabled={creationModalOpen || ticketCreationSubmitting}
            />

            {hasValidProject && (
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

      {jiraState.status === 'connected' && hasValidProject && (
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
