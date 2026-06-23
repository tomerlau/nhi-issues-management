import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import RecentTicketsPanel from '../src/components/RecentTicketsPanel';
import {
  createTicket,
  listRecentTickets,
  RecentTicketsApiError,
  TicketApiError,
  type CreatedTicket,
  type ListRecentTicketsResult,
  type RecentTicketsErrorKind,
} from '../src/api/tickets';

vi.mock('../src/api/tickets', async () => {
  const actual = await vi.importActual<typeof import('../src/api/tickets')>('../src/api/tickets');
  return {
    ...actual,
    listRecentTickets: vi.fn(),
    createTicket: vi.fn(),
  };
});

const mockedList = vi.mocked(listRecentTickets);
const mockedCreate = vi.mocked(createTicket);

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

const defaultProps = {
  onOpenCreationModal: vi.fn(),
  onTicketCreated: vi.fn(),
};

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

// ---------------------------------------------------------------------------
// Prompt state (no valid project)
// ---------------------------------------------------------------------------

describe('prompt state', () => {
  it('renders nothing when no project key is entered', () => {
    const { container } = render(<RecentTicketsPanel projectKey="" refreshKey={0} {...defaultProps} />);

    expect(container.firstChild).toBeNull();
    expect(mockedList).not.toHaveBeenCalled();
  });

  it('renders nothing for an invalid project key', () => {
    const { container } = render(<RecentTicketsPanel projectKey="1AB" refreshKey={0} {...defaultProps} />);

    expect(container.firstChild).toBeNull();
    expect(mockedList).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// No request for invalid keys
// ---------------------------------------------------------------------------

describe('no request for invalid keys', () => {
  it('makes no request when the project key is empty', async () => {
    render(<RecentTicketsPanel projectKey="" refreshKey={0} {...defaultProps} />);
    await act(async () => { vi.advanceTimersByTime(600); });

    expect(mockedList).not.toHaveBeenCalled();
  });

  it('makes no request when a non-zero refreshKey arrives with an invalid key', async () => {
    const { rerender } = render(<RecentTicketsPanel projectKey="" refreshKey={0} {...defaultProps} />);
    rerender(<RecentTicketsPanel projectKey="" refreshKey={1} {...defaultProps} />);
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

    render(<RecentTicketsPanel projectKey="SCRUM" refreshKey={0} {...defaultProps} />);
    await act(async () => { vi.advanceTimersByTime(600); });

    expect(screen.getByText(/loading tickets/i)).toBeInTheDocument();
  });

  it('shows loading immediately when the project key becomes valid', () => {
    mockedList.mockReturnValue(new Promise(() => {}));

    render(<RecentTicketsPanel projectKey="SCRUM" refreshKey={0} {...defaultProps} />);

    expect(screen.getByText(/loading tickets/i)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Mode B — zero tickets (first-ticket inline form)
// ---------------------------------------------------------------------------

describe('Mode B — zero tickets', () => {
  it('renders "Create your first Jira ticket!" when the response has zero tickets', async () => {
    mockedList.mockResolvedValue(success([]));

    render(<RecentTicketsPanel projectKey="SCRUM" refreshKey={0} {...defaultProps} />);
    await act(async () => { vi.advanceTimersByTime(600); });

    expect(screen.getByRole('heading', { name: /create your first jira ticket/i })).toBeInTheDocument();
  });

  it('does NOT render a "Recent tickets" heading in Mode B', async () => {
    mockedList.mockResolvedValue(success([]));

    render(<RecentTicketsPanel projectKey="SCRUM" refreshKey={0} {...defaultProps} />);
    await act(async () => { vi.advanceTimersByTime(600); });

    expect(screen.queryByRole('heading', { name: /recent tickets/i })).not.toBeInTheDocument();
  });

  it('does NOT render a ticket list or empty-state text in Mode B', async () => {
    mockedList.mockResolvedValue(success([]));

    render(<RecentTicketsPanel projectKey="SCRUM" refreshKey={0} {...defaultProps} />);
    await act(async () => { vi.advanceTimersByTime(600); });

    expect(screen.queryByRole('list')).not.toBeInTheDocument();
    expect(screen.queryByText(/no tickets/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/no recent tickets/i)).not.toBeInTheDocument();
  });

  it('shows the inline ticket creation form with title and description inputs in Mode B', async () => {
    mockedList.mockResolvedValue(success([]));

    render(<RecentTicketsPanel projectKey="SCRUM" refreshKey={0} {...defaultProps} />);
    await act(async () => { vi.advanceTimersByTime(600); });

    expect(screen.getByLabelText(/title/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/description/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^create ticket$/i })).toBeInTheDocument();
  });

  it('does NOT show a project-key input in the inline form (Mode B)', async () => {
    mockedList.mockResolvedValue(success([]));

    render(<RecentTicketsPanel projectKey="SCRUM" refreshKey={0} {...defaultProps} />);
    await act(async () => { vi.advanceTimersByTime(600); });

    // No project-key input anywhere — it lives in the page-level selector.
    expect(screen.queryByLabelText(/project key/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/jira project/i)).not.toBeInTheDocument();
  });

  it('transitions to Mode A after successful first-ticket creation', async () => {
    const onTicketCreated = vi.fn();
    mockedList
      .mockResolvedValueOnce(success([]))
      .mockResolvedValue(success([TICKET_A]));
    mockedCreate.mockResolvedValue({ issueId: '10001', issueKey: 'SCRUM-1' } as CreatedTicket);

    render(
      <RecentTicketsPanel
        projectKey="SCRUM"
        refreshKey={0}
        onOpenCreationModal={vi.fn()}
        onTicketCreated={onTicketCreated}
      />,
    );
    await act(async () => { vi.advanceTimersByTime(600); });

    // Mode B: fill and submit form.
    fireEvent.change(screen.getByLabelText(/title/i), { target: { value: 'Test ticket' } });
    fireEvent.change(screen.getByLabelText(/description/i), { target: { value: 'Description' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^create ticket$/i }));
    });

    await screen.findByRole('status');
    // onTicketCreated notifies parent to increment refreshKey.
    expect(onTicketCreated).toHaveBeenCalled();
  });

  it('calls onTicketCreated after successful inline creation in Mode B', async () => {
    const onTicketCreated = vi.fn();
    mockedList.mockResolvedValue(success([]));
    mockedCreate.mockResolvedValue({ issueId: '10001', issueKey: 'SCRUM-1' } as CreatedTicket);

    render(
      <RecentTicketsPanel
        projectKey="SCRUM"
        refreshKey={0}
        onOpenCreationModal={vi.fn()}
        onTicketCreated={onTicketCreated}
      />,
    );
    await act(async () => { vi.advanceTimersByTime(600); });

    fireEvent.change(screen.getByLabelText(/title/i), { target: { value: 'Test' } });
    fireEvent.change(screen.getByLabelText(/description/i), { target: { value: 'Desc' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^create ticket$/i }));
    });

    await screen.findByRole('status');
    expect(onTicketCreated).toHaveBeenCalledTimes(1);
  });

  it('does NOT call onTicketCreated after failed inline creation in Mode B', async () => {
    const onTicketCreated = vi.fn();
    mockedList.mockResolvedValue(success([]));
    mockedCreate.mockRejectedValue(new TicketApiError('not_connected', 'x'));

    render(
      <RecentTicketsPanel
        projectKey="SCRUM"
        refreshKey={0}
        onOpenCreationModal={vi.fn()}
        onTicketCreated={onTicketCreated}
      />,
    );
    await act(async () => { vi.advanceTimersByTime(600); });

    fireEvent.change(screen.getByLabelText(/title/i), { target: { value: 'Test' } });
    fireEvent.change(screen.getByLabelText(/description/i), { target: { value: 'Desc' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^create ticket$/i }));
    });

    await screen.findByRole('alert');
    expect(onTicketCreated).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Mode A — tickets exist
// ---------------------------------------------------------------------------

describe('Mode A — tickets exist', () => {
  it('renders the "Recent tickets" heading when tickets are returned', async () => {
    mockedList.mockResolvedValue(success([TICKET_A]));

    render(<RecentTicketsPanel projectKey="SCRUM" refreshKey={0} {...defaultProps} />);
    await act(async () => { vi.advanceTimersByTime(600); });

    expect(screen.getByRole('heading', { name: /recent tickets/i })).toBeInTheDocument();
  });

  it('does NOT render the inline creation form in Mode A', async () => {
    mockedList.mockResolvedValue(success([TICKET_A]));

    render(<RecentTicketsPanel projectKey="SCRUM" refreshKey={0} {...defaultProps} />);
    await act(async () => { vi.advanceTimersByTime(600); });

    expect(screen.queryByRole('heading', { name: /create your first/i })).not.toBeInTheDocument();
    // No title/description inputs (those belong to the modal, not the panel in Mode A).
    expect(screen.queryByLabelText(/^title$/i)).not.toBeInTheDocument();
  });

  it('renders a "Create ticket" button that calls onOpenCreationModal', async () => {
    const onOpenCreationModal = vi.fn();
    mockedList.mockResolvedValue(success([TICKET_A]));

    render(
      <RecentTicketsPanel
        projectKey="SCRUM"
        refreshKey={0}
        onOpenCreationModal={onOpenCreationModal}
        onTicketCreated={vi.fn()}
      />,
    );
    await act(async () => { vi.advanceTimersByTime(600); });

    fireEvent.click(screen.getByRole('button', { name: /^create ticket$/i }));

    expect(onOpenCreationModal).toHaveBeenCalledTimes(1);
  });

  it('renders a ticket with its title as a link', async () => {
    mockedList.mockResolvedValue(success([TICKET_A]));

    render(<RecentTicketsPanel projectKey="SCRUM" refreshKey={0} {...defaultProps} />);
    await act(async () => { vi.advanceTimersByTime(600); });

    const link = screen.getByRole('link', { name: /leaked service-account key/i });
    expect(link).toBeInTheDocument();
  });

  it('renders the Jira issue key alongside the title', async () => {
    mockedList.mockResolvedValue(success([TICKET_A]));

    render(<RecentTicketsPanel projectKey="SCRUM" refreshKey={0} {...defaultProps} />);
    await act(async () => { vi.advanceTimersByTime(600); });

    expect(screen.getByText('SCRUM-1')).toBeInTheDocument();
  });

  it('renders the creation time in a <time> element with the ISO dateTime attribute', async () => {
    mockedList.mockResolvedValue(success([TICKET_A]));

    render(<RecentTicketsPanel projectKey="SCRUM" refreshKey={0} {...defaultProps} />);
    await act(async () => { vi.advanceTimersByTime(600); });

    const timeEl = document.querySelector('time');
    expect(timeEl).not.toBeNull();
    expect(timeEl?.getAttribute('dateTime')).toBe('2026-06-01T12:00:00.000Z');
  });

  it('links open in a new tab with safe rel attributes', async () => {
    mockedList.mockResolvedValue(success([TICKET_A]));

    render(<RecentTicketsPanel projectKey="SCRUM" refreshKey={0} {...defaultProps} />);
    await act(async () => { vi.advanceTimersByTime(600); });

    const link = screen.getByRole('link', { name: /leaked service-account key/i }) as HTMLAnchorElement;
    expect(link.target).toBe('_blank');
    expect(link.rel).toContain('noopener');
    expect(link.rel).toContain('noreferrer');
    expect(link.href).toBe(TICKET_A.url);
  });

  it('renders all returned tickets in server order', async () => {
    mockedList.mockResolvedValue(success([TICKET_A, TICKET_B]));

    render(<RecentTicketsPanel projectKey="SCRUM" refreshKey={0} {...defaultProps} />);
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
    render(<RecentTicketsPanel projectKey="SCRUM" refreshKey={0} {...defaultProps} />);
    await act(async () => { vi.advanceTimersByTime(600); });
  }

  it('shows an error alert for a not_connected error', async () => {
    await renderWithError('not_connected');
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

    render(<RecentTicketsPanel projectKey="SCRUM" refreshKey={0} {...defaultProps} />);
    await act(async () => { vi.advanceTimersByTime(600); });

    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();

    await act(async () => {
      screen.getByRole('button', { name: /retry/i }).click();
    });

    expect(await screen.findByRole('link', { name: /leaked service-account key/i })).toBeInTheDocument();
  });

  it('does not show duplicate-creation warnings in read error messages', async () => {
    const kinds: RecentTicketsErrorKind[] = ['timeout', 'unreachable', 'network', 'server', 'internal_error'];
    for (const kind of kinds) {
      mockedList.mockRejectedValue(new RecentTicketsApiError(kind, 'x'));
      const { unmount } = render(<RecentTicketsPanel projectKey="SCRUM" refreshKey={0} {...defaultProps} />);
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

    render(<RecentTicketsPanel projectKey="scrum" refreshKey={0} {...defaultProps} />);
    await act(async () => { vi.advanceTimersByTime(600); });

    expect(mockedList).toHaveBeenCalledWith('SCRUM', expect.anything());
  });

  it('trims whitespace from the key before requesting', async () => {
    mockedList.mockResolvedValue(success([]));

    render(<RecentTicketsPanel projectKey="  SCRUM  " refreshKey={0} {...defaultProps} />);
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

    const { rerender } = render(<RecentTicketsPanel projectKey="SCRUM" refreshKey={0} {...defaultProps} />);
    await act(async () => { vi.advanceTimersByTime(600); });

    expect(mockedList).toHaveBeenCalledTimes(1);
    expect(mockedList).toHaveBeenLastCalledWith('SCRUM', expect.anything());

    mockedList.mockResolvedValue(success([TICKET_B]));
    rerender(<RecentTicketsPanel projectKey="PROJ" refreshKey={0} {...defaultProps} />);
    await act(async () => { vi.advanceTimersByTime(600); });

    expect(mockedList).toHaveBeenCalledTimes(2);
    expect(mockedList).toHaveBeenLastCalledWith('PROJ', expect.anything());
  });

  it('does not show the previous project results while loading the new project', async () => {
    mockedList.mockResolvedValue(success([TICKET_A]));

    const { rerender } = render(<RecentTicketsPanel projectKey="SCRUM" refreshKey={0} {...defaultProps} />);
    await act(async () => { vi.advanceTimersByTime(600); });

    expect(screen.getByRole('link', { name: TICKET_A.title })).toBeInTheDocument();

    mockedList.mockReturnValue(new Promise(() => {}));
    rerender(<RecentTicketsPanel projectKey="PROJ" refreshKey={0} {...defaultProps} />);

    expect(screen.queryByRole('link', { name: TICKET_A.title })).not.toBeInTheDocument();
    expect(screen.getByText(/loading tickets/i)).toBeInTheDocument();
  });

  it('reverts to no content when the key becomes empty', async () => {
    mockedList.mockResolvedValue(success([TICKET_A]));

    const { rerender } = render(<RecentTicketsPanel projectKey="SCRUM" refreshKey={0} {...defaultProps} />);
    await act(async () => { vi.advanceTimersByTime(600); });

    rerender(<RecentTicketsPanel projectKey="" refreshKey={0} {...defaultProps} />);

    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.queryByText(/loading tickets/i)).not.toBeInTheDocument();
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

    const { rerender } = render(<RecentTicketsPanel projectKey="SCRUM" refreshKey={0} {...defaultProps} />);
    await act(async () => { vi.advanceTimersByTime(600); });

    rerender(<RecentTicketsPanel projectKey="PROJ" refreshKey={0} {...defaultProps} />);
    await act(async () => { vi.advanceTimersByTime(600); });

    await act(async () => { resolveSCRUM(success([TICKET_A])); });

    expect(screen.queryByText(TICKET_A.title)).not.toBeInTheDocument();
    expect(screen.getByText(TICKET_B.title)).toBeInTheDocument();
  });

  it('ignores a stale response that arrives during the debounce window for the new project', async () => {
    let resolveSCRUM!: (r: ListRecentTicketsResult) => void;
    const scrumPromise = new Promise<ListRecentTicketsResult>((res) => { resolveSCRUM = res; });

    mockedList
      .mockReturnValueOnce(scrumPromise)
      .mockResolvedValue(success([]));

    const { rerender } = render(<RecentTicketsPanel projectKey="SCRUM" refreshKey={0} {...defaultProps} />);
    await act(async () => { vi.advanceTimersByTime(600); });

    rerender(<RecentTicketsPanel projectKey="PROJ" refreshKey={0} {...defaultProps} />);

    expect(screen.getByText(/loading tickets/i)).toBeInTheDocument();

    await act(async () => { resolveSCRUM(success([TICKET_A])); });

    expect(screen.queryByText(TICKET_A.title)).not.toBeInTheDocument();
    expect(screen.getByText(/loading tickets/i)).toBeInTheDocument();

    await act(async () => { vi.advanceTimersByTime(600); });

    expect(screen.queryByText(TICKET_A.title)).not.toBeInTheDocument();
    // Mode B: shows first-ticket form, no recent-ticket text.
    expect(screen.getByRole('heading', { name: /create your first jira ticket/i })).toBeInTheDocument();
  });

  it('does not show an error when a request is aborted by a project change', async () => {
    let resolveSCRUM!: (r: ListRecentTicketsResult) => void;
    const scrumPromise = new Promise<ListRecentTicketsResult>((res) => { resolveSCRUM = res; });

    mockedList
      .mockReturnValueOnce(scrumPromise)
      .mockResolvedValue(success([]));

    const { rerender } = render(<RecentTicketsPanel projectKey="SCRUM" refreshKey={0} {...defaultProps} />);
    await act(async () => { vi.advanceTimersByTime(600); });

    rerender(<RecentTicketsPanel projectKey="PROJ" refreshKey={0} {...defaultProps} />);

    await act(async () => { resolveSCRUM(success([TICKET_A])); });

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
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

    const { unmount } = render(<RecentTicketsPanel projectKey="SCRUM" refreshKey={0} {...defaultProps} />);
    await act(async () => { vi.advanceTimersByTime(600); });

    expect(screen.getByText(/loading tickets/i)).toBeInTheDocument();
    unmount();

    expect(requestAborted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Refresh on successful ticket creation
// ---------------------------------------------------------------------------

describe('refresh on successful ticket creation', () => {
  it('immediately re-fetches when refreshKey increments (bypasses debounce)', async () => {
    mockedList.mockResolvedValue(success([TICKET_A]));

    const { rerender } = render(<RecentTicketsPanel projectKey="SCRUM" refreshKey={0} {...defaultProps} />);
    await act(async () => { vi.advanceTimersByTime(600); });

    expect(mockedList).toHaveBeenCalledTimes(1);

    mockedList.mockResolvedValue(success([TICKET_A, TICKET_B]));
    rerender(<RecentTicketsPanel projectKey="SCRUM" refreshKey={1} {...defaultProps} />);

    await act(async () => { vi.advanceTimersByTime(0); });

    expect(mockedList).toHaveBeenCalledTimes(2);

    await waitFor(() => {
      expect(screen.getByText(TICKET_B.title)).toBeInTheDocument();
    });
  });

  it('uses the current project key when refreshKey increments', async () => {
    mockedList.mockResolvedValue(success([]));

    const { rerender } = render(<RecentTicketsPanel projectKey="SCRUM" refreshKey={0} {...defaultProps} />);
    await act(async () => { vi.advanceTimersByTime(600); });

    rerender(<RecentTicketsPanel projectKey="SCRUM" refreshKey={1} {...defaultProps} />);
    await act(async () => { vi.advanceTimersByTime(0); });

    expect(mockedList).toHaveBeenLastCalledWith('SCRUM', expect.anything());
  });
});
