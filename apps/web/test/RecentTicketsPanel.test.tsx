import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import RecentTicketsPanel from '../src/components/RecentTicketsPanel';
import {
  listRecentTickets,
  RecentTicketsApiError,
  type ListRecentTicketsResult,
  type RecentTicketsErrorKind,
} from '../src/api/tickets';

vi.mock('../src/api/tickets', async () => {
  const actual = await vi.importActual<typeof import('../src/api/tickets')>('../src/api/tickets');
  return {
    ...actual,
    listRecentTickets: vi.fn(),
  };
});

const mockedList = vi.mocked(listRecentTickets);

const TICKET_A = {
  issueId: '10001',
  issueKey: 'SCRUM-1',
  title: 'Leaked service-account key',
  createdAt: '2026-06-01T12:00:00.000Z',
  url: 'https://acme.atlassian.net/browse/SCRUM-1',
};

const TICKET_B = {
  issueId: '10002',
  issueKey: 'SCRUM-2',
  title: 'Stale OAuth token',
  createdAt: '2026-05-15T08:30:00.000Z',
  url: 'https://acme.atlassian.net/browse/SCRUM-2',
};

function success(tickets = [TICKET_A]): ListRecentTicketsResult {
  return { tickets };
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

// ---------------------------------------------------------------------------
// Prompt state
// ---------------------------------------------------------------------------

describe('prompt state', () => {
  it('shows a prompt when no project key is entered', () => {
    render(<RecentTicketsPanel projectKey="" refreshKey={0} />);

    expect(screen.getByText(/enter a jira project key/i)).toBeInTheDocument();
    expect(mockedList).not.toHaveBeenCalled();
  });

  it('shows a prompt for an invalid project key', () => {
    render(<RecentTicketsPanel projectKey="1AB" refreshKey={0} />);

    expect(screen.getByText(/enter a jira project key/i)).toBeInTheDocument();
    expect(mockedList).not.toHaveBeenCalled();
  });

  it('shows a prompt for a single-character key (too short)', () => {
    render(<RecentTicketsPanel projectKey="A" refreshKey={0} />);

    expect(screen.getByText(/enter a jira project key/i)).toBeInTheDocument();
    expect(mockedList).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// No request for invalid keys
// ---------------------------------------------------------------------------

describe('no request for invalid keys', () => {
  it('makes no request when the project key is empty', async () => {
    render(<RecentTicketsPanel projectKey="" refreshKey={0} />);
    await act(async () => { vi.advanceTimersByTime(600); });

    expect(mockedList).not.toHaveBeenCalled();
  });

  it('makes no request when a non-zero refreshKey arrives with an invalid key', async () => {
    const { rerender } = render(<RecentTicketsPanel projectKey="" refreshKey={0} />);
    rerender(<RecentTicketsPanel projectKey="" refreshKey={1} />);
    await act(async () => { vi.advanceTimersByTime(600); });

    expect(mockedList).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Loading state
// ---------------------------------------------------------------------------

describe('loading state', () => {
  it('shows a loading state while the request is pending', async () => {
    mockedList.mockReturnValue(new Promise(() => {}));

    render(<RecentTicketsPanel projectKey="SCRUM" refreshKey={0} />);
    await act(async () => { vi.advanceTimersByTime(600); });

    expect(screen.getByText(/loading tickets/i)).toBeInTheDocument();
  });

  it('shows loading immediately when the project key becomes valid', () => {
    mockedList.mockReturnValue(new Promise(() => {}));

    render(<RecentTicketsPanel projectKey="SCRUM" refreshKey={0} />);

    expect(screen.getByText(/loading tickets/i)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

describe('empty state', () => {
  it('shows the empty state when no tickets are returned', async () => {
    mockedList.mockResolvedValue(success([]));

    render(<RecentTicketsPanel projectKey="SCRUM" refreshKey={0} />);
    await act(async () => { vi.advanceTimersByTime(600); });

    expect(screen.getByText(/no tickets created through this application/i)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Success rendering
// ---------------------------------------------------------------------------

describe('success rendering', () => {
  it('renders a ticket with its title as a link', async () => {
    mockedList.mockResolvedValue(success([TICKET_A]));

    render(<RecentTicketsPanel projectKey="SCRUM" refreshKey={0} />);
    await act(async () => { vi.advanceTimersByTime(600); });

    const link = screen.getByRole('link', { name: /leaked service-account key/i });
    expect(link).toBeInTheDocument();
  });

  it('renders the Jira issue key alongside the title', async () => {
    mockedList.mockResolvedValue(success([TICKET_A]));

    render(<RecentTicketsPanel projectKey="SCRUM" refreshKey={0} />);
    await act(async () => { vi.advanceTimersByTime(600); });

    expect(screen.getByText('SCRUM-1')).toBeInTheDocument();
  });

  it('renders the creation time in a <time> element with the ISO dateTime attribute', async () => {
    mockedList.mockResolvedValue(success([TICKET_A]));

    render(<RecentTicketsPanel projectKey="SCRUM" refreshKey={0} />);
    await act(async () => { vi.advanceTimersByTime(600); });

    const timeEl = document.querySelector('time');
    expect(timeEl).not.toBeNull();
    expect(timeEl?.getAttribute('dateTime')).toBe('2026-06-01T12:00:00.000Z');
  });

  it('links open in a new tab with safe rel attributes', async () => {
    mockedList.mockResolvedValue(success([TICKET_A]));

    render(<RecentTicketsPanel projectKey="SCRUM" refreshKey={0} />);
    await act(async () => { vi.advanceTimersByTime(600); });

    const link = screen.getByRole('link', { name: /leaked service-account key/i }) as HTMLAnchorElement;
    expect(link.target).toBe('_blank');
    expect(link.rel).toContain('noopener');
    expect(link.rel).toContain('noreferrer');
    expect(link.href).toBe(TICKET_A.url);
  });

  it('renders all returned tickets in server order', async () => {
    mockedList.mockResolvedValue(success([TICKET_A, TICKET_B]));

    render(<RecentTicketsPanel projectKey="SCRUM" refreshKey={0} />);
    await act(async () => { vi.advanceTimersByTime(600); });

    const links = screen.getAllByRole('link');
    expect(links[0]).toHaveTextContent(TICKET_A.title);
    expect(links[1]).toHaveTextContent(TICKET_B.title);
  });
});

// ---------------------------------------------------------------------------
// Error state and retry
// ---------------------------------------------------------------------------

describe('error state and retry', () => {
  async function renderWithError(kind: RecentTicketsErrorKind) {
    mockedList.mockRejectedValue(new RecentTicketsApiError(kind, 'raw ignored'));
    render(<RecentTicketsPanel projectKey="SCRUM" refreshKey={0} />);
    await act(async () => { vi.advanceTimersByTime(600); });
  }

  it('shows an error alert for a not_connected error', async () => {
    await renderWithError('not_connected');
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(/not connected to jira/i);
  });

  it('shows an error alert for a credentials_rejected error', async () => {
    await renderWithError('credentials_rejected');
    expect(screen.getByRole('alert')).toHaveTextContent(/credentials were rejected/i);
  });

  it('shows an error alert for a timeout error', async () => {
    await renderWithError('timeout');
    expect(screen.getByRole('alert')).toHaveTextContent(/did not respond in time/i);
  });

  it('shows an error alert for an authentication error', async () => {
    await renderWithError('authentication');
    expect(screen.getByRole('alert')).toHaveTextContent(/session is no longer valid/i);
  });

  it('shows an error alert for a server error', async () => {
    await renderWithError('server');
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('shows a Retry button in the error state', async () => {
    await renderWithError('unreachable');
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });

  it('never shows the raw backend message', async () => {
    await renderWithError('not_connected');
    expect(screen.queryByText(/raw ignored/i)).not.toBeInTheDocument();
  });

  it('retries when the Retry button is clicked', async () => {
    mockedList
      .mockRejectedValueOnce(new RecentTicketsApiError('unreachable', 'x'))
      .mockResolvedValue(success([TICKET_A]));

    render(<RecentTicketsPanel projectKey="SCRUM" refreshKey={0} />);
    await act(async () => { vi.advanceTimersByTime(600); });

    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();

    await act(async () => {
      screen.getByRole('button', { name: /retry/i }).click();
    });

    expect(await screen.findByRole('link', { name: /leaked service-account key/i })).toBeInTheDocument();
  });

  it('does not show duplicate-creation warnings in error messages', async () => {
    const kinds: RecentTicketsErrorKind[] = ['timeout', 'unreachable', 'network', 'server', 'internal_error'];
    for (const kind of kinds) {
      mockedList.mockRejectedValue(new RecentTicketsApiError(kind, 'x'));
      const { unmount } = render(<RecentTicketsPanel projectKey="SCRUM" refreshKey={0} />);
      await act(async () => { vi.advanceTimersByTime(600); });
      expect(screen.getByRole('alert')).not.toHaveTextContent(/duplicate/i);
      unmount();
    }
  });
});

// ---------------------------------------------------------------------------
// Project-key normalization
// ---------------------------------------------------------------------------

describe('project-key normalization', () => {
  it('normalizes a lowercase key to uppercase before requesting', async () => {
    mockedList.mockResolvedValue(success([]));

    render(<RecentTicketsPanel projectKey="scrum" refreshKey={0} />);
    await act(async () => { vi.advanceTimersByTime(600); });

    expect(mockedList).toHaveBeenCalledWith('SCRUM', expect.anything());
  });

  it('trims whitespace from the key before requesting', async () => {
    mockedList.mockResolvedValue(success([]));

    render(<RecentTicketsPanel projectKey="  SCRUM  " refreshKey={0} />);
    await act(async () => { vi.advanceTimersByTime(600); });

    expect(mockedList).toHaveBeenCalledWith('SCRUM', expect.anything());
  });
});

// ---------------------------------------------------------------------------
// Changing project key
// ---------------------------------------------------------------------------

describe('changing the project key', () => {
  it('requests the new project after the debounce when the key changes', async () => {
    mockedList.mockResolvedValue(success([]));

    const { rerender } = render(<RecentTicketsPanel projectKey="SCRUM" refreshKey={0} />);
    await act(async () => { vi.advanceTimersByTime(600); });

    expect(mockedList).toHaveBeenCalledTimes(1);
    expect(mockedList).toHaveBeenLastCalledWith('SCRUM', expect.anything());

    mockedList.mockResolvedValue(success([TICKET_B]));
    rerender(<RecentTicketsPanel projectKey="PROJ" refreshKey={0} />);
    await act(async () => { vi.advanceTimersByTime(600); });

    expect(mockedList).toHaveBeenCalledTimes(2);
    expect(mockedList).toHaveBeenLastCalledWith('PROJ', expect.anything());
  });

  it('does not show the previous project results while loading the new project', async () => {
    mockedList.mockResolvedValue(success([TICKET_A]));

    const { rerender } = render(<RecentTicketsPanel projectKey="SCRUM" refreshKey={0} />);
    await act(async () => { vi.advanceTimersByTime(600); });

    expect(screen.getByRole('link', { name: TICKET_A.title })).toBeInTheDocument();

    // Switch to a new project — loading state should immediately hide old results.
    mockedList.mockReturnValue(new Promise(() => {}));
    rerender(<RecentTicketsPanel projectKey="PROJ" refreshKey={0} />);

    expect(screen.queryByRole('link', { name: TICKET_A.title })).not.toBeInTheDocument();
    expect(screen.getByText(/loading tickets/i)).toBeInTheDocument();
  });

  it('reverts to prompt when the key becomes empty', async () => {
    mockedList.mockResolvedValue(success([TICKET_A]));

    const { rerender } = render(<RecentTicketsPanel projectKey="SCRUM" refreshKey={0} />);
    await act(async () => { vi.advanceTimersByTime(600); });

    rerender(<RecentTicketsPanel projectKey="" refreshKey={0} />);

    expect(screen.getByText(/enter a jira project key/i)).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Stale response prevention
// ---------------------------------------------------------------------------

describe('stale response prevention', () => {
  it('ignores the response for the old project when the key changes while loading', async () => {
    let resolveSCRUM!: (r: ListRecentTicketsResult) => void;
    const scrumPromise = new Promise<ListRecentTicketsResult>((res) => { resolveSCRUM = res; });

    mockedList
      .mockReturnValueOnce(scrumPromise)
      .mockResolvedValue(success([TICKET_B]));

    const { rerender } = render(<RecentTicketsPanel projectKey="SCRUM" refreshKey={0} />);
    await act(async () => { vi.advanceTimersByTime(600); }); // SCRUM debounce fires

    // Switch to PROJ before SCRUM resolves.
    rerender(<RecentTicketsPanel projectKey="PROJ" refreshKey={0} />);
    await act(async () => { vi.advanceTimersByTime(600); }); // PROJ debounce fires

    // Now resolve the stale SCRUM request.
    await act(async () => { resolveSCRUM(success([TICKET_A])); });

    // PROJ's results (TICKET_B) should be shown; SCRUM's TICKET_A must not appear.
    expect(screen.queryByText(TICKET_A.title)).not.toBeInTheDocument();
    expect(screen.getByText(TICKET_B.title)).toBeInTheDocument();
  });

  it('ignores a stale response that arrives during the debounce window for the new project', async () => {
    let resolveSCRUM!: (r: ListRecentTicketsResult) => void;
    const scrumPromise = new Promise<ListRecentTicketsResult>((res) => { resolveSCRUM = res; });

    mockedList
      .mockReturnValueOnce(scrumPromise)
      .mockResolvedValue(success([]));

    const { rerender } = render(<RecentTicketsPanel projectKey="SCRUM" refreshKey={0} />);
    await act(async () => { vi.advanceTimersByTime(600); }); // SCRUM debounce fires, request in flight

    // Switch to PROJ — the SCRUM request is aborted immediately and the component
    // enters loading state for PROJ. The PROJ debounce has NOT fired yet.
    rerender(<RecentTicketsPanel projectKey="PROJ" refreshKey={0} />);

    expect(screen.getByText(/loading tickets/i)).toBeInTheDocument();

    // Resolve the stale SCRUM promise while PROJ debounce is still pending.
    await act(async () => { resolveSCRUM(success([TICKET_A])); });

    // SCRUM result must be invisible; loading state for PROJ must still be shown.
    expect(screen.queryByText(TICKET_A.title)).not.toBeInTheDocument();
    expect(screen.getByText(/loading tickets/i)).toBeInTheDocument();

    // Now fire the PROJ debounce and let its response resolve.
    await act(async () => { vi.advanceTimersByTime(600); });

    expect(screen.queryByText(TICKET_A.title)).not.toBeInTheDocument();
    expect(screen.getByText(/no tickets/i)).toBeInTheDocument();
  });

  it('does not show an error when a request is aborted by a project change', async () => {
    let resolveSCRUM!: (r: ListRecentTicketsResult) => void;
    const scrumPromise = new Promise<ListRecentTicketsResult>((res) => { resolveSCRUM = res; });

    mockedList
      .mockReturnValueOnce(scrumPromise)
      .mockResolvedValue(success([]));

    const { rerender } = render(<RecentTicketsPanel projectKey="SCRUM" refreshKey={0} />);
    await act(async () => { vi.advanceTimersByTime(600); });

    rerender(<RecentTicketsPanel projectKey="PROJ" refreshKey={0} />);

    // Resolve the aborted SCRUM response — must produce no error.
    await act(async () => { resolveSCRUM(success([TICKET_A])); });

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('aborted requests do not show a network error', async () => {
    mockedList.mockReturnValue(new Promise(() => {})); // never resolves

    const { rerender } = render(<RecentTicketsPanel projectKey="SCRUM" refreshKey={0} />);
    await act(async () => { vi.advanceTimersByTime(600); });

    // Aborting happens when key changes.
    rerender(<RecentTicketsPanel projectKey="" refreshKey={0} />);

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText(/enter a jira project key/i)).toBeInTheDocument();
  });

  it('aborts the active request when the component unmounts', async () => {
    let requestAborted = false;
    mockedList.mockImplementation((_key, signal) => {
      return new Promise<ListRecentTicketsResult>((_, reject) => {
        signal?.addEventListener('abort', () => {
          requestAborted = true;
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
    });

    const { unmount } = render(<RecentTicketsPanel projectKey="SCRUM" refreshKey={0} />);
    await act(async () => { vi.advanceTimersByTime(600); });

    expect(screen.getByText(/loading tickets/i)).toBeInTheDocument();
    unmount();

    expect(requestAborted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Refresh from successful creation
// ---------------------------------------------------------------------------

describe('refresh on successful ticket creation', () => {
  it('immediately re-fetches when refreshKey increments (bypasses debounce)', async () => {
    mockedList.mockResolvedValue(success([TICKET_A]));

    const { rerender } = render(<RecentTicketsPanel projectKey="SCRUM" refreshKey={0} />);
    await act(async () => { vi.advanceTimersByTime(600); });

    expect(mockedList).toHaveBeenCalledTimes(1);

    // Simulate successful creation: refreshKey increments.
    mockedList.mockResolvedValue(success([TICKET_A, TICKET_B]));
    rerender(<RecentTicketsPanel projectKey="SCRUM" refreshKey={1} />);

    // Should fire immediately (no debounce wait needed).
    await act(async () => { vi.advanceTimersByTime(0); });

    expect(mockedList).toHaveBeenCalledTimes(2);
    expect(screen.getByText(TICKET_B.title)).toBeInTheDocument();
  });

  it('uses the current project key when refreshKey increments', async () => {
    mockedList.mockResolvedValue(success([]));

    const { rerender } = render(<RecentTicketsPanel projectKey="SCRUM" refreshKey={0} />);
    await act(async () => { vi.advanceTimersByTime(600); });

    rerender(<RecentTicketsPanel projectKey="SCRUM" refreshKey={1} />);
    await act(async () => { vi.advanceTimersByTime(0); });

    expect(mockedList).toHaveBeenLastCalledWith('SCRUM', expect.anything());
  });
});
