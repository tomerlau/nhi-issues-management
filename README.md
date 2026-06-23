# NHI Issues Management

A focused proof of concept for integrating Oasis Security IdentityHub with Jira.

This repository is built in milestones. The current milestone (Milestone 12)
adds application-issued API-key authentication: an `api_keys` table, key
generation and verification, an Express middleware, and local CLI scripts to
provision and revoke keys. It builds on the existing session-based
authentication and AuthContext infrastructure.

Milestone 10 added a backend-only recent-tickets read: an authenticated
`GET /api/tickets?projectKey=...` endpoint that returns the ten most recent
tickets created through this application for the tenant's currently connected
Jira site and a selected project. Membership and order come from local
provenance; every displayed value (current key, title, creation time) is
hydrated live from Jira in fixed internal batches. It builds on the Milestone 8
ticket-creation provenance.

Milestone 9 added the frontend ticket-creation UI: an authenticated user whose
tenant is connected to Jira can create an NHI finding ticket from the application
shell. It is frontend only and consumes the unchanged Milestone 8
`POST /api/tickets` contract; no backend behavior changed.

Milestone 8 added a backend-only ticket-creation domain service: an
authenticated `POST /api/tickets` endpoint that creates a fixed-`Task` Jira Cloud
issue against the tenant's shared connection and records minimal local provenance
for the created issue. It builds on the Milestone 7 integration layer.

Milestone 7 added the backend-only Jira integration layer this builds on: one
central Jira client and a tenant-scoped integration service that validates a Jira
project against the authenticated tenant's shared connection. It also moved Jira
credential encryption to a tenant-only v2 format and deleted the older v1
connections.

Milestone 5 added the backend-only Jira API-token connection that this builds
on: an authenticated user connects a Jira Cloud account by submitting a site
URL, Atlassian email, and API token. The connection is a tenant-wide
organization integration shared by all users in the tenant. The credentials are
validated against Jira before storage, and the API token is encrypted at rest
and never returned to the frontend.

Earlier milestones added backend-only application authentication (globally
unique user emails, Argon2id-hashed passwords, persistent server-side sessions,
secure session cookies, and reusable authentication middleware), the
authenticated frontend application shell (initial session restoration, login and
logout, authenticated and unauthenticated states, loading states, and clear
authentication and network errors), a backend-only Jira API-token connection
(a tenant-wide Jira Cloud connection validated against Jira before storage, with
the API token encrypted at rest and never returned to the frontend), and the
frontend Jira connection UI (a tenant-wide connection panel in the authenticated
shell that views, creates, and replaces the shared connection while keeping the
Atlassian API token out of React state and browser storage).

## Earlier milestone scope (Milestone 6: Jira connection UI)

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

## Current milestone scope (Milestone 10: Recent tickets backend)

Backend only. Milestone 10 adds the first ticket read: an authenticated
`GET /api/tickets?projectKey=...` that returns the ten most recent tickets
created through this application for the authenticated tenant, the currently
connected Jira site, and a selected project.

Implemented:

- **`GET /api/tickets`** (`apps/api/src/jira/ticket-routes.ts`), session
  authenticated and returning `Cache-Control: no-store`. The only request input
  is the `projectKey` query parameter, validated and normalized (trim, uppercase)
  with the same conservative Jira project-key syntax and length used for ticket
  creation. A missing, empty, malformed, or repeated `projectKey` is a structured
  400 with no Jira call. No tenant, user, connection, site, credential, limit,
  cursor, or ownership value is ever read from the request.
- **A tenant-scoped batch read on the provenance repository**
  (`listRecentCandidates` in `ticket-provenance-repository.ts`). Every query is
  scoped to `tenant_id`, the currently connected `jira_site_url`, and the
  normalized `jira_project_key`; it is **not** filtered by `created_by_user_id`
  (two users in a tenant see the same tenant-owned tickets) and **not** by
  `jira_connection_id` (the site-URL snapshot is the visibility boundary).
  Ordering is stable (`created_at DESC, id DESC`) with internal keyset pagination,
  so concurrent inserts never shift or duplicate a page. Migration
  `007_jira_ticket_provenance_recent_index.sql` adds a forward-only, additive
  index matching this exact access pattern.
- **A `bulkFetchIssues` operation on the central Jira client** that performs one
  `POST /rest/api/3/issue/bulkfetch` per batch requesting only the minimal
  `summary`, `created`, and `project` fields. It identifies issues by their
  immutable Jira id, assumes no response order, runtime-validates the complete
  success response (a single malformed issue invalidates the whole response), and
  returns only sanitized outcomes. Issues Jira omits (deleted, moved away, or
  inaccessible) are simply absent; individual Jira issue errors are never read or
  exposed.
- **A recent-tickets domain service** (`recent-tickets-service.ts`) that loads the
  tenant connection exactly once through a narrowly-scoped helper
  (`jira-connection-loader.ts`), re-validates the site URL, decrypts the token
  just-in-time, and reuses one short-lived client and origin snapshot for every
  batch — so a concurrent connection replacement can never mix two Jira sites in
  one request. It loads local candidates in fixed internal batches of 25, hydrates
  each with one bulk fetch, skips absent and moved issues (current project key ≠
  selected), and stops at ten valid tickets or when candidates are exhausted.
  Every displayed value comes from the live Jira hydration; the `url` is built
  only from the validated current origin plus `/browse/` and the percent-encoded
  current key, never from a self/redirect/location URL.
- **Sanitized HTTP outcome mapping**: 200 with `{ tickets: [...] }` (an empty
  array when there are no valid results); 400 invalid input; 401 unauthenticated;
  409 not connected; 502 `jira_credentials_rejected` when the stored credentials
  are rejected, or 502 `jira_unreachable` for a malformed response / unavailable
  upstream; 503 not configured or credentials undecryptable; 504 timeout. No raw
  Jira content, tokens, or internal detail ever leak.

Explicitly **not** implemented in Milestone 10: any frontend or recent-tickets
UI; user-controlled pagination, limits, sorting, or filtering beyond the single
`projectKey`; editing, deleting, or transitioning issues; full-text search or
Jira project discovery; caching or background refresh of hydrated issues; cursors
or limits exposed in the request or response; and Jira Server / Data Center
support.

## Earlier milestone scope (Milestone 9: Ticket creation UI)

Frontend only; it consumes the unchanged Milestone 8 backend contract
(`POST /api/tickets`). No backend changes were made. Milestone 9 lets an
authenticated user whose tenant is connected to Jira create an NHI finding ticket
from the application shell.

Implemented:

- A focused frontend ticket API module (`apps/web/src/api/tickets.ts`) that posts
  the relative `/api/tickets` endpoint with the same-origin session cookie, sends
  exactly `projectKey`/`title`/`description`, defensively validates the success
  body, maps every documented backend error code (plus 401, network, and
  unexpected outcomes) to safe UI error kinds, never renders raw backend/Jira
  text, never logs, and never retries.
- A focused `TicketCreationPanel` component
  (`apps/web/src/components/TicketCreationPanel.tsx`) with accessible labels,
  `role="alert"`/`role="status"` feedback, client-side usability validation
  matching the documented limits, project-key normalization to uppercase on submit
  (the input preserves the casing the user types), disabled
  controls and duplicate-submit prevention while pending, clear success feedback
  including the returned issue key (clearing the title/description and keeping the
  project key), and a distinct uncertain-outcome warning advising the user to
  check Jira before retrying for every failure that can occur after the request
  leaves the browser (timeout, unreachable, network, and any unexpected server
  outcome), because ticket creation is not idempotent.
- Integration into the authenticated shell: `JiraConnectionPanel` reports the
  loaded connection state to `AuthenticatedShell` through a small callback, and the
  shell renders the ticket panel only when the tenant connection has loaded as
  connected — with no second connection-status request. Login, logout, session
  restoration, and the Jira connection flow are unchanged.
- Frontend tests (Vitest + React Testing Library) covering the ticket API module
  (path/method/headers/credentials/body, success parsing, malformed-body
  rejection, the full error-code mapping, 401/unknown-status/unknown-code
  fallbacks, network failure, raw-message suppression, and no automatic retry),
  the panel (connected rendering, validation, normalization, payload, loading and
  disabled controls, duplicate-submit prevention, success and field-clearing
  behavior, every error category, the uncertain-outcome warning, and accessible
  alert/status behavior), and the shell gating (ticket form appears only when
  connected; hidden while loading, on a load error, and when disconnected).

Explicitly **not** implemented in Milestone 9: any Jira project discovery,
search, or dropdown; issue-type selection or configurable issue types; Jira custom
fields; a recent-tickets list or endpoint integration; ticket links; ticket
editing, deletion, or transitions; webhook synchronization; external API-key
authentication or a REST API for external callers; routing or global frontend
state; and any later-milestone functionality.

## Earlier milestone scope (Milestone 8: Ticket creation domain service)

Backend only. Milestone 8 adds the first ticket-creation flow: an authenticated
user creates a fixed-`Task` Jira issue in a project against the tenant's shared
connection, and the application records local provenance for the created issue.

Implemented:

- **`POST /api/tickets`** (`apps/api/src/jira/ticket-routes.ts`), session
  authenticated and returning `Cache-Control: no-store`. It accepts only
  `projectKey`, `title`, and `description`; `tenantId` and the creating `userId`
  come solely from the session. Any client-supplied `tenantId`, `userId`,
  `connectionId`, `siteUrl`, `issueType`, or ownership field is ignored. The body
  is fully validated (project-key syntax and length, non-empty bounded title and
  description, internal line breaks preserved) before any Jira network request,
  with no validation framework.
- **A `createIssue` operation on the central Jira client** that performs
  `POST /rest/api/3/issue` with the fixed, non-subtask `Task` issue type resolved
  by Milestone 7, the validated canonical project id, the title as the summary,
  and the description rendered as a minimal ADF document preserving internal line
  breaks. It runtime-validates the response (non-empty issue id and key) and
  returns only sanitized outcomes; no raw Jira content leaks. It remains
  Jira-specific, not a general SDK.
- **A `createTicket` operation on the tenant-scoped integration service**
  (`jira-integration-service.ts`) that loads the connection once, re-validates the
  site URL, decrypts the token just-in-time, constructs a single short-lived
  client, and uses that **same** client and connection for both project validation
  and issue creation — so a concurrent connection replacement can never split the
  two. It returns the sanitized issue id/key plus the exact connection and project
  metadata used.
- **A ticket-creation domain service** (`ticket-service.ts`) and a focused
  provenance table (`jira_ticket_provenance`, migration
  `006_jira_ticket_provenance.sql`) plus repository. Provenance is inserted **only
  after** Jira confirms a successful creation; no pending row is written
  beforehand. The table stores only identifiers and an audit trail (provenance id,
  tenant id, creating user id, connection id, a site-URL snapshot, project id/key,
  issue id/key, local timestamp) — never the title, description, credentials, or
  any raw Jira response. Tenant-safe composite foreign keys and a
  `UNIQUE (tenant_id, jira_site_url, jira_issue_id)` constraint prevent duplicates.
- **Sanitized HTTP outcome mapping**: 201 on creation; 400 invalid input; 401
  unauthenticated; 409 not connected; 422 project inaccessible or `Task`
  unsupported; 502 `jira_credentials_rejected` when the stored credentials are
  rejected, or 502 `jira_unreachable` for an invalid response / unavailable
  upstream; 503 not configured or credentials undecryptable; 504 timeout; 500 on a
  provenance persistence failure. No raw Jira content, tokens, or internal detail
  ever leak.

Approved POC behavior: Jira creation and SQLite provenance persistence are
sequential and **not** a distributed transaction, so not every issue Jira creates
is guaranteed a local provenance row. If Jira confirms the creation but provenance
persistence fails, the result is `persistence_failed` (HTTP 500); if Jira may have
created the issue but the request times out before the response is read, the
result is a timeout (HTTP 504). In both cases the issue may exist in Jira while
remaining untracked locally. There is no idempotency key, durable operation
tracking, safe retry, reconciliation, compensating deletion, or worker/queue, so
an immediate retry after a timeout may create a duplicate issue.

Explicitly **not** implemented in Milestone 8: any frontend or ticket-creation
UI; a recent-tickets list or any read/query endpoint; editing, deleting, or
transitioning issues; external application API-key authentication; Jira project
discovery or search; configurable issue types, custom fields, labels, components,
or assignees; idempotency keys, retries, workers, queues, reconciliation,
compensating deletion, webhooks; and Jira Server / Data Center support.

## Earlier milestone scope (Milestone 7: Jira integration layer)

Backend only. Milestone 7 provides one secure abstraction for authenticated Jira
Cloud API access using the authenticated tenant's shared connection.

Implemented:

- **A central Jira client** (`apps/api/src/jira/jira-client.ts`) that owns all
  Jira HTTP behavior: it targets only the already-validated direct
  `https://<site>.atlassian.net` origin, builds Basic authentication in memory
  (never persisting or logging the plaintext token or Authorization header), uses
  an injected fetch transport, applies a timeout that stays armed through the full
  response-body read, uses `redirect: 'manual'` and never follows redirects,
  safely percent-encodes dynamic project identifiers, validates response shapes at
  runtime, and returns only sanitized outcomes (never raw Jira bodies, network
  errors, redirect locations, stack traces, or credentials). It is intentionally
  not a general-purpose Atlassian SDK.
- **The M5 credential verifier reuses the client** instead of maintaining a second
  HTTP implementation, preserving its existing outcome contract
  (`accountId`/`credentials_rejected`/`timeout`/`unavailable`) and all M5
  connection endpoint behavior.
- **A tenant-scoped integration service**
  (`apps/api/src/jira/jira-integration-service.ts`) that receives an
  `AuthContext`, loads the connection only via
  `JiraConnectionRepository.findByTenant(context.tenantId)`, re-validates the
  stored site URL before any network call, decrypts the token just-in-time bound
  to the stored tenant only, creates a short-lived client, and validates a Jira
  project. Cross-tenant access is impossible even when another connection id, Jira
  key, site URL, or configurer id is known.
- **Project validation** via `GET /rest/api/3/project/{idOrKey}?expand=issueTypes`
  returning the project id, canonical key, and the id of the **fixed**, non-subtask
  issue type named exactly `Task`. Distinct outcomes cover a valid project, not
  connected, an inaccessible project, an unsupported `Task` type, rejected
  credentials, timeout, unavailable, and an internal configuration failure. A
  subtask named `Task` is not accepted.
- **Tenant-only v2 credential encryption.** The token AAD now binds only the
  credential type, the credential format version, and `tenantId`;
  `configured_by_user_id` is audit metadata only and no longer participates in
  encryption or decryption. Stored tokens use the `v2.` prefix.
- **Migration 005** (`005_jira_connection_v2_credentials.sql`), a forward-only
  `DELETE` of all `jira_connections` rows. Existing v1 connections cannot be
  decrypted under the tenant-only context, so affected tenants are disconnected
  and must reconnect; their next connection is stored as v2.

Explicitly **not** implemented in Milestone 7: any frontend or Jira connection UI;
ticket creation; local ticket provenance; recent-tickets; a REST endpoint for
project validation; external application API-key authentication; Jira project
discovery or search; configurable issue types; custom Jira fields;
OAuth/3LO/refresh tokens/rotation; Jira Server or Data Center support; and any
general-purpose Atlassian SDK. The project currently has no ticket-creation flow,
recent-ticket flow, project-discovery UI, or external Jira REST endpoint.

## Earlier milestone scope (Milestone 5: Jira API-token connection)

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
- AES-256-GCM encryption of the API token with a fresh random nonce. As of
  Milestone 7 the additional authenticated data is bound to the credential type,
  the credential format version, and the tenant only (the `v2` format); see the
  Jira integration layer section below.
- A `jira_connections` table with a composite foreign key from
  `(tenant_id, configured_by_user_id)` to `users(tenant_id, id)` and exactly one
  connection per tenant (`UNIQUE (tenant_id)`). Every read and write is scoped by
  tenant; `configured_by_user_id` is audit metadata recording the last successful
  configurer, not an authorization boundary.

Explicitly **not** implemented in Milestone 5: any frontend or Jira connection
UI; OAuth 2.0 / 3LO, client id/secret, callbacks, state, or token refresh; a
reusable Jira API client (owned by M7); Jira project discovery or validation;
ticket creation; a disconnect endpoint; and production KMS or key rotation.

## Earlier milestone scope (Milestone 4: Authenticated application shell)

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
- `jira_ticket_provenance(id, tenant_id, created_by_user_id, jira_connection_id, jira_site_url, jira_project_id, jira_project_key, jira_issue_id, jira_issue_key, created_at)` —
  local provenance for Jira issues created through `POST /api/tickets` (Milestone
  8). It stores only stable identifiers and an audit trail — never the ticket
  title, description, credentials, or any raw Jira response, since Jira remains
  the source of truth for mutable issue contents. Composite foreign keys into
  `users(tenant_id, id)` and `jira_connections(tenant_id, id)` keep every row
  tenant-safe (the latter backed by a `UNIQUE (tenant_id, id)` index the migration
  adds), and `UNIQUE (tenant_id, jira_site_url, jira_issue_id)` prevents recording
  the same issue twice. `jira_site_url` is a snapshot so the row keeps identifying
  the issue's site even after the connection is replaced. Migration
  `007_jira_ticket_provenance_recent_index.sql` adds the additive index
  `ix_jira_ticket_provenance_recent (tenant_id, jira_site_url, jira_project_key,
  created_at DESC, id DESC)` serving the recent-tickets read access pattern.

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
# the stored token starts with the version prefix (v2.) and is never the plaintext.
sqlite3 apps/api/data/app.db \
  'SELECT tenant_id, configured_by_user_id, site_url, email, substr(encrypted_token,1,3) FROM jira_connections;'
```

The plaintext token must not appear in API logs, API responses, frontend state,
generated files, the database token field, or `git status`.

## Manual Jira integration-layer validation (Milestone 7)

The Milestone 7 integration layer (`JiraIntegrationService`) is internal: it has
no committed HTTP route or product surface yet. Validate it with a **temporary**
local script that you delete afterwards — do not commit any throwaway CLI, route,
or product surface.

First reproduce the v1 → v2 migration. Starting from a database created before
Milestone 7 (one that still holds a Milestone 5 connection encrypted with the v1
`v1.` prefix), apply migrations and confirm migration 005 disconnects every
tenant:

```bash
# Inspect existing connections before migrating (token starts with v1.).
sqlite3 apps/api/data/app.db \
  'SELECT tenant_id, substr(encrypted_token,1,3) FROM jira_connections;'

npm run migrate   # applies 005_jira_connection_v2_credentials.sql

# After migration the table is empty: every tenant is disconnected.
sqlite3 apps/api/data/app.db 'SELECT count(*) FROM jira_connections;'   # 0
```

Reconnect through the Milestone 5 endpoint (see the section above) and confirm
the freshly stored token now carries the `v2.` prefix:

```bash
sqlite3 apps/api/data/app.db \
  'SELECT tenant_id, substr(encrypted_token,1,3) FROM jira_connections;'  # v2.
```

Then exercise the integration service directly with a temporary script. Create
`apps/api/tmp-validate.mjs` and delete it when finished (it is a throwaway and
must never be committed):

```js
// TEMPORARY validation script — delete after use, do not commit.
// Reuses the application's own configuration resolvers so it opens the same
// database (DATABASE_PATH or the default apps/api/data/app.db, resolved relative
// to the module, not the working directory) and decodes the key identically.
import { resolveDatabasePath } from './dist/config/database.js';
import { resolveJiraEncryptionKey } from './dist/config/jira-crypto.js';
import { openDatabase } from './dist/database/connection.js';
import { JiraIntegrationService } from './dist/jira/jira-integration-service.js';

async function main() {
  const encryptionKey = resolveJiraEncryptionKey();
  if (encryptionKey === null) {
    throw new Error('JIRA_CREDENTIAL_ENCRYPTION_KEY is not set; export the same key used when the connection was created.');
  }

  const db = openDatabase(resolveDatabasePath());
  try {
    const service = new JiraIntegrationService({ db, encryptionKey, fetch });

    // Replace with real tenant/user ids from your seeded data.
    const acmeAlice = { userId: 'user-acme-alice', tenantId: 'tenant-acme' };
    const acmeBob = { userId: 'user-acme-bob', tenantId: 'tenant-acme' };
    const globexAlice = { userId: 'user-globex-alice', tenantId: 'tenant-globex' };

    console.log('accessible Task project', await service.validateProject(acmeAlice, 'YOUR_PROJECT_KEY'));
    console.log('same tenant, other user', await service.validateProject(acmeBob, 'YOUR_PROJECT_KEY'));
    console.log('nonexistent / inaccessible', await service.validateProject(acmeAlice, 'NOPE'));
    console.log('project without a Task type', await service.validateProject(acmeAlice, 'PROJECT_WITHOUT_TASK'));
    console.log('other tenant is isolated', await service.validateProject(globexAlice, 'YOUR_PROJECT_KEY'));
  } finally {
    db.close();
  }
}

await main();
```

```bash
npm run build --workspace apps/api
export JIRA_CREDENTIAL_ENCRYPTION_KEY="<the key used when connecting>"
node apps/api/tmp-validate.mjs
rm apps/api/tmp-validate.mjs   # remove the throwaway script
```

Expected outcomes:

- **Accessible project supporting Task** → `{ status: 'valid', projectId, projectKey, taskIssueTypeId }`.
- **Same-tenant second user** (Bob) → identical `valid` result; the connection is
  shared per tenant, decrypted by `tenantId` only.
- **Nonexistent / inaccessible project** → `{ status: 'project_inaccessible' }`.
- **Project with no non-subtask `Task` type** → `{ status: 'task_unsupported' }`.
- **Another tenant** (Globex, no connection) → `{ status: 'not_connected' }` with
  no outbound request.

Throughout, confirm the plaintext token never appears in stdout, logs, API
responses, the SQLite `encrypted_token` field, generated files, or `git status`.

## Ticket creation (Milestone 8)

An authenticated user creates a Jira Cloud issue of the fixed **`Task`** type in a
project, against the tenant's shared connection. This is the first ticket-creation
flow; it is backend only.

| Method & path        | Auth required | Purpose                                                       |
| -------------------- | ------------- | ------------------------------------------------------------- |
| `POST /api/tickets`  | yes (cookie)  | Create a fixed-`Task` Jira issue and record local provenance. |

The response includes `Cache-Control: no-store`. The request body accepts only
the three domain fields; `tenantId` and the creating `userId` are derived from the
session, and any client-supplied `tenantId`, `userId`, `connectionId`, `siteUrl`,
`issueType`, or ownership field is ignored.

Request body:

```json
{
  "projectKey": "ABC",
  "title": "NHI finding: leaked service-account key",
  "description": "A short description.\nInternal line breaks are preserved."
}
```

Success (HTTP 201) returns only the Jira issue id and key:

```json
{ "issueId": "10500", "issueKey": "ABC-42" }
```

`projectKey` is trimmed, uppercased, and must match a conservative Jira
project-key syntax; `title` (≤ 255 characters) and `description` (≤ 5000
characters) must be non-empty after trimming, and the description's internal line
breaks are preserved. The issue type is always the project's non-subtask `Task`
type, never chosen by the request. No endpoint stores or returns the ticket title
or description after creation — Jira is the source of truth — and no response ever
includes credentials or raw Jira content.

### Safe error behavior

| Condition                                                | Status | Code                        |
| -------------------------------------------------------- | ------ | --------------------------- |
| Invalid request input                                    | 400    | `invalid_request`           |
| Missing application session                              | 401    | `unauthenticated`           |
| Tenant has no Jira connection                            | 409    | `jira_not_connected`        |
| Project inaccessible to the tenant connection            | 422    | `jira_project_inaccessible` |
| Project does not support the fixed `Task` issue type     | 422    | `jira_task_unsupported`       |
| Stored Jira credentials rejected                         | 502    | `jira_credentials_rejected` |
| Jira unreachable / invalid response / upstream error     | 502    | `jira_unreachable`          |
| Jira request timed out                                   | 504    | `jira_timeout`              |
| Encryption key absent or stored credential undecryptable | 503    | `jira_not_configured`       |
| Jira created the issue but local provenance failed       | 500    | `internal_error`            |

Unlike the connect-time endpoint (where rejected credentials return 422), a
credential rejection during ticket creation maps to 502: the connection was
verified at connect time, so a later rejection is treated as an upstream failure.
It returns its own `jira_credentials_rejected` ("The stored Jira credentials were
rejected. Reconnect Jira and try again.") so the caller knows to reconnect,
distinct from the generic `jira_unreachable` used for a network error, malformed or
rate-limited response, or 5xx.

The provenance row is written **only after** Jira confirms a successful creation.
Jira creation and local persistence are sequential and not atomic, so not every
issue Jira creates is guaranteed a local provenance row:

- If Jira confirms the creation but the provenance insert fails, the response is
  HTTP 500 and the already-created Jira issue remains untracked locally.
- If Jira may have created the issue but the application times out or loses the
  response before reading it, the application never learns the issue id/key,
  records no provenance, and returns HTTP 504 even though the issue may exist.

There is no idempotency key, durable operation tracking, safe retry,
reconciliation, compensating deletion, or worker/queue; Jira remains the source of
truth, and an immediate retry after a timeout may create a duplicate issue. This is
an approved POC tradeoff — see [docs/assumptions.md](docs/assumptions.md).

### Manual ticket-creation validation

These steps require a real Jira Cloud site, account email, an **unscoped** API
token, and a project the account can create `Task` issues in. Connect first via
`POST /api/jira/connection` (see [Jira connection](#jira-connection-milestone-5)),
then:

```bash
# Log in as an Acme user and connect Jira (see the Jira connection section), then
# create a ticket. tenant and creator come only from the session cookie.
curl -i -b alice.cookies -X POST http://localhost:3001/api/tickets \
  -H 'Content-Type: application/json' \
  -d '{"projectKey":"ABC","title":"Leaked service-account key","description":"Found a leaked key.\nRotate immediately."}'

# Client-supplied ownership fields are ignored: the row is still owned by the
# session tenant/user and the session connection's site.
curl -i -b alice.cookies -X POST http://localhost:3001/api/tickets \
  -H 'Content-Type: application/json' \
  -d '{"projectKey":"ABC","title":"t","description":"d","tenantId":"tenant-globex","userId":"user-globex-alice","siteUrl":"https://evil.atlassian.net","issueType":"Bug"}'

# No connection -> 409; invalid input -> 400; unknown/inaccessible project -> 422.
curl -i -b globex.cookies -X POST http://localhost:3001/api/tickets \
  -H 'Content-Type: application/json' \
  -d '{"projectKey":"ABC","title":"t","description":"d"}'
```

What to confirm:

- **Happy path** → HTTP 201 with `{ issueId, issueKey }`, and the issue appears in
  Jira as a `Task`.
- **Ownership comes only from the session** → the stored provenance row records the
  session tenant, the session user as creator, and the session connection's site,
  never the spoofed values.
- **No connection** → HTTP 409 `jira_not_connected` with no Jira call.
- **Provenance stores no contents** → the row holds only identifiers; the title and
  description never appear in the database, logs, or responses.

```bash
# Provenance rows hold identifiers only — no title, description, or token.
sqlite3 apps/api/data/app.db \
  'SELECT tenant_id, created_by_user_id, jira_site_url, jira_project_key, jira_issue_key FROM jira_ticket_provenance;'
```

## Recent tickets (Milestone 10)

An authenticated user reads the ten most recent tickets created through this
application for the tenant's currently connected Jira site and a selected
project. This is the first ticket read; it is backend only.

| Method & path                       | Auth required | Purpose                                                          |
| ----------------------------------- | ------------- | ---------------------------------------------------------------- |
| `GET /api/tickets?projectKey=ABC`   | yes (cookie)  | Return up to ten recent app-created tickets for the project.     |

The response includes `Cache-Control: no-store`. The only request input is the
`projectKey` query parameter; it is trimmed, uppercased, and must match the same
conservative Jira project-key syntax and length as ticket creation. A missing,
empty, malformed, or repeated `projectKey` is a structured 400 with no Jira call.
No tenant, user, connection, site, credential, limit, cursor, or ownership value
is ever read from the request, and there is no user-controlled pagination.

Success (HTTP 200) returns at most ten tickets in stable local provenance order
(`created_at DESC, id DESC`), or an empty array when there are no valid results:

```json
{
  "tickets": [
    {
      "issueId": "10500",
      "issueKey": "ABC-42",
      "title": "Leaked service-account key",
      "createdAt": "2026-06-01T12:00:00.000Z",
      "url": "https://acme.atlassian.net/browse/ABC-42"
    }
  ]
}
```

Membership and order come from local provenance, but every displayed value
(current key, title, Jira creation time) is hydrated live from Jira, and the
`url` is built only from the validated current Jira origin plus `/browse/` and
the percent-encoded current key — never from a self/redirect/location URL. Local
candidates are loaded in fixed internal batches of 25 and hydrated with one bulk
fetch per batch; issues Jira omits (deleted, moved away, inaccessible) and issues
that moved to another project are skipped, and later batches are loaded until ten
valid tickets are found or candidates run out. The connection is loaded once and a
single client and origin snapshot is reused for the whole request, so one response
never mixes two Jira sites. Two users in the same tenant see the same tenant-owned
tickets; the connection id is not part of the visibility boundary, so the
site-URL snapshot still identifies where each issue was created even after the
connection row is replaced.

### Safe error behavior

| Condition                                                | Status | Code                        |
| -------------------------------------------------------- | ------ | --------------------------- |
| Missing/empty/malformed/repeated `projectKey`            | 400    | `invalid_request`           |
| Missing application session                              | 401    | `unauthenticated`           |
| Tenant has no Jira connection                            | 409    | `jira_not_connected`        |
| Stored Jira credentials rejected                         | 502    | `jira_credentials_rejected` |
| Jira unreachable / malformed response / upstream error   | 502    | `jira_unreachable`          |
| Jira request timed out                                   | 504    | `jira_timeout`              |
| Encryption key absent or stored credential undecryptable | 503    | `jira_not_configured`       |

### Manual recent-tickets validation

Connect Jira and create one or more tickets first (see
[Ticket creation](#ticket-creation-milestone-8)), then:

```bash
# Read the recent tickets for a project. tenant and site come only from the session.
curl -i -b alice.cookies 'http://localhost:3001/api/tickets?projectKey=ABC'

# Invalid/missing/repeated projectKey -> 400 with no Jira call.
curl -i -b alice.cookies 'http://localhost:3001/api/tickets'
curl -i -b alice.cookies 'http://localhost:3001/api/tickets?projectKey=ab-cd'

# No connection -> 409. A second same-tenant user sees the same tenant-owned rows.
curl -i -b globex.cookies 'http://localhost:3001/api/tickets?projectKey=ABC'
```

What to confirm:

- **Happy path** → HTTP 200 with up to ten tickets newest-first, each `url`
  pointing at the connected site's `/browse/<currentKey>`.
- **Live hydration** → renaming or moving an issue in Jira is reflected (a moved
  issue disappears from its old project's list; a deleted issue is skipped).
- **No user-controlled pagination** → adding `limit`/`cursor` query parameters
  changes nothing; the fixed cap of ten always applies.
- **Tenant isolation** → another tenant never sees these rows even when connected
  to the same Jira site URL.

## Ticket creation UI (Milestone 9)

The authenticated application shell now lets a user whose tenant is connected to
Jira create an NHI finding ticket. It is **frontend only**: a focused frontend
ticket API module (`apps/web/src/api/tickets.ts`) and a `TicketCreationPanel`
component (`apps/web/src/components/TicketCreationPanel.tsx`) consume the
unchanged Milestone 8 `POST /api/tickets` contract over the Vite proxy with the
same-origin session cookie. No backend behavior changed.

### When the form appears

The ticket-creation panel is rendered **only after** the tenant's shared Jira
connection status has loaded successfully as *connected*. The existing
`JiraConnectionPanel` reports the loaded connection state up to the shell through
a small callback, so the shell gates the ticket panel without issuing a second
connection-status request. While the status is loading, on a status-load error,
and when the tenant is disconnected, the ticket form is not shown.

### Form fields and validation

The form sends exactly three fields and nothing else (`tenantId`, the creating
`userId`, the connection, the site URL, and the fixed `Task` issue type all come
from the server-side session and backend):

| Field         | Client-side usability limit                                                       |
| ------------- | --------------------------------------------------------------------------------- |
| Project key   | Case-insensitive; entered casing is preserved while editing and normalized to uppercase on submit; 2–10 characters matching `^[A-Z][A-Z0-9]+$` after normalization. |
| Title         | Non-empty after trimming; at most 255 characters.                                 |
| Description   | Non-empty after trimming; at most 5000 characters; internal line breaks preserved. |

Client-side validation only improves usability and is **not** a security
boundary; the backend remains authoritative. Invalid local input is reported
inline and no network request is made.

### Success and safe error behavior

On HTTP 201 the panel shows clear success feedback including the returned Jira
issue key (for example `SCRUM-6`), then clears the title and description while
**keeping the project key** so the user can file another ticket in the same
project. Submission controls are disabled while a request is in flight and
duplicate submissions are prevented, so repeated clicks produce only one request.

Every documented backend failure maps to safe, category-specific copy; raw
backend or Jira messages, technical error codes, credentials, session values, and
internal IDs are never rendered:

| Backend code (status)                | Frontend behavior                                         |
| ------------------------------------ | --------------------------------------------------------- |
| `invalid_request` (400)              | Check the project key, title, and description.            |
| `unauthenticated` (401)              | Session no longer valid — sign in again.                  |
| `jira_not_connected` (409)           | Tenant no longer connected — connect Jira and try again.  |
| `jira_project_inaccessible` (422)    | Project not found or not accessible — check the key.       |
| `jira_task_unsupported` (422)        | Project does not support the `Task` issue type.           |
| `jira_credentials_rejected` (502)    | Stored credentials rejected — reconnect Jira.            |
| `jira_unreachable` (502)             | **Uncertain outcome** (see below).                        |
| `jira_timeout` (504)                 | **Uncertain outcome** (see below).                        |
| `jira_not_configured` (503)          | Jira integration not configured on the server.            |
| `internal_error` (500) / unexpected  | **Uncertain outcome** (see below).                        |
| Browser/server network failure       | **Uncertain outcome** (see below).                        |

### Uncertain outcomes and the POC duplicate-creation risk

Milestone 8 documents that ticket creation is **not** idempotent: once the request
leaves the browser, any failure may have occurred *after* Jira already created the
issue, so an immediate retry can create a duplicate. The frontend therefore treats
every post-request failure as an **uncertain outcome**, not just upstream timeouts
and unreachable errors:

- `jira_timeout` (504) and `jira_unreachable` (502) — Jira may or may not have
  received and acted on the request.
- A browser/network failure where the response was never seen — the request may
  still have reached the backend and Jira.
- `internal_error` (500) and any unexpected/malformed server outcome — the backend
  may have created the Jira issue and then failed while recording provenance or
  building the response.

For all of these the UI shows a distinct warning that the ticket *may* have been
created and that the user should **check Jira before retrying**, because retrying
may create a duplicate. Only definitive, pre-creation failures (validation,
authentication, not-connected, inaccessible project, unsupported Task, rejected
credentials, not-configured) are shown as certain failures safe to correct and
resubmit. The frontend never retries a ticket creation automatically.

### How the request is kept safe

The ticket API module sends only `projectKey`, `title`, and `description` with
`credentials: 'same-origin'`; it never sends a tenant, user, connection, site, or
issue-type field, defensively validates the success body (reading only the safe
`issueId`/`issueKey`), parses only the structured `{ error: { code } }` envelope,
never renders raw backend/Jira text, never logs requests/responses/errors, and
never retries. Form contents are held only in transient React state and are never
written to `localStorage`, `sessionStorage`, IndexedDB, cookies, the URL, or any
global state.

### Manual validation: ticket creation UI (Milestone 9)

With both apps running (`npm run dev`), the demo users seeded (`npm run seed`),
and the encryption key configured (see
[Setup: encryption key](#setup-encryption-key)), exercise the UI at
http://localhost:5173. Steps that create a real Jira issue require a real Jira
Cloud site, account email, an **unscoped** API token, and a project the account
can create `Task` issues in.

1. **Sign in with a connected tenant.** Sign in as a tenant user (e.g.
   `alice@example.com` / `acme-alice-demo`) whose tenant already has a valid Jira
   connection (connect first via the Jira connection panel if needed). Confirm the
   **Create a Jira ticket** form appears below the connection panel.
2. **Create a real ticket.** Enter a project key, title, and a multi-line
   description, and submit. Confirm in Jira that the issue was created in the
   **correct project**, as a fixed **`Task`**, with the title mapped to the summary
   and the description preserved (including internal line breaks), and that the UI
   shows the returned **issue key**.
3. **Project-key casing and normalization.** Enter the project key in lowercase
   (e.g. `scrum`) and confirm the input **preserves the entered casing while
   typing**; on submit, confirm the request sends the canonical uppercase value
   (`SCRUM`) and that creation succeeds. Project keys are case-insensitive — the
   frontend normalizes to uppercase on submit and the backend independently trims
   and uppercases before validation — so lowercase input is valid. Uppercase is
   used for consistency and provenance, not because Jira rejects lowercase input.
4. **Local validation.** Submit with empty fields, an over-255-character title, or
   an over-5000-character description, and confirm each is rejected inline before
   any network request (DevTools Network shows no `POST /api/tickets`).
5. **Inaccessible project / unsupported Task.** Use a project key the connection
   cannot access (→ inaccessible copy) and, if available, a project with no
   non-subtask `Task` type (→ unsupported-Task copy).
6. **Disconnected tenant.** As a tenant with no Jira connection, confirm the
   ticket form does not appear at all.
7. **Stored-credential rejection.** With a connection whose token has been revoked
   or rotated, attempt a creation and confirm the reconnect guidance appears.
8. **Uncertain outcomes (duplicate-creation risk).** Because ticket creation is
   not idempotent, exercise every failure that can occur after the request leaves
   the browser. Some are hard to reproduce against a real Jira instance, so
   controlled frontend/API mocking (for example, a DevTools network override or a
   stubbed `createTicket`/`/api/tickets` response) is acceptable. Cover all five:
   - **`jira_timeout` (504).** Simulate a slow/unresponsive upstream so the backend
     returns a timeout.
   - **`jira_unreachable` (502).** Simulate an unavailable upstream or an invalid
     upstream response.
   - **Browser/network interruption after submission.** Send the request, then drop
     connectivity or stop the API mid-request so the browser never sees a response.
   - **`internal_error` (500).** Simulate the server failing after creation — this
     can represent the case where Jira created the issue but local provenance
     persistence failed.
   - **Malformed or unexpected success/server response.** Return a non-JSON body, a
     success body missing `issueId`/`issueKey`, or an unrecognized status/code.

   For **each** case, confirm that:
   - the UI states the ticket **may have been created**,
   - the user is told to **check Jira before retrying**,
   - the UI warns that **retrying may create a duplicate**,
   - **no automatic second `POST /api/tickets`** is sent (DevTools Network shows a
     single request; only an explicit user resubmit produces another),
   - **no raw backend or Jira details** (raw messages, technical codes, stack
     traces, credentials, session values, or internal IDs) are displayed.
9. **Duplicate-submit prevention.** Click **Create ticket** repeatedly while a
   request is pending and confirm exactly one `POST /api/tickets` is sent.
10. **Shared connection, real provenance.** Have two users in the same tenant each
    create a ticket through the shared connection and confirm the backend
    provenance rows record the actual creating user (see the Milestone 8 query).
11. **Cross-tenant isolation.** Confirm a different tenant neither sees nor can use
    the first tenant's Jira connection.
12. **Regression.** Confirm login, logout, session restoration on refresh, and the
    Jira connection replacement flow all continue to work with the ticket panel
    mounted.
13. **No sensitive data leaks.** Using DevTools, confirm no credentials, session
    values, raw Jira content, internal IDs, or form contents appear in the DOM
    after submission, browser storage (`localStorage`, `sessionStorage`,
    IndexedDB, cookies), the console, network responses, the URL, generated files,
    or `git status`.

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
│   │   │   ├── jira/        # Jira connection + ticket routes, client, integration & ticket services, token cipher
│   │   │   └── repositories/# tenant-scoped repositories (users, sessions, Jira connection, ticket provenance)
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
