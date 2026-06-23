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
- "Recent tickets" view for a selected Jira project, with values hydrated
  live from Jira. The last valid project picked by the authenticated user is
  remembered in the browser and restored automatically on the next visit, so
  recent tickets load immediately. Short-form Jira project guidance lives in
  an accessible information tooltip on the project field (hover or keyboard
  focus) rather than persistent helper text.
- External REST endpoint `POST /api/v1/tickets` authenticated by an
  application-issued API key (Bearer).
- Local CLI commands to provision and revoke API keys.
- SQLite persistence with explicit, versioned migrations.

## Setup instructions

Requirements: Node.js 24 (`.nvmrc`) and npm 10+.

```bash
nvm use            # or otherwise ensure Node.js 24 is active
npm ci
npm run setup      # create apps/api/.env, generate the Jira encryption key, migrate and seed
npm run dev        # start API on :3001 and web on :5173
```

Open <http://localhost:5173> and sign in with one of the demo accounts below.

> **Setup behavior:** `npm run setup` is idempotent. It creates the
> git-ignored `apps/api/.env` from the example, fills
> `JIRA_CREDENTIAL_ENCRYPTION_KEY` with a freshly generated 32-byte value
> only when it is missing or empty, never overwrites a valid existing key,
> and never prints the key value. Without that key, Jira-dependent
> operations return HTTP 503 `jira_not_configured`. See
> [docs/setup.md](docs/setup.md) for the full setup.

## Demo users

`npm run seed` creates two tenants and three users. Passwords are public test
credentials for the local POC only; the database stores only their Argon2id
hashes.

| Tenant          | Email                      | Password            |
| --------------- | -------------------------- | ------------------- |
| `tenant-acme`   | `alice@example.com`        | `acme-alice-demo`   |
| `tenant-acme`   | `bob@example.com`          | `acme-bob-demo`     |
| `tenant-globex` | `alice@globex.example.com` | `globex-alice-demo` |

## Key assumptions and design decisions

- **User lifecycle management is out of scope.** There is no user
  registration, creation, invitation, deletion, or management through the UI
  or REST API. Demo users are provisioned only by the seed/setup flow
  (`npm run setup` / `npm run seed`).
- **API-key lifecycle management is local-only.** There is no UI or REST API
  for creating, listing, rotating, or revoking API keys. Keys are provisioned
  and revoked only through the local CLI commands
  (`npm run api-key:create` / `npm run api-key:revoke`).
- **Jira project selection is a text input, not a discovery dropdown.** The
  UI accepts a Jira project key in a validated text field. An ideal
  production UX would discover the projects accessible through the connected
  Atlassian account and present them in a searchable dropdown. That requires
  additional Jira project-discovery calls, pagination, loading and error
  states, and most likely caching, and was deliberately excluded from this
  time-boxed POC.
- **Unscoped Atlassian API tokens only.** The implementation supports only
  direct, unscoped Atlassian API tokens authenticated against
  `https://<site>.atlassian.net`. Scoped Atlassian API tokens require a
  different Atlassian host and the cloud-id-based request model, which does
  not match this POC's direct site-origin architecture. Scoped API tokens
  and OAuth 2.0 Authorization Code Flow (3LO) are not implemented.
- **Fixed Jira issue type.** Ticket creation supports only the Jira issue
  type named exactly `Task`. Issue-type selection, project-specific schemas,
  custom fields, and configurable field mappings are outside this POC.
- **The optional NHI Blog Digest bonus is not implemented.**

### Jira authentication choice

The POC uses a manually generated Atlassian API token because it keeps local
setup and reviewer validation straightforward: a single value pasted into
the Jira connection form is enough to exercise the full integration.

A production implementation would generally prefer **OAuth 2.0 Authorization
Code Flow (3LO)**: it avoids asking the user to paste a long-lived
credential, provides delegated authorization with user-visible scopes, and
gives the application standard lifecycle hooks (refresh, revocation,
expiry). Supporting 3LO requires registering an Atlassian OAuth
application, managing client credentials, handling redirect URIs and
consent, exchanging and refreshing access tokens, and securely storing the
resulting token material. That work was intentionally excluded from this
time-boxed POC. API-token authentication is not invalid or inherently
insecure for this scope — it is a deliberate POC-versus-production
tradeoff.

See [docs/assumptions.md](docs/assumptions.md) for the full list of POC
assumptions and production alternatives.

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
