# Setup

How to install, configure, and run the application from a clean clone.

## Prerequisites

- Node.js 24 (`>=24 <25`, see `.nvmrc`). With `nvm`, run `nvm use`.
- npm 10+ (bundled with Node.js 24).
- (Optional) `sqlite3` CLI to inspect the local database during validation.
- (Optional) An Atlassian account with an unscoped Jira Cloud API token if you
  want to exercise real Jira flows.

## Install and one-shot setup

```bash
git clone https://github.com/tomerlau/nhi-issues-management.git
cd nhi-issues-management
nvm use            # or otherwise ensure Node.js 24 is active
npm ci
npm run setup
```

`npm run setup` is the default clean-clone path. It is cross-platform and
idempotent:

- Creates the git-ignored `apps/api/.env` from `apps/api/.env.example` when it
  does not already exist.
- Generates a fresh `JIRA_CREDENTIAL_ENCRYPTION_KEY` (32 random bytes, canonical
  standard base64) when the variable is missing or empty, and writes it back to
  `apps/api/.env` using an atomic temp-file rename.
- Preserves an existing valid key unchanged; the generated value is never
  printed and never leaves the `.env` file.
- Fails fast with a sanitized message — **without modifying the file** — when
  the key is set but not valid canonical base64 decoding to 32 bytes.
- Applies pending SQL migrations and inserts the demo tenants and users by
  delegating to `npm run seed`.

> Losing `JIRA_CREDENTIAL_ENCRYPTION_KEY` makes existing encrypted Jira
> connections undecryptable. Affected tenants must reconnect Jira. Do not
> rotate or delete the local key unless you intend that.

> Production systems should not rely on a local `.env`. Provision secrets
> through a managed secrets service and use KMS-backed envelope encryption.

### Environment variables

The API loads `apps/api/.env` on startup (built-in Node.js loader; no `dotenv`
dependency). `apps/api/.env` is git-ignored and must never be committed.

| Variable                          | Required | Notes                                                                                       |
| --------------------------------- | -------- | ------------------------------------------------------------------------------------------- |
| `JIRA_CREDENTIAL_ENCRYPTION_KEY`  | for Jira | AES-256-GCM key, canonical standard base64 decoding to exactly 32 bytes. Managed by `npm run setup`. |
| `DATABASE_PATH`                   | no       | Overrides the SQLite path. Defaults to `apps/api/data/app.db`. `:memory:` is used internally by tests. |
| `NODE_ENV`                        | no       | When `production`, the session cookie is set with `Secure`. Unset for local HTTP development. |

Behavior when the encryption key is unavailable:

- **Missing/empty**: Jira-dependent operations are unavailable and return
  HTTP 503 `jira_not_configured`. Health, login, logout, and session
  restoration still work.
- **Malformed** (present but not valid 32 bytes): API startup fails with a
  sanitized configuration error. The key value is never logged.

### Manual key generation (alternative)

`npm run setup` is the recommended path. To generate a key manually:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

Paste the value into `apps/api/.env`:

```
JIRA_CREDENTIAL_ENCRYPTION_KEY=<the generated value>
```

## Database migrations and seed data

`npm run setup` already runs both. To run them on their own:

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

> The documented clean-clone flow above (`npm ci`, `npm run setup`,
> `npm run dev`) has been validated successfully. `npm run setup` was also
> re-run to confirm idempotency, and `npm run check` passed.
