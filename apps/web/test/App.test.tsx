import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App';
import { fetchHealth } from '../src/api/health';

vi.mock('../src/api/health', () => ({
  fetchHealth: vi.fn(),
}));

const mockedFetchHealth = vi.mocked(fetchHealth);

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe('App backend status', () => {
  it('displays a loading state while the health check is pending', () => {
    mockedFetchHealth.mockReturnValue(new Promise(() => {}));

    render(<App />);

    expect(screen.getByText(/checking backend availability/i)).toBeInTheDocument();
  });

  it('displays a connected state when the health check succeeds', async () => {
    mockedFetchHealth.mockResolvedValue({ status: 'ok' });

    render(<App />);

    expect(await screen.findByText(/connected to the backend service/i)).toBeInTheDocument();
  });

  it('displays a meaningful unavailable state when the health check fails', async () => {
    mockedFetchHealth.mockRejectedValue(new Error('network error'));

    render(<App />);

    expect(
      await screen.findByText(/backend service is currently unavailable/i),
    ).toBeInTheDocument();
  });
});
