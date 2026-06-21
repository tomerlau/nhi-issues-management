# IdentityHub to Jira

A focused proof of concept for integrating Oasis Security IdentityHub with Jira.

This repository is built in milestones. The current milestone adds backend-only
application authentication: globally unique user emails, scrypt-hashed
passwords, persistent server-side sessions, secure session cookies, and reusable
authentication middleware.

## Current milestone scope (Milestone 3: Application Authentication)

Implemented:

- Global email uniqueness for users, replacing the Milestone 2 per-tenant
  uniqueness, via a new migration that rebuilds the `users` table and adds a
  composite `(tenant_id, id)` key for tenant-aware authentication foreign keys.
- Password credentials stored separately from the user record in
  `user_credentials`, hashed with Node's built-in `crypto.scrypt` using a random
  salt and a versioned, self-describing hash format with constant-time
  verification. Plaintext passwords are never stored, and hashes are never
  returned by the user repository or any API response.
- Persistent server-side sessions in a `sessions` table that stores only the
  SHA-256 hash of an opaque 256-bit token, the owning tenant and user, and
  creation/expiration times. Sessions have an absolute eight-hour lifetime.
- Cookie-based authentication: the raw token is sent only in an `HttpOnly`,
  `SameSite=Lax`, `Path=/` cookie (`Secure` in production), never in JSON or
  client-side storage.
- Authentication endpoints `POST /api/auth/login`, `GET /api/auth/session`, and
  `POST /api/auth/logout`, all returning `Cache-Control: no-store`.
- Reusable authentication middleware that resolves the session from the cookie,
  loads the session and user within their tenant scope, and attaches a typed
  authenticated context — userId and tenantId always come from the session,
  never from request input.
- Idempotent demo seeding extended with deterministic password credentials.

Carried over from earlier milestones:

- npm-workspaces monorepo with separate `apps/api` (backend) and `apps/web` (frontend).
- SQLite persistence using the built-in Node.js 24 `node:sqlite` module (no ORM, no external SQLite library).
- Versioned, transactional, idempotent SQL migrations run by a minimal in-repo migration runner.
- Per-connection foreign-key enforcement (`PRAGMA foreign_keys = ON`), verified by the database factory.
- Tenant-scoped repositories: every tenant-owned user read/write requires the owning `tenantId`.
- Express backend exposing `GET /api/health` (unchanged; unauthenticated and not touching the database).
- React + Vite frontend showing backend availability with a retry action.
- Quality gates (ESLint, strict typecheck, Vitest, build) and GitHub Actions CI.

Explicitly **not** implemented in Milestone 3 (deferred to later work):

- Authentication UI; the frontend is unchanged.
- User registration, password reset or change, SSO, or social login.
- Roles, permissions, API keys, or tenant administration.
- Rate limiting, account lockout, or other abuse protections.
- Redis or distributed session storage; sessions are single-instance SQLite.
- A general-purpose authentication framework.
- Jira OAuth, Jira credentials/token encryption, Jira API access, or ticket creation.

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

`GET /api/health` returns HTTP 200 with exactly `{ "status": "ok" }`.

Stop the backend (or run only `npm run dev --workspace apps/web`) to see the
frontend switch to its unavailable state; use the retry action after restarting
the backend.

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
just the scrypt hash of each password, never the plaintext.

## Authentication

Authentication is backend-only and cookie-based. Login accepts only an email and
password; the backend derives the user and tenant from the stored user record,
and clients never provide or override `userId` or `tenantId` after login.

| Method & path           | Auth required | Purpose                                            |
| ----------------------- | ------------- | -------------------------------------------------- |
| `POST /api/auth/login`  | no            | Verify credentials, create a session, set cookie.  |
| `GET /api/auth/session` | yes (cookie)  | Return the authenticated user.                     |
| `POST /api/auth/logout` | no            | Revoke the current session and clear the cookie.   |

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

**Session** — `GET /api/auth/session` returns the same safe user shape on success
and an HTTP 401 with code `unauthenticated` when the cookie is missing, invalid,
expired, or revoked.

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

# The session is rejected afterwards (HTTP 401).
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

Inspect the database to confirm passwords are hashed and raw tokens are absent
(requires the `sqlite3` CLI; the application itself does not depend on it):

```bash
# Password hashes only — every value starts with the scrypt format prefix.
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

The frontend never calls the backend by absolute URL. It requests the relative
path `/api/health`. In development, the Vite dev server (`apps/web/vite.config.ts`)
proxies any request beginning with `/api` to `http://localhost:3001`. This keeps
the browser talking only to the Vite origin, so no permissive CORS configuration
is required on the backend.

## Repository structure

```
/
├── apps/
│   ├── api/                 # Express + TypeScript backend
│   │   ├── migrations/      # numbered *.sql migration files
│   │   ├── src/
│   │   │   ├── app.ts       # Express application construction
│   │   │   ├── server.ts    # process startup, db init, listening
│   │   │   ├── config/      # database path resolution (DATABASE_PATH)
│   │   │   ├── database/    # connection factory, migrator, lifecycle, seed
│   │   │   └── repositories/# tenant-scoped tenant and user repositories
│   │   └── test/            # backend Vitest tests
│   └── web/                 # React + Vite frontend
│       ├── src/
│       │   ├── api/         # typed backend API functions
│       │   ├── App.tsx      # backend-availability UI
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
