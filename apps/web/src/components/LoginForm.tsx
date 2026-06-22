import { useId, useState, type FormEvent } from 'react';
import { AuthError, login, type SafeUser } from '../api/auth';

interface LoginFormProps {
  onAuthenticated: (user: SafeUser) => void;
}

/**
 * Map a login failure to generic, UI-safe copy. Invalid credentials stay generic
 * so the form never reveals whether an email exists, and raw backend text is
 * never shown.
 */
function messageForError(error: unknown): string {
  if (error instanceof AuthError) {
    switch (error.kind) {
      case 'invalid_credentials':
        return 'Invalid email or password.';
      case 'invalid_request':
        return 'Please enter a valid email and password.';
      case 'network':
        return 'Unable to reach the server. Check your connection and try again.';
      default:
        return 'Something went wrong. Please try again.';
    }
  }
  return 'Something went wrong. Please try again.';
}

export default function LoginForm({ onAuthenticated }: LoginFormProps) {
  const emailId = useId();
  const passwordId = useId();
  const errorId = useId();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting) {
      return;
    }

    if (email.trim().length === 0 || password.length === 0) {
      setError('Enter both your email and password.');
      return;
    }

    setSubmitting(true);
    setError(null);

    login(email, password)
      .then((user) => {
        // Clear the password immediately on a completed (successful) attempt.
        setPassword('');
        onAuthenticated(user);
      })
      .catch((loginError: unknown) => {
        // Clear the password on a completed (failed) attempt too.
        setPassword('');
        setError(messageForError(loginError));
        setSubmitting(false);
      });
  };

  return (
    <main className="auth-card" aria-labelledby={`${emailId}-heading`}>
      <h1 id={`${emailId}-heading`}>Sign in to IdentityHub to Jira</h1>
      <form className="auth-form" onSubmit={handleSubmit} noValidate>
        <div className="field">
          <label htmlFor={emailId}>Email</label>
          <input
            id={emailId}
            name="email"
            type="email"
            autoComplete="username"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            disabled={submitting}
            required
            aria-invalid={error !== null}
            aria-describedby={error ? errorId : undefined}
          />
        </div>

        <div className="field">
          <label htmlFor={passwordId}>Password</label>
          <input
            id={passwordId}
            name="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            disabled={submitting}
            required
            aria-invalid={error !== null}
            aria-describedby={error ? errorId : undefined}
          />
        </div>

        {error && (
          <p id={errorId} className="form-error" role="alert">
            {error}
          </p>
        )}

        <button type="submit" disabled={submitting}>
          {submitting ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </main>
  );
}
