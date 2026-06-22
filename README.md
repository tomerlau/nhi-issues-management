# NHI Issues Management

A focused proof of concept for integrating Oasis Security IdentityHub with Jira.

This repository is built in milestones. The current milestone (Milestone 6)
adds the **Jira connection UI**: inside the authenticated application shell an
authenticated user can view, create, and replace the tenant-wide Jira connection
introduced by the Milestone 5 backend. The UI shows the shared connection status,
explains that the connection is shared by everyone in the tenant, displays only
the safe site URL and Atlassian email, and lets any tenant user replace the
shared connection. The Atlassian API token is entered through an uncontrolled
secret input, exists only transiently during submission, is cleared immediately
when an actual POST request begins, and is never stored in React state or any
browser storage.

Earlier milestones added backend-only application authentication (globally
unique user emails, Argon2id-hashed passwords, persistent server-side sessions,
secure session cookies, and reusable authentication middleware), the
authenticated frontend application shell (initial session restoration, login and
logout, authenticated and unauthenticated states, loading states, and clear
authentication and network errors), and a backend-only Jira API-token connection
(a tenant-wide Jira Cloud connection validated against Jira before storage, with
the API token encrypted at rest and never returned to the frontend).

## Current milestone scope (Milestone 6: Jira connection UI)

Frontend only; it consumes the unchanged Milestone 5 backend contract
(`GET`/`POST /api/jira/connection`). No backend changes were made.

Implemented:

- A focused frontend Jira API module (`apps/web/src/api/jira.ts`) that calls the
  two relative `/api/jira/connection` endpoints over the Vite proxy with the
  same-origin session cookie. It defines safe connection-status types, loads the
  current connection, and creates or replaces it. It validates success bodies
  defensively (reading only the safe `connected`/`siteUrl`/`email` fields and
  ignoring any unexpected credential-shaped fields), parses only the structured
  `{ error: { code } }` envelope, and maps validation, credential, configuration,
  timeout, unreachable, network, authentication, and unexpected-server failures
  to distinct UI error kinds. It never logs requests, responses, credentials, or
  raw backend/Jira error text.
- A focused Jira connection panel (`apps/web/src/components/JiraConnectionPanel.tsx`)
  rendered inside the existing authenticated shell. It shows loading,
  disconnected, connected, and retryable load-error states; explains that the
  connection is shared by the whole tenant; displays only the safe site URL and
  email when connected; and lets any authenticated tenant user create or replace
  the shared connection. Internal user/tenant/connection IDs, account IDs, audit
  metadata, encrypted data, and credential material are never displayed.
- Strict API-token secret handling in the form: the token input is `type="password"`,
  uncontrolled, and read only via a DOM ref at submit time. The captured token is
  cleared from the input immediately when an actual POST request begins (before the
  HTTP response), is never placed in React state, props, context, or any browser
  storage, and is never retained for a retry — a second attempt requires
  re-entering the token. If client-side validation fails before a request is made,
  the uncontrolled input retains its value so the user can correct the other
  fields. `siteUrl` and `email` use ordinary React state.
- Submission behavior: duplicate submissions are prevented and controls are
  disabled while a save is in flight, with clear loading text. Empty fields are
  rejected client-side before any request (the backend remains the authoritative
  Jira URL security policy). Success updates the displayed safe status and shows
  whether the shared connection was created or replaced; a failure shows safe,
  category-specific copy, keeps the previous connection visible and active, and
  never implies it was removed.
- Frontend tests (Vitest + React Testing Library) covering the API module
  (endpoint paths/methods/body/credentials, response parsing, defensive handling
  of malformed bodies, and the full error-code mapping) and the panel (all
  states, successful initial connection and replacement, client validation,
  duplicate-submit prevention, every error category, retry after a load failure,
  preserved connection after a failed replacement, and the token secret-handling
  rules).

Explicitly **not** implemented in Milestone 6: any Jira project input,
discovery, validation, or dropdown; ticket creation or a recent-tickets view; a
reusable Jira backend client; a disconnect endpoint or button; OAuth / 3LO;
scoped API-token support; roles, permissions, or tenant-admin UI; API-key
functionality; browser credential persistence; global frontend state; and
routing.

## Current milestone scope (Milestone 5: Jira API-token connection)

Backend only. An authenticated application user connects a Jira Cloud account
for their tenant. The connection is a tenant-wide organization integration
shared by all users in the tenant. The flow validates the submitted credentials
against Jira before anything is stored, encrypts the API token at rest, and never
returns the token (or any credential material) to the frontend.

Implemented:

- `POST /api/jira/connection` and `GET /api/jira/connection`, both requiring the
  existing application session and both returning `Cache-Control: no-store`.
  `tenantId` and the acting `userId` come solely from the session; any
  client-supplied `tenantId`, `userId`, `configuredByUserId`, or `connectionId`
  in the request body is ignored.
- Strict Jira Cloud site-URL validation and SSRF protection: only normalized
  `https://<site>.atlassian.net` origins are accepted, and no network request is
  made until validation succeeds.
- A small, focused Jira credential verifier that calls
  `GET {siteUrl}/rest/api/3/myself` with Jira Cloud Basic authentication over an
  injectable HTTP transport, with an explicit timeout and no redirect following.
  The credential must be an **unscoped** Atlassian API token. Scoped API tokens
  are **not** supported: they must be sent to `https://api.atlassian.com/ex/jira/<cloudId>`
  rather than the direct `https://<site>.atlassian.net` origin this POC validates
  against, so a scoped token will fail verification here.
- AES-256-GCM encryption of the API token with a fresh random nonce and
  additional authenticated data bound to the credential type/version and the
  credential context `(tenantId, configuredByUserId)`, using an
  environment-provided 32-byte key.
- A `jira_connections` table with a composite foreign key from
  `(tenant_id, configured_by_user_id)` to `users(tenant_id, id)` and exactly one
  connection per tenant (`UNIQUE (tenant_id)`). Every read and write is scoped by
  tenant; `configured_by_user_id` is audit metadata recording the last successful
  configurer, not an authorization boundary.

Explicitly **not** implemented in Milestone 5: any frontend or Jira connection
UI; OAuth 2.0 / 3LO, client id/secret, callbacks, state, or token refresh; a
reusable Jira API client (owned by M7); Jira project discovery or validation;
ticket creation; a disconnect endpoint; and production KMS or key rotation.

## Current milestone scope (Milestone 4: Authenticated application shell)

Implemented:

- A focused frontend authentication API module (`apps/web/src/api/auth.ts`) that
  calls the three existing `/api/auth/*` endpoints over relative URLs, parses the
  structured backend error envelope safely, and distinguishes the normal
  unauthenticated session-restoration result (`user: null`) from invalid
  credentials, invalid input, network failure, and unexpected server failure. It
  relies exclusively on the HttpOnly session cookie and never reads, stores, or
  returns tokens.
- An explicit frontend authentication state model in `apps/web/src/App.tsx`
  (`restoring` → `authenticated` / `unauthenticated` / `restore_error`). On load
  the app calls `GET /api/auth/session`, shows a loading state, then renders the
  authenticated shell (HTTP 200 with a user) or the login screen (HTTP 200 with
  `user: null`). A network or unexpected server failure during restoration is
  shown as a retryable error and is **not** treated as logged out.
- A login screen (`apps/web/src/components/LoginForm.tsx`) with email and
  password inputs (`type="password"`), required-field validation, accessible
  labels and announced errors, disabled submission while pending (no duplicate
  submits), and a generic invalid-credentials message that never reveals whether
  an email exists. The password field is cleared after every completed attempt.
- A minimal authenticated shell (`apps/web/src/components/AuthenticatedShell.tsx`)
  showing the product name and the authenticated user's display name and email,
  with a logout action. A failed logout keeps the user authenticated and shows a
  retryable error rather than pretending the session was revoked. Internal user
  and tenant IDs are never rendered.
- Frontend tests (Vitest + React Testing Library) covering session restoration,
  login, logout, error handling, duplicate-submit prevention, and the exact
  endpoint methods, paths, and request bodies.

Carried over from earlier milestones:

- Backend-only cookie authentication: `POST /api/auth/login`,
  `GET /api/auth/session`, `POST /api/auth/logout`, Argon2id password hashing,
  and SQLite-backed sessions storing only the SHA-256 hash of an opaque 256-bit
  token. M4 includes one focused M3 contract correction: session restoration now
  returns HTTP 200 with `{ user: null }` for the normal unauthenticated case
  instead of HTTP 401. Login and logout behavior are unchanged, and genuine
  protected routes still return HTTP 401 when unauthenticated.
- npm-workspaces monorepo with separate `apps/api` (backend) and `apps/web` (frontend).
- SQLite persistence using the built-in Node.js 24 `node:sqlite` module (no ORM, no external SQLite library).
- Versioned, transactional, idempotent SQL migrations run by a minimal in-repo migration runner.
- Per-connection foreign-key enforcement (`PRAGMA foreign_keys = ON`), verified by the database factory.
- Tenant-scoped repositories: every tenant-owned user read/write requires the owning `tenantId`.
- Express backend exposing `GET /api/health` (unchanged; unauthenticated and not touching the database).
- Quality gates (ESLint, strict typecheck, Vitest, build) and GitHub Actions CI.

Explicitly **not** implemented in Milestone 4 (deferred to later work):

- User registration, password reset or change, SSO, or social login.
- Roles, permissions, API keys, tenant selection, or tenant administration.
- Frontend routing, a global state library, a design system, or a generic API client.
- Rate limiting, account lockout, or other abuse protections.
- Redis or distributed session storage; sessions are single-instance SQLite.
- Jira UI, Jira OAuth, Jira API access, or ticket creation.

## Prerequisites

- **Node.js 24** (see `.nvmrc`). With `nvm`, run `nvm use`.
- npm 10+ (bundled with Node.js 24).

## Clean-clone setup

No environment file and no external database service are required. The database
is a local SQLite file created on demand; a clean clone works with only Node.js.

```bash
git clone https://github.com/tomerlau/nhi-issues-management.git
cd nhi-issues-management
nvm use            # or otherwise ensure Node.js 24 is active
npm ci
npm run dev        # runs migrations on startup, then serves both apps
```

To populate the demo tenants and users:

```bash
npm run seed       # idempotent; safe to run repeatedly
```

## Development

`npm run dev` starts both applications together:

- Frontend: http://localhost:5173
- Backend: http://localhost:3001
- Health endpoint: http://localhost:3001/api/health (or http://localhost:5173/api/health through the proxy)

`GET /api/health` returns HTTP 200 with exactly `{ "status": "ok" }`. The health
endpoint remains available for backend liveness checks; the frontend no longer
renders a health screen.

Open http://localhost:5173 and the app first restores any existing session, then
shows either the authenticated shell or the login screen. Seed the demo users
(`npm run seed`) and sign in with one of the demo accounts below. See
[Browser-based authentication workflow](#browser-based-authentication-workflow)
and [Manual validation](#manual-validation) for the full flow.

On startup the backend opens the SQLite database, enables and verifies
foreign-key enforcement, applies any pending migrations, and only then starts
listening. The database is closed during graceful shutdown (SIGINT/SIGTERM).

## Persistence (SQLite)

The backend persists data in a local SQLite database using the built-in
Node.js 24 `node:sqlite` module. There is no external database service, no ORM,
and no external SQLite dependency.

- **Default location:** `apps/api/data/app.db` (created on first run; the
  `apps/api/data/` directory and `*.db` / `-wal` / `-shm` files are git-ignored).
- **`DATABASE_PATH`:** optional environment variable overriding the location.
  Set it to a file path, or to the literal `:memory:` for an ephemeral database.
  Tests always use isolated in-memory or temporary databases and never touch the
  default development database.

Commands (run from the repository root):

```bash
npm run migrate    # apply pending migrations to the resolved database
npm run seed       # run migrations, then insert demo data (idempotent)
```

### Schema

- `tenants(id, name, created_at)` — a tenant is an isolation boundary.
- `users(id, tenant_id, email, display_name, created_at)` — each user belongs to
  exactly one tenant. `tenant_id` references `tenants(id)`, `email` is **globally
  unique**, and `(tenant_id, id)` is unique so authentication tables can
  reference a user by tenant and id together.
- `user_credentials(user_id, tenant_id, password_hash, created_at)` — password
  hashes, stored apart from the user record and referenced by a composite
  `(tenant_id, user_id)` foreign key.
- `sessions(token_hash, tenant_id, user_id, created_at, expires_at)` — server-side
  sessions storing only the SHA-256 hash of the session token.
- `jira_connections(id, tenant_id, configured_by_user_id, site_url, email, account_id, encrypted_token, created_at, updated_at)` —
  exactly one tenant-wide Jira Cloud connection per tenant (enforced by
  `UNIQUE (tenant_id)` and a composite foreign key from
  `(tenant_id, configured_by_user_id)` into `users(tenant_id, id)`). The
  connection is shared by all users in the tenant; `configured_by_user_id`
  records the last successful configurer for audit only. The API token is stored
  only as an AES-256-GCM encrypted, versioned value.

All tables are SQLite `STRICT` tables. Repositories enforce tenant scope: every
normal user query requires the owning `tenantId`, so a user can never be read
through another tenant's context. The single deliberate exception is a global
find-by-email lookup used only at login, where the tenant is derived from the
matched user.

### Demo data

`npm run seed` creates exactly two tenants and their demo users with fixed,
readable IDs and deterministic, documented demo passwords (idempotent — safe to
run repeatedly):

| Tenant          | Name        | User ID             | Email                      | Demo password       |
| --------------- | ----------- | ------------------- | -------------------------- | ------------------- |
| `tenant-acme`   | Acme Corp   | `user-acme-alice`   | `alice@example.com`        | `acme-alice-demo`   |
| `tenant-acme`   | Acme Corp   | `user-acme-bob`     | `bob@example.com`          | `acme-bob-demo`     |
| `tenant-globex` | Globex Corp | `user-globex-alice` | `alice@globex.example.com` | `globex-alice-demo` |

These are public test credentials for the local POC only. The database stores
just the Argon2id hash of each password, never the plaintext.

## Authentication

Authentication is backend-only and cookie-based. Login accepts only an email and
password; the backend derives the user and tenant from the stored user record,
and clients never provide or override `userId` or `tenantId` after login.

| Method & path           | Auth required | Purpose                                                  |
| ----------------------- | ------------- | -------------------------------------------------------- |
| `POST /api/auth/login`  | no            | Verify credentials, create a session, set cookie.        |
| `GET /api/auth/session` | no            | Return the authenticated user, or `user: null` if none.  |
| `POST /api/auth/logout` | no            | Revoke the current session and clear the cookie.         |

All three responses include `Cache-Control: no-store`.

**Login** — request body:

```json
{ "email": "alice@example.com", "password": "acme-alice-demo" }
```

Success (HTTP 200) returns only safe user fields and sets the session cookie:

```json
{ "user": { "id": "user-acme-alice", "tenantId": "tenant-acme", "email": "alice@example.com", "displayName": "Alice Anderson" } }
```

Invalid credentials (unknown email, wrong password, or a user without a
credential record) all return the same generic HTTP 401, so a client cannot tell
whether an email exists:

```json
{ "error": { "code": "invalid_credentials", "message": "Invalid email or password." } }
```

Missing or malformed input (non-string fields, empty values, or values over the
length limits) returns a structured HTTP 400 with code `invalid_request`.

**Session** — `GET /api/auth/session` always returns HTTP 200. It returns
`{ "user": <safe user> }` when the session cookie is valid, and `{ "user": null }`
when the cookie is missing, invalid, expired, or revoked. Restoring an
unauthenticated session is a normal application state, not a request failure, so
it deliberately does **not** return 401 (which would surface as a console error
on initial load). Genuine protected routes still return HTTP 401 when
unauthenticated, and invalid login credentials still return HTTP 401.

**Logout** — `POST /api/auth/logout` deletes the current session (if any), clears
the cookie, and is idempotent. It never affects other concurrent sessions.

### Cookie-based local workflow

The session cookie is `nhi_session`, set with `HttpOnly`, `SameSite=Lax`,
`Path=/`, and a `Max-Age` matching the eight-hour session lifetime. `Secure` is
enabled when `NODE_ENV=production` and disabled for local HTTP development. The
raw token lives only in the cookie; only its SHA-256 hash is stored server-side.
Because sessions are persisted in SQLite, a session survives an API restart as
long as the same database file is used. See
[Manual validation](#manual-validation) for end-to-end `curl` examples.

### Browser-based authentication workflow

The frontend (`apps/web`) provides the user-facing authentication experience and
talks to the backend only over relative `/api/auth/*` requests through the Vite
dev proxy. It holds no tokens of its own — the browser sends the HttpOnly
`nhi_session` cookie automatically, and the cookie is not readable from
JavaScript.

1. On load the app calls `GET /api/auth/session` and shows a brief loading state.
   - HTTP 200 with a user → the authenticated shell (display name, email, sign-out).
   - HTTP 200 with `user: null` → the login screen (no console error, because this
     normal unauthenticated state is not a failed request).
   - A network or unexpected server error → a retryable "couldn't verify your
     session" message, **not** the login screen.
2. Signing in posts the email and password to `POST /api/auth/login`. Invalid
   credentials show a single generic message; the password field is cleared after
   every attempt and is never persisted.
3. A page refresh re-runs step 1, so a valid session is restored automatically
   and a logged-out browser stays on the login screen.
4. Signing out posts to `POST /api/auth/logout` and returns to the login screen.
   If logout fails (network/server), the app keeps you signed in and shows a
   retryable error rather than pretending the session ended.

Log in with one of the [demo accounts](#demo-data), e.g. `alice@example.com` /
`acme-alice-demo`.

## Jira connection (Milestone 5)

An authenticated user connects a Jira Cloud account for their tenant. The
connection is a **tenant-wide organization integration shared by all users in
the tenant**: any authenticated tenant user can read its safe status and any of
them can create or replace the single shared connection. Users in other tenants
can never read, use, or replace it. The backend validates the credentials against
Jira before storing anything, encrypts the API token at rest, and never returns
the token to any client.

| Method & path              | Auth required | Purpose                                          |
| -------------------------- | ------------- | ------------------------------------------------ |
| `POST /api/jira/connection`| yes (cookie)  | Validate Jira credentials, create or replace the tenant connection. |
| `GET /api/jira/connection` | yes (cookie)  | Return safe connection status for the tenant.    |

Both responses include `Cache-Control: no-store`. `tenantId` and the acting
`userId` are derived from the session only; any client-supplied `tenantId`,
`userId`, `configuredByUserId`, or `connectionId` in the request body is ignored.
`configured_by_user_id` records the last user who successfully configured the
connection for audit only; it is not an authorization boundary, so any tenant
user may replace the connection. (Restricting this to authorized tenant
administrators is the documented production alternative; allowing every tenant
user keeps roles and tenant administration out of this POC.)

### Setup: encryption key

The Jira API token is encrypted with AES-256-GCM using an environment-provided
key, `JIRA_CREDENTIAL_ENCRYPTION_KEY`, a base64 value decoding to exactly 32
bytes. Generate one with Node.js:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

Copy `apps/api/.env.example` to `apps/api/.env` and set the value. The API loads
`apps/api/.env` on startup (built-in Node.js loader, no `dotenv` dependency).

- **Missing key:** health, login, logout, and session restoration keep working;
  the Jira connection endpoints return HTTP 503 `jira_not_configured`.
- **Malformed key** (present but not 32 bytes after decoding): startup fails with
  a sanitized configuration error. The key value is never logged.

### Endpoint contracts

`POST /api/jira/connection` request body:

```json
{
  "siteUrl": "https://your-site.atlassian.net",
  "email": "you@example.com",
  "apiToken": "your-atlassian-api-token"
}
```

Success (HTTP 200, for both first connection and reconnection):

```json
{ "connected": true, "siteUrl": "https://your-site.atlassian.net", "email": "you@example.com" }
```

`GET /api/jira/connection` returns either `{ "connected": false }` or the same
connected shape above. No endpoint ever returns the API token, the encrypted
token, encryption metadata, authorization headers, raw Jira responses, or the
Jira account id.

### Safe error behavior

| Condition                                          | Status | Code                        |
| -------------------------------------------------- | ------ | --------------------------- |
| Invalid request input or invalid/unsafe site URL   | 400    | `invalid_request`           |
| Missing application session                        | 401    | `unauthenticated`           |
| Jira rejected the credentials                      | 422    | `jira_credentials_rejected` |
| Jira unreachable / invalid response / upstream error | 502  | `jira_unreachable`          |
| Jira request timed out                             | 504    | `jira_timeout`              |
| Encryption key not configured                      | 503    | `jira_not_configured`       |

Error responses never include raw Jira bodies, stack traces, tokens, the
email/token combination, or internal exception messages. A failed validation or
failed replacement never deletes or overwrites an existing valid connection.

### Site URL rules (SSRF protection)

Only direct, normalized `https://<site>.atlassian.net` URLs are accepted. The
following are rejected before any network call: HTTP, non-Atlassian hosts,
deceptive suffixes (`x.atlassian.net.attacker.com`), bare `atlassian.net`,
embedded credentials, explicit ports, any path other than `/`, query strings,
fragments, IP addresses, `localhost`, multi-label hosts, and malformed URLs.

### Manual Jira validation

These steps require a real Jira Cloud site, account email, and an **unscoped**
[API token](https://id.atlassian.com/manage-profile/security/api-tokens) (create
the token without selecting any scopes). Scoped tokens are not supported by this
POC, because they target `https://api.atlassian.com/ex/jira/<cloudId>` instead of
the direct site origin. Run them yourself to reproduce the validation end to end.

These steps exercise the tenant-wide sharing model. They use two Acme users
(Alice and Bob) and one Globex user, each with its own cookie jar. A real Jira
connection (step 4 onward) requires real credentials; the sharing, replacement,
and isolation behavior can otherwise be reasoned about from the responses.

What to confirm:

- **Alice connects Jira for Acme.** `POST` as Alice returns HTTP 200 `connected`.
- **Bob sees the same connection.** `GET` as Bob (another Acme user) returns the
  identical `siteUrl`/`email` — the connection is shared, not per-user.
- **Bob replaces it and Alice sees the replacement.** `POST` as Bob returns
  HTTP 200; a subsequent `GET` as Alice shows Bob's new `siteUrl`/`email`.
- **Bob's failed replacement preserves the active connection.** A `POST` as Bob
  with an invalid token returns HTTP 422 and leaves the stored row — including
  `configured_by_user_id` and timestamps — completely unchanged.
- **Globex remains isolated and can create its own connection.** A `GET` as the
  Globex user returns `{ "connected": false }` while Acme is connected, and a
  `POST` as Globex creates an independent second row.
- **At most one row per tenant.** The database holds a single
  `jira_connections` row per tenant.
- **`configured_by_user_id` identifies the last successful configurer** (Alice,
  then Bob after his successful replacement) and is audit-only.
- **No plaintext token leaks** into responses, logs, database fields, generated
  files, frontend-visible data, source control, or `git status`.

```bash
# 1. Generate and export a key, then start the API with Jira configured.
export JIRA_CREDENTIAL_ENCRYPTION_KEY="$(node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))")"
npm run dev --workspace apps/api

# 2. Log in as two Acme users and one Globex user, each with its own cookie jar.
curl -s -c alice.cookies -X POST http://localhost:3001/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"alice@example.com","password":"acme-alice-demo"}' > /dev/null
curl -s -c bob.cookies -X POST http://localhost:3001/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"bob@example.com","password":"acme-bob-demo"}' > /dev/null
curl -s -c globex.cookies -X POST http://localhost:3001/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"alice@globex.example.com","password":"globex-alice-demo"}' > /dev/null

# 3. Both Acme users start disconnected.
curl -s -b alice.cookies http://localhost:3001/api/jira/connection   # {"connected":false}
curl -s -b bob.cookies   http://localhost:3001/api/jira/connection   # {"connected":false}

# 4. Alice connects for Acme (replace placeholders with real credentials).
curl -i -b alice.cookies -X POST http://localhost:3001/api/jira/connection \
  -H 'Content-Type: application/json' \
  -d '{"siteUrl":"https://your-site.atlassian.net","email":"alice@example.com","apiToken":"REAL_TOKEN"}'

# 5. Bob, another Acme user, sees the SAME shared connection.
curl -s -b bob.cookies http://localhost:3001/api/jira/connection

# 6. Bob replaces it; Alice then sees Bob's replacement.
curl -i -b bob.cookies -X POST http://localhost:3001/api/jira/connection \
  -H 'Content-Type: application/json' \
  -d '{"siteUrl":"https://your-other-site.atlassian.net","email":"bob@example.com","apiToken":"REAL_TOKEN"}'
curl -s -b alice.cookies http://localhost:3001/api/jira/connection

# 7. Bob's failed replacement (invalid token) -> 422, active connection preserved.
curl -i -b bob.cookies -X POST http://localhost:3001/api/jira/connection \
  -H 'Content-Type: application/json' \
  -d '{"siteUrl":"https://your-other-site.atlassian.net","email":"bob@example.com","apiToken":"WRONG"}'

# 8. Globex is isolated; it sees nothing of Acme and creates its own connection.
curl -s -b globex.cookies http://localhost:3001/api/jira/connection   # {"connected":false}
curl -i -b globex.cookies -X POST http://localhost:3001/api/jira/connection \
  -H 'Content-Type: application/json' \
  -d '{"siteUrl":"https://globex-site.atlassian.net","email":"alice@globex.example.com","apiToken":"REAL_TOKEN"}'

# 9. Invalid site URL -> 400 with no outbound request.
curl -i -b alice.cookies -X POST http://localhost:3001/api/jira/connection \
  -H 'Content-Type: application/json' \
  -d '{"siteUrl":"http://evil.example.com","email":"alice@example.com","apiToken":"REAL_TOKEN"}'
```

Confirm exactly one row per tenant, audit metadata, and that no token leaks:

```bash
# One row per tenant; configured_by_user_id is the last successful configurer;
# the stored token starts with the version prefix (v1.) and is never the plaintext.
sqlite3 apps/api/data/app.db \
  'SELECT tenant_id, configured_by_user_id, site_url, email, substr(encrypted_token,1,3) FROM jira_connections;'
```

The plaintext token must not appear in API logs, API responses, frontend state,
generated files, the database token field, or `git status`.

## Jira connection UI (Milestone 6)

The authenticated application shell now includes a Jira connection panel
(`apps/web/src/components/JiraConnectionPanel.tsx`) backed by a focused frontend
API module (`apps/web/src/api/jira.ts`). It is the user-facing view of the
tenant-wide Milestone 5 backend connection and adds no backend behavior.

On mount the panel calls `GET /api/jira/connection` and renders one of four
states:

- **Loading** while the status request is in flight.
- **Disconnected** — explains that the connection is shared by the whole tenant
  and shows the connection form (Jira Cloud site URL, Atlassian account email,
  and an unscoped Atlassian API token), with the expected
  `https://<site>.atlassian.net` URL format made explicit.
- **Connected** — shows that the tenant is connected, displays only the safe site
  URL and Atlassian email returned by the backend, restates that the connection
  is shared by the tenant, and offers a **Replace connection** action. Internal
  IDs, account IDs, audit metadata, encrypted data, and credential material are
  never shown.
- **Retryable load error** — a safe message with a **Try again** action when the
  status cannot be loaded.

Creating or replacing the connection posts to `POST /api/jira/connection`.
Duplicate submissions are prevented and the controls are disabled while the
request is in flight. Empty fields are rejected client-side before any request;
the backend remains the authoritative Jira URL security policy. On success the
panel updates the displayed safe status and reports whether the shared connection
was created or replaced. On failure it shows safe, category-specific copy
(invalid input, rejected credentials, server not configured, timeout,
unreachable, network failure, expired session, or a generic retryable error),
keeps any existing connection visible and active, and never implies it was
removed. Raw backend messages and credential material are never rendered.

### How the API token is handled in the browser

The Atlassian API token is treated as a secret in the form:

- The token input is `type="password"` and **uncontrolled** — it is never bound
  to React state.
- The token is read only at submission time via a DOM ref. The input is **cleared
  immediately when an actual POST request begins**, before the HTTP response
  resolves. If client-side required-field validation fails before a request is
  made, the uncontrolled input retains its value so the user can correct the
  other fields.
- The token exists only transiently in the local submit call and the outgoing
  request body. It is never stored in React state, context, props, a store, or
  any browser storage (`localStorage`, `sessionStorage`, IndexedDB, cookies),
  and is never placed in URLs, logs, errors, analytics, or rendered output.
- The token is never retained for a retry, and a request carrying a token is
  never retried automatically: a completed POST attempt (successful or failed)
  requires re-entering the token.
- `siteUrl` and `email` use ordinary local React state.
- The Jira fields are kept independent of the application login form so a browser
  password manager does not autofill them: the form carries `autocomplete="off"`,
  the inputs use Jira-specific names (`jiraSiteUrl`, `jiraAccountEmail`,
  `jiraApiToken`), the email input is `type="text"` with `inputMode="email"` plus
  `autoComplete="off"`/`autoCapitalize="none"`/`spellCheck=false`, and the token
  input uses `autoComplete="new-password"`. No Jira field value is ever derived
  from the authenticated application user.

It is expected that the submitted token is present transiently in the outgoing
request body, which is visible to the user who owns the browser session; the
application does not and cannot hide it from that user. Local development accesses
the frontend and API through `localhost` over plain HTTP, so the local request is
**not** protected by TLS. Any non-local or production deployment must use
HTTPS/TLS so the token is not exposed in transit.

### Manual validation: Jira connection UI (Milestone 6)

With both apps running (`npm run dev`), the demo users seeded (`npm run seed`),
and the encryption key configured (see
[Setup: encryption key](#setup-encryption-key)), exercise the UI at
http://localhost:5173. Steps 1, the happy path, and the replacement steps require
a real Jira Cloud site, account email, and **unscoped** API token.

1. **Happy path.** Sign in as Alice (`alice@example.com` / `acme-alice-demo`).
   The Jira panel loads the **disconnected** state. Enter a valid Jira site URL,
   Atlassian email, and unscoped API token, and connect. Confirm the panel shows
   the **connected** state with the safe site URL and email only.
   - **Autofill independence.** With the application login credentials saved in
     Chrome's password manager, open or reload the Jira connection form and
     confirm all three Jira fields stay empty — the saved application password
     must not be inserted into the API-token field, and the email field must not
     be prefilled with the signed-in user. Then enter valid Jira credentials
     manually and confirm the connection still succeeds.
2. **Same-tenant sharing.** In a separate browser profile or private window, sign
   in as Bob (`bob@example.com` / `acme-bob-demo`). Confirm Bob sees the same
   shared connection. Replace it as Bob, then refresh as Alice and confirm she
   sees Bob's replacement.
3. **Failed replacement.** As any Acme user, click **Replace connection** and
   submit with an invalid token. Confirm an error appears, the previous
   connection stays visible and labelled connected, and the token field is empty
   and must be entered again.
4. **Cross-tenant isolation.** Sign in as the Globex user
   (`alice@globex.example.com` / `globex-alice-demo`) separately. Confirm the
   Acme connection is not visible and Globex has its own independent
   disconnected/connected state.
5. **Failure paths.** Exercise, where practical: an invalid URL/input (HTTP, a
   non-Atlassian host) → check-your-input copy; rejected credentials; a missing
   server encryption key (start the API without `JIRA_CREDENTIAL_ENCRYPTION_KEY`)
   → "not configured" copy; Jira timeout/unavailable behavior; an
   application-server network failure (stop the API) → "unable to reach the
   server" copy; and a status-load failure with the **Try again** retry.
6. **Secret verification.** Using browser DevTools, confirm the token does not
   appear in `localStorage`, `sessionStorage`, IndexedDB, cookies, the rendered
   DOM after submission, API responses, or the console; and confirm it is absent
   from application logs, the database token field, generated files, and
   `git status`. It is expected that the submitted token appears transiently in
   the outgoing request body visible to the browser's own user. Note that local
   development accesses the frontend and API through `localhost` over plain HTTP,
   so the local request is not protected by TLS; any non-local or production
   deployment must use HTTPS/TLS.
7. **Regression.** Confirm session restoration on refresh, login, logout success,
   and logout-failure behavior (stop the API, sign out → retryable error, stays
   signed in) all continue to work with the panel mounted.

## Manual validation

These commands exercise the full authentication flow locally. They assume the
API is reachable at `http://localhost:3001` (the default `npm run dev` port).

Reset to a clean local database, then migrate and seed:

```bash
# Remove any existing development database (the data/ directory is git-ignored).
rm -f apps/api/data/app.db apps/api/data/app.db-wal apps/api/data/app.db-shm
npm run migrate      # apply migrations to the resolved database
npm run seed         # insert demo tenants, users, and credentials (idempotent)
```

Start the API (in a separate terminal):

```bash
npm run dev --workspace apps/api
```

Log in and save the cookie to a jar, then read the session and log out:

```bash
# Log in (stores the nhi_session cookie in alice.cookies).
curl -i -c alice.cookies -X POST http://localhost:3001/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"alice@example.com","password":"acme-alice-demo"}'

# Read the authenticated session using the saved cookie.
curl -i -b alice.cookies http://localhost:3001/api/auth/session

# Log out (revokes only this session and clears the cookie).
curl -i -b alice.cookies -c alice.cookies -X POST http://localhost:3001/api/auth/logout

# Afterwards the session is gone (HTTP 200 with {"user":null}).
curl -i -b alice.cookies http://localhost:3001/api/auth/session
```

Two users with separate cookie jars remain authenticated independently:

```bash
curl -s -c bob.cookies -X POST http://localhost:3001/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"bob@example.com","password":"acme-bob-demo"}' > /dev/null
curl -s -c globex.cookies -X POST http://localhost:3001/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"alice@globex.example.com","password":"globex-alice-demo"}' > /dev/null

curl -s -b bob.cookies http://localhost:3001/api/auth/session       # Acme / Bob
curl -s -b globex.cookies http://localhost:3001/api/auth/session    # Globex / Alice
```

### Browser checklist

With both apps running (`npm run dev`) and the demo users seeded, exercise the
frontend at http://localhost:5173:

- **Clean startup:** reset/migrate/seed as above, start `npm run dev`, open the
  app — it shows the login screen.
- **Login:** sign in with a valid demo account (e.g. `alice@example.com` /
  `acme-alice-demo`); the shell shows the display name and email.
- **Refresh while signed in:** reload the page — the session is restored without
  re-entering credentials.
- **Logout:** click sign out — the app returns to the login screen.
- **Refresh after logout:** reload — the login screen stays; the user is not
  restored.
- **Invalid password:** sign in with a wrong password — a single generic
  "Invalid email or password" message appears (it does not reveal whether the
  email exists), and the password field is cleared.
- **Empty fields:** submit with empty email and/or password — an inline
  validation message appears and no request is sent.
- **Backend down during restoration:** stop the API, reload — a retryable
  "couldn't verify your session" error appears (not the login screen); restart
  the API and use **Try again**.
- **Backend down during login:** stop the API, attempt to sign in — a network
  error message appears and you remain on the login screen.
- **Backend down during logout:** while signed in, stop the API, click sign out —
  a retryable error appears and you stay signed in.
- **Two users, isolated:** sign in as `bob@example.com` / `acme-bob-demo` in one
  browser profile (or private window) and `alice@globex.example.com` /
  `globex-alice-demo` in another — each keeps its own session via its own cookie,
  and the two tenants (Acme, Globex) remain isolated.
- **DevTools verification:** in the browser DevTools confirm that
  `localStorage` and `sessionStorage` hold no session token or password, that no
  password is retained in the DOM after login, that the authenticated user comes
  only from the session response (there is no user/tenant selector to override),
  and that no token, password, or secret appears in network responses, the URL,
  or the console.

Inspect the database to confirm passwords are hashed and raw tokens are absent
(requires the `sqlite3` CLI; the application itself does not depend on it):

```bash
# Password hashes only — every value starts with the Argon2id PHC prefix ($argon2id$).
sqlite3 apps/api/data/app.db 'SELECT user_id, password_hash FROM user_credentials;'

# Sessions store only token hashes (64-char SHA-256 hex), never raw tokens.
sqlite3 apps/api/data/app.db 'SELECT token_hash, tenant_id, user_id, expires_at FROM sessions;'
```

The raw token printed in the login `Set-Cookie` header will not appear in the
`sessions` table. Neither the API logs nor any API response print password
hashes, session hashes, raw tokens, or the cookie value.

## Quality gate commands

Run from the repository root; each delegates to both workspaces:

```bash
npm run lint        # ESLint across both apps
npm run typecheck   # TypeScript strict typecheck for both apps
npm test            # Vitest unit tests for both apps
npm run migrate     # Apply pending SQLite migrations
npm run seed        # Migrate, then insert idempotent demo data
npm run build       # Build backend (tsc) and frontend (vite build)
npm run check       # All of the above (fail-fast) plus the workflow hook tests
```

`npm run check` runs lint, typecheck, all Vitest tests, the workflow hook tests,
and the build. It does not seed; `migrate` and `seed` are explicit, separate
commands.

## Claude Code workflow

This repository is built with Claude Code under a fixed, committed workflow.

- Start each milestone with the **start-milestone** skill. It updates `main`
  (fast-forward only) and creates one `milestone/<n>-<slug>` branch before any
  files are edited.
- One branch per milestone. Fix iterations stay on the existing milestone branch
  rather than opening a new one.
- Claude does not stage, commit, push, or manage pull requests. The developer
  reviews the changes and owns all commits, pushes, and PRs.
- Finish every implementation iteration with the **finish-work** skill, which
  inspects the diff and runs the full quality gate.
- `npm run check` is the canonical local quality gate (lint, typecheck, all
  tests including the workflow hook tests, then build).

What is committed vs. local:

- The project-level `.claude/settings.json`, `.claude/hooks/`, and
  `.claude/skills/` are intentionally committed — they define the shared
  workflow and its guardrails.
- Local-only Claude settings stay in `.claude/settings.local.json`, which is
  git-ignored and must not be committed.

A `PreToolUse` hook blocks file edits on `main`, `master`, or a detached HEAD,
and a `Stop` hook runs `npm run check` when there are local changes. Both are
enforced by Claude Code, not by this README.

## How the Vite proxy works

The frontend never calls the backend by absolute URL. It requests relative paths
such as `/api/auth/session`. In development, the Vite dev server
(`apps/web/vite.config.ts`) proxies any request beginning with `/api` to
`http://localhost:3001`. This keeps the browser talking only to the Vite origin,
so no permissive CORS configuration is required on the backend, and the
same-origin `nhi_session` cookie is sent automatically.

## Repository structure

```
/
├── apps/
│   ├── api/                 # Express + TypeScript backend
│   │   ├── migrations/      # numbered *.sql migration files
│   │   ├── src/
│   │   │   ├── app.ts       # Express application construction
│   │   │   ├── server.ts    # process startup, db init, listening
│   │   │   ├── config/      # database path, env loading, Jira key resolution
│   │   │   ├── database/    # connection factory, migrator, lifecycle, seed
│   │   │   ├── jira/        # Jira connection routes, verifier, token cipher
│   │   │   └── repositories/# tenant-scoped repositories (users, sessions, Jira)
│   │   └── test/            # backend Vitest tests
│   └── web/                 # React + Vite frontend
│       ├── src/
│       │   ├── api/         # typed backend API functions (auth)
│       │   ├── components/  # LoginForm, AuthenticatedShell
│       │   ├── App.tsx      # authentication state + shell
│       │   ├── styles.css   # minimal application styling
│       │   └── main.tsx     # React entry point
│       └── test/            # frontend Vitest tests
├── docs/
│   ├── architecture.md
│   └── assumptions.md
├── .github/workflows/ci.yml
├── .nvmrc
└── package.json             # npm workspaces + root scripts
```

## Further reading

- [docs/architecture.md](docs/architecture.md) — structure, separation, and request flow.
- [docs/assumptions.md](docs/assumptions.md) — project assumptions and production tradeoffs.
