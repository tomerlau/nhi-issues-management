# Setup

How to install, configure, and run the application from a clean clone.

## Prerequisites

- Node.js 24 (`>=24 <25`, see `.nvmrc`). With `nvm`, run `nvm use`.
- npm 10+ (bundled with Node.js 24).
- (Optional) `sqlite3` CLI to inspect the local database during validation.
- (Optional) An Atlassian account with an unscoped Jira Cloud API token if you
  want to exercise real Jira flows.

## Install

```bash
git clone https://github.com/tomerlau/nhi-issues-management.git
cd nhi-issues-management
nvm use            # or otherwise ensure Node.js 24 is active
npm ci
```

## Environment configuration

The API loads `apps/api/.env` on startup (built-in Node.js loader; no `dotenv`
dependency). Copy the example and edit it:

```bash
cp apps/api/.env.example apps/api/.env
```

### `JIRA_CREDENTIAL_ENCRYPTION_KEY`

Encryption key for Jira API tokens at rest (AES-256-GCM). Must be canonical
standard base64 decoding to exactly 32 bytes.

Generate a fresh key:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

Paste it into `apps/api/.env`:

```
JIRA_CREDENTIAL_ENCRYPTION_KEY=<the generated value>
```

Behavior:

- **Missing/empty**: health, login, logout, and session restoration keep
  working; Jira endpoints return HTTP 503 `jira_not_configured`.
- **Malformed** (present but not valid 32 bytes): startup fails with a sanitized
  configuration error. The key value is never logged.

Never commit `apps/api/.env` (it is git-ignored). Use a new key per environment.

### `DATABASE_PATH` (optional)

Override the SQLite location. Defaults to `apps/api/data/app.db`. Use
`:memory:` for an ephemeral database (used internally by tests; do not point
the app at it).

### `NODE_ENV`

When `production`, the session cookie is set with `Secure`. Local development
runs over plain HTTP on `localhost`, so this is unset by default.

## Database migrations and seed data

```bash
npm run migrate    # apply pending SQL migrations to the resolved database
npm run seed       # run migrations, then insert demo tenants and users (idempotent)
```

Migrations live in `apps/api/migrations/` as numbered `*.sql` files and are
applied transactionally by an in-repo runner. `npm run dev` also applies
pending migrations on startup.

## Run

```bash
npm run dev
```

- Web (Vite): <http://localhost:5173>
- API (Express): <http://localhost:3001>
- Health check: <http://localhost:3001/api/health>

The Vite dev server proxies `/api/*` to the backend, so the browser stays on a
single origin and the session cookie is sent automatically.

## API-key provisioning and revocation

API keys authenticate the external REST endpoint (`POST /api/v1/tickets`).
They are provisioned and revoked locally via two CLI scripts.

Provision a key for an existing user (resolved by globally unique email):

```bash
npm run api-key:create --workspace apps/api -- --email alice@example.com
```

The script prints the full key once — store it as a secret immediately. It
cannot be recovered later; the database stores only its SHA-256 hash.

Revoke a key by its public key ID (the prefix shown when provisioning):

```bash
npm run api-key:revoke --workspace apps/api -- --key-id <keyId>
```

Revocation physically deletes the row and is idempotent. See
[api.md](api.md) for endpoint usage and [security.md](security.md) for the key
format.

## Useful workflows

- [docs/manual-validation.md](manual-validation.md) — end-to-end validation
  checklist (login, Jira, sharing, isolation, tickets, API keys).
- [docs/api.md](api.md) — external REST API reference and curl examples.

> Clean-clone validation has not been performed for this submission yet.
