import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App';
import { AuthError, login, logout, restoreSession, type SafeUser } from '../src/api/auth';
import { getJiraConnection, JiraApiError, saveJiraConnection } from '../src/api/jira';
import { createTicket, listRecentTickets, TicketApiError, type CreatedTicket, type ListRecentTicketsResult, type RecentTicket } from '../src/api/tickets';

vi.mock('../src/api/auth', async () => {
  const actual = await vi.importActual<typeof import('../src/api/auth')>('../src/api/auth');
  return {
    ...actual,
    login: vi.fn(),
    logout: vi.fn(),
    restoreSession: vi.fn(),
  };
});

vi.mock('../src/api/jira', async () => {
  const actual = await vi.importActual<typeof import('../src/api/jira')>('../src/api/jira');
  return {
    ...actual,
    getJiraConnection: vi.fn(),
    saveJiraConnection: vi.fn(),
  };
});

vi.mock('../src/api/tickets', async () => {
  const actual = await vi.importActual<typeof import('../src/api/tickets')>('../src/api/tickets');
  return {
    ...actual,
    createTicket: vi.fn(),
    listRecentTickets: vi.fn(),
  };
});

const mockedRestore = vi.mocked(restoreSession);
const mockedLogin = vi.mocked(login);
const mockedLogout = vi.mocked(logout);
const mockedGetJira = vi.mocked(getJiraConnection);
const mockedSaveJira = vi.mocked(saveJiraConnection);
const mockedCreateTicket = vi.mocked(createTicket);
const mockedListRecentTickets = vi.mocked(listRecentTickets);

const alice: SafeUser = {
  id: 'user-acme-alice',
  tenantId: 'tenant-acme',
  email: 'alice@example.com',
  displayName: 'Alice Anderson',
};

function typeInto(label: RegExp, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

async function renderLoggedOut() {
  mockedRestore.mockResolvedValue(null);
  render(<App />);
  return screen.findByRole('button', { name: /^sign in$/i });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ shouldAdvanceTime: true });
  mockedGetJira.mockResolvedValue({ connected: false });
  mockedListRecentTickets.mockResolvedValue({ tickets: [] });
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

// ---------------------------------------------------------------------------
// Product branding
// ---------------------------------------------------------------------------

describe('product branding', () => {
  it('uses the product name in the login heading', async () => {
    await renderLoggedOut();

    expect(
      screen.getByRole('heading', { name: /sign in to NHI Issues Management/i }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/IdentityHub to Jira/i)).not.toBeInTheDocument();
  });

  it('uses the product name in the authenticated header', async () => {
    mockedRestore.mockResolvedValue(alice);

    render(<App />);
    await screen.findByText(/welcome, alice anderson/i);

    expect(within(screen.getByRole('banner')).getByText('NHI Issues Management')).toBeInTheDocument();
    expect(screen.queryByText(/IdentityHub to Jira/i)).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Session restoration
// ---------------------------------------------------------------------------

describe('session restoration', () => {
  it('shows a loading state while restoration is pending', () => {
    mockedRestore.mockReturnValue(new Promise(() => {}));

    render(<App />);

    expect(screen.getByText(/checking your session/i)).toBeInTheDocument();
  });

  it('restores an authenticated session on load', async () => {
    mockedRestore.mockResolvedValue(alice);

    render(<App />);

    expect(await screen.findByText(/welcome, alice anderson/i)).toBeInTheDocument();
  });

  it('shows the login screen on the unauthenticated state', async () => {
    mockedRestore.mockResolvedValue(null);

    render(<App />);

    expect(await screen.findByRole('button', { name: /^sign in$/i })).toBeInTheDocument();
  });

  it('shows a retryable error when restoration fails', async () => {
    mockedRestore.mockRejectedValue(new AuthError('network', 'Unable to reach the server.'));

    render(<App />);

    expect(await screen.findByText(/couldn.t verify your session/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^sign in$/i })).not.toBeInTheDocument();
  });

  it('retries restoration and recovers after a failure', async () => {
    mockedRestore.mockRejectedValueOnce(new AuthError('network', 'Unable to reach the server.'));
    mockedRestore.mockResolvedValueOnce(alice);

    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: /try again/i }));

    expect(await screen.findByText(/welcome, alice anderson/i)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

describe('login', () => {
  it('authenticates and shows the safe user on success', async () => {
    await renderLoggedOut();
    mockedLogin.mockResolvedValue(alice);

    typeInto(/email/i, 'alice@example.com');
    typeInto(/password/i, 'acme-alice-demo');
    fireEvent.click(screen.getByRole('button', { name: /^sign in$/i }));

    expect(await screen.findByText(/welcome, alice anderson/i)).toBeInTheDocument();
    expect(screen.getByText('alice@example.com')).toBeInTheDocument();
    expect(mockedLogin).toHaveBeenCalledWith('alice@example.com', 'acme-alice-demo');
  });

  it('shows a generic error for invalid credentials', async () => {
    await renderLoggedOut();
    mockedLogin.mockRejectedValue(
      new AuthError('invalid_credentials', 'Invalid email or password.'),
    );

    typeInto(/email/i, 'alice@example.com');
    typeInto(/password/i, 'wrong');
    fireEvent.click(screen.getByRole('button', { name: /^sign in$/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/invalid email or password/i);
    expect(screen.getByLabelText(/password/i)).toHaveValue('');
  });

  it('validates required fields without calling the API', async () => {
    await renderLoggedOut();

    fireEvent.click(screen.getByRole('button', { name: /^sign in$/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /enter both your email and password/i,
    );
    expect(mockedLogin).not.toHaveBeenCalled();
  });

  it('shows a network/server error message on transport failure', async () => {
    await renderLoggedOut();
    mockedLogin.mockRejectedValue(new AuthError('network', 'Unable to reach the server.'));

    typeInto(/email/i, 'alice@example.com');
    typeInto(/password/i, 'acme-alice-demo');
    fireEvent.click(screen.getByRole('button', { name: /^sign in$/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/unable to reach the server/i);
  });

  it('prevents duplicate submissions while a login is in flight', async () => {
    await renderLoggedOut();
    let resolveLogin: (user: SafeUser) => void = () => {};
    mockedLogin.mockReturnValue(
      new Promise<SafeUser>((resolve) => { resolveLogin = resolve; }),
    );

    typeInto(/email/i, 'alice@example.com');
    typeInto(/password/i, 'acme-alice-demo');
    const submit = screen.getByRole('button', { name: /^sign in$/i });
    fireEvent.click(submit);
    fireEvent.click(submit);

    expect(submit).toBeDisabled();
    expect(mockedLogin).toHaveBeenCalledTimes(1);

    resolveLogin(alice);
    expect(await screen.findByText(/welcome, alice anderson/i)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Project selector and Jira gating
// ---------------------------------------------------------------------------

describe('project selector gating', () => {
  it('shows the "Jira project" selector only when Jira is connected', async () => {
    mockedRestore.mockResolvedValue(alice);
    mockedGetJira.mockResolvedValue({
      connected: true,
      siteUrl: 'https://acme.atlassian.net',
      email: 'alice@example.com',
    });

    render(<App />);
    await screen.findByText(/welcome, alice anderson/i);

    expect(await screen.findByLabelText(/jira project/i)).toBeInTheDocument();
  });

  it('hides the "Jira project" selector when Jira is disconnected', async () => {
    mockedRestore.mockResolvedValue(alice);
    mockedGetJira.mockResolvedValue({ connected: false });

    render(<App />);
    await screen.findByText(/jira not connected/i);

    expect(screen.queryByLabelText(/jira project/i)).not.toBeInTheDocument();
  });

  it('hides the "Jira project" selector while the connection status is loading', async () => {
    mockedRestore.mockResolvedValue(alice);
    mockedGetJira.mockReturnValue(new Promise(() => {}));

    render(<App />);
    await screen.findByText(/welcome, alice anderson/i);

    expect(screen.queryByLabelText(/jira project/i)).not.toBeInTheDocument();
  });

  it('shows a prompt when no valid project key is entered', async () => {
    mockedRestore.mockResolvedValue(alice);
    mockedGetJira.mockResolvedValue({
      connected: true,
      siteUrl: 'https://acme.atlassian.net',
      email: 'alice@example.com',
    });

    render(<App />);
    await screen.findByLabelText(/jira project/i);

    expect(screen.getByText(/enter a jira project key/i)).toBeInTheDocument();
    expect(mockedListRecentTickets).not.toHaveBeenCalled();
  });

  it('shows exactly one project-key input — in the page-level selector', async () => {
    mockedRestore.mockResolvedValue(alice);
    mockedGetJira.mockResolvedValue({
      connected: true,
      siteUrl: 'https://acme.atlassian.net',
      email: 'alice@example.com',
    });

    render(<App />);
    await screen.findByLabelText(/jira project/i);

    // Only one input with name="projectKey" or label "Jira project".
    const projectInputs = document.querySelectorAll('input[name="projectKey"]');
    expect(projectInputs.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Compact Jira status bar
// ---------------------------------------------------------------------------

describe('compact Jira status bar', () => {
  it('shows "Jira not connected" and "Connect Jira" button when disconnected', async () => {
    mockedRestore.mockResolvedValue(alice);
    mockedGetJira.mockResolvedValue({ connected: false });

    render(<App />);
    await screen.findByText(/welcome, alice anderson/i);
    await screen.findByText(/jira not connected/i);

    expect(screen.getByRole('button', { name: /^connect jira$/i })).toBeInTheDocument();
  });

  it('shows "Jira connected" and "Manage" button when connected', async () => {
    mockedRestore.mockResolvedValue(alice);
    mockedGetJira.mockResolvedValue({
      connected: true,
      siteUrl: 'https://acme.atlassian.net',
      email: 'alice@example.com',
    });

    render(<App />);
    await screen.findByText(/jira connected/i);

    expect(screen.getByRole('button', { name: /^manage$/i })).toBeInTheDocument();
  });

  it('does NOT show the Jira site URL on the page (only inside the modal)', async () => {
    mockedRestore.mockResolvedValue(alice);
    mockedGetJira.mockResolvedValue({
      connected: true,
      siteUrl: 'https://acme.atlassian.net',
      email: 'alice@example.com',
    });

    render(<App />);
    await screen.findByText(/jira connected/i);

    expect(screen.queryByText('https://acme.atlassian.net')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Mode B — zero tickets
// ---------------------------------------------------------------------------

describe('Mode B — zero tickets', () => {
  async function renderConnectedWithProject(projectKey = 'SCRUM') {
    mockedRestore.mockResolvedValue(alice);
    mockedGetJira.mockResolvedValue({
      connected: true,
      siteUrl: 'https://acme.atlassian.net',
      email: 'alice@example.com',
    });
    mockedListRecentTickets.mockResolvedValue({ tickets: [] });
    render(<App />);
    await screen.findByLabelText(/jira project/i);
    typeInto(/jira project/i, projectKey);
    await act(async () => { vi.advanceTimersByTime(600); });
    await screen.findByRole('heading', { name: /create your first jira ticket/i });
  }

  it('shows Mode B heading when zero tickets are returned', async () => {
    await renderConnectedWithProject();

    expect(screen.getByRole('heading', { name: /create your first jira ticket/i })).toBeInTheDocument();
  });

  it('does NOT show "Recent tickets" heading in Mode B', async () => {
    await renderConnectedWithProject();

    expect(screen.queryByRole('heading', { name: /^recent tickets$/i })).not.toBeInTheDocument();
  });

  it('shows inline creation form in Mode B', async () => {
    await renderConnectedWithProject();

    expect(screen.getByLabelText(/title/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/description/i)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Mode A — tickets exist
// ---------------------------------------------------------------------------

describe('Mode A — tickets exist', () => {
  const OLD_TICKET: RecentTicket = {
    issueId: '10001',
    issueKey: 'SCRUM-1',
    title: 'Existing ticket title',
    createdAt: '2024-01-01T00:00:00.000Z',
    url: 'https://acme.atlassian.net/browse/SCRUM-1',
  };

  async function renderConnectedWithTickets() {
    mockedRestore.mockResolvedValue(alice);
    mockedGetJira.mockResolvedValue({
      connected: true,
      siteUrl: 'https://acme.atlassian.net',
      email: 'alice@example.com',
    });
    mockedListRecentTickets.mockResolvedValue({ tickets: [OLD_TICKET] });
    render(<App />);
    await screen.findByLabelText(/jira project/i);
    typeInto(/jira project/i, 'SCRUM');
    await act(async () => { vi.advanceTimersByTime(600); });
    await screen.findByRole('heading', { name: /recent tickets/i });
  }

  it('shows "Recent tickets" heading in Mode A', async () => {
    await renderConnectedWithTickets();

    expect(screen.getByRole('heading', { name: /recent tickets/i })).toBeInTheDocument();
  });

  it('shows a "Create ticket" button in Mode A', async () => {
    await renderConnectedWithTickets();

    expect(screen.getByRole('button', { name: /^create ticket$/i })).toBeInTheDocument();
  });

  it('opens the creation modal when "Create ticket" is clicked', async () => {
    await renderConnectedWithTickets();

    fireEvent.click(screen.getByRole('button', { name: /^create ticket$/i }));

    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('modal does not contain a project-key input', async () => {
    await renderConnectedWithTickets();

    fireEvent.click(screen.getByRole('button', { name: /^create ticket$/i }));

    await screen.findByRole('dialog');
    // Only one projectKey input total (the page-level selector).
    const projectInputs = document.querySelectorAll('input[name="projectKey"]');
    expect(projectInputs.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Ticket creation refreshes recent tickets
// ---------------------------------------------------------------------------

describe('ticket creation refreshes recent tickets', () => {
  it('calls listRecentTickets after a successful ticket creation via inline form (Mode B)', async () => {
    mockedRestore.mockResolvedValue(alice);
    mockedGetJira.mockResolvedValue({
      connected: true,
      siteUrl: 'https://acme.atlassian.net',
      email: 'alice@example.com',
    });
    mockedCreateTicket.mockResolvedValue({ issueId: '10001', issueKey: 'SCRUM-1' } as CreatedTicket);
    mockedListRecentTickets.mockResolvedValue({ tickets: [] });

    render(<App />);
    await screen.findByLabelText(/jira project/i);

    typeInto(/jira project/i, 'SCRUM');
    await act(async () => { vi.advanceTimersByTime(600); });
    await screen.findByRole('heading', { name: /create your first jira ticket/i });

    typeInto(/title/i, 'Test ticket');
    typeInto(/description/i, 'Test description');
    fireEvent.click(screen.getByRole('button', { name: /^create ticket$/i }));

    await screen.findByRole('status');

    await waitFor(() => {
      expect(mockedListRecentTickets).toHaveBeenCalledWith('SCRUM', expect.anything());
    });
  });

  it('does not call listRecentTickets after a failed ticket creation', async () => {
    mockedRestore.mockResolvedValue(alice);
    mockedGetJira.mockResolvedValue({
      connected: true,
      siteUrl: 'https://acme.atlassian.net',
      email: 'alice@example.com',
    });
    mockedCreateTicket.mockRejectedValue(new TicketApiError('not_connected', 'x'));

    render(<App />);
    await screen.findByLabelText(/jira project/i);

    typeInto(/jira project/i, 'SCRUM');
    await act(async () => { vi.advanceTimersByTime(600); });
    await screen.findByRole('heading', { name: /create your first jira ticket/i });

    typeInto(/title/i, 'Test ticket');
    typeInto(/description/i, 'Test description');
    fireEvent.click(screen.getByRole('button', { name: /^create ticket$/i }));

    await screen.findByRole('alert');

    const callCountAfterFailure = mockedListRecentTickets.mock.calls.length;
    await new Promise<void>((r) => setTimeout(r, 100));
    expect(mockedListRecentTickets.mock.calls.length).toBe(callCountAfterFailure);
  });
});

// ---------------------------------------------------------------------------
// Connection save refreshes recent tickets
// ---------------------------------------------------------------------------

describe('connection save refreshes recent tickets', () => {
  const connectedJira = {
    connected: true as const,
    siteUrl: 'https://acme.atlassian.net',
    email: 'alice@example.com',
  };

  const OLD_TICKET: RecentTicket = {
    issueId: 'OLD-1',
    issueKey: 'SCRUM-100',
    title: 'Old ticket before connection replaced',
    createdAt: '2024-01-01T00:00:00.000Z',
    url: 'https://acme.atlassian.net/browse/SCRUM-100',
  };

  const NEW_TICKET: RecentTicket = {
    issueId: 'NEW-1',
    issueKey: 'SCRUM-101',
    title: 'New ticket after connection replaced',
    createdAt: '2024-01-02T00:00:00.000Z',
    url: 'https://new.atlassian.net/browse/SCRUM-101',
  };

  async function renderConnectedWithProject() {
    mockedRestore.mockResolvedValue(alice);
    mockedGetJira.mockResolvedValue(connectedJira);
    mockedListRecentTickets.mockResolvedValueOnce({ tickets: [OLD_TICKET] });
    render(<App />);
    await screen.findByLabelText(/jira project/i);

    typeInto(/jira project/i, 'SCRUM');
    await act(async () => { vi.advanceTimersByTime(600); });
    await screen.findByText(OLD_TICKET.title);
  }

  it('replaces old results with new results after a successful connection replacement', async () => {
    await renderConnectedWithProject();

    let resolveRefresh!: (value: ListRecentTicketsResult) => void;
    mockedListRecentTickets.mockReturnValueOnce(
      new Promise<ListRecentTicketsResult>((res) => { resolveRefresh = res; }),
    );

    mockedSaveJira.mockResolvedValue({
      connected: true,
      siteUrl: 'https://new.atlassian.net',
      email: 'alice@example.com',
    });

    // Open the Jira modal via "Manage".
    fireEvent.click(screen.getByRole('button', { name: /^manage$/i }));
    await screen.findByRole('dialog');

    fireEvent.change(screen.getByLabelText(/site url/i), {
      target: { value: 'https://new.atlassian.net' },
    });
    fireEvent.change(screen.getByLabelText(/account email/i), {
      target: { value: 'alice@example.com' },
    });
    fireEvent.change(screen.getByLabelText(/api token/i), {
      target: { value: 'token123' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^replace connection$/i }));

    // Modal closes on success.
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    // Old results are gone; loading is in progress; project key is preserved.
    await waitFor(() => {
      expect(screen.queryByText(OLD_TICKET.title)).not.toBeInTheDocument();
      expect(screen.getByText(/loading tickets/i)).toBeInTheDocument();
    });
    expect((screen.getByLabelText(/jira project/i) as HTMLInputElement).value).toBe('SCRUM');

    await act(async () => { resolveRefresh({ tickets: [NEW_TICKET] }); });

    expect(screen.getByText(NEW_TICKET.title)).toBeInTheDocument();
    expect(screen.queryByText(OLD_TICKET.title)).not.toBeInTheDocument();
  });

  it('leaves existing results unchanged after a failed connection replacement', async () => {
    await renderConnectedWithProject();

    expect(screen.getByText(OLD_TICKET.title)).toBeInTheDocument();

    mockedSaveJira.mockRejectedValue(new JiraApiError('credentials_rejected', 'x'));

    fireEvent.click(screen.getByRole('button', { name: /^manage$/i }));
    await screen.findByRole('dialog');

    fireEvent.change(screen.getByLabelText(/site url/i), {
      target: { value: 'https://new.atlassian.net' },
    });
    fireEvent.change(screen.getByLabelText(/account email/i), {
      target: { value: 'alice@example.com' },
    });
    fireEvent.change(screen.getByLabelText(/api token/i), {
      target: { value: 'wrong-token' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^replace connection$/i }));

    await screen.findByRole('alert');

    // Modal stays open; close it.
    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));

    expect(screen.getByText(OLD_TICKET.title)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Logout
// ---------------------------------------------------------------------------

describe('logout', () => {
  async function renderAuthenticated() {
    mockedRestore.mockResolvedValue(alice);
    render(<App />);
    await screen.findByText(/welcome, alice anderson/i);
  }

  it('returns to the login screen on success', async () => {
    await renderAuthenticated();
    mockedLogout.mockResolvedValue();

    fireEvent.click(screen.getByRole('button', { name: /sign out/i }));

    expect(await screen.findByRole('button', { name: /^sign in$/i })).toBeInTheDocument();
  });

  it('keeps the user authenticated and shows a retryable error when logout fails', async () => {
    await renderAuthenticated();
    mockedLogout.mockRejectedValue(new AuthError('network', 'Unable to reach the server.'));

    fireEvent.click(screen.getByRole('button', { name: /sign out/i }));

    const header = screen.getByRole('banner');
    expect(within(header).getByText('Alice Anderson')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/still signed in/i));
    expect(screen.getByRole('button', { name: /sign out/i })).toBeEnabled();
  });
});
