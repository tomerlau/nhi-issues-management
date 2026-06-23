import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App';
import { AuthError, login, logout, restoreSession, type SafeUser } from '../src/api/auth';
import { getJiraConnection, JiraApiError, saveJiraConnection } from '../src/api/jira';
import { createTicket, listRecentTickets, TicketApiError, type CreatedTicket } from '../src/api/tickets';

vi.mock('../src/api/auth', async () => {
  const actual = await vi.importActual<typeof import('../src/api/auth')>('../src/api/auth');
  return {
    ...actual,
    login: vi.fn(),
    logout: vi.fn(),
    restoreSession: vi.fn(),
  };
});

// The authenticated shell mounts the Jira panel, which loads its status on mount.
// Stub it so these auth-focused tests never make a real network request.
vi.mock('../src/api/jira', async () => {
  const actual = await vi.importActual<typeof import('../src/api/jira')>('../src/api/jira');
  return {
    ...actual,
    getJiraConnection: vi.fn(),
    saveJiraConnection: vi.fn(),
  };
});

// The shell also mounts the ticket panels. Stub both so these tests never make
// real network requests (recent tickets are not requested until a valid project
// key is entered, but creation is exercised in the integration tests below).
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

/** Resolve restoreSession to the unauthenticated state and wait for the login form. */
async function renderLoggedOut() {
  mockedRestore.mockResolvedValue(null);
  render(<App />);
  return screen.findByRole('button', { name: /^sign in$/i });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedGetJira.mockResolvedValue({ connected: false });
  mockedListRecentTickets.mockResolvedValue({ tickets: [] });
});

afterEach(() => {
  cleanup();
});

describe('product branding', () => {
  it('uses the product name in the login heading and not the old name', async () => {
    await renderLoggedOut();

    expect(
      screen.getByRole('heading', { name: /sign in to NHI Issues Management/i }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/IdentityHub to Jira/i)).not.toBeInTheDocument();
  });

  it('uses the product name in the authenticated header and subtitle', async () => {
    mockedRestore.mockResolvedValue(alice);

    render(<App />);
    await screen.findByText(/welcome, alice anderson/i);

    expect(within(screen.getByRole('banner')).getByText('NHI Issues Management')).toBeInTheDocument();
    expect(screen.getByText('You are signed in to NHI Issues Management.')).toBeInTheDocument();
    expect(screen.queryByText(/IdentityHub to Jira/i)).not.toBeInTheDocument();
  });
});

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

  it('shows the login screen on the unauthenticated 401 state', async () => {
    mockedRestore.mockResolvedValue(null);

    render(<App />);

    expect(await screen.findByRole('button', { name: /^sign in$/i })).toBeInTheDocument();
  });

  it('shows a retryable error (not the login screen) when restoration fails', async () => {
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
    // The password field is cleared after a completed attempt.
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
      new Promise<SafeUser>((resolve) => {
        resolveLogin = resolve;
      }),
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

describe('ticket creation gating', () => {
  it('shows the ticket creation form only when Jira is connected', async () => {
    mockedRestore.mockResolvedValue(alice);
    mockedGetJira.mockResolvedValue({
      connected: true,
      siteUrl: 'https://acme.atlassian.net',
      email: 'alice@example.com',
    });

    render(<App />);
    await screen.findByText(/welcome, alice anderson/i);

    expect(await screen.findByLabelText(/project key/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^create ticket$/i })).toBeInTheDocument();
  });

  it('hides the ticket creation form when Jira is disconnected', async () => {
    mockedRestore.mockResolvedValue(alice);
    mockedGetJira.mockResolvedValue({ connected: false });

    render(<App />);
    await screen.findByText(/welcome, alice anderson/i);
    await screen.findByText(/not connected to jira yet/i);

    expect(screen.queryByLabelText(/project key/i)).not.toBeInTheDocument();
  });

  it('hides the ticket creation form while the connection status is loading', async () => {
    mockedRestore.mockResolvedValue(alice);
    mockedGetJira.mockReturnValue(new Promise(() => {}));

    render(<App />);
    await screen.findByText(/welcome, alice anderson/i);

    expect(screen.queryByLabelText(/project key/i)).not.toBeInTheDocument();
  });

  it('hides the ticket creation form when the connection status fails to load', async () => {
    mockedRestore.mockResolvedValue(alice);
    mockedGetJira.mockRejectedValue(new JiraApiError('network', 'x'));

    render(<App />);
    await screen.findByText(/welcome, alice anderson/i);
    await screen.findByText(/unable to reach the server/i);

    expect(screen.queryByLabelText(/project key/i)).not.toBeInTheDocument();
  });
});

describe('recent-tickets panel', () => {
  async function renderConnected() {
    mockedRestore.mockResolvedValue(alice);
    mockedGetJira.mockResolvedValue({
      connected: true,
      siteUrl: 'https://acme.atlassian.net',
      email: 'alice@example.com',
    });
    render(<App />);
    await screen.findByLabelText(/project key/i);
  }

  it('shows the recent-tickets panel when Jira is connected', async () => {
    await renderConnected();

    expect(screen.getByRole('heading', { name: /recent tickets/i })).toBeInTheDocument();
  });

  it('shows the prompt state when no project key is entered', async () => {
    await renderConnected();

    expect(screen.getByText(/enter a jira project key/i)).toBeInTheDocument();
    expect(mockedListRecentTickets).not.toHaveBeenCalled();
  });

  it('hides the recent-tickets panel when Jira is disconnected', async () => {
    mockedRestore.mockResolvedValue(alice);
    mockedGetJira.mockResolvedValue({ connected: false });

    render(<App />);
    await screen.findByText(/not connected to jira yet/i);

    expect(screen.queryByText(/recent tickets/i)).not.toBeInTheDocument();
  });
});

describe('ticket creation refreshes recent tickets', () => {
  it('calls listRecentTickets after a successful ticket creation', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    mockedRestore.mockResolvedValue(alice);
    mockedGetJira.mockResolvedValue({
      connected: true,
      siteUrl: 'https://acme.atlassian.net',
      email: 'alice@example.com',
    });
    mockedCreateTicket.mockResolvedValue({ issueId: '10001', issueKey: 'SCRUM-1' } as CreatedTicket);
    mockedListRecentTickets.mockResolvedValue({ tickets: [] });

    render(<App />);
    await screen.findByLabelText(/project key/i);

    typeInto(/project key/i, 'SCRUM');
    typeInto(/title/i, 'Test ticket');
    typeInto(/description/i, 'Test description');
    fireEvent.click(screen.getByRole('button', { name: /^create ticket$/i }));

    await screen.findByRole('status');

    await waitFor(() => {
      expect(mockedListRecentTickets).toHaveBeenCalledWith('SCRUM', expect.anything());
    });

    vi.useRealTimers();
  });

  it('does not call listRecentTickets after a failed ticket creation', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    mockedRestore.mockResolvedValue(alice);
    mockedGetJira.mockResolvedValue({
      connected: true,
      siteUrl: 'https://acme.atlassian.net',
      email: 'alice@example.com',
    });
    mockedCreateTicket.mockRejectedValue(new TicketApiError('not_connected', 'x'));

    render(<App />);
    await screen.findByLabelText(/project key/i);

    typeInto(/project key/i, 'SCRUM');
    typeInto(/title/i, 'Test ticket');
    typeInto(/description/i, 'Test description');
    fireEvent.click(screen.getByRole('button', { name: /^create ticket$/i }));

    await screen.findByRole('alert');

    // listRecentTickets should not have been called beyond initial debounce behavior.
    // Since there's an active valid key, it may be called by the debounce but NOT by
    // the failed creation trigger.
    const callCountAfterFailure = mockedListRecentTickets.mock.calls.length;

    // Wait a bit to confirm no extra call from the failure.
    await new Promise<void>((r) => setTimeout(r, 100));
    expect(mockedListRecentTickets.mock.calls.length).toBe(callCountAfterFailure);

    vi.useRealTimers();
  });
});

describe('connection save refreshes recent tickets', () => {
  const connectedJira = {
    connected: true as const,
    siteUrl: 'https://acme.atlassian.net',
    email: 'alice@example.com',
  };

  async function renderConnectedWithProject() {
    mockedRestore.mockResolvedValue(alice);
    mockedGetJira.mockResolvedValue(connectedJira);
    mockedListRecentTickets.mockResolvedValue({ tickets: [] });
    render(<App />);
    await screen.findByLabelText(/project key/i);

    typeInto(/project key/i, 'SCRUM');
    await act(async () => { vi.advanceTimersByTime(600); });
  }

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('calls listRecentTickets after a successful connection replacement', async () => {
    await renderConnectedWithProject();
    const callsBefore = mockedListRecentTickets.mock.calls.length;

    mockedSaveJira.mockResolvedValue({
      connected: true,
      siteUrl: 'https://new.atlassian.net',
      email: 'alice@example.com',
    });

    fireEvent.click(screen.getByRole('button', { name: /replace connection/i }));
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

    await waitFor(() => {
      expect(mockedListRecentTickets.mock.calls.length).toBeGreaterThan(callsBefore);
    });
  });

  it('does not call listRecentTickets after a failed connection replacement', async () => {
    await renderConnectedWithProject();

    mockedSaveJira.mockRejectedValue(new JiraApiError('credentials_rejected', 'x'));

    fireEvent.click(screen.getByRole('button', { name: /replace connection/i }));
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

    const callsAfterFailure = mockedListRecentTickets.mock.calls.length;
    await new Promise<void>((r) => setTimeout(r, 100));
    expect(mockedListRecentTickets.mock.calls.length).toBe(callsAfterFailure);
  });
});

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
