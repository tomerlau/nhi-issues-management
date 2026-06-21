import { useCallback, useEffect, useState } from 'react';
import { fetchHealth } from './api/health';

type BackendStatus = 'loading' | 'connected' | 'unavailable';

const containerStyle: React.CSSProperties = {
  fontFamily: 'system-ui, sans-serif',
  maxWidth: '32rem',
  margin: '4rem auto',
  padding: '0 1rem',
  lineHeight: 1.5,
};

export default function App() {
  const [status, setStatus] = useState<BackendStatus>('loading');

  const checkHealth = useCallback((signal?: AbortSignal) => {
    setStatus('loading');
    fetchHealth(signal)
      .then((health) => {
        setStatus(health.status === 'ok' ? 'connected' : 'unavailable');
      })
      .catch(() => {
        if (!signal?.aborted) {
          setStatus('unavailable');
        }
      });
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    checkHealth(controller.signal);
    return () => controller.abort();
  }, [checkHealth]);

  return (
    <main style={containerStyle}>
      <h1>IdentityHub to Jira</h1>
      <p>Project foundation (Milestone 1)</p>

      <section aria-live="polite">
        {status === 'loading' && <p>Checking backend availability…</p>}

        {status === 'connected' && (
          <p role="status">Connected to the backend service.</p>
        )}

        {status === 'unavailable' && (
          <div role="alert">
            <p>The backend service is currently unavailable. Please make sure it is running.</p>
            <button type="button" onClick={() => checkHealth()}>
              Try again
            </button>
          </div>
        )}
      </section>
    </main>
  );
}
