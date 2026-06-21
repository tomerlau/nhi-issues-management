export interface HealthResponse {
  status: 'ok' | 'unavailable';
}

/**
 * Typed wrapper around the backend health endpoint. Centralizing the request
 * keeps components free of raw `fetch` calls and response shape assumptions.
 */
export async function fetchHealth(signal?: AbortSignal): Promise<HealthResponse> {
  const response = await fetch('/api/health', {
    headers: { Accept: 'application/json' },
    signal,
  });

  if (!response.ok) {
    throw new Error(`Health request failed with status ${response.status}`);
  }

  return (await response.json()) as HealthResponse;
}
