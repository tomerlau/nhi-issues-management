# IdentityHub to Jira

A focused proof of concept for integrating Oasis Security IdentityHub with Jira.

This repository is built in milestones. The current milestone adds the first
persistence and domain model: a local SQLite database with versioned
migrations, a tenant and user schema, tenant-scoped repositories, and
deterministic demo seed data for two isolated tenants.

## Current milestone scope (Milestone 2: Data Model and Tenant Isolation)

Implemented:

- SQLite persistence using the built-in Node.js 24 `node:sqlite` module (no ORM, no external SQLite library).
- Versioned, transactional, idempotent SQL migrations run by a minimal in-repo migration runner.
- `tenants` and `users` tables as SQLite `STRICT` tables, with `users` scoped to a tenant.
- Per-connection foreign-key enforcement (`PRAGMA foreign_keys = ON`), verified by the database factory.
- Tenant-scoped repositories: every user read/write requires the owning `tenantId`.
- Deterministic, idempotent demo seed of exactly two tenants and their demo users.
- Backend startup that opens the database, verifies foreign keys, and runs pending migrations before listening.
- Focused tests proving schema integrity, migration behavior, and cross-tenant isolation.

Carried over from Milestone 1:

- npm-workspaces monorepo with separate `apps/api` (backend) and `apps/web` (frontend).
- Express backend exposing `GET /api/health` (unchanged; it does not touch the database).
- React + Vite frontend showing backend availability with a retry action.
- Quality gates (ESLint, strict typecheck, Vitest, build) and GitHub Actions CI.

Explicitly **not** implemented in Milestone 2 (deferred to later work):

- Login, logout, sessions, cookies, registration, or tenant administration.
- Passwords, password hashes, API keys, roles, or any authentication fields (Milestone 3).
- Jira OAuth, Jira credentials/token encryption, Jira API access, or ticket creation.
- Tenant slugs or tenant codes; cascading tenant deletion.
- Frontend tenant or user screens, or any debug HTTP endpoint exposing tenants/users.
- Docker, PostgreSQL, an ORM, or a generic repository/migration framework.

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
  exactly one tenant. `tenant_id` references `tenants(id)`, and `(tenant_id,
  email)` is unique, so email uniqueness is **per tenant**, not global. Both
  tables are SQLite `STRICT` tables.

Repositories enforce tenant scope: every user query requires the owning
`tenantId`, so a user can never be read through another tenant's context. A user
ID alone is never sufficient to retrieve a user.

### Demo data

`npm run seed` creates exactly two tenants and their demo users with fixed,
readable IDs:

| Tenant          | Name         | User IDs / emails                                                   |
| --------------- | ------------ | ------------------------------------------------------------------- |
| `tenant-acme`   | Acme Corp    | `user-acme-alice` (`alice@example.com`), `user-acme-bob` (`bob@example.com`) |
| `tenant-globex` | Globex Corp  | `user-globex-alice` (`alice@example.com`)                           |

`alice@example.com` exists in both tenants on purpose, demonstrating that email
uniqueness is tenant-scoped. The demo records carry no passwords or credentials;
authentication is Milestone 3.

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
