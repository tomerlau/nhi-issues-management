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
  it('shows "Jira not connected" with no button in the header when disconnected', async () => {
    mockedRestore.mockResolvedValue(alice);
    mockedGetJira.mockResolvedValue({ connected: false });

    render(<App />);
    await screen.findByText(/jira not connected/i);

    const header = screen.getByRole('banner');
    // No Connect Jira or Manage button in the header — only in main content as inline form submit.
    expect(within(header).queryByRole('button', { name: /^connect jira$/i })).not.toBeInTheDocument();
    expect(within(header).queryByRole('button', { name: /manage jira connection/i })).not.toBeInTheDocument();
  });

  it('shows "Jira connected" and gear button when connected', async () => {
    mockedRestore.mockResolvedValue(alice);
    mockedGetJira.mockResolvedValue({
      connected: true,
      siteUrl: 'https://acme.atlassian.net',
      email: 'alice@example.com',
    });

    render(<App />);
    await screen.findByText(/jira connected/i);

    expect(screen.getByRole('button', { name: /manage jira connection/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^manage$/i })).not.toBeInTheDocument();
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
// Mode B to Mode A transition
// ---------------------------------------------------------------------------

describe('Mode B to Mode A transition', () => {
  it('transitions from Mode B to Mode A after the first ticket is created', async () => {
    const FIRST_TICKET: RecentTicket = {
      issueId: '10001',
      issueKey: 'SCRUM-1',
      title: 'First ever ticket',
      createdAt: '2024-01-01T00:00:00.000Z',
      url: 'https://acme.atlassian.net/browse/SCRUM-1',
    };

    mockedRestore.mockResolvedValue(alice);
    mockedGetJira.mockResolvedValue({
      connected: true,
      siteUrl: 'https://acme.atlassian.net',
      email: 'alice@example.com',
    });
    mockedListRecentTickets
      .mockResolvedValueOnce({ tickets: [] })
      .mockResolvedValue({ tickets: [FIRST_TICKET] });
    mockedCreateTicket.mockResolvedValue({ issueId: '10001', issueKey: 'SCRUM-1' });

    render(<App />);
    await screen.findByLabelText(/jira project/i);
    typeInto(/jira project/i, 'SCRUM');
    await act(async () => { vi.advanceTimersByTime(600); });
    await screen.findByRole('heading', { name: /create your first jira ticket/i });

    typeInto(/title/i, 'First ever ticket');
    typeInto(/description/i, 'Details here');
    fireEvent.click(screen.getByRole('button', { name: /^create ticket$/i }));

    await screen.findByRole('status');

    await screen.findByRole('heading', { name: /recent tickets/i });
    expect(screen.getByText('First ever ticket')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /create your first jira ticket/i })).not.toBeInTheDocument();
    expect((screen.getByLabelText(/jira project/i) as HTMLInputElement).value).toBe('SCRUM');
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
// Mode A modal behaviour
// ---------------------------------------------------------------------------

describe('Mode A modal behaviour', () => {
  const EXISTING_TICKET: RecentTicket = {
    issueId: '10001',
    issueKey: 'SCRUM-1',
    title: 'Existing ticket',
    createdAt: '2024-01-01T00:00:00.000Z',
    url: 'https://acme.atlassian.net/browse/SCRUM-1',
  };

  const SECOND_TICKET: RecentTicket = {
    issueId: '10002',
    issueKey: 'SCRUM-2',
    title: 'Second ticket',
    createdAt: '2024-01-02T00:00:00.000Z',
    url: 'https://acme.atlassian.net/browse/SCRUM-2',
  };

  async function renderWithModalOpen() {
    mockedRestore.mockResolvedValue(alice);
    mockedGetJira.mockResolvedValue({
      connected: true,
      siteUrl: 'https://acme.atlassian.net',
      email: 'alice@example.com',
    });
    mockedListRecentTickets.mockResolvedValue({ tickets: [EXISTING_TICKET] });
    render(<App />);
    await screen.findByLabelText(/jira project/i);
    typeInto(/jira project/i, 'SCRUM');
    await act(async () => { vi.advanceTimersByTime(600); });
    await screen.findByRole('heading', { name: /recent tickets/i });
    fireEvent.click(screen.getByRole('button', { name: /^create ticket$/i }));
    await screen.findByRole('dialog');
  }

  it('closes the modal, refreshes the list, and shows the new ticket on successful creation', async () => {
    mockedRestore.mockResolvedValue(alice);
    mockedGetJira.mockResolvedValue({
      connected: true,
      siteUrl: 'https://acme.atlassian.net',
      email: 'alice@example.com',
    });
    mockedListRecentTickets
      .mockResolvedValueOnce({ tickets: [EXISTING_TICKET] })
      .mockResolvedValue({ tickets: [EXISTING_TICKET, SECOND_TICKET] });
    mockedCreateTicket.mockResolvedValue({ issueId: SECOND_TICKET.issueId, issueKey: SECOND_TICKET.issueKey });

    render(<App />);
    await screen.findByLabelText(/jira project/i);
    typeInto(/jira project/i, 'SCRUM');
    await act(async () => { vi.advanceTimersByTime(600); });
    await screen.findByRole('heading', { name: /recent tickets/i });
    fireEvent.click(screen.getByRole('button', { name: /^create ticket$/i }));
    await screen.findByRole('dialog');

    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/title/i), { target: { value: 'Second ticket' } });
    fireEvent.change(within(dialog).getByLabelText(/description/i), { target: { value: 'Details' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /^create ticket$/i }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    await screen.findByText(SECOND_TICKET.title);
    expect((screen.getByLabelText(/jira project/i) as HTMLInputElement).value).toBe('SCRUM');
  });

  it('keeps the modal open, preserves fields, and shows an error on a definite failure', async () => {
    await renderWithModalOpen();
    mockedCreateTicket.mockRejectedValue(new TicketApiError('not_connected', 'x'));

    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/title/i), { target: { value: 'My ticket' } });
    fireEvent.change(within(dialog).getByLabelText(/description/i), { target: { value: 'My description' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /^create ticket$/i }));

    await within(dialog).findByRole('alert');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect((within(dialog).getByLabelText(/title/i) as HTMLInputElement).value).toBe('My ticket');
    expect((within(dialog).getByLabelText(/description/i) as HTMLTextAreaElement).value).toBe('My description');
    expect(mockedListRecentTickets).toHaveBeenCalledTimes(1);
  });

  it('keeps the modal open and shows a duplicate warning on an uncertain outcome', async () => {
    await renderWithModalOpen();
    mockedCreateTicket.mockRejectedValue(new TicketApiError('network', 'x'));

    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/title/i), { target: { value: 'My ticket' } });
    fireEvent.change(within(dialog).getByLabelText(/description/i), { target: { value: 'My description' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /^create ticket$/i }));

    const alert = await within(dialog).findByRole('alert');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(alert).toHaveTextContent(/duplicate/i);
  });

  it('disables the close button and blocks Escape while a submission is in flight', async () => {
    await renderWithModalOpen();
    mockedCreateTicket.mockReturnValue(new Promise<CreatedTicket>(() => {}));

    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/title/i), { target: { value: 'My ticket' } });
    fireEvent.change(within(dialog).getByLabelText(/description/i), { target: { value: 'Details' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /^create ticket$/i }));

    expect(within(dialog).getByRole('button', { name: /^close$/i })).toBeDisabled();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(mockedCreateTicket).toHaveBeenCalledTimes(1);
  });

  it('returns focus to the "Create ticket" trigger when the modal is closed', async () => {
    await renderWithModalOpen();

    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /^close$/i }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    await act(async () => { vi.runAllTimers(); });

    expect(document.activeElement).toBe(screen.getByRole('button', { name: /^create ticket$/i }));
  });
});

// ---------------------------------------------------------------------------
// Project selector locking
// ---------------------------------------------------------------------------

describe('project selector locking', () => {
  const connectedJira = {
    connected: true as const,
    siteUrl: 'https://acme.atlassian.net',
    email: 'alice@example.com',
  };

  const EXISTING_TICKET: RecentTicket = {
    issueId: '10001',
    issueKey: 'SCRUM-1',
    title: 'Existing ticket',
    createdAt: '2024-01-01T00:00:00.000Z',
    url: 'https://acme.atlassian.net/browse/SCRUM-1',
  };

  async function renderModeA() {
    mockedRestore.mockResolvedValue(alice);
    mockedGetJira.mockResolvedValue(connectedJira);
    mockedListRecentTickets.mockResolvedValue({ tickets: [EXISTING_TICKET] });
    render(<App />);
    await screen.findByLabelText(/jira project/i);
    typeInto(/jira project/i, 'SCRUM');
    await act(async () => { vi.advanceTimersByTime(600); });
    await screen.findByRole('heading', { name: /recent tickets/i });
  }

  async function renderModeB() {
    mockedRestore.mockResolvedValue(alice);
    mockedGetJira.mockResolvedValue(connectedJira);
    mockedListRecentTickets.mockResolvedValue({ tickets: [] });
    render(<App />);
    await screen.findByLabelText(/jira project/i);
    typeInto(/jira project/i, 'SCRUM');
    await act(async () => { vi.advanceTimersByTime(600); });
    await screen.findByRole('heading', { name: /create your first jira ticket/i });
  }

  // — Mode A: selector locking around the creation modal —

  it('selector is enabled before the Mode A modal opens', async () => {
    await renderModeA();

    expect(screen.getByLabelText(/jira project/i)).not.toBeDisabled();
  });

  it('selector becomes disabled immediately when the modal opens', async () => {
    await renderModeA();

    fireEvent.click(screen.getByRole('button', { name: /^create ticket$/i }));
    await screen.findByRole('dialog');

    expect(screen.getByLabelText(/jira project/i)).toBeDisabled();
  });

  it('selector remains disabled while a modal submission is in flight', async () => {
    await renderModeA();
    mockedCreateTicket.mockReturnValue(new Promise<CreatedTicket>(() => {}));

    fireEvent.click(screen.getByRole('button', { name: /^create ticket$/i }));
    await screen.findByRole('dialog');

    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/title/i), { target: { value: 'My ticket' } });
    fireEvent.change(within(dialog).getByLabelText(/description/i), { target: { value: 'Details' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /^create ticket$/i }));

    expect(screen.getByLabelText(/jira project/i)).toBeDisabled();
  });

  it('selector remains disabled after a definite failure while the modal is still open', async () => {
    await renderModeA();
    mockedCreateTicket.mockRejectedValue(new TicketApiError('not_connected', 'x'));

    fireEvent.click(screen.getByRole('button', { name: /^create ticket$/i }));
    await screen.findByRole('dialog');

    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/title/i), { target: { value: 'My ticket' } });
    fireEvent.change(within(dialog).getByLabelText(/description/i), { target: { value: 'Details' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /^create ticket$/i }));

    await within(dialog).findByRole('alert');

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByLabelText(/jira project/i)).toBeDisabled();
  });

  it('selector becomes enabled after closing the failed modal', async () => {
    await renderModeA();
    mockedCreateTicket.mockRejectedValue(new TicketApiError('not_connected', 'x'));

    fireEvent.click(screen.getByRole('button', { name: /^create ticket$/i }));
    await screen.findByRole('dialog');

    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/title/i), { target: { value: 'My ticket' } });
    fireEvent.change(within(dialog).getByLabelText(/description/i), { target: { value: 'Details' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /^create ticket$/i }));

    await within(dialog).findByRole('alert');
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /^close$/i }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    expect(screen.getByLabelText(/jira project/i)).not.toBeDisabled();
  });

  it('selector becomes enabled and project is unchanged after successful modal creation', async () => {
    mockedRestore.mockResolvedValue(alice);
    mockedGetJira.mockResolvedValue(connectedJira);
    mockedListRecentTickets
      .mockResolvedValueOnce({ tickets: [EXISTING_TICKET] })
      .mockResolvedValue({ tickets: [EXISTING_TICKET] });
    mockedCreateTicket.mockResolvedValue({ issueId: '10002', issueKey: 'SCRUM-2' });

    render(<App />);
    await screen.findByLabelText(/jira project/i);
    typeInto(/jira project/i, 'SCRUM');
    await act(async () => { vi.advanceTimersByTime(600); });
    await screen.findByRole('heading', { name: /recent tickets/i });

    fireEvent.click(screen.getByRole('button', { name: /^create ticket$/i }));
    await screen.findByRole('dialog');

    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/title/i), { target: { value: 'New ticket' } });
    fireEvent.change(within(dialog).getByLabelText(/description/i), { target: { value: 'Details' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /^create ticket$/i }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    expect(screen.getByLabelText(/jira project/i)).not.toBeDisabled();
    expect((screen.getByLabelText(/jira project/i) as HTMLInputElement).value).toBe('SCRUM');
  });

  // — Mode B: selector locking around inline submission —

  it('selector is enabled while the Mode B inline form is idle', async () => {
    await renderModeB();

    expect(screen.getByLabelText(/jira project/i)).not.toBeDisabled();
  });

  it('selector becomes disabled when Mode B inline submission starts', async () => {
    await renderModeB();
    mockedCreateTicket.mockReturnValue(new Promise<CreatedTicket>(() => {}));

    typeInto(/title/i, 'First ticket');
    typeInto(/description/i, 'Details');
    fireEvent.click(screen.getByRole('button', { name: /^create ticket$/i }));

    expect(screen.getByLabelText(/jira project/i)).toBeDisabled();
  });

  it('selector becomes enabled after a definite Mode B failure', async () => {
    await renderModeB();
    mockedCreateTicket.mockRejectedValue(new TicketApiError('not_connected', 'x'));

    typeInto(/title/i, 'First ticket');
    typeInto(/description/i, 'Details');
    fireEvent.click(screen.getByRole('button', { name: /^create ticket$/i }));

    await screen.findByRole('alert');

    expect(screen.getByLabelText(/jira project/i)).not.toBeDisabled();
    expect((screen.getByLabelText(/jira project/i) as HTMLInputElement).value).toBe('SCRUM');
  });

  it('selector becomes enabled after an uncertain Mode B failure', async () => {
    await renderModeB();
    mockedCreateTicket.mockRejectedValue(new TicketApiError('network', 'x'));

    typeInto(/title/i, 'First ticket');
    typeInto(/description/i, 'Details');
    fireEvent.click(screen.getByRole('button', { name: /^create ticket$/i }));

    await screen.findByRole('alert');

    expect(screen.getByLabelText(/jira project/i)).not.toBeDisabled();
    expect((screen.getByLabelText(/jira project/i) as HTMLInputElement).value).toBe('SCRUM');
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

    // Open the Jira modal via the gear button.
    fireEvent.click(screen.getByRole('button', { name: /manage jira connection/i }));
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

    fireEvent.click(screen.getByRole('button', { name: /manage jira connection/i }));
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
    expect(within(header).getByText('alice@example.com')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/still signed in/i));
    expect(screen.getByRole('button', { name: /sign out/i })).toBeEnabled();
  });
});

// ---------------------------------------------------------------------------
// Header content
// ---------------------------------------------------------------------------

describe('header content', () => {
  it('does not render the user display name in the header', async () => {
    mockedRestore.mockResolvedValue(alice);
    render(<App />);
    await screen.findByText(/welcome, alice anderson/i);

    const header = screen.getByRole('banner');
    expect(within(header).queryByText('Alice Anderson')).not.toBeInTheDocument();
  });

  it('renders the authenticated user email in the header', async () => {
    mockedRestore.mockResolvedValue(alice);
    render(<App />);
    await screen.findByText(/welcome, alice anderson/i);

    const header = screen.getByRole('banner');
    expect(within(header).getByText('alice@example.com')).toBeInTheDocument();
  });

  it('does not render the signed-in explanatory sentence', async () => {
    mockedRestore.mockResolvedValue(alice);
    render(<App />);
    await screen.findByText(/welcome, alice anderson/i);

    expect(
      screen.queryByText(/you are signed in to NHI Issues Management/i),
    ).not.toBeInTheDocument();
  });

  it('shows the connected indicator class when Jira is connected', async () => {
    mockedRestore.mockResolvedValue(alice);
    mockedGetJira.mockResolvedValue({
      connected: true,
      siteUrl: 'https://acme.atlassian.net',
      email: 'alice@example.com',
    });
    render(<App />);
    await screen.findByText(/jira connected/i);

    expect(document.querySelector('.jira-indicator-connected')).toBeInTheDocument();
    expect(document.querySelector('.jira-indicator-disconnected')).not.toBeInTheDocument();
  });

  it('shows the disconnected indicator class when Jira is not connected', async () => {
    mockedRestore.mockResolvedValue(alice);
    mockedGetJira.mockResolvedValue({ connected: false });
    render(<App />);
    await screen.findByText(/jira not connected/i);

    expect(document.querySelector('.jira-indicator-disconnected')).toBeInTheDocument();
    expect(document.querySelector('.jira-indicator-connected')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Disconnected Jira — inline connection form
// ---------------------------------------------------------------------------

describe('disconnected Jira — inline connection form', () => {
  async function renderDisconnected() {
    mockedRestore.mockResolvedValue(alice);
    mockedGetJira.mockResolvedValue({ connected: false });
    render(<App />);
    await screen.findByText(/jira not connected/i);
    // Inline form appears once loading resolves as disconnected.
    await screen.findByLabelText(/jira cloud site url/i);
  }

  it('renders the inline connection form in main content when disconnected', async () => {
    await renderDisconnected();

    expect(screen.getByLabelText(/jira cloud site url/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/atlassian account email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/atlassian api token/i)).toBeInTheDocument();
  });

  it('does not open a dialog for the disconnected state', async () => {
    await renderDisconnected();

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('inline form fields are not inside a dialog', async () => {
    await renderDisconnected();

    const siteUrlInput = screen.getByLabelText(/jira cloud site url/i);
    expect(siteUrlInput.closest('[role="dialog"]')).toBeNull();
  });

  it('does not show ProjectSelector before connection', async () => {
    await renderDisconnected();

    expect(screen.queryByLabelText(/jira project/i)).not.toBeInTheDocument();
  });

  it('shows the tenant-sharing disclaimer in the inline form', async () => {
    await renderDisconnected();

    expect(screen.getByText(/shared by everyone in your tenant/i)).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('shows a Connect Jira submit button in main content', async () => {
    await renderDisconnected();

    const submitBtn = screen.getByRole('button', { name: /^connect jira$/i });
    expect(submitBtn.closest('[role="dialog"]')).toBeNull();
  });

  it('successful connection: calls save once, removes inline form, shows gear, shows ProjectSelector', async () => {
    mockedRestore.mockResolvedValue(alice);
    mockedGetJira
      .mockResolvedValueOnce({ connected: false })
      .mockResolvedValue({
        connected: true,
        siteUrl: 'https://acme.atlassian.net',
        email: 'alice@example.com',
      });
    mockedSaveJira.mockResolvedValue({
      connected: true,
      siteUrl: 'https://acme.atlassian.net',
      email: 'alice@example.com',
    });

    render(<App />);
    await screen.findByLabelText(/jira cloud site url/i);

    fireEvent.change(screen.getByLabelText(/jira cloud site url/i), {
      target: { value: 'https://acme.atlassian.net' },
    });
    fireEvent.change(screen.getByLabelText(/atlassian account email/i), {
      target: { value: 'alice@example.com' },
    });
    fireEvent.change(screen.getByLabelText(/atlassian api token/i), {
      target: { value: 'secret-token' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^connect jira$/i }));

    expect(mockedSaveJira).toHaveBeenCalledTimes(1);
    expect(mockedSaveJira).toHaveBeenCalledWith({
      siteUrl: 'https://acme.atlassian.net',
      email: 'alice@example.com',
      apiToken: 'secret-token',
    });

    // After success: inline form gone, connected header, gear button, ProjectSelector.
    await waitFor(() => {
      expect(screen.queryByLabelText(/jira cloud site url/i)).not.toBeInTheDocument();
    });
    await screen.findByText(/jira connected/i);
    expect(screen.getByRole('button', { name: /manage jira connection/i })).toBeInTheDocument();
    await screen.findByLabelText(/jira project/i);
  });

  it('successful connection does not show a persistent success message', async () => {
    mockedRestore.mockResolvedValue(alice);
    mockedGetJira
      .mockResolvedValueOnce({ connected: false })
      .mockResolvedValue({
        connected: true,
        siteUrl: 'https://acme.atlassian.net',
        email: 'alice@example.com',
      });
    mockedSaveJira.mockResolvedValue({
      connected: true,
      siteUrl: 'https://acme.atlassian.net',
      email: 'alice@example.com',
    });

    render(<App />);
    await screen.findByLabelText(/jira cloud site url/i);

    fireEvent.change(screen.getByLabelText(/jira cloud site url/i), { target: { value: 'https://acme.atlassian.net' } });
    fireEvent.change(screen.getByLabelText(/atlassian account email/i), { target: { value: 'alice@example.com' } });
    fireEvent.change(screen.getByLabelText(/atlassian api token/i), { target: { value: 'tok' } });
    fireEvent.click(screen.getByRole('button', { name: /^connect jira$/i }));

    await screen.findByText(/jira connected/i);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('failed connection: keeps inline form, shows error, does not show ProjectSelector', async () => {
    mockedRestore.mockResolvedValue(alice);
    mockedGetJira.mockResolvedValue({ connected: false });
    mockedSaveJira.mockRejectedValue(new JiraApiError('credentials_rejected', 'ignored'));

    render(<App />);
    await screen.findByLabelText(/jira cloud site url/i);

    fireEvent.change(screen.getByLabelText(/jira cloud site url/i), { target: { value: 'https://acme.atlassian.net' } });
    fireEvent.change(screen.getByLabelText(/atlassian account email/i), { target: { value: 'alice@example.com' } });
    fireEvent.change(screen.getByLabelText(/atlassian api token/i), { target: { value: 'bad-token' } });
    fireEvent.click(screen.getByRole('button', { name: /^connect jira$/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).toBeInTheDocument();
    expect(screen.getByLabelText(/jira cloud site url/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/jira project/i)).not.toBeInTheDocument();
  });

  it('clears the API token immediately when submission begins', async () => {
    mockedRestore.mockResolvedValue(alice);
    mockedGetJira.mockResolvedValue({ connected: false });
    mockedSaveJira.mockReturnValue(new Promise(() => {}));

    render(<App />);
    await screen.findByLabelText(/jira cloud site url/i);

    fireEvent.change(screen.getByLabelText(/jira cloud site url/i), { target: { value: 'https://acme.atlassian.net' } });
    fireEvent.change(screen.getByLabelText(/atlassian account email/i), { target: { value: 'alice@example.com' } });
    const tokenField = screen.getByLabelText(/atlassian api token/i) as HTMLInputElement;
    fireEvent.change(tokenField, { target: { value: 'secret' } });
    fireEvent.click(screen.getByRole('button', { name: /^connect jira$/i }));

    expect(tokenField.value).toBe('');
    expect(screen.getByRole('button', { name: /connecting/i })).toBeDisabled();
  });

  it('pending submission: disables inputs and submit, sends only one request', async () => {
    mockedRestore.mockResolvedValue(alice);
    mockedGetJira.mockResolvedValue({ connected: false });
    mockedSaveJira.mockReturnValue(new Promise(() => {}));

    render(<App />);
    await screen.findByLabelText(/jira cloud site url/i);

    fireEvent.change(screen.getByLabelText(/jira cloud site url/i), { target: { value: 'https://acme.atlassian.net' } });
    fireEvent.change(screen.getByLabelText(/atlassian account email/i), { target: { value: 'alice@example.com' } });
    fireEvent.change(screen.getByLabelText(/atlassian api token/i), { target: { value: 'tok' } });

    const submit = screen.getByRole('button', { name: /^connect jira$/i });
    fireEvent.click(submit);
    fireEvent.click(submit);

    expect(mockedSaveJira).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText(/jira cloud site url/i)).toBeDisabled();
    expect(screen.getByLabelText(/atlassian account email/i)).toBeDisabled();
  });

  it('client validation: shows error without calling backend when fields are empty', async () => {
    await renderDisconnected();

    fireEvent.click(screen.getByRole('button', { name: /^connect jira$/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/enter the jira site url/i);
    expect(mockedSaveJira).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Jira status resilience — GET errors vs. explicit disconnected
// ---------------------------------------------------------------------------

describe('Jira status resilience', () => {
  it('does NOT show the inline form when the initial status GET fails', async () => {
    mockedRestore.mockResolvedValue(alice);
    mockedGetJira.mockRejectedValue(new JiraApiError('network', 'x'));

    render(<App />);
    // Panel shows a safe error with Retry — this is not an explicit disconnected state.
    await screen.findByRole('button', { name: /try again/i });

    expect(screen.queryByLabelText(/jira cloud site url/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^connect jira$/i })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/jira project/i)).not.toBeInTheDocument();
  });

  it('shows the inline form only after Retry returns an explicit disconnected response', async () => {
    mockedRestore.mockResolvedValue(alice);
    mockedGetJira
      .mockRejectedValueOnce(new JiraApiError('network', 'x'))
      .mockResolvedValueOnce({ connected: false });

    render(<App />);
    await screen.findByRole('button', { name: /try again/i });

    // Before retry: error state → inline form must not appear.
    expect(screen.queryByLabelText(/jira cloud site url/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /try again/i }));

    // After retry resolves as disconnected: inline form appears.
    await screen.findByLabelText(/jira cloud site url/i);
    expect(screen.queryByLabelText(/jira project/i)).not.toBeInTheDocument();
  });

  it('shows gear and ProjectSelector (no inline form) when Retry returns connected', async () => {
    mockedRestore.mockResolvedValue(alice);
    mockedGetJira
      .mockRejectedValueOnce(new JiraApiError('network', 'x'))
      .mockResolvedValueOnce({
        connected: true,
        siteUrl: 'https://acme.atlassian.net',
        email: 'alice@example.com',
      });

    render(<App />);
    await screen.findByRole('button', { name: /try again/i });

    expect(screen.queryByLabelText(/jira cloud site url/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/jira project/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /try again/i }));

    await screen.findByRole('button', { name: /manage jira connection/i });
    await screen.findByLabelText(/jira project/i);
    expect(screen.queryByLabelText(/jira cloud site url/i)).not.toBeInTheDocument();
  });

  it('removes the inline form immediately on POST success, before the follow-up GET resolves', async () => {
    mockedRestore.mockResolvedValue(alice);
    mockedGetJira
      .mockResolvedValueOnce({ connected: false })
      .mockReturnValue(new Promise(() => {})); // follow-up GET never resolves
    mockedSaveJira.mockResolvedValue({
      connected: true,
      siteUrl: 'https://acme.atlassian.net',
      email: 'alice@example.com',
    });

    render(<App />);
    await screen.findByLabelText(/jira cloud site url/i);

    fireEvent.change(screen.getByLabelText(/jira cloud site url/i), { target: { value: 'https://acme.atlassian.net' } });
    fireEvent.change(screen.getByLabelText(/atlassian account email/i), { target: { value: 'alice@example.com' } });
    fireEvent.change(screen.getByLabelText(/atlassian api token/i), { target: { value: 'tok' } });
    fireEvent.click(screen.getByRole('button', { name: /^connect jira$/i }));

    // Form gone and ProjectSelector visible — even while the follow-up GET is still pending.
    await waitFor(() => {
      expect(screen.queryByLabelText(/jira cloud site url/i)).not.toBeInTheDocument();
    });
    await screen.findByLabelText(/jira project/i);
    expect(mockedSaveJira).toHaveBeenCalledTimes(1);
  });

  it('stays connected when the follow-up GET after inline POST fails', async () => {
    mockedRestore.mockResolvedValue(alice);
    mockedGetJira
      .mockResolvedValueOnce({ connected: false })
      .mockRejectedValue(new JiraApiError('network', 'x')); // follow-up GET fails
    mockedSaveJira.mockResolvedValue({
      connected: true,
      siteUrl: 'https://acme.atlassian.net',
      email: 'alice@example.com',
    });

    render(<App />);
    await screen.findByLabelText(/jira cloud site url/i);

    fireEvent.change(screen.getByLabelText(/jira cloud site url/i), { target: { value: 'https://acme.atlassian.net' } });
    fireEvent.change(screen.getByLabelText(/atlassian account email/i), { target: { value: 'alice@example.com' } });
    fireEvent.change(screen.getByLabelText(/atlassian api token/i), { target: { value: 'tok' } });
    fireEvent.click(screen.getByRole('button', { name: /^connect jira$/i }));

    // POST succeeded: form gone and ProjectSelector visible.
    await waitFor(() => {
      expect(screen.queryByLabelText(/jira cloud site url/i)).not.toBeInTheDocument();
    });
    await screen.findByLabelText(/jira project/i);

    // Wait long enough for the follow-up GET failure to propagate.
    await waitFor(() => {
      // ProjectSelector must still be visible (shell stayed connected, did not revert).
      expect(screen.getByLabelText(/jira project/i)).toBeInTheDocument();
      // Inline form must remain absent — error is not treated as disconnected.
      expect(screen.queryByLabelText(/jira cloud site url/i)).not.toBeInTheDocument();
    });
    expect(mockedSaveJira).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Connected Jira — gear opens manage modal
// ---------------------------------------------------------------------------

describe('connected Jira — gear opens manage modal', () => {
  async function renderConnected() {
    mockedRestore.mockResolvedValue(alice);
    mockedGetJira.mockResolvedValue({
      connected: true,
      siteUrl: 'https://acme.atlassian.net',
      email: 'alice@example.com',
    });
    render(<App />);
    await screen.findByRole('button', { name: /manage jira connection/i });
  }

  it('gear button opens the manage modal', async () => {
    await renderConnected();

    fireEvent.click(screen.getByRole('button', { name: /manage jira connection/i }));

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /manage jira connection/i })).toBeInTheDocument();
  });

  it('existing connection details are shown only inside the modal, not on the page', async () => {
    await renderConnected();

    expect(screen.queryByText('https://acme.atlassian.net')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /manage jira connection/i }));
    await screen.findByRole('dialog');

    expect(within(screen.getByRole('dialog')).getByText('https://acme.atlassian.net')).toBeInTheDocument();
  });

  it('replacement form fields start empty (token never pre-populated)', async () => {
    await renderConnected();

    fireEvent.click(screen.getByRole('button', { name: /manage jira connection/i }));
    await screen.findByRole('dialog');

    const dialog = screen.getByRole('dialog');
    expect((within(dialog).getByLabelText(/site url/i) as HTMLInputElement).value).toBe('');
    expect((within(dialog).getByLabelText(/atlassian account email/i) as HTMLInputElement).value).toBe('');
    expect((within(dialog).getByLabelText(/api token/i) as HTMLInputElement).value).toBe('');
  });

  it('cancel restores focus to the gear button', async () => {
    await renderConnected();

    fireEvent.click(screen.getByRole('button', { name: /manage jira connection/i }));
    await screen.findByRole('dialog');

    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /^cancel$/i }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    await act(async () => { vi.runAllTimers(); });

    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: /manage jira connection/i }),
    );
  });

  it('close button restores focus to the gear button', async () => {
    await renderConnected();

    fireEvent.click(screen.getByRole('button', { name: /manage jira connection/i }));
    await screen.findByRole('dialog');

    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /^close$/i }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    await act(async () => { vi.runAllTimers(); });

    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: /manage jira connection/i }),
    );
  });
});
