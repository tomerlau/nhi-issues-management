# Architecture

This document describes the architecture that currently exists through
Milestone 7. It intentionally avoids designing later domain layers in detail.

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
endpoints — currently the authentication endpoints `/api/auth/*`. The backend
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

The token is verified before anything is stored. `jira-verifier.ts` is a small,
focused verifier — deliberately *not* the reusable Jira integration layer planned
for M7 (see below). It validates the submitted site URL first
(`site-url.ts`), accepting only normalized `https://<site>.atlassian.net`
origins; this is the SSRF boundary, so no network request is made until
validation succeeds. It then calls `GET {origin}/rest/api/3/myself` with Jira
Cloud Basic authentication, building the `Authorization` header only in memory
for the outbound request — never persisted, never logged. The credential is an
**unscoped** Atlassian API token; scoped tokens are not supported, because they
must be sent to `https://api.atlassian.com/ex/jira/<cloudId>` rather than the
direct `https://<site>.atlassian.net` origin this verifier targets, so they fail
here. The HTTP transport is injected, so tests never reach live Jira. Redirects
are not followed, and an explicit timeout bounds the *entire* response lifecycle:
the abort stays armed across the request, the status check, and the full body
read, and is cleared only once the whole operation finishes, so a stall while
reading the body maps to `timeout` rather than `unavailable`. The JSON response
shape is validated at runtime: a success must carry a non-empty `accountId` (the
submitted email is stored as the username, since Jira may hide the account
email). Every failure is mapped to a sanitized outcome — rejected credentials,
timeout, or unavailable — and never exposes raw Jira bodies, network errors, or
redirect destinations.

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
distinguishing `project_inaccessible` (404), `task_unsupported` (no normal
`Task`), `credentials_rejected` (401/403), `timeout`, and `unavailable`
(redirects, 429, 5xx, network errors, malformed JSON, and malformed success
shapes). A project whose only `Task` is a subtask is **not** accepted.

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
