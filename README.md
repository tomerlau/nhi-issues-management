# NHI Issues Management

A focused proof of concept for managing Non-Human Identity (NHI) findings and
turning them into Jira tickets. It includes a small React UI for tenant users,
an Express backend, a tenant-wide Jira Cloud integration, local ticket
provenance, and an external REST API for creating tickets from outside callers
using application-issued API keys.

## Features

- Cookie-based application login with seeded demo tenants and users.
- Tenant-wide Jira Cloud connection using an unscoped Atlassian API token,
  encrypted at rest.
- Ticket creation against the tenant's shared Jira connection (fixed `Task`
  issue type) with local provenance.
- "Recent tickets" view for a selected Jira project, with values hydrated live
  from Jira.
- External REST endpoint `POST /api/v1/tickets` authenticated by an
  application-issued API key (Bearer).
- Local CLI commands to provision and revoke API keys.
- SQLite persistence with explicit, versioned migrations.

## Quick start

Requirements: Node.js 24 (`.nvmrc`) and npm 10+.

```bash
nvm use            # or otherwise ensure Node.js 24 is active
npm ci
npm run setup      # create apps/api/.env, generate the Jira key, migrate and seed
npm run dev        # start API on :3001 and web on :5173
```

Open <http://localhost:5173> and sign in with one of the demo accounts below.

`npm run setup` is idempotent: it creates the git-ignored `apps/api/.env` from
the example, fills `JIRA_CREDENTIAL_ENCRYPTION_KEY` with a freshly generated
32-byte value only when it is missing or empty, never overwrites a valid
existing key, and never prints the key value. Without that key, Jira-dependent
operations are unavailable and return HTTP 503 `jira_not_configured`. See
[docs/setup.md](docs/setup.md) for the full setup.

## Demo users

`npm run seed` creates two tenants and three users. Passwords are public test
credentials for the local POC only; the database stores only their Argon2id
hashes.

| Tenant          | Email                      | Password            |
| --------------- | -------------------------- | ------------------- |
| `tenant-acme`   | `alice@example.com`        | `acme-alice-demo`   |
| `tenant-acme`   | `bob@example.com`          | `acme-bob-demo`     |
| `tenant-globex` | `alice@globex.example.com` | `globex-alice-demo` |

## Main commands

Run from the repository root.

| Command                                       | Purpose                                            |
| --------------------------------------------- | -------------------------------------------------- |
| `npm run setup`                               | Create the git-ignored `apps/api/.env`, generate the Jira encryption key when missing, then migrate and seed. |
| `npm run dev`                                 | Run API (`:3001`) and web (`:5173`) together.      |
| `npm run migrate`                             | Apply pending SQL migrations.                      |
| `npm run seed`                                | Migrate, then insert demo tenants/users (idempotent). |
| `npm run lint`                                | ESLint across the repo.                            |
| `npm run typecheck`                           | TypeScript strict typecheck for both apps.         |
| `npm test`                                    | Backend and frontend Vitest test suites.           |
| `npm run build`                               | Build backend and frontend.                        |
| `npm run check`                               | Canonical quality gate: lint, typecheck, tests, workflow-hook tests, setup tests, build. |
| `npm run api-key:create --workspace apps/api -- --email <email>` | Provision an API key for a user.   |
| `npm run api-key:revoke --workspace apps/api -- --key-id <id>`   | Revoke an API key.                |

## Repository layout

```
apps/
  api/      Express + TypeScript backend
  web/      React + Vite frontend
docs/       Product documentation (see below)
```

## Documentation

- [docs/setup.md](docs/setup.md) — install, environment, run, API-key CLI.
- [docs/architecture.md](docs/architecture.md) — components, request flows,
  persistence, sessions, Jira integration.
- [docs/api.md](docs/api.md) — external ticket REST API.
- [docs/security.md](docs/security.md) — trust boundaries, sessions, isolation,
  credential handling, SSRF, API keys, logging.
- [docs/assumptions.md](docs/assumptions.md) — POC assumptions, tradeoffs,
  production alternatives.
- [docs/manual-validation.md](docs/manual-validation.md) — end-to-end manual
  validation checklist.

The optional NHI Blog Digest bonus is **not implemented** in this POC.
