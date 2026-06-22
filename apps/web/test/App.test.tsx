import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App';
import { AuthError, login, logout, restoreSession, type SafeUser } from '../src/api/auth';
import { getJiraConnection, JiraApiError } from '../src/api/jira';

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

const mockedRestore = vi.mocked(restoreSession);
const mockedLogin = vi.mocked(login);
const mockedLogout = vi.mocked(logout);
const mockedGetJira = vi.mocked(getJiraConnection);

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
