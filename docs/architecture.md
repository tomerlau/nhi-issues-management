# Architecture

This document describes the final architecture of the application as
implemented. For setup commands see [setup.md](setup.md); for the external API
see [api.md](api.md); for security-specific concerns see
[security.md](security.md).

## Components

```
apps/
  api/   Express + TypeScript backend, SQLite persistence, Jira client
  web/   React + Vite frontend (TypeScript)
```

The frontend and backend are independent npm workspaces with their own
dependency trees and build outputs. They communicate only over HTTP. The
frontend holds no backend secrets and calls only relative `/api/*` paths via
the Vite dev proxy, which forwards them to the backend on
`http://localhost:3001`. This keeps the browser same-origin so the `HttpOnly`
`nhi_session` cookie is sent automatically and no CORS configuration is needed.

Shared tooling (TypeScript base config, ESLint flat config) lives at the
repository root.

## Backend startup and process model

- `src/app.ts` exports `createApp(db, options)`. It registers the
  unauthenticated `GET /api/health`, JSON parsing with a 10 KB body limit, then
  mounts:
  - `/api/auth` — login, session restoration, logout.
  - `/api/jira` — tenant-wide Jira connection.
  - `/api/tickets` — session-authenticated ticket creation and recent-tickets read.
  - `/api/v1/tickets` — external API-key-authenticated ticket creation.
  Two terminal error middlewares translate body-parser failures into the
  standard 400 envelope and catch any uncaught error as an opaque HTTP 500
  `internal_error`. Both set `Cache-Control: no-store` on credential-bearing
  paths.
- `src/server.ts` loads `apps/api/.env`, resolves the database location,
  initializes the database (opens the connection, verifies `PRAGMA
  foreign_keys`, runs pending migrations), resolves the Jira encryption key,
  starts the HTTP server on port 3001, and registers a SIGINT/SIGTERM shutdown
  that closes the server and the database.

Tests exercise the full Express application against an isolated in-memory
database via `supertest`, without binding a port.

## Persistence

SQLite via the built-in Node.js 24 `node:sqlite` module. No ORM, query
builder, or external SQLite dependency. All tables are `STRICT`.

`src/database/connection.ts` opens every connection through one factory,
executes `PRAGMA foreign_keys = ON`, and reads it back to verify enforcement —
because foreign keys are a per-connection setting in SQLite, routing every
connection through this factory is what makes referential integrity always
active.

### Migration runner

`src/database/migrator.ts` ensures a `schema_migrations` table, lists numbered
`*.sql` files from `apps/api/migrations/` in deterministic order, and applies
only those not already recorded. Each migration runs inside its own
transaction: on success it is recorded and committed; on failure it is rolled
back and left unrecorded, so the next run retries it. Re-running is
idempotent.

### Schema

| Table                      | Purpose                                                              |
| -------------------------- | -------------------------------------------------------------------- |
| `tenants`                  | Tenant isolation boundary.                                           |
| `users`                    | One user belongs to exactly one tenant. Email is globally unique.    |
| `user_credentials`         | Argon2id password hash, keyed by `(tenant_id, user_id)`.             |
| `sessions`                 | Server-side sessions; stores SHA-256 hash of the token.              |
| `jira_connections`         | Tenant-wide Jira connection, `UNIQUE (tenant_id)`. Token encrypted.  |
| `jira_ticket_provenance`   | Local pointer for each Jira issue created via this application.      |
| `api_keys`                 | Application-issued API keys; stores SHA-256 hash of the secret.      |

Every tenant-owned read or write requires an explicit `tenantId`. The single
intentional exception is `UserRepository.findByEmailForAuthentication`, used
only at login, which derives the tenant from the matched user. Foreign keys
provide referential integrity; tenant-scoped repository queries provide
authorization isolation.

## Sessions and application authentication

`POST /api/auth/login` validates email and password, finds the user by
globally unique email, verifies the Argon2id password hash, generates a 256-bit
opaque session token, stores only its SHA-256 hash in `sessions`, and sets the
token in the `nhi_session` cookie (`HttpOnly`, `SameSite=Lax`, `Path=/`,
`Max-Age` matching an eight-hour TTL, `Secure` when `NODE_ENV=production`).

`GET /api/auth/session` always returns HTTP 200: `{ user }` for a valid
session, `{ user: null }` otherwise. An unauthenticated initial load is a
normal application state, not a request failure. The protected-route
middleware (`requireAuth`) still returns HTTP 401 on its own.

`POST /api/auth/logout` deletes only the session row for the current token
hash, clears the cookie, and is idempotent.

All `/api/auth/*` responses include `Cache-Control: no-store`. After login,
the principal (`tenantId`, `userId`) comes solely from the stored session row;
no request input can assert or override it.

## Frontend authentication

`apps/web/src/App.tsx` holds one explicit auth state value:

```
restoring → GET /api/auth/session ┬ 200 { user }      → authenticated(user)
                                  ├ 200 { user: null } → unauthenticated
                                  └ network/unexpected → restore_error (retryable)
```

`src/api/auth.ts`, `src/api/jira.ts`, and `src/api/tickets.ts` are small
explicit modules — not a generic API client. Each defines a typed error union,
maps documented backend codes to safe UI kinds, defensively validates success
bodies through type guards, and discards raw backend `message` text so server
content never reaches the user. None of them logs requests or responses.
`AbortError` is propagated raw so unmount cleanup does not flip state.

The browser holds the session only as the `HttpOnly` cookie. No session
token, authorization header, or password is ever written to React state
(beyond the password field during a login submit), `localStorage`,
`sessionStorage`, the URL, or logs. There is no UI to assert or override a
user or tenant id.

## Frontend shell layout

`AuthenticatedShell.tsx` is the single authenticated view. It owns:

- `JiraConnectionPanel` (header bar): a compact connection indicator and a
  gear-icon button that opens a "Manage Jira connection" modal when connected.
- `JiraInlineConnectForm`: the first-time connect form, rendered in the main
  area only when the panel has confirmed `disconnected`.
- `ProjectSelector`: a Jira project-key input with an inline info-icon
  tooltip. Disabled while the ticket-creation modal is open or a creation
  request is in flight.
- `RecentTicketsPanel`: rendered once a valid project key is entered. In
  *Mode A* (≥ 1 tickets) it shows the list with a "Create ticket" button that
  opens the creation modal; in *Mode B* (zero tickets) it shows an inline
  "Create your first Jira ticket!" form.
- `TicketCreationModal`: an accessible modal (`role="dialog"
  aria-modal="true"`) that hosts `TicketCreationForm` with Escape disabled
  while the form is submitting.

A small `JiraShellState` discriminated union (`loading | error | disconnected
| connected`) drives gating. A successful inline connect transitions the
shell to `connected` immediately from the POST response, and a transient
follow-up GET failure cannot demote a confirmed connection.

## Jira connection

Tenant-wide ownership: exactly one Jira connection per tenant (`UNIQUE
(tenant_id)`), shared by all users in the tenant. `configured_by_user_id` is
audit metadata only — it does **not** authorize who may replace the
connection, and it does **not** participate in token decryption.

### Endpoints

| Method & path               | Auth          | Purpose                                            |
| --------------------------- | ------------- | -------------------------------------------------- |
| `POST /api/jira/connection` | cookie        | Validate Jira credentials, create or replace.      |
| `GET /api/jira/connection`  | cookie        | Return safe connection status for the tenant.      |

Request body for `POST`:

```json
{ "siteUrl": "https://your-site.atlassian.net", "email": "you@example.com", "apiToken": "..." }
```

Success response (both endpoints): `{ "connected": true, "siteUrl": "...",
"email": "..." }` or `{ "connected": false }` for `GET`. The API token, the
encrypted ciphertext, the Jira account id, audit metadata, and internal IDs
are never returned.

### Validate-then-store flow

1. `site-url.ts` accepts only normalized direct `https://<site>.atlassian.net`
   origins. No network call is made until validation succeeds (SSRF boundary).
2. `jira-verifier.ts` constructs a short-lived `JiraClient` and calls
   `loadAccountIdentity` (`GET /rest/api/3/myself`) to verify the token.
3. On success the token is encrypted with AES-256-GCM (`token-cipher.ts`) and
   upserted into `jira_connections` by `tenantId`. A failed validation or
   replacement never overwrites an existing valid connection.

`tenantId` and the acting `userId` come solely from the session; any
client-supplied `tenantId`, `userId`, `configuredByUserId`, or `connectionId`
in the body is ignored.

## Central Jira client

`apps/api/src/jira/jira-client.ts` owns all outbound Jira HTTP behavior:

- Targets only an already-validated direct
  `https://<site>.atlassian.net` origin.
- Builds Basic authentication in memory; never persists or logs the plaintext
  token or `Authorization` header.
- Uses an injected `fetch`-compatible transport (tests never reach live Jira).
- `redirect: 'manual'`; never follows redirects.
- Default 8 s timeout; the timer covers the full response-body read, so a
  body-stall maps to `timeout`.
- Validates response shape at runtime and returns only sanitized outcomes
  (`valid` / `project_inaccessible` / `task_unsupported` /
  `credentials_rejected` / `timeout` / `unavailable`). Raw Jira bodies,
  redirect locations, individual issue errors, and stack traces never escape.

Operations implemented:

- `loadAccountIdentity()` — `GET /rest/api/3/myself`.
- `validateProject(idOrKey)` — `GET /rest/api/3/project/{idOrKey}?expand=issueTypes`,
  returns the project id, canonical key, and the id of the non-subtask issue
  type named exactly `Task`.
- `createIssue(input)` — `POST /rest/api/3/issue` with the fixed `Task` issue
  type, the title as `summary`, and the description as a minimal ADF document
  preserving internal line breaks as `hardBreak` nodes.
- `bulkFetchIssues(ids)` — `POST /rest/api/3/issue/bulkfetch` requesting only
  `summary`, `created`, and `project` for recent-ticket hydration.

The client is intentionally not a general-purpose Atlassian SDK.

## Tenant-scoped integration service

`jira-integration-service.ts` is the tenant boundary for Jira access. It
receives an `AuthContext`, loads the connection only via
`JiraConnectionRepository.findByTenant(context.tenantId)`, re-validates the
stored site URL (defense in depth), decrypts the token just-in-time bound to
the stored tenant only, and constructs one short-lived `JiraClient`. For
`createTicket`, the same client is used for both project validation and issue
creation, so a concurrent connection replacement cannot split the two across
different Jira sites.

Cross-tenant access is impossible: a tenant without a connection returns
`not_connected` and makes no Jira call, even when another tenant is connected
and even when a connection id, site URL, or user id is known.

## Ticket creation

Session route: `POST /api/tickets` behind `requireAuth`. External route:
`POST /api/v1/tickets` behind `createRequireApiKeyAuth`. Both share the same
domain pipeline; only the authentication boundary differs.

```
Router (session or API-key)
  → validateTicketBody (shared)         — only projectKey, title, description
  → TicketService.createTicket          — orchestration
    → JiraIntegrationService.createTicket
      → loader + re-validate URL + decrypt → JiraClient
      → validateProject → createIssue
    → TicketProvenanceRepository.create — only after Jira confirms
  → sendCreateTicketResponse (shared)   — identical status/error envelope
```

Validation (shared `ticket-validation.ts`): `projectKey` trimmed and
uppercased, matching `^[A-Z][A-Z0-9]+$`, 2–10 chars; `title` non-empty,
trimmed, ≤ 255 chars; `description` non-empty, trimmed, ≤ 5000 chars, internal
line breaks preserved.

Outcome mapping (shared `ticket-result-mapper.ts`):

| Outcome                  | Status | Code                         |
| ------------------------ | ------ | ---------------------------- |
| `created`                | 201    | — (`{ issueId, issueKey }`)  |
| `not_connected`          | 409    | `jira_not_connected`         |
| `project_inaccessible`   | 422    | `jira_project_inaccessible`  |
| `task_unsupported`       | 422    | `jira_task_unsupported`      |
| `credentials_rejected`   | 502    | `jira_credentials_rejected`  |
| `unavailable`            | 502    | `jira_unreachable`           |
| `timeout`                | 504    | `jira_timeout`               |
| `configuration_error`    | 503    | `jira_not_configured`        |
| `persistence_failed`     | 500    | `internal_error`             |

`tenantId` and the creating `userId` come solely from the authenticated
context (session row or API-key record). Spoofed `tenantId`, `userId`,
`connectionId`, `siteUrl`, `issueType`, and similar fields in the body are
ignored.

### Provenance

`jira_ticket_provenance` stores only stable identifiers and audit metadata:
provenance id, `tenant_id`, `created_by_user_id`, `jira_connection_id`, a
`jira_site_url` snapshot, project id/key, issue id/key, local `created_at`.
It deliberately stores **no** ticket title, description, credentials, or raw
Jira response — Jira remains the source of truth for mutable issue contents.

A `UNIQUE (tenant_id, jira_site_url, jira_issue_id)` constraint prevents
recording the same issue twice. The site URL is a snapshot, so the row keeps
identifying the issue's site even after the tenant replaces its connection.

The provenance row is written **only after** Jira confirms a successful
creation. Jira creation and SQLite persistence are sequential and not atomic:

- Jira confirms creation but the provenance insert fails → `persistence_failed`
  (HTTP 500); the Jira issue exists but has no local pointer.
- The request times out before Jira's response is read → `jira_timeout` (HTTP
  504); the issue may or may not exist.

There is no idempotency key, durable workflow, retry orchestration, or
reconciliation. An immediate retry after a timeout may create a duplicate.
See [assumptions.md](assumptions.md) for the approved POC tradeoff.

## Recent tickets

`GET /api/tickets?projectKey=...` (cookie-authenticated) returns up to ten
recent tickets for the tenant's currently connected Jira site and the selected
project.

```
GET /api/tickets
  → validateProjectKeyQuery (same syntax/length as creation; rejects repeated value)
  → RecentTicketsService.list
    → jira-connection-loader.loadOnce → JiraClient + origin snapshot
    → TicketProvenanceRepository.listRecentCandidates (batches of 25, keyset cursor)
    → JiraClient.bulkFetchIssues per batch
    → drop omitted/moved issues; stop at 10 valid results
  → 200 { tickets: [...] }
```

Membership and order come from local provenance (scoped to `tenant_id`,
current `jira_site_url`, normalized `jira_project_key`, ordered `created_at
DESC, id DESC`). Every displayed value — current key, title, creation time —
is hydrated live from Jira. The browse `url` is built only from the validated
current origin plus `/browse/` and the percent-encoded current key.

The read is **not** filtered by creating user (two users in a tenant see the
same tenant-owned tickets) and **not** by connection id (the site-URL
snapshot is the visibility boundary). The connection is loaded once per
request and the same `JiraClient` and origin snapshot are used for every
batch, so one response can never mix two Jira sites.

Outcome mapping mirrors ticket creation (200 / 400 / 401 / 409 / 502 / 503 /
504) using the same shared error envelopes.

## External REST API

`POST /api/v1/tickets` is mounted at `/api/v1/tickets`. The router:

1. Sets `Cache-Control: no-store` on every response.
2. Runs `createRequireApiKeyAuth` before any Jira state is read. Session
   cookies are not accepted; a request without a valid
   `Authorization: Bearer <key>` returns 401.
3. Validates the body with the shared `validateTicketBody`.
4. Delegates to the same `TicketService.createTicket` used by the UI route.
5. Maps the result with the shared `sendCreateTicketResponse`.

There is no second ticket-creation domain service, no second Jira client, and
no second provenance repository. See [api.md](api.md) for the full external
contract.

## API-key authentication

Format: `nhi_<keyId>.<secret>`.

- `keyId` — 16 random bytes, base64url, 22 chars. Public selector, stored as
  the primary key in `api_keys.id`.
- `secret` — 32 random bytes, base64url, 43 chars (≥ 256 bits of entropy).
  Only its SHA-256 hash is persisted.
- `.` is the separator; it is not in the base64url alphabet, so the format is
  unambiguous.

The plaintext full key is shown exactly once during local provisioning and
cannot be recovered. Revocation physically deletes the row; there is no
`revoked_at` column.

`createRequireApiKeyAuth` reads `Authorization: Bearer <key>`, parses it,
looks up the row by `keyId`, and performs a timing-safe comparison of the
SHA-256 hash. Every failure — missing header, wrong scheme, malformed key,
unknown id, wrong secret, deleted key — returns the same generic 401 with
`Cache-Control: no-store`. On success it populates `req.auth.context` with
the same `AuthContext` shape used by session auth, derived exclusively from
the stored key record.

CLI commands `api-key:create` and `api-key:revoke` are the only provisioning
surface; there is no management UI or REST endpoint for keys.

## Health endpoint

`GET /api/health` returns HTTP 200 with exactly `{ "status": "ok" }`. It
depends on no external resource and exposes no configuration or internal
state. The frontend does not render a health screen.

## Quality gates

`npm run check` runs (fail-fast): ESLint, TypeScript strict typecheck,
backend and frontend Vitest tests, the Claude workflow hook tests (Node test
runner), then the full build. GitHub Actions CI runs the same gate on pushes
and pull requests.
