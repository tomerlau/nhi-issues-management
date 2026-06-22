import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import {
  getJiraConnection,
  saveJiraConnection,
  JiraApiError,
  messageForKind,
  type JiraConnectionStatus,
  type JiraErrorKind,
} from '../api/jira';

/**
 * The panel's load lifecycle for the tenant's shared Jira connection:
 * - `loading`: the initial `GET /api/jira/connection` is in flight.
 * - `error`: the status could not be loaded; `kind` retains the safe failure
 *   category so the panel can show category-specific copy.
 * - `ready`: a safe connection status was loaded.
 */
type LoadState =
  | { status: 'loading' }
  | { status: 'error'; kind: JiraErrorKind }
  | { status: 'ready'; connection: JiraConnectionStatus };

/**
 * Tenant-wide Jira connection panel. It shows the shared connection status and
 * lets any authenticated tenant user create or replace the single connection.
 *
 * The API token is handled as a secret: its input is uncontrolled and read only
 * via a DOM ref at submit time, the value is cleared from the field immediately
 * once captured (before the network request resolves), and it is never placed in
 * React state or any browser storage. siteUrl and email are ordinary state.
 */
export default function JiraConnectionPanel() {
  const headingId = useId();
  const siteUrlId = useId();
  const siteUrlHintId = useId();
  const emailId = useId();
  const tokenId = useId();
  const tokenHintId = useId();
  const errorId = useId();

  const [load, setLoad] = useState<LoadState>({ status: 'loading' });
  const [siteUrl, setSiteUrl] = useState('');
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // The token never enters React state. It lives only in this uncontrolled input
  // and, transiently, in the submit handler and outgoing request body.
  const tokenRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback((signal?: AbortSignal) => {
    setLoad({ status: 'loading' });
    getJiraConnection(signal)
      .then((connection) => {
        setLoad({ status: 'ready', connection });
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') {
          return;
        }
        // Preserve the distinct failure category; unknown errors fall back to server.
        const kind = error instanceof JiraApiError ? error.kind : 'server';
        setLoad({ status: 'error', kind });
      });
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    refresh(controller.signal);
    return () => controller.abort();
  }, [refresh]);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting || load.status !== 'ready') {
      return;
    }

    const tokenInput = tokenRef.current;
    const apiToken = tokenInput?.value ?? '';

    // Small client-side usability validation only; the backend stays authoritative
    // on the Jira URL security policy. Reject empty fields before any network call.
    if (siteUrl.trim().length === 0 || email.trim().length === 0 || apiToken.length === 0) {
      setNotice(null);
      setFormError('Enter the Jira site URL, Atlassian email, and API token.');
      return;
    }

    const wasConnected = load.connection.connected;

    setSubmitting(true);
    setFormError(null);
    setNotice(null);

    // Clear the captured token from the input immediately, before the request
    // resolves, so it is never retained for a retry or visible in the DOM.
    if (tokenInput) {
      tokenInput.value = '';
    }

    saveJiraConnection({ siteUrl, email, apiToken })
      .then((connection) => {
        setLoad({ status: 'ready', connection });
        setReplacing(false);
        setSiteUrl('');
        setEmail('');
        setSubmitting(false);
        setNotice(
          wasConnected
            ? 'Jira connection replaced. The shared connection for your tenant has been updated.'
            : 'Jira connection created. It is now shared by everyone in your tenant.',
        );
      })
      .catch((error: unknown) => {
        // A failed save never removes the existing connection: keep the loaded
        // status untouched and require the token to be entered again.
        const kind = error instanceof JiraApiError ? error.kind : 'server';
        setFormError(messageForKind(kind));
        setSubmitting(false);
      });
  };

  if (load.status === 'loading') {
    return (
      <section className="jira-panel" aria-labelledby={headingId}>
        <h2 id={headingId}>Jira connection</h2>
        <p aria-live="polite">Loading the Jira connection…</p>
      </section>
    );
  }

  if (load.status === 'error') {
    // An expired session cannot be recovered by retrying the request: ask the
    // user to refresh or sign in again instead of offering a futile retry.
    const authFailure = load.kind === 'authentication';
    return (
      <section className="jira-panel" aria-labelledby={headingId}>
        <h2 id={headingId}>Jira connection</h2>
        <p className="form-error" role="alert">
          {authFailure
            ? 'Your session is no longer valid. Please refresh the page or sign in again.'
            : messageForKind(load.kind)}
        </p>
        {!authFailure && (
          <button type="button" onClick={() => refresh()}>
            Try again
          </button>
        )}
      </section>
    );
  }

  const { connection } = load;
  const showForm = !connection.connected || replacing;

  return (
    <section className="jira-panel" aria-labelledby={headingId}>
      <h2 id={headingId}>Jira connection</h2>

      {notice && (
        <p className="form-success" role="status">
          {notice}
        </p>
      )}

      {connection.connected ? (
        <div className="jira-status jira-status-connected">
          <p className="jira-connection-state">
            <span className="jira-status-indicator" aria-hidden="true" />
            <span className="jira-status-label">Connected</span>
            <span>Your tenant is connected to Jira.</span>
          </p>
          <dl className="jira-details">
            <div>
              <dt>Site URL</dt>
              <dd>{connection.siteUrl}</dd>
            </div>
            <div>
              <dt>Atlassian email</dt>
              <dd>{connection.email}</dd>
            </div>
          </dl>
          {!replacing && (
            <button
              type="button"
              onClick={() => {
                setNotice(null);
                setFormError(null);
                setReplacing(true);
              }}
            >
              Replace connection
            </button>
          )}
        </div>
      ) : (
        <p className="jira-status jira-status-disconnected">
          Your tenant is not connected to Jira yet. Add a Jira Cloud connection to
          get started.
        </p>
      )}

      {showForm && (
        <form className="jira-form" onSubmit={handleSubmit} noValidate autoComplete="off">
          <h3>
            {connection.connected ? 'Replace the shared connection' : 'Connect Jira Cloud'}
          </h3>

          <div className="field">
            <label htmlFor={siteUrlId}>Jira Cloud site URL</label>
            <input
              id={siteUrlId}
              name="jiraSiteUrl"
              type="url"
              inputMode="url"
              autoComplete="off"
              placeholder="https://your-site.atlassian.net"
              value={siteUrl}
              onChange={(event) => setSiteUrl(event.target.value)}
              disabled={submitting}
              required
              aria-invalid={formError !== null}
              aria-describedby={
                formError ? `${siteUrlHintId} ${errorId}` : siteUrlHintId
              }
            />
            <p id={siteUrlHintId} className="field-hint">
              Use the format https://&lt;site&gt;.atlassian.net
            </p>
          </div>

          <div className="field">
            <label htmlFor={emailId}>Atlassian account email</label>
            <input
              id={emailId}
              name="jiraAccountEmail"
              type="text"
              inputMode="email"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              disabled={submitting}
              required
              aria-invalid={formError !== null}
              aria-describedby={formError ? errorId : undefined}
            />
          </div>

          <div className="field">
            <label htmlFor={tokenId}>Atlassian API token</label>
            <input
              id={tokenId}
              name="jiraApiToken"
              type="password"
              autoComplete="new-password"
              ref={tokenRef}
              disabled={submitting}
              required
              aria-invalid={formError !== null}
              aria-describedby={formError ? `${tokenHintId} ${errorId}` : tokenHintId}
            />
            <p id={tokenHintId} className="field-hint">
              Use an unscoped Atlassian API token. The token is sent to the
              backend only for this request, is not stored in your browser, and is
              never shown again.
            </p>
          </div>

          {formError && (
            <p id={errorId} className="form-error" role="alert">
              {formError}
            </p>
          )}

          <div className="jira-form-actions">
            <button type="submit" disabled={submitting}>
              {submitting
                ? 'Connecting…'
                : connection.connected
                  ? 'Replace connection'
                  : 'Connect Jira'}
            </button>
            {connection.connected && replacing && (
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  setReplacing(false);
                  setFormError(null);
                  setSiteUrl('');
                  setEmail('');
                }}
                disabled={submitting}
              >
                Cancel
              </button>
            )}
          </div>
        </form>
      )}

      <p className="jira-shared-note">
        The Jira connection is shared by everyone in your tenant. Connecting or
        replacing it changes the integration for all users in your organization.
      </p>
    </section>
  );
}
