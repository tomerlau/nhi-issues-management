import { useId, useRef, useState, type FormEvent } from 'react';
import {
  saveJiraConnection,
  JiraApiError,
  messageForKind,
  type JiraConnectionStatus,
} from '../api/jira';

interface JiraInlineConnectFormProps {
  /** Called with the new connection after a successful save. */
  onSuccess?: (connection: JiraConnectionStatus) => void;
}

/**
 * Inline Jira connection form rendered in the main content area when the
 * tenant has no Jira connection. On success the parent removes this form and
 * shows the connected header state + project selector.
 *
 * The API token field is uncontrolled and cleared immediately on submission,
 * so the secret never persists in React state or the DOM after the request
 * begins.
 */
export default function JiraInlineConnectForm({ onSuccess }: JiraInlineConnectFormProps) {
  const siteUrlId = useId();
  const siteUrlHintId = useId();
  const emailId = useId();
  const tokenId = useId();
  const tokenHintId = useId();
  const errorId = useId();

  const [siteUrl, setSiteUrl] = useState('');
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const tokenRef = useRef<HTMLInputElement>(null);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting) return;

    const tokenInput = tokenRef.current;
    const apiToken = tokenInput?.value ?? '';

    if (siteUrl.trim().length === 0 || email.trim().length === 0 || apiToken.length === 0) {
      setFormError('Enter the Jira site URL, Atlassian email, and API token.');
      return;
    }

    setSubmitting(true);
    setFormError(null);

    if (tokenInput) {
      tokenInput.value = '';
    }

    saveJiraConnection({ siteUrl, email, apiToken })
      .then((connection) => {
        onSuccess?.(connection);
      })
      .catch((error: unknown) => {
        const kind = error instanceof JiraApiError ? error.kind : 'server';
        setFormError(messageForKind(kind));
        setSubmitting(false);
      });
  };

  return (
    <div className="jira-inline-connect">
      <h2>Connect Jira Cloud</h2>
      <form onSubmit={handleSubmit} noValidate autoComplete="off">
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

        <div className="jira-form-actions" style={{ marginTop: '1rem' }}>
          <button type="submit" disabled={submitting}>
            {submitting ? 'Connecting…' : 'Connect Jira'}
          </button>
        </div>
      </form>

      <p className="jira-shared-note">
        The Jira connection is shared by everyone in your tenant. Connecting or
        replacing it changes the integration for all users in your organization.
      </p>
    </div>
  );
}
