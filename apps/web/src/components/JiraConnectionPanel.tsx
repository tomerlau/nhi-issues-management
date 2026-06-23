import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import {
  getJiraConnection,
  saveJiraConnection,
  JiraApiError,
  messageForKind,
  type JiraConnectionStatus,
  type JiraErrorKind,
} from '../api/jira';

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; kind: JiraErrorKind }
  | { status: 'ready'; connection: JiraConnectionStatus };

interface JiraConnectionPanelProps {
  onConnectionChange?: (connected: boolean) => void;
  onConnectionSaved?: () => void;
}

/**
 * Compact Jira connection status bar. Shows the current connection state and
 * a trigger button ("Connect Jira" or "Manage") that opens a modal for
 * connection creation or replacement. Connection details (site URL, email) and
 * the tenant-sharing disclaimer are inside the modal only.
 */
export default function JiraConnectionPanel({
  onConnectionChange,
  onConnectionSaved,
}: JiraConnectionPanelProps) {
  const modalHeadingId = useId();
  const siteUrlId = useId();
  const siteUrlHintId = useId();
  const emailId = useId();
  const tokenId = useId();
  const tokenHintId = useId();
  const errorId = useId();

  const [load, setLoad] = useState<LoadState>({ status: 'loading' });
  const [modalOpen, setModalOpen] = useState(false);
  const [siteUrl, setSiteUrl] = useState('');
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const tokenRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback((signal?: AbortSignal) => {
    setLoad({ status: 'loading' });
    getJiraConnection(signal)
      .then((connection) => {
        setLoad({ status: 'ready', connection });
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        const kind = error instanceof JiraApiError ? error.kind : 'server';
        setLoad({ status: 'error', kind });
      });
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    refresh(controller.signal);
    return () => controller.abort();
  }, [refresh]);

  const connectedNow = load.status === 'ready' && load.connection.connected;
  useEffect(() => {
    onConnectionChange?.(connectedNow);
  }, [connectedNow, onConnectionChange]);

  const openModal = () => {
    setFormError(null);
    setSiteUrl('');
    setEmail('');
    setModalOpen(true);
    requestAnimationFrame(() => {
      modalRef.current?.focus();
    });
  };

  const closeModal = () => {
    setModalOpen(false);
    setSiteUrl('');
    setEmail('');
    setFormError(null);
    requestAnimationFrame(() => {
      triggerRef.current?.focus();
    });
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape' && !submitting) {
      closeModal();
    }
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting || load.status !== 'ready') return;

    const tokenInput = tokenRef.current;
    const apiToken = tokenInput?.value ?? '';

    if (siteUrl.trim().length === 0 || email.trim().length === 0 || apiToken.length === 0) {
      setFormError('Enter the Jira site URL, Atlassian email, and API token.');
      return;
    }

    const wasConnected = load.connection.connected;

    setSubmitting(true);
    setFormError(null);

    if (tokenInput) {
      tokenInput.value = '';
    }

    saveJiraConnection({ siteUrl, email, apiToken })
      .then((connection) => {
        setLoad({ status: 'ready', connection });
        setSubmitting(false);
        setModalOpen(false);
        setSiteUrl('');
        setEmail('');
        setNotice(
          wasConnected
            ? 'Jira connection replaced. The shared connection for your tenant has been updated.'
            : 'Jira connection created. It is now shared by everyone in your tenant.',
        );
        onConnectionSaved?.();
        requestAnimationFrame(() => {
          triggerRef.current?.focus();
        });
      })
      .catch((error: unknown) => {
        const kind = error instanceof JiraApiError ? error.kind : 'server';
        setFormError(messageForKind(kind));
        setSubmitting(false);
      });
  };

  // -------------------------------------------------------------------------
  // Compact status bar rendering
  // -------------------------------------------------------------------------

  const renderStatus = () => {
    if (load.status === 'loading') {
      return (
        <p className="jira-status-compact" aria-live="polite">
          Loading Jira connection…
        </p>
      );
    }

    if (load.status === 'error') {
      const authFailure = load.kind === 'authentication';
      return (
        <div className="jira-status-compact jira-status-error">
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
        </div>
      );
    }

    const { connection } = load;
    return (
      <div className="jira-status-compact">
        {connection.connected ? (
          <>
            <span className="jira-indicator-connected" aria-hidden="true" />
            <span className="jira-label-connected">Jira connected</span>
          </>
        ) : (
          <>
            <span className="jira-indicator-disconnected" aria-hidden="true" />
            <span className="jira-label-disconnected">Jira not connected</span>
          </>
        )}
        <button
          ref={triggerRef}
          type="button"
          className="secondary"
          onClick={openModal}
        >
          {connection.connected ? 'Manage' : 'Connect Jira'}
        </button>
      </div>
    );
  };

  // -------------------------------------------------------------------------
  // Modal rendering
  // -------------------------------------------------------------------------

  const renderModal = () => {
    if (!modalOpen || load.status !== 'ready') return null;

    const { connection } = load;
    const modalTitle = connection.connected ? 'Manage Jira connection' : 'Connect Jira';

    return (
      <div className="modal-backdrop">
        <div
          className="modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby={modalHeadingId}
          tabIndex={-1}
          ref={modalRef}
          onKeyDown={handleKeyDown}
        >
          <div className="modal-header">
            <h2 id={modalHeadingId} className="modal-title">
              {modalTitle}
            </h2>
            <button
              type="button"
              className="modal-close"
              aria-label="Close"
              onClick={closeModal}
              disabled={submitting}
            >
              ✕
            </button>
          </div>

          <div className="modal-body">
            {connection.connected && (
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
            )}

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
                  onChange={(e) => setSiteUrl(e.target.value)}
                  disabled={submitting}
                  required
                  aria-invalid={formError !== null}
                  aria-describedby={formError ? `${siteUrlHintId} ${errorId}` : siteUrlHintId}
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
                  onChange={(e) => setEmail(e.target.value)}
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
                <button
                  type="button"
                  className="secondary"
                  onClick={closeModal}
                  disabled={submitting}
                >
                  Cancel
                </button>
              </div>
            </form>

            <p className="jira-shared-note">
              The Jira connection is shared by everyone in your tenant. Connecting or
              replacing it changes the integration for all users in your organization.
            </p>
          </div>
        </div>
      </div>
    );
  };

  return (
    <>
      <div className="jira-connection-bar">
        {notice && (
          <p className="form-success" role="status">
            {notice}
          </p>
        )}
        {renderStatus()}
      </div>
      {renderModal()}
    </>
  );
}
