# Architecture

This document describes the architecture that currently exists through
Milestone 5. It intentionally avoids designing later domain layers in detail.

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
frontend holds no backend secrets or configuration; the only thing it knows is
the relative endpoint `/api/health`.

## Local request flow

```
Browser
  -> Vite development server (5173)
  -> /api proxy
  -> Express GET /api/health (3001)
  -> { "status": "ok" }
```

In development the Vite dev server proxies any `/api/*` request to the backend.
This keeps the browser on a single origin and removes any need for permissive
CORS on the backend.

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
tenant and user, and an absolute eight-hour expiry. Session resolution
(`GET /api/auth/session` and the `requireAuth` middleware) reads the cookie,
hashes the token, looks up a non-expired session by that hash, and loads the user
within the session's own `(tenantId, userId)` scope. Logout deletes only the row
matching the current token hash, leaving every other session intact.

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

## Jira connection (Milestone 5)

Milestone 5 lets an authenticated user connect their own Jira Cloud account with
a site URL, Atlassian email, and API token. It is backend only and reuses the
existing authentication trust boundary: `tenantId` and `userId` come solely from
the session, never from request input.

### Connection boundary and ownership

`src/jira/` is a self-contained boundary mounted at `/api/jira`. Routes
(`jira-routes.ts`) sit behind `requireAuth`, validate input, and delegate to
`JiraConnectionService`, which orchestrates verification, encryption, and
persistence. The `JiraConnectionRepository` follows the existing explicit,
tenant-scoped SQLite style: every read and write requires both `tenantId` and
`userId`, there is no lookup by connection id or user id alone, and the
`jira_connections` table carries a composite foreign key into
`users(tenant_id, id)` plus a `UNIQUE (tenant_id, user_id)` constraint enforcing
one connection per user. Reconnection updates only the owner's own row.

### Credential verification flow

The token is verified before anything is stored. `jira-verifier.ts` is a small,
focused verifier — deliberately *not* the reusable Jira integration layer planned
for M7 (see below). It validates the submitted site URL first
(`site-url.ts`), accepting only normalized `https://<site>.atlassian.net`
origins; this is the SSRF boundary, so no network request is made until
validation succeeds. It then calls `GET {origin}/rest/api/3/myself` with Jira
Cloud Basic authentication, building the `Authorization` header only in memory
for the outbound request — never persisted, never logged. The HTTP transport is
injected, so tests never reach live Jira. Redirects are not followed, an explicit
timeout bounds the call, and the JSON response shape is validated at runtime: a
success must carry a non-empty `accountId` (the submitted email is stored as the
username, since Jira may hide the account email). Every failure is mapped to a
sanitized outcome — rejected credentials, timeout, or unavailable — and never
exposes raw Jira bodies, network errors, or redirect destinations.

### Encryption at rest

`token-cipher.ts` encrypts the API token with AES-256-GCM before it reaches
SQLite. Each encryption uses a fresh random 12-byte nonce, and the serialized
value is a versioned, dot-separated format (`v1.<nonce>.<ciphertext>.<authTag>`).
Additional authenticated data binds the ciphertext to the credential
type/version and the owning `(tenantId, userId)`, so a stored value cannot be
moved to a different owner and decrypted, and any tampering fails the
authentication tag. The 32-byte key comes from
`JIRA_CREDENTIAL_ENCRYPTION_KEY` (base64), resolved at startup in
`config/jira-crypto.ts`: a malformed key fails startup with a sanitized error,
while a missing key leaves the rest of the application running and makes the Jira
endpoints return HTTP 503 `jira_not_configured`. The key is never logged or
echoed in any error. The token is write-only in this milestone; nothing decrypts
it yet (decryption exists and is tested for the round trip and ownership
binding, and will be used by the M7 integration layer).

### Why this verifier is not the M7 Jira client

The verifier does exactly one thing — confirm a submitted credential is valid and
return its account id. It deliberately avoids becoming a general Jira client:
there is no shared transport abstraction, no project discovery, and no ticket
operations. M7 owns the reusable Jira integration layer; introducing that
abstraction now would add indirection with no payoff and risk hiding the focused
SSRF and credential-handling logic this milestone depends on.

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
