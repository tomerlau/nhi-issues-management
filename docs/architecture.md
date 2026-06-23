# Architecture

This document describes the architecture that currently exists through
Milestone 12. It intentionally avoids designing later domain layers in detail.

## Monorepo structure

The repository is an npm-workspaces monorepo with two independent applications:

- `apps/api` — the Node.js/TypeScript backend (Express).
- `apps/web` — the React/Vite frontend (TypeScript).

Shared tooling configuration (TypeScript base config, ESLint flat config) lives
at the repository root so both applications stay consistent. Application runtime
dependencies are scoped to their respective workspaces: the frontend never
depends on backend packages and vice versa. No shared code package exists yet,
because there is no genuine cross-application code to share.

## Frontend / backend separation

The frontend and backend are separate applications with separate dependency
trees, build outputs, and lifecycles. They communicate only over HTTP. The
frontend holds no backend secrets or configuration; it knows only relative `/api`
endpoints — the authentication endpoints `/api/auth/*`, the Jira connection
endpoints `/api/jira/connection`, and (as of Milestone 8) the ticket-creation
endpoint `/api/tickets` — which Milestone 10 extends with a `GET` recent-tickets
read on the same path. The backend
health endpoint `/api/health` remains available separately for liveness checks
and is not part of the frontend authentication flow.

## Local request flow

```
Browser (React app, 5173)
  -> Vite development server (5173)
  -> /api proxy
  -> Express /api/auth/* and /api/health (3001)
  -> JSON response (+ Set-Cookie: nhi_session on login)
```

In development the Vite dev server proxies any `/api/*` request to the backend.
This keeps the browser on a single origin and removes any need for permissive
CORS on the backend. Because requests stay same-origin, the browser attaches the
`HttpOnly` `nhi_session` cookie automatically; the frontend never reads or sets
it.

## Frontend authentication

The frontend (`apps/web`) is the user-facing authentication experience built on
the backend endpoints. It keeps the same separation as the rest of the app: it
holds no secrets, talks to the backend only over relative `/api` requests, and
derives the authenticated user solely from the backend session response.

### Authentication API module

`src/api/auth.ts` is a small, explicit module — not a generic API client. It
exposes `restoreSession`, `login`, and `logout`, each calling exactly one
endpoint, plus a `SafeUser` type and a typed `AuthError`. It reads the structured
`{ error: { code } }` envelope defensively (never trusting its shape) and the
`{ user }` success envelope through a `SafeUser` type guard, so a malformed
response becomes a `server` error rather than a bad render. The normal logged-out
state is not an error: session restoration always answers HTTP 200 with a
`{ user }` envelope, and `restoreSession` returns the `SafeUser` when present or
`null` when `user` is `null`. A missing `user`, an invalid user object, an
unexpected primitive body, invalid JSON, or any non-200 status (including an
unexpected 401) all become a `server` failure. Actual API failures are raised as
a typed `AuthError` whose kind is one of `invalid_credentials`,
`invalid_request`, `network`, or `server`, and the backend's error *message* is
deliberately discarded so raw server text never reaches the user. `restoreSession`
accepts an `AbortSignal` and re-throws `AbortError` unwrapped so an unmounted
initial load does not flip state.

### Authentication state flow

`src/App.tsx` holds one explicit state value:

```
restoring ── GET /api/auth/session ──┬─ 200 { user }      ──> authenticated(user)
                                     ├─ 200 { user: null } ──> unauthenticated
                                     └─ network/server     ──> restore_error (retryable)
```

On mount the app calls `GET /api/auth/session` while showing a loading state.
HTTP 200 with a user renders the authenticated shell; HTTP 200 with `user: null`
renders the login screen. Because being unauthenticated is a normal state rather
than a failed request, the endpoint never answers 401 here, so an initial
unauthenticated load produces no console error. A network or unexpected server
failure — including an unexpected non-200 response — is a **distinct**
`restore_error` state with a retry action; it is never collapsed into "logged
out", because that would let a transient outage masquerade as a sign-out. Because
restoration re-runs on every load, a refresh restores a valid session
automatically and leaves a logged-out browser on the login screen.

### Login and logout HTTP flow

The login form owns its own email/password fields and submits to
`POST /api/auth/login`. On success the backend sets the cookie and returns the
safe user, which becomes the authenticated state; the password field is cleared
after every completed attempt and the submit button is disabled while a request
is in flight, preventing duplicate submissions. Invalid credentials surface a
single generic message, mirroring the backend's deliberate refusal to reveal
whether an email exists.

Logout posts to `POST /api/auth/logout`. Success requires both an HTTP success
status and a body that is exactly `{ status: "ok" }`; a success status with a
malformed, non-JSON, or unexpected body is treated as a `server` failure. Only a
proven-complete logout returns the app to the login screen. On a network or
server failure — including an unverifiable body — it keeps the authenticated
state and shows a retryable error rather than pretending the session was revoked,
since the cookie and server-side session may still be live.

### Why no token or credential is stored on the client

The browser holds the session only as the `HttpOnly` `nhi_session` cookie, which
JavaScript cannot read. The frontend therefore never stores a session token,
authorization header, or password in React state (beyond the password field while
a login submits), `localStorage`, `sessionStorage`, the URL, or logs. The
authenticated principal comes only from the backend session response, and there
is no UI to assert or override a user or tenant id — keeping the M3 trust boundary
intact from the browser down. This is the frontend analogue of storing only token
hashes server-side: the value that authenticates a request never lives anywhere a
script or a leaked log could replay it.

## Frontend Jira connection (Milestone 6)

Milestone 6 adds the user-facing view of the tenant-wide Jira connection. It is
frontend only and consumes the unchanged Milestone 5 backend contract
(`GET`/`POST /api/jira/connection`); no backend behavior changed.

### Jira API module

`src/api/jira.ts` mirrors the `auth.ts` style: a small, explicit module — not a
generic client. It exposes `getJiraConnection`, `saveJiraConnection`, a
`JiraConnectionStatus` type, a typed `JiraApiError`, and a `messageForKind`
helper that maps each error kind to safe, generic copy. It reads the structured
`{ error: { code } }` envelope defensively and maps recognized backend codes
(`invalid_request`, `jira_credentials_rejected`, `jira_not_configured`,
`jira_timeout`, `jira_unreachable`, `unauthenticated`) plus transport and
unexpected-status outcomes to distinct kinds (`invalid_request`,
`credentials_rejected`, `not_configured`, `timeout`, `unreachable`,
`authentication`, `network`, `server`). Success bodies are parsed through a
status parser that reads **only** the safe `connected`/`siteUrl`/`email` fields,
so an unexpected credential-shaped field in a response is structurally ignored
rather than surfaced, and a malformed body becomes a `server` error. The backend
*message* is always discarded so raw server or Jira text never reaches the user,
and the module logs nothing.

### Jira connection panel

`src/components/JiraConnectionPanel.tsx` is mounted in the application header
inside the authenticated shell. As of Milestone 11 it was refactored from a
full-page form into a compact status bar + modal. The bar renders only the
current connection state ("Jira connected" / "Jira not connected") and a trigger
button ("Manage" or "Connect Jira"). Connection details (site URL, email), the
tenant-sharing disclaimer, and the create/replace form live exclusively inside an
accessible modal (`div[role="dialog" aria-modal="true"]`) that opens on demand
and closes on a successful save. A failed save keeps the modal open; Escape is
blocked while a save is in flight.

Regardless of modal or bar, the component owns a small load state (`loading` →
`ready` / `error`) plus the safe connection status. The load-error state retains
the safe `JiraErrorKind` (falling back to `server` for an unknown error, ignoring
`AbortError`), shows category-specific copy, and offers a **Try again** retry
where retrying is meaningful. An authentication failure asks the user to refresh
or sign in rather than offering a futile retry. It derives the displayed status
solely from the backend response; it never renders raw backend messages, technical
error codes, internal user/tenant/connection IDs, account IDs, audit metadata,
encrypted data, or credential material.

### Why the API token is never held in client state

The token is the one field deliberately kept out of React state. `siteUrl` and
`email` are ordinary controlled inputs, but the token input is **uncontrolled**
and read only through a DOM ref at submit time. The token is cleared immediately
when an actual POST request begins — before the network request resolves — so the
secret never persists in the input, is never retained for a retry, and is never
placed in state, context, props, a store, or any browser storage. If client-side
validation fails before a request is made, the uncontrolled input retains its
value so the user can correct the other fields without re-typing the token. The
token exists only as a transient local variable and in the outgoing request body.
This
is the frontend analogue of the backend's write-only credential handling: the
value that authenticates to Jira never lives anywhere a re-render, a retry, or a
leaked store could replay it. A failed save preserves the previously loaded
connection unchanged and forces the token to be re-entered for another attempt,
matching the backend guarantee that a failed replacement never disturbs the
stored connection.

The token therefore lives only transiently in the outgoing request body; the
client makes no claim about transport encryption. Local development accesses the
frontend and API through `localhost` over plain HTTP, so the local request is not
protected by TLS. Any non-local or production deployment must use HTTPS/TLS so the
token is not exposed in transit. This is a deployment concern, not a client-state
concern: the not-stored-in-the-browser guarantees above hold regardless of
transport.

## Backend application / startup separation

The backend separates application construction from process startup:

- `src/app.ts` exports `createApp(db, options)`, which builds and configures the
  Express application: it disables `x-powered-by`, registers the unauthenticated
  `GET /api/health`, adds JSON body parsing with a small size limit, and mounts
  the authentication routes backed by the injected database. It knows nothing
  about ports, sockets, or process signals. The database is injected (rather than
  opened inside `createApp`) so tests can exercise the full application against an
  isolated in-memory database, and so the cookie `Secure` flag can be configured
  per environment.
- `src/server.ts` is the process entry point. It resolves the database location,
  initializes the database (open, verify foreign keys, run migrations), constructs
  the app with that database and the production-derived cookie setting, starts the
  HTTP server on the fixed local port 3001, and registers a SIGINT/SIGTERM handler
  that closes the HTTP server and then the database.

This separation lets tests exercise the full Express application in-process with
`supertest`, without binding a real TCP port or opening a database.

## Health endpoint

`GET /api/health` returns HTTP 200 with exactly `{ "status": "ok" }`. It depends
on no external resource and exposes no configuration, paths, or internals.

## Quality gates and CI

ESLint, TypeScript strict typecheck, Vitest tests, and builds run for both
workspaces via root scripts, and GitHub Actions runs the same checks on pushes
and pull requests.

## Persistence

Milestone 2 introduces persistence with SQLite, using the built-in Node.js 24
`node:sqlite` module. No ORM, query builder, or external SQLite dependency is
used.

### Connection lifecycle

`src/database/connection.ts` exports `openDatabase(location)`, the single factory
for every connection the application creates. It ensures the parent directory
exists for file-backed databases, executes `PRAGMA foreign_keys = ON`, and then
reads the pragma back to verify enforcement is actually on, failing fast if not.
Because foreign keys are a per-connection setting in SQLite, routing all
connections through this factory is what guarantees referential integrity is
always active.

`src/config/database.ts` resolves the location: `DATABASE_PATH` when set,
otherwise the default `apps/api/data/app.db`. The literal `:memory:` selects an
in-memory database, used throughout tests. `src/database/lifecycle.ts` composes
the factory with the migrator (`initializeDatabase`), and `src/server.ts` calls
it on startup and closes the connection during graceful shutdown.

### Migration flow

`src/database/migrator.ts` is a minimal runner. It ensures a `schema_migrations`
table, lists numbered `*.sql` files from `apps/api/migrations/` in deterministic
order, and applies only those not already recorded. Each migration runs inside
its own transaction: on success it is recorded in `schema_migrations` and
committed; on failure it is rolled back and left unrecorded, so the next run
retries it and partially applied schema never persists. Re-running is therefore
idempotent and safe. Migration files are plain SQL — there is no programmatic
migration framework.

### Tenant and user schema

`001_initial_schema.sql` creates the original two `STRICT` tables, and
`002_authentication.sql` evolves the schema for authentication:

- `tenants(id TEXT PK, name, created_at)`.
- `users(id TEXT PK, tenant_id, email, display_name, created_at)` with
  `tenant_id` referencing `tenants(id)`. As of migration 002, `email` is
  **globally unique**, and the table carries a `UNIQUE (tenant_id, id)`
  constraint so authentication tables can reference a user by tenant and id
  together.
- `user_credentials(user_id PK, tenant_id, password_hash, created_at)` with a
  composite `FOREIGN KEY (tenant_id, user_id)` into `users`.
- `sessions(token_hash PK, tenant_id, user_id, created_at, expires_at)` with the
  same composite foreign key into `users`.

A user belongs to exactly one tenant. SQLite cannot alter a table constraint in
place, so migration 002 rebuilds `users` (copy into a new table, drop, rename).
This runs inside the migrator's transaction with foreign keys still enabled,
which is safe because the credential and session tables are created afterwards,
so nothing references `users` during the rebuild. No cascading delete is defined;
deletion remains out of scope.

### Authentication: credential storage

Password credentials live in their own `user_credentials` table rather than on
the user row, so a hash is never read or returned as part of a normal user
query. Only the authentication path reads them, through a dedicated
`UserCredentialRepository`. Passwords are hashed with Argon2id through the
maintained `argon2` package, wrapped by a small application-owned module
(`src/auth/password.ts`) exposing only async `hashPassword` and `verifyPassword`.
The library generates a fresh random salt per hash and returns the standard
self-describing PHC string (`$argon2id$v=19$m=...,t=...,p=...$salt$hash`), which
is stored verbatim — the application does not parse hashes, manage salts, or
handle crypto parameters itself. Verification delegates to the library and
returns `false` (rather than throwing) for a malformed or unsupported stored
hash. The database contains only hashes; plaintext passwords are never stored.

### Authentication: login and session resolution

Login (`POST /api/auth/login`) accepts only an email and password. The email is
normalized (trimmed and lowercased) and looked up with the one deliberately
tenant-unaware query, `UserRepository.findByEmailForAuthentication`; because
email is globally unique this resolves at most one user, and the tenant is then
read from that user record. The password is verified against the stored
credential. Unknown email, a missing credential record, and a wrong password all
return the same generic 401, so a client cannot probe which emails exist.

On success the server generates an opaque session token — 32 random bytes (256
bits) as URL-safe base64 — records a session row, and returns the token only in
the session cookie. A session row stores the token's SHA-256 hash, the owning
tenant and user, and an absolute eight-hour expiry. Session resolution reads the
cookie, hashes the token, looks up a non-expired session by that hash, and loads
the user within the session's own `(tenantId, userId)` scope. Logout deletes only
the row matching the current token hash, leaving every other session intact.

Session restoration and protected routes treat a resolved session differently.
`GET /api/auth/session` is **not** a protected route: it always returns HTTP 200,
with `{ user: SafeUser }` for a valid session and `{ user: null }` for a missing,
invalid, expired, or revoked one, because being unauthenticated on initial load
is a normal application state rather than a request failure. The reusable
`requireAuth` middleware, which guards genuine protected routes, still rejects an
unauthenticated request with a generic HTTP 401 and is unchanged. Invalid login
credentials likewise still return HTTP 401, and all authentication responses
remain `Cache-Control: no-store`.

### Authentication: trust boundary

Email and password enter the system exactly once, at login. Everything after
login derives the principal solely from the server-side session: the middleware
attaches a typed context whose `userId` and `tenantId` come from the stored
session row, never from the request body, query string, or headers. There is no
code path that lets a client assert a user or tenant identity directly, which
keeps Milestone 2's tenant isolation intact under authentication.

### Why raw tokens are not stored

The database stores only the SHA-256 hash of each session token, while the raw
token exists only in the client's `HttpOnly` cookie. A leaked database row
therefore cannot be replayed as a live session, since the stored hash cannot be
reversed into the token a client must present. The token carries 256 bits of
entropy, so guessing a valid token is infeasible. This is the session analogue of
storing password hashes rather than plaintext.

### Tenant-scoped repositories

`src/repositories/` holds small, explicit repositories. `TenantRepository`
creates, finds, and lists tenants. `UserRepository` requires the owning
`tenantId` on its tenant-owned methods (`create`, `findById`, `findByEmail`,
`list`), and every such query includes `tenant_id` in its `WHERE` clause. The one
deliberate exception is `findByEmailForAuthentication(email)`, a global
tenant-unaware lookup used only at login — before a tenant is known — that
relies on global email uniqueness to return at most one user, from which the
tenant is then derived. There is still no unscoped accessor for normal reads such
as `findUserById(userId)` or `listAllUsers()`. `UserCredentialRepository` and
`SessionRepository` (added in Milestone 3) are likewise scoped: credential reads
require `(tenantId, userId)`, and session deletion targets a single token hash.
All values are passed as bound parameters via prepared statements.

### Foreign-key integrity vs. tenant authorization

These are two distinct guarantees and neither replaces the other. Foreign keys
provide *referential integrity*: a user row cannot reference a tenant that does
not exist. Tenant-scoped repository queries provide *authorization isolation*: a
caller operating in tenant A's context cannot read or list tenant B's users,
even though both rows are valid and the foreign keys are satisfied. A user ID
alone is never treated as sufficient scope; the tenant boundary is always
required.

## Jira connection (Milestone 5, corrected to tenant-wide ownership)

Milestone 5 lets authenticated users connect a Jira Cloud account with a site
URL, Atlassian email, and API token. It is backend only and reuses the existing
authentication trust boundary: `tenantId` and the acting `userId` come solely
from the session, never from request input.

The Jira connection is a **tenant-wide organization integration shared by every
user in the tenant**, not a per-user connection. Any authenticated user in a
tenant can read the safe connection status and any of them can create or replace
the single shared connection. Users in other tenants can never read, use, or
replace it. (This corrects the original Milestone 5 model, which stored one
connection per `(tenant_id, user_id)`.)

### Connection boundary and ownership

`src/jira/` is a self-contained boundary mounted at `/api/jira`. Routes
(`jira-routes.ts`) sit behind `requireAuth`, validate input, and delegate to
`JiraConnectionService`, which orchestrates verification, encryption, and
persistence. The `JiraConnectionRepository` follows the existing explicit,
tenant-scoped SQLite style: every read and write requires `tenantId`, there is
no lookup or mutation path by connection id, user id, or any client-provided
ownership field, and the `jira_connections` table carries a composite foreign
key from `(tenant_id, configured_by_user_id)` into `users(tenant_id, id)` plus a
`UNIQUE (tenant_id)` constraint enforcing exactly one connection per tenant.
Creating or replacing the connection upserts by `tenantId` alone: a replacement
updates the existing row in place, preserving its `id` while rewriting the
connection fields, the encrypted token, `configured_by_user_id`, and
`updated_at`.

`configured_by_user_id` records the user who last successfully configured the
connection, for audit only. It is **not** an authorization boundary: any tenant
user may replace the connection regardless of who configured it last. This is a
deliberate POC simplification — see the production alternative in
`docs/assumptions.md` (only authorized tenant administrators manage the shared
integration). A failed verification or replacement never touches the stored row,
so an existing valid connection survives a failed replacement unchanged.

### Migration to tenant-wide ownership (migration 004)

`004_jira_connection_tenant_wide.sql` rebuilds `jira_connections`, replacing
`user_id` with `configured_by_user_id`, swapping the `UNIQUE (tenant_id, user_id)`
constraint for `UNIQUE (tenant_id)`, and re-pointing the composite foreign key at
`(tenant_id, configured_by_user_id)`. SQLite cannot alter a constraint in place,
so the table is recreated (create new, copy, drop, rename) inside the migrator's
transaction with foreign keys enabled, which is safe because nothing references
`jira_connections`. Existing rows are preserved where possible: the previous
`user_id` is carried over verbatim as `configured_by_user_id` so the stored
ciphertext — whose AAD binds `(tenant_id, user_id)` — stays decryptable. Because
the old schema permitted one row per `(tenant_id, user_id)`, a tenant may hold
several legacy rows while the new schema allows only one; the migration
deterministically retains exactly one per tenant, choosing the greatest
`updated_at` and breaking ties by the greatest `id`. The migration is forward
only and, like every migration, is recorded once and skipped on re-run.

### Credential verification flow

The token is verified before anything is stored. The submitted site URL is
validated first (`site-url.ts`), accepting only normalized
`https://<site>.atlassian.net` origins; this is the SSRF boundary, so no network
request is made until validation succeeds. `jira-verifier.ts` is then a small
wrapper that preserves the Milestone 5 verification contract: it delegates all
Jira HTTP behavior to the central `JiraClient` (see "Jira integration layer"
below), which owns `Authorization`-header construction, timeout handling,
redirect handling, response parsing, and sanitized failure mapping. The verifier
simply calls `loadAccountIdentity()` and returns the existing M5 outcomes —
`accountId` on success, or a sanitized `credentials_rejected` / `timeout` /
`unavailable` failure. The credential is an **unscoped** Atlassian API token;
scoped tokens are not supported, because they must be sent to
`https://api.atlassian.com/ex/jira/<cloudId>` rather than the direct
`https://<site>.atlassian.net` origin the client targets, so they fail here. The
HTTP transport is injected, so tests never reach live Jira.

### Encryption at rest (v2, tenant-only)

`token-cipher.ts` encrypts the API token with AES-256-GCM before it reaches
SQLite. Each encryption uses a fresh random 12-byte nonce, and the serialized
value is a versioned, dot-separated format (`v2.<nonce>.<ciphertext>.<authTag>`).
Additional authenticated data binds the ciphertext to the **credential type, the
credential format version, and the owning tenant** — and nothing else. Because
the Jira connection belongs to the tenant rather than to the user who configured
it, the credential context is the `tenantId` alone: `configured_by_user_id` is
audit metadata on the connection row and **does not participate in encryption or
decryption**. A stored value therefore decrypts under its tenant regardless of
who configured or is using the connection, but a ciphertext copied to another
tenant fails the authentication tag, as does any tampering. The AAD is encoded as
a fixed-order JSON array rather than a delimiter-joined string, so a field value
that itself contains a delimiter can never forge a field boundary. Decryption
accepts only the `v2` format; the previous `v1` format (whose AAD included the
configuring user id) is unsupported and fails with a generic sanitized error
rather than being migrated in place — see migration 005 below.

The 32-byte key comes from `JIRA_CREDENTIAL_ENCRYPTION_KEY` (canonical standard
base64), resolved at startup in `config/jira-crypto.ts`. Decoding is strict: the
value must match the standard base64 alphabet with valid padding and re-encode
back to exactly the input (which rejects invalid characters, embedded whitespace,
trailing garbage, and malformed padding that `Buffer.from(_, 'base64')` would
otherwise silently ignore) and decode to exactly 32 bytes. A malformed key fails
startup with a sanitized error, while a missing key leaves the rest of the
application running and makes the Jira endpoints return HTTP 503
`jira_not_configured`. The key is never logged or echoed in any error.

### Migration to v2 credentials (migration 005)

`005_jira_connection_v2_credentials.sql` is a forward-only migration that
`DELETE`s every row from `jira_connections`. Existing rows hold `v1` ciphertext
bound to `(tenantId, configuredByUserId)`, which the tenant-only `v2` cipher
cannot decrypt; rather than leave undecryptable rows that still appear connected,
the migration removes them. Affected tenants become disconnected and must
reconnect, and their next connection is stored as `v2`. The `jira_connections`
schema — its columns, the `UNIQUE (tenant_id)` constraint, and the composite
foreign key — is unchanged. Like every migration it runs inside the migrator's
transaction and is recorded once in `schema_migrations`, so a re-run is skipped
and never re-deletes. This is an approved POC decision: there is no backward
compatibility with `v1` ciphertext, and deleting existing local Jira connection
data is acceptable. Migrations 003 and 004 are not modified.

## Jira integration layer (Milestone 7)

Milestone 7 adds one secure backend abstraction for authenticated Jira Cloud API
access using the authenticated tenant's shared connection. It is backend only:
there is no new frontend, no new REST endpoint, and no ticket creation. It owns
two operations currently required — loading the Jira account identity (for the
existing credential-verification flow) and validating a Jira project — and
deliberately avoids becoming a general-purpose Atlassian SDK.

### The central Jira client

`jira-client.ts` is the single component that owns Jira HTTP behavior; nothing
else in the application builds a Jira request, reads a Jira response, or touches
the Authorization header. A `JiraClient` is constructed with an already-validated
direct Jira Cloud origin, the stored Atlassian email, the decrypted API token, an
injected fetch-compatible transport, and a timeout. It:

- builds Basic authentication once in memory and never persists or logs the
  plaintext token or the Authorization header;
- constructs request URLs only from the validated origin plus
  application-controlled paths, and safely percent-encodes the dynamic project
  identifier — it never uses a response's own URL for a follow-up;
- uses `redirect: 'manual'` and never follows redirects;
- arms an explicit timeout across the entire response lifecycle, including the
  full body read, so a stall while reading the body maps to `timeout`;
- validates every response shape at runtime; and
- returns only sanitized outcomes — never a raw Jira body, network error,
  redirect location, stack trace, credential, or internal exception message.

`loadAccountIdentity()` performs `GET /rest/api/3/myself` and returns the account
id or a sanitized `credentials_rejected` / `timeout` / `unavailable` failure.
`validateProject(projectIdOrKey)` performs
`GET /rest/api/3/project/{projectIdOrKey}?expand=issueTypes`, validates the
response shape, returns the project id, canonical key, and the id of the
non-subtask issue type named exactly `Task`, or a sanitized failure
distinguishing `project_inaccessible` (403 or 404 — the authenticated account
cannot reach the project), `task_unsupported` (no normal `Task`),
`credentials_rejected` (401), `timeout`, and `unavailable` (redirects, 429, 5xx,
network errors, malformed JSON, and malformed success shapes). A project whose
only `Task` is a subtask is **not** accepted. (Credential verification via
`loadAccountIdentity()` still treats both 401 and 403 as `credentials_rejected`.)

### The credential verifier reuses the client

`jira-verifier.ts` no longer maintains its own HTTP implementation. It builds a
short-lived `JiraClient` and calls `loadAccountIdentity()`, mapping the result to
the unchanged M5 verifier contract (`accountId` on success;
`credentials_rejected`, `timeout`, or `unavailable` on failure). The M5 connection
endpoints, status codes, and sanitized error envelopes are therefore preserved,
including the rule that a failed verification never overwrites an existing
connection.

### Tenant-scoped integration service

`jira-integration-service.ts` is the tenant boundary for Jira access. It receives
an `AuthContext` and loads the connection **only** through
`JiraConnectionRepository.findByTenant(context.tenantId)`. It never accepts a
tenantId, userId, connectionId, site URL, email, or credential-ownership value
from untrusted request data, so cross-tenant access is impossible even when
another connection's id, key, site URL, or configurer is known. When the tenant
has no connection it returns a distinct `not_connected` result. As defense in
depth it re-validates the stored site URL before any network request and performs
no network call when it is invalid. It decrypts the token only immediately before
an outbound operation, bound to the stored connection's `tenantId` alone (never
`context.userId` or `configured_by_user_id`); a wrong key, malformed ciphertext,
unsupported (`v1`) version, or authentication-tag failure all collapse into one
sanitized `configuration_error`. It then creates a short-lived `JiraClient` with
the stored origin, stored email, and decrypted token, keeping the plaintext token
in the smallest practical scope, and maps the client's outcome to a tenant-scoped
project-validation result (`valid`, `not_connected`, `project_inaccessible`,
`task_unsupported`, `credentials_rejected`, `timeout`, `unavailable`,
`configuration_error`). No result variant ever carries the plaintext token.

### Terminal error handling

`app.ts` registers two error-handling middlewares after all routes. The first
translates body-parser failures (malformed JSON, payload too large) into the same
structured 400 `invalid_request` shape the routes use. The second is a terminal
catch-all for any unexpected error that escapes a route (for example an
asynchronous rejection forwarded by `.catch(next)`): if the response has already
started it delegates to Express, otherwise it returns a stable, opaque
HTTP 500 `{ "error": { "code": "internal_error", "message": "An unexpected error occurred." } }`.
It deliberately leaks nothing about the failure — no error message, stack,
dependency or database detail, request body, cookie, or credential — and logs
nothing about the error. Both handlers set `Cache-Control: no-store` for
`/api/auth` and `/api/jira` paths so error responses on credential-bearing routes
are never cached.

### Why no ORM or generic repository layer

The schema is intentionally tiny and the queries are simple and explicit. Using
the built-in `node:sqlite` API with hand-written SQL keeps the persistence layer
easy to read and audit, avoids an additional SQLite-specific native database
dependency, and makes the tenant boundary visible in every query. The project
does still include one binary runtime dependency, `argon2`, for password
hashing, so this is not a no-native-dependency design. The main reason for
avoiding an ORM remains keeping SQL explicit, auditable, and visibly
tenant-scoped: an ORM or a generic base repository would add abstraction and
indirection with no payoff at this scope, and a generic layer risks hiding the
very tenant-scoping the design depends on.

## Ticket creation domain service (Milestone 8)

Milestone 8 adds the first ticket-creation flow: an authenticated user creates a
Jira issue (of the fixed `Task` type) in a project, and the application records
local provenance for the created issue. It builds directly on the Milestone 7
integration layer and adds one REST endpoint, one domain service, and one
provenance table. It is backend only.

### Request boundary and ownership

`/api/tickets` (`ticket-routes.ts`) sits behind `requireAuth` and sets
`Cache-Control: no-store` on every response. `POST /api/tickets` accepts only
three domain fields — `projectKey`, `title`, and `description` — and derives
`tenantId` and the creating `userId` solely from the session. Any client-supplied
`tenantId`, `userId`, `connectionId`, `siteUrl`, `issueType`, or ownership field
in the body is ignored: the validator reads only the three domain fields, so no
request input can redirect the ticket to another tenant, connection, site, or
issue type. The body is fully validated before any Jira network request:
`projectKey` is trimmed, uppercased, and checked against a conservative Jira
project-key syntax and length bound; `title` and `description` are trimmed,
required to be non-empty, and bounded in length, with `description` preserving
meaningful internal line breaks. No validation framework is used.

### Same-connection validate-then-create flow

`jira-integration-service.ts` gains `createTicket(context, input)`. It loads the
tenant's shared connection **exactly once** via
`JiraConnectionRepository.findByTenant(context.tenantId)`, re-validates the
stored site URL, and decrypts the token just-in-time bound to the stored tenant
only — identical to the project-validation path. It then constructs a **single**
short-lived `JiraClient` and uses that one client for **both** project validation
and issue creation. This is deliberate: it does not call the public
`validateProject` and then independently reload the connection for creation, so a
concurrent connection replacement can never make validation and creation run
against different Jira connections. On success it returns the sanitized Jira issue
id and key together with the exact connection and project metadata used
(connection id, site URL, project id, canonical project key), so the caller
records provenance consistent with the connection the issue was actually created
against. Every failure mirrors the project-validation outcomes and never carries
the plaintext token or raw Jira content.

`jira-client.ts` gains `createIssue(input)`, which performs
`POST /rest/api/3/issue` with `{ fields: { project: { id }, issuetype: { id },
summary, description } }`. The project id and Task issue-type id come only from
the prior validation result, never from request input; the description is
converted to a minimal ADF document that preserves internal line breaks as
deterministic `hardBreak` nodes (ADF forbids empty text nodes, so empty lines emit
only a break). It runtime-validates the response and returns only a non-empty
issue id and key, mapping a 401 to `credentials_rejected`, a stall to `timeout`,
and every other rejection (a Jira-rejected creation, redirect, 429, 5xx, network
error, or malformed response) to `unavailable`. No raw Jira content escapes. The
client remains Jira-specific and is not a general-purpose SDK.

### Provenance is recorded only after Jira confirms creation

`ticket-service.ts` is the domain service composing the integration layer with
`TicketProvenanceRepository`. It delegates to `createTicket`; on any non-`created`
outcome it passes the sanitized result straight through. Only after Jira returns a
validated successful creation does it insert one provenance row, using the exact
connection and project metadata the integration layer reported. No pending or
placeholder row is ever written before Jira is called.

`jira_ticket_provenance` (migration `006_jira_ticket_provenance.sql`) is a focused
`STRICT` table storing only stable identifiers and an audit trail: a provenance
id, the owning `tenant_id`, the creating `created_by_user_id`, the
`jira_connection_id`, a `jira_site_url` snapshot, the `jira_project_id` /
`jira_project_key`, the `jira_issue_id` / `jira_issue_key`, and a local
`created_at`. It deliberately stores **no** ticket title, description, credential,
or raw Jira response — Jira remains the source of truth for mutable issue
contents, and the application keeps only the minimal pointer needed to identify
the created issue. Tenant safety is enforced by composite foreign keys into
`users(tenant_id, id)` and `jira_connections(tenant_id, id)` (the latter backed by
a new `UNIQUE (tenant_id, id)` index on `jira_connections` that the migration adds
so the composite reference resolves). A `UNIQUE (tenant_id, jira_site_url,
jira_issue_id)` constraint prevents recording the same issue twice for a tenant
and site. The `jira_site_url` is stored as a snapshot rather than only referencing
the connection, so the row keeps identifying which site the issue lives on even
after the tenant replaces its connection.

### Sequential creation is not a distributed transaction (approved POC tradeoff)

Jira issue creation and local provenance persistence are sequential and are not
atomic, so the application cannot guarantee that every issue Jira creates also has
a local provenance row. Two distinct cases leave an issue untracked:

- **Confirmed creation, failed provenance.** Jira confirms the creation and
  returns the issue id and key, but the subsequent provenance insert fails (for
  example, the unique constraint rejects a duplicate). The domain service returns a
  distinct `persistence_failed` outcome and the route maps it to an opaque HTTP
  500; the already-created Jira issue remains untracked locally.
- **Unconfirmed creation after a timeout.** Jira may actually create the issue, but
  the application times out or loses the response while waiting for it or reading
  the response body. The application never learns the resulting issue id or key, so
  it records no provenance and returns a timeout (`jira_timeout`, HTTP 504) even
  though the issue may in fact exist in Jira.

There is deliberately no idempotency key, durable operation tracking, safe-retry
mechanism, reconciliation worker, compensating deletion, or queue/worker state
machine. This is an explicitly approved POC simplification documented in
`docs/assumptions.md`; the production alternative (an idempotent, durable creation
workflow with operation tracking, safe retries, and reconciliation/recovery) is
noted there. Jira remains the source of truth for which issues exist. Because the
flow is not idempotent, an immediate retry after an unconfirmed timeout may create
a duplicate Jira issue.

### Outcome-to-status mapping

The route maps the domain outcomes to stable, sanitized HTTP responses: `created`
→ 201 `{ issueId, issueKey }`; `not_connected` → 409 `jira_not_connected`;
`project_inaccessible` → 422 `jira_project_inaccessible`; `task_unsupported` → 422
`jira_task_unsupported`; `credentials_rejected` → 502 `jira_credentials_rejected`
("The stored Jira credentials were rejected. Reconnect Jira and try again.");
`unavailable` → 502 `jira_unreachable`; `timeout` → 504 `jira_timeout`;
`configuration_error` → 503
`jira_not_configured` (the encryption key is absent or the stored credential
cannot be decrypted); and `persistence_failed` → 500 `internal_error`. An invalid
body returns 400 `invalid_request` before any Jira call, and an unauthenticated
request returns 401 `unauthenticated`. The terminal error handlers in `app.ts` now
also apply `Cache-Control: no-store` to `/api/tickets`, so error responses on this
credential-bearing route are never cached. Notably, for ticket creation a
credential rejection maps to 502 (the connection was previously verified, so a
later rejection is treated as an upstream failure) rather than the 422 used by the
M5 connection endpoint. The two 502 cases are deliberately distinguished: a
rejection of the stored credentials returns `jira_credentials_rejected` so the
caller knows to reconnect Jira, while a network error, malformed or rate-limited
response, or 5xx returns the generic `jira_unreachable`.

## Frontend ticket creation (Milestone 9)

Milestone 9 adds the user-facing ticket-creation flow. It is **frontend only** and
consumes the unchanged Milestone 8 `POST /api/tickets` contract; no backend
behavior changed. The flow follows the same client boundary as the rest of the
frontend: it holds no secrets, talks to the backend only over a relative `/api`
request with the same-origin session cookie, and derives the tenant and creating
user solely from the server-side session.

### End-to-end flow

```
TicketCreationPanel (form: projectKey, title, description)
  -> frontend ticket API module (src/api/tickets.ts: createTicket)
  -> POST /api/tickets (relative, same-origin cookie, via the Vite proxy)
  -> existing Milestone 8 backend ticket service
  -> 201 { issueId, issueKey } | sanitized { error: { code } }
```

### Ticket API module

`src/api/tickets.ts` mirrors the `auth.ts`/`jira.ts` style: a small, explicit
module — not a generic client. It exposes `createTicket`, a `TicketCreationRequest`
type, a `CreatedTicket` success type, a typed `TicketApiError`, a
`messageForTicketError` helper mapping each error kind to safe generic copy, and an
`isUncertainTicketOutcome` predicate. The request body carries exactly
`projectKey`, `title`, and `description`; no tenant, user, connection, site, or
issue-type field is ever sent, so the server-derived ownership boundary is intact
from the browser down. It reads the structured `{ error: { code } }` envelope
defensively and maps the documented codes (`invalid_request`, `unauthenticated`,
`jira_not_connected`, `jira_project_inaccessible`, `jira_task_unsupported`,
`jira_credentials_rejected`, `jira_unreachable`, `jira_timeout`,
`jira_not_configured`, `internal_error`) plus transport and unexpected-status
outcomes to distinct kinds. The success body is parsed through a guard that reads
**only** non-empty string `issueId`/`issueKey`, so an unexpected or malformed body
becomes a `server` error rather than a bad render. The backend *message* is always
discarded, the module logs nothing, and it never retries — an unconfirmed creation
must not be silently duplicated.

### Ticket creation panel

`src/components/TicketCreationPanel.tsx` owns the controlled `projectKey`/`title`/
`description` fields (the project-key input preserves exactly the casing the user
types and is normalized to uppercase only on submit), the submit lifecycle, and
the success/error feedback. Project keys are case-insensitive: the frontend trims
and uppercases the value when validating and submitting, and the backend
independently trims and uppercases it before its own validation, so lowercase
input such as `scrum` is valid and becomes the canonical `SCRUM`. Uppercase is the
canonical form used for consistency and provenance, not because Jira rejects
lowercase input. Client-side validation mirrors the backend limits (project-key
syntax and 2–10 length, non-empty bounded title ≤ 255 and description ≤ 5000,
internal description line breaks preserved) but is explicitly only a usability
aid, not a security boundary — the backend stays authoritative. A client validation failure shows an inline `role="alert"` message
and makes no network request. While a request is in flight all controls are
disabled and a re-entrant submit is ignored, so duplicate submissions cannot
produce more than one request. On HTTP 201 the panel announces the returned issue
key through a `role="status"` region, clears the title and description, and keeps
the project key so the user can file another ticket in the same project. Each
documented failure renders safe, category-specific copy; an expired session is
treated distinctly from retryable failures; and every *uncertain* outcome renders
a distinct warning that Jira may already have created the issue and that the user
should check Jira before retrying because a retry may create a duplicate. Because
ticket creation is not idempotent, the uncertain class is not limited to upstream
timeouts: it covers `jira_timeout`, the generic `jira_unreachable`, a
browser/network failure after submission where the response is never observed,
`internal_error` (which can mean Jira created the issue but the backend then failed
to record provenance or build the response), and any malformed or unexpected
server/success response. All of these may occur after Jira created the issue, so
the UI warns the ticket may already exist, tells the user to check Jira before
retrying, warns that retrying may create a duplicate, and never retries
automatically — matching the approved Milestone 8 POC tradeoff that ticket
creation is not idempotent. Raw backend/Jira text, technical
error codes, credentials, session values, and internal IDs are never rendered, and
form contents live only in transient React state (never browser storage, the URL,
or global state).

### Gating on the loaded connection state

The ticket panel is shown only once the tenant's shared Jira connection has loaded
successfully as *connected*. Rather than issuing a second connection-status
request, `JiraConnectionPanel` reports its loaded connection state upward through a
small `onConnectionChange` callback (it reports `false` while loading, on a
status-load error, and when disconnected, and `true` once a connected status is
loaded or a save succeeds). `AuthenticatedShell` holds that boolean and renders
both the ticket-creation and recent-tickets panels only when it is `true`.

`JiraConnectionPanel` also exposes an `onConnectionSaved` callback, called after
a successful connection creation or replacement (never after a failure). The shell
increments `refreshKey` in response, which causes `RecentTicketsPanel` to abort
any active request, enter loading state, and immediately re-fetch against the new
Jira connection. This ensures old-site ticket links disappear when the tenant
switches Jira sites, without issuing another connection-status request or exposing
any credential or raw connection data to the ticket panel.

This is a deliberately narrow local composition: connection management, ticket
creation, and the recent-ticket list stay as separate components, and no global
state, routing, or broad context abstraction is introduced.

## Recent tickets backend (Milestone 10)

Milestone 10 adds the first ticket read: `GET /api/tickets?projectKey=...` returns
the ten most recent tickets created through this application for the authenticated
tenant, the currently connected Jira site, and one selected project. It builds on
the Milestone 8 provenance table and the Milestone 7 Jira client, adding one
read handler on the existing `/api/tickets` route, one read service, one bulk
hydration operation on the client, and one additive index. It is backend only.

### Request boundary

`GET /api/tickets` shares the `/api/tickets` router, so it inherits `requireAuth`
and `Cache-Control: no-store`. The only request input is the `projectKey` query
parameter, validated by `validateProjectKeyQuery` with the same conservative
syntax and length used at creation time and normalized (trim, uppercase). Express
parses a repeated `projectKey` as an array, which is rejected, so no ambiguous or
duplicated value can reach the query; a missing, empty, or malformed key is a
structured 400 before any Jira call. No tenant, user, connection, site, credential,
limit, cursor, or ownership value is ever read from the request. There is no
user-controlled pagination: the batch size and result cap are fixed internal
constants.

### Membership from local provenance, values from live Jira

The trust boundary is explicit. **Local provenance** (`jira_ticket_provenance`)
decides *which* tickets appear and in what order; **Jira** decides every displayed
*value*. `TicketProvenanceRepository.listRecentCandidates` returns only the
identifiers the flow needs (provenance `id`, immutable `jira_issue_id`,
`created_at`) for rows matching the tenant, the current connected `jira_site_url`,
and the normalized `jira_project_key`. It is deliberately **not** filtered by
`created_by_user_id` (so two users in a tenant see the same tenant-owned tickets)
and **not** by `jira_connection_id` (the site-URL snapshot is the visibility
boundary, so a row created against the now-current site is still visible after the
connection row is replaced in place). Order is stable (`created_at DESC, id DESC`)
and pagination is internal keyset: the first batch passes no cursor, and a later
batch selects rows strictly after the last loaded candidate under the same order,
so concurrent inserts never shift or duplicate a page. Migration
`007_jira_ticket_provenance_recent_index.sql` adds an additive index on
`(tenant_id, jira_site_url, jira_project_key, created_at DESC, id DESC)` that
serves the equality filter, ordering, and keyset comparison directly.

### One connection snapshot, batched bulk hydration

`recent-tickets-service.ts` loads the tenant connection **exactly once** through a
narrowly-scoped helper, `jira-connection-loader.ts`. The helper mirrors the M8
integration-service connection handling — `findByTenant`, re-validate the site URL
(defense in depth), decrypt the token just-in-time bound to the stored tenant —
and constructs a single short-lived `JiraClient`, returning it together with the
re-validated `origin` and the stored `siteUrl`. Extracting this helper rather than
reloading per batch is deliberate: the service reuses the one client and origin
snapshot for every batch, so a concurrent connection replacement can never make
one request mix two Jira sites. A missing connection is `not_connected`; an invalid
stored site URL or an undecryptable token collapses to a single
`configuration_error`, and no variant carries the plaintext token.

The service loads candidates in fixed batches of 25 and hydrates each with one
`JiraClient.bulkFetchIssues` call (`POST /rest/api/3/issue/bulkfetch`, requesting
only `summary`, `created`, and `project`). The client identifies issues by their
immutable id, assumes no response order, and runtime-validates the **complete**
success response: the top-level `issues` array must be present and every present
issue must validate fully, so a single malformed issue invalidates the whole
response (mapped to `unavailable`). `issueErrors` and omitted issues are simply
absent. The service maps the returned issues by id, then rebuilds the result in
local provenance order, skipping any candidate Jira omitted (deleted, moved away,
inaccessible) and any issue whose current project key differs from the selected
project (a moved issue). It keeps loading later batches until ten valid tickets are
found or candidates are exhausted (a short batch signals exhaustion). Each returned
item's `url` is built only from the validated current `origin` plus `/browse/` and
the percent-encoded current key — never a self/redirect/location URL.

### Outcome-to-status mapping

`ok` → 200 `{ tickets: [...] }` (an empty array when there are no valid results);
`not_connected` → 409 `jira_not_connected`; `credentials_rejected` → 502
`jira_credentials_rejected`; `unavailable` → 502 `jira_unreachable`; `timeout` →
504 `jira_timeout`; `configuration_error` → 503 `jira_not_configured`. An invalid
`projectKey` returns 400 `invalid_request` before any Jira call, and an
unauthenticated request returns 401 `unauthenticated`. The mapping mirrors the
sanitized Jira outcomes already used by ticket creation; no variant carries the
plaintext token, raw Jira content, or internal error detail.

## Frontend recent-tickets UI (Milestone 11)

Milestone 11 delivers the full recent-tickets UX redesign. It is **frontend
only** and consumes the unchanged Milestone 10 `GET /api/tickets?projectKey=...`
contract; no backend behavior changed. The flow follows the same client boundary
as the rest of the frontend: it holds no secrets, talks to the backend only over
a relative `/api` request with the same-origin session cookie, and derives
displayed values solely from the validated API response.

### Page-level project selector

`src/components/ProjectSelector.tsx` is a new standalone component rendered in
the main content area when the tenant is Jira-connected. It shows a "Jira
project" label, a single text input, and a "Used for recent tickets and new
ticket creation." hint. A validation error (`role="alert"`) appears only for
non-empty, invalid keys — an empty value is always silent. The component is not
inside any form element; it is wired directly into `AuthenticatedShell` via an
`onChange` prop.

### Shared project-key state and shell layout

`AuthenticatedShell` owns three pieces of state: the raw `projectKey` string, an
integer `refreshKey`, and a boolean `creationModalOpen`. When the tenant is
Jira-connected the shell renders:

1. `JiraConnectionPanel` in the header alongside user info.
2. `ProjectSelector` in the main area.
3. A no-project prompt **or** `RecentTicketsPanel`, gated on whether the
   normalized key is valid.
4. `TicketCreationModal` (rendered outside the flow, always present while
   Jira-connected, shown/hidden via the `open` prop).

`handleConnectionChange` is wrapped in `useCallback` because `JiraConnectionPanel`
lists `onConnectionChange` in its effect dependency array — an unstable reference
would cause that effect to re-run on every shell render. The other shell callbacks
(`handleTicketCreated`, `handleConnectionSaved`, `handleOpenCreationModal`,
`handleCloseCreationModal`) use `useCallback` as convention.

`handleConnectionSaved` increments `refreshKey` after `JiraConnectionPanel`
reports a successful connection creation or replacement, triggering an immediate
re-fetch against the new Jira site. A failed save never calls the callback.

### Shared project-key utility

`src/utils/project-key.ts` exports `normalizeProjectKey`, `isValidProjectKey`,
`PROJECT_KEY_PATTERN`, and `MAX_PROJECT_KEY_LENGTH`. `ProjectSelector` and
`RecentTicketsPanel` both import from this module. The pattern is the same
conservative Jira project-key syntax the backend enforces: `^[A-Z][A-Z0-9]+$`,
at least two characters, at most ten.

### Read API module extension

`src/api/tickets.ts` gains a second export group for the read side:
`RecentTicket`, `ListRecentTicketsResult`, `RecentTicketsErrorKind`,
`RecentTicketsApiError`, `messageForReadError`, and `listRecentTickets`. The
function sends `GET /api/tickets?projectKey=<encoded>` with
`credentials: 'same-origin'` and an optional `AbortSignal`. It propagates
`AbortError` (a `DOMException` with `name === 'AbortError'`) raw without wrapping
it in a `RecentTicketsApiError`, so the caller can check `signal.aborted` rather
than catch-filtering. Every other failure — including a network `TypeError` — is
mapped to a typed `RecentTicketsApiError`. The backend `message` field is always
discarded; `messageForReadError` provides safe, generic copy for each kind.

Success body validation is stricter than the creation side, because the response
is rendered directly:

- The top-level body must be an object with an `Array` `tickets` field.
- Each ticket must have non-empty string `issueId`, `issueKey`, `title`, and
  `url`, and a non-empty string `createdAt` whose `Date` parse is not `NaN`.
- Each `url` must parse as a valid URL with the `https:` protocol, a hostname
  matching `/^[^.]+\.atlassian\.net$/`, and a path starting with `/browse/`.
  HTTP URLs, non-Atlassian hosts, bare `atlassian.net`, and paths outside
  `/browse/` are all rejected.

A single invalid ticket item rejects the whole response as a `server` error
rather than silently dropping the item, so the caller always receives a
consistent, fully-validated list.

### TicketCreationForm component

`src/components/TicketCreationForm.tsx` is a new reusable form component that
accepts `projectKey: string` and an optional `onSuccess: (issueKey: string) =>
void`. It exposes only `title` and `description` inputs — no project-key input —
and shows a read-only "Creating in project `<key>`" context line. It owns the
full ticket-creation submit lifecycle: client-side validation, the `createTicket`
API call, success feedback (announced via `role="status"`) and field-clearing,
and error feedback (via `role="alert"` with a distinct uncertain-outcome warning
for non-idempotent failures). Duplicate submissions are prevented and controls
are disabled while a request is in flight.

### TicketCreationModal component

`src/components/TicketCreationModal.tsx` wraps `TicketCreationForm` in an
accessible modal. It renders `div[role="dialog" aria-modal="true"
aria-labelledby=…]` (rather than a native `<dialog>`) with a "Create ticket" h2
heading, a close (✕) button, and a Cancel button, and handles the Escape key.
Escape is blocked while the form is submitting (detected by checking whether the
form's submit button is disabled). On a successful creation it calls `onClose()`
first, then `onTicketCreated()` to trigger a `refreshKey` increment in the shell.
On failure the modal stays open. The `triggerRef` prop is used to return focus to
the opening button after the modal closes.

### RecentTicketsPanel component — Mode A and Mode B

`src/components/RecentTicketsPanel.tsx` accepts `projectKey: string`,
`refreshKey: number`, `onOpenCreationModal?: () => void`, and
`onTicketCreated?: () => void`. Its internal state is a single discriminated
union:

```
{ type: 'prompt' } | { type: 'loading' } | { type: 'success'; tickets } | { type: 'error'; kind }
```

The `prompt` state returns `null` — the shell shows a no-project prompt itself.
The `loading` and `error` states render a panel div without any heading. The
`success` state has two distinct modes determined solely by `tickets.length`:

**Mode A** (tickets exist): renders a `<section aria-labelledby=…>` with a
`.recent-tickets-header` flex row containing an h2 "Recent tickets" and a
"Create ticket" button that calls `onOpenCreationModal`. Followed by
`<ol className="recent-tickets-list">` with each ticket showing the title as an
`<a>` link (`target="_blank" rel="noopener noreferrer"`), the issue key, and a
`<time>` element with the ISO `dateTime` attribute. No inline creation form.

**Mode B** (zero tickets): renders a `<div className="recent-tickets-panel
first-ticket-panel">` with an h2 "Create your first Jira ticket!" heading, an
intro paragraph, and a `TicketCreationForm` that calls `onTicketCreated` on
success. No "Recent tickets" heading, no ticket list, and no empty-state text.

**Debouncing vs. immediate refresh** and **stale-response prevention** are
unchanged: three `useEffect` hooks (unmount cleanup, debounced key changes, and
immediate refresh on `refreshKey`), an `AbortController` per fetch, and stale
checks in `.then`/`.catch` handlers.

### End-to-end flow

```
AuthenticatedShell (projectKey, refreshKey, creationModalOpen)
  |-> JiraConnectionPanel (header: compact bar + modal)
  |-> ProjectSelector (page-level key input)
  |-> RecentTicketsPanel (projectKey, refreshKey, onOpenCreationModal, onTicketCreated)
  |     Mode A: list + "Create ticket" -> opens TicketCreationModal
  |     Mode B: TicketCreationForm -> POST /api/tickets -> onTicketCreated -> refreshKey++
  |     Error: safe copy + Retry
  |     -> GET /api/tickets?projectKey=<key> (debounced / immediate on refresh)
  |-> TicketCreationModal (open, onClose, onTicketCreated)
        -> TicketCreationForm -> POST /api/tickets -> onClose + refreshKey++
```

## API-key authentication (Milestone 12)

Milestone 12 adds application-issued API-key authentication as a second
authentication path alongside the existing session-cookie mechanism. It is backend
only and adds no new REST endpoints visible to external callers.

### Key format and generation

Keys follow the format `nhi_<keyId>.<secret>`:

- `keyId` — 16 cryptographically random bytes encoded as base64url (22 characters).
  This is the public selector stored as the primary key in `api_keys.id`.
- `secret` — 32 cryptographically random bytes encoded as base64url (43 characters,
  ≥ 256 bits of entropy). Only the SHA-256 hash of the secret is persisted; the
  plaintext is shown exactly once during local provisioning and cannot be recovered.
- `.` is the separator. Because `.` is not in the base64url alphabet
  (`A-Z a-z 0-9 - _`), the format is unambiguous regardless of the characters in
  either base64url component.

`api-key-token.ts` owns format generation, parsing, SHA-256 hashing, and
timing-safe verification. It never constructs an Authorization header and never
logs the secret or the full key.

### api_keys table

`008_api_keys.sql` creates a SQLite `STRICT` table with columns `id` (public
selector, primary key), `tenant_id`, `user_id`, `secret_hash`, and `created_at`. A
composite `FOREIGN KEY (tenant_id, user_id)` references `users(tenant_id, id)`,
enforcing referential integrity and tenant safety. There is no `revoked_at` column
and no soft-delete: revocation physically deletes the row, so a revoked key is
permanently indistinguishable from an unknown key.

### ApiKeyRepository

`ApiKeyRepository` exposes three operations:

- `create(record)` — inserts a new row with the public id, tenant/user metadata,
  and secret hash.
- `findById(keyId)` — looks up a row by the public key id. This lookup is
  **deliberately unscoped by tenant**: the key ID is the trusted selector chosen
  at generation time, and the ownership is then read from the stored row rather
  than from any request input.
- `deleteById(keyId)` — physically removes the row. Idempotent: a missing key id
  causes no error. There is no tombstone, no `revoked_at`, and no audit history.

### ApiKeyService

`ApiKeyService` exposes three operations:

- `create(tenantId, userId)` — generates the key and secret (both cryptographically
  random), hashes the secret with SHA-256, persists only the hash and metadata, and
  returns the `fullKey` exactly once. The plaintext secret is not retained after
  this call.
- `authenticate(rawKey)` → `AuthContext | null` — parses the raw key string into
  `keyId` and `secret`, looks up the record by `keyId` via `findById`, performs a
  timing-safe comparison of the SHA-256 hash of the presented secret against the
  stored hash, and on success returns an `AuthContext` constructed from the stored
  `tenantId` and `userId`. Returns `null` for every failure (malformed format,
  unknown id, wrong secret, deleted key). The timing-safe comparison prevents
  secret enumeration via response timing.
- `revoke(keyId)` → `boolean` — delegates to `deleteById` and returns `true` when
  the row existed and was deleted, `false` when it was already absent.

### Middleware (createRequireApiKeyAuth)

`createRequireApiKeyAuth` is an Express middleware factory. It reads the
`Authorization: Bearer <api-key>` header from the incoming request and delegates
verification to `ApiKeyService.authenticate`. On success it writes `req.auth` with
the same `AuthenticatedState` shape used by session authentication, populating
`req.auth.context` with the `AuthContext` from the stored key record. All failure
paths — missing `Authorization` header, wrong scheme (not `Bearer`), malformed key
format, unknown key ID, wrong secret, deleted key — return the same
`401 Unauthenticated` response with `Cache-Control: no-store`. No failure path
discloses whether the key existed, whether the ID was valid, or any detail about
why the request was rejected.

### Trust boundary

Ownership derives exclusively from the stored key record. The middleware never
reads `tenantId`, `userId`, or any ownership-related value from the request body,
query string, path parameters, or additional headers. A key authenticates exactly
as the tenant and user recorded at creation time, with no override path. This
mirrors the session-auth trust model where `tenantId` and `userId` come solely
from the stored session row.

### AuthContext reuse

The middleware populates `req.auth.context` with the same `AuthContext` shape used
by `requireAuth` (session middleware). Downstream route handlers can use either
middleware interchangeably for authorization checks. The `user` field in
`AuthenticatedState` is now **optional**: session authentication populates it with
the loaded `SafeUser`; API-key authentication does not load a user record and
leaves `user` absent. The `AuthContext` type comment was updated to remove
session-only language, since it now describes a shared context populated by both
authentication paths.

### Local provisioning CLI scripts

Two CLI scripts provide local key management. There is no management UI and no REST
provisioning endpoint in M12; all provisioning is through these two scripts.

- `api-key-create.ts` (`npm run api-key:create --workspace apps/api -- --email <email>`)
  — validates the email address before the user lookup and API-key creation: trims input, requires
  exactly one `@`, a non-empty local part, a non-empty domain with at least one dot
  but no leading or trailing dot, no embedded whitespace, and at most 254 characters.
  A malformed or overlong address produces a format error that is distinct from a
  user-not-found error. Any argument or validation failure exits non-zero. On a valid
  address, the script resolves the user by globally unique email using
  `UserRepository.findByEmailForAuthentication`, derives `tenantId` and `userId` from
  the stored user record (never from CLI arguments), generates and persists the key
  via `ApiKeyService.create`, and prints the full plaintext key exactly once with a
  clear warning that it cannot be retrieved again. Success exits 0.
- `api-key-revoke.ts` (`npm run api-key:revoke --workspace apps/api -- --key-id <id>`)
  — calls `ApiKeyService.revoke(keyId)` and physically deletes the row. Missing or
  empty `--key-id` exits non-zero. An already-absent key ID exits 0 and reports that
  no row was found (idempotent — no tombstone, no failure).
