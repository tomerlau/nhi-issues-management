# Project Assumptions

This document records the assumptions and tradeoffs relevant to the
functionality implemented through the current milestone (Milestone 5). It grows
cumulatively as later milestones add functionality.

## Scope

- This is a focused proof of concept (POC), not a production system.
- Mandatory functionality has priority over optional functionality.
- Milestone 1 established the project foundation.
- Milestone 2 adds persistence, the tenant/user data model, and tenant isolation.
- Milestone 3 adds backend-only application authentication.
- Milestone 5 adds a backend-only Jira API-token connection.
- The optional blog digest is not part of the current implementation.

## Frontend

- React, built with Vite, written in TypeScript.
- A separate frontend application.
- Communicates with the backend only over relative `/api` requests, forwarded by
  the Vite development proxy.

## Backend

- Node.js, written in TypeScript, using Express.
- A separate backend application.
- Application construction (`app.ts`) is kept separate from process startup
  (`server.ts`) for testability.

## Monorepo

- **POC choice:** npm workspaces with simple root scripts.
- **Alternative:** Nx or Turborepo.
- **Tradeoff:** lower setup complexity and easier explanation, without advanced
  caching or task orchestration.

## Local runtime

- **POC assumption:** the application runs directly with local Node.js and no
  containers.
- **Production alternative:** containerized deployment with production routing
  and managed infrastructure.
- **Tradeoff:** lower local setup friction, with less production parity.

## Persistence: SQLite as the local database

- **POC assumption:** SQLite is used as a local file-backed relational database.
- **Production alternative:** a managed relational database such as PostgreSQL
  with production credentials, backups, availability, monitoring, and
  operational lifecycle management.
- **Tradeoff:** SQLite minimizes local setup and submission friction but does not
  provide the concurrency, scaling, or availability characteristics expected from
  production infrastructure.

## Persistence: synchronous `node:sqlite` API

- **POC assumption:** the implementation uses the synchronous built-in
  Node.js 24 `node:sqlite` API.
- **Production alternative:** an asynchronous production database client and
  connection pool.
- **Tradeoff:** the built-in API avoids a SQLite-specific native database
  dependency and keeps the POC small, but synchronous database work blocks the
  Node.js event loop and the API is not treated as the production persistence
  choice.

## Persistence: in-repo migration runner

- **POC assumption:** migrations use a small internal SQL migration runner.
- **Production alternative:** an established schema-management tool appropriate to
  the production database and deployment workflow.
- **Tradeoff:** the custom runner is easy to inspect and sufficient for the small
  POC schema, but intentionally lacks advanced migration tooling.

## Tenants and users: seeded demo records

- **POC assumption:** tenants, users, and their credentials are deterministic
  seeded demo records. Registration, password reset, password change, and
  account-management flows are not supported. Credentials are stored as Argon2id
  hashes; plaintext passwords are never stored.
- **Production alternative:** a managed tenant and identity lifecycle with
  administrative provisioning, authentication, auditing, and account-management
  flows.
- **Tradeoff:** seeded records make isolation easy to demonstrate locally but are
  not a production user-management solution.

- **POC assumption:** seeded tenants and users use fixed, readable string
  identifiers.
- **Production alternative:** generate opaque UUIDs, preferably UUIDv7, when
  creating tenants and users.
- **Tradeoff:** readable identifiers make the POC, tests, logs, and manual
  database inspection easier to understand, but they are not intended as
  production-grade identifiers.

## Data model and isolation

- Users belong to exactly one tenant.
- Emails are globally unique; the same email cannot exist in more than one tenant.
- Repository methods that read or write tenant-owned data require an explicit
  tenant scope; a user ID alone is never sufficient authorization scope. The one
  exception is a global find-by-email lookup used only at login, from which the
  tenant is then derived.
- Foreign keys provide referential integrity but do not replace tenant-scoped
  repository queries, which provide authorization isolation.

## Authentication

- **Users are predefined and seeded.** There is no registration; the demo users
  and their credentials are created by the idempotent seed.
- **Login accepts email and password only.** The backend derives the user and
  tenant from the stored user record; clients never provide or override `userId`
  or `tenantId` after login.
- **Passwords are hashed locally with Argon2id via the maintained `argon2`
  package.** The library manages random salts and the standard PHC storage
  format; the application keeps only a thin wrapper and does no custom crypto
  formatting or parameter handling.
  - **Production alternative:** a managed identity provider or centralized
    authentication service may own password credentials entirely.
  - **Tradeoff:** this adds a binary runtime dependency, but avoids maintaining
    custom cryptographic formatting, parsing, and parameter-handling code.
- **Sessions are SQLite-backed and single-instance.**
  - **Production alternative:** a shared session store (e.g. Redis) or signed,
    revocable tokens behind a load balancer.
  - **Tradeoff:** SQLite sessions are simple and survive an API restart on the
    same database file, but do not support horizontal scaling.
- **Raw session tokens are stored only in HttpOnly cookies.** The database stores
  only each token's SHA-256 hash, so a leaked database row cannot be replayed as a
  session. Tokens carry 256 bits of entropy.
- **Secure cookies depend on the environment.** The `Secure` cookie attribute is
  enabled when `NODE_ENV=production` and disabled for local HTTP development.
- **Deferred:** registration, password reset or change, SSO and social login,
  roles and permissions, API keys, tenant administration, rate limiting, account
  lockout, and production/distributed session infrastructure.

## Jira connection (Milestone 5)

- **POC assumption:** users create and submit an Atlassian API token through the
  application. The token is encrypted in the local SQLite database with an
  environment-provided application key (`JIRA_CREDENTIAL_ENCRYPTION_KEY`,
  base64, decoding to exactly 32 bytes) using AES-256-GCM.
  - **Production alternative:** Atlassian OAuth 2.0 Authorization Code Flow
    (3LO), with a managed key service such as AWS KMS providing envelope
    encryption and key rotation.
  - **Tradeoff:** API-token authentication significantly reduces setup and
    implementation complexity for the home-assignment POC, but requires the
    application to receive and retain a manually provisioned, long-lived
    credential.
- **The exercise reviewer confirmed either approach (API token or OAuth 2.0 3LO)
  is acceptable;** the simpler API-token connection was the chosen source of
  truth for this milestone.
- **Jira Cloud only.** Only direct `https://<site>.atlassian.net` URLs are
  supported; the URL is validated and normalized to its HTTPS origin before any
  network call (SSRF boundary).
- **One connection per application user,** owned by the `(tenantId, userId)`
  pair and reachable only within that scope.
- **Credentials are validated before persistence.** The token is verified
  against `GET /rest/api/3/myself` and only stored on success; a failed
  validation or reconnection never overwrites an existing valid connection.
- **API tokens are never returned to the frontend** and never logged. Only safe
  connection status (connected flag, site URL, email) is exposed.
- **Tokens may expire or be revoked.** When that happens the connection becomes
  invalid and the user must reconnect; there is no automatic refresh (API tokens
  are not refreshable).
- **The encryption key is required only for Jira connection operations.** When it
  is missing, the Jira endpoints return HTTP 503 `jira_not_configured` while
  health, login, logout, and session restoration continue to work. No fallback
  or development key is ever generated.
- **Deferred:** any frontend or Jira connection UI; OAuth 2.0 / 3LO and token
  refresh; a reusable Jira API client (Milestone 7); Jira project discovery or
  validation; ticket creation; a disconnect endpoint; and production KMS
  integration or key rotation.
