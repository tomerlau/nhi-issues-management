# Project Assumptions

This document records the assumptions and tradeoffs relevant to the
functionality implemented through the current milestone (Milestone 7). It grows
cumulatively as later milestones add functionality.

## Scope

- This is a focused proof of concept (POC), not a production system.
- Mandatory functionality has priority over optional functionality.
- Milestone 1 established the project foundation.
- Milestone 2 adds persistence, the tenant/user data model, and tenant isolation.
- Milestone 3 adds backend-only application authentication.
- Milestone 4 adds the frontend authenticated application shell on top of the
  Milestone 3 backend, without changing the backend authentication contract.
- Milestone 5 adds a backend-only Jira API-token connection.
- Milestone 7 adds a backend-only Jira integration layer: one central Jira
  client and a tenant-scoped integration service that validates a Jira project
  against the authenticated tenant's shared connection, plus a move from v1 to
  tenant-only v2 credential encryption.
- The optional blog digest is not part of the current implementation.

## Frontend

- React, built with Vite, written in TypeScript.
- A separate frontend application.
- Communicates with the backend only over relative `/api` requests, forwarded by
  the Vite development proxy.
- The frontend relies entirely on the server-managed `HttpOnly` cookie session.
  It stores no session token, authorization header, or password in
  `localStorage`, `sessionStorage`, the URL, or logs, and derives the
  authenticated user only from the backend session response. There is no UI to
  select or override a user or tenant id.

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
  session. Tokens carry 256 bits of entropy. The frontend never reads or stores
  the token; the browser sends the cookie automatically on same-origin `/api`
  requests.
- **Secure cookies depend on the environment.** The `Secure` cookie attribute is
  enabled when `NODE_ENV=production` and disabled for local HTTP development.
- **Session restoration is a normal HTTP 200 state.** `GET /api/auth/session`
  returns HTTP 200 with `{ user: null }` when there is no valid session, so an
  unauthenticated initial load is not a request failure. Genuine protected routes
  and invalid login credentials still return HTTP 401. The frontend renders the
  login screen from `{ user: null }` and treats a network or unexpected server
  failure during restoration as a retryable error, not as being logged out.
- **Deferred:** registration, password reset or change, SSO and social login,
  roles and permissions, API keys, tenant selection and administration, frontend
  routing, rate limiting, account lockout, and production/distributed session
  infrastructure.

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
- **Unscoped API tokens only.** The submitted credential must be an unscoped
  Atlassian API token used with Jira Cloud Basic authentication against the
  direct site origin. Scoped API tokens are intentionally **not** supported:
  Atlassian requires scoped tokens to be sent to
  `https://api.atlassian.com/ex/jira/<cloudId>` (a different host that needs
  cloud-id resolution), which is outside this POC's direct-origin model, so a
  scoped token fails verification. OAuth 2.0 / 3LO remains documented only as the
  production alternative below, not an implemented option.
- **The Jira connection is a tenant-wide organization integration,** shared by
  every user in the tenant — not a per-user connection. There is exactly one
  connection per tenant (`UNIQUE (tenant_id)`), reachable only within that
  tenant's scope; users in other tenants can never read, use, or replace it.
  - Every authenticated user in a tenant can read the safe connection status.
  - Every authenticated user in a tenant can create or replace the shared
    connection. A successful replacement updates the existing row in place
    (preserving its id) and records the acting user as the configurer; a failed
    replacement preserves the existing connection unchanged.
  - `configured_by_user_id` records the user who last successfully configured the
    connection. It is **audit metadata only, not an authorization boundary**: who
    configured it last never restricts who may replace it.
  - **Production alternative:** restrict creating or replacing the shared
    integration to authorized tenant administrators, with roles and permissions
    governing who manages the connection.
  - **Tradeoff:** allowing every tenant user to create or replace the connection
    avoids adding roles, permissions, and tenant administration to this POC,
    while keeping the integration shared at the correct (tenant) scope.
- **Legacy per-user connections are consolidated by migration 004.** The original
  Milestone 5 schema stored one connection per `(tenant_id, user_id)`. The
  forward-only migration rebuilds the table to the tenant-wide shape and, when a
  tenant holds several legacy rows, deterministically keeps exactly one: the
  greatest `updated_at`, breaking ties by the greatest `id`. The retained row's
  previous `user_id` becomes its `configured_by_user_id`, so its encrypted token
  (whose AAD binds `(tenant_id, user_id)`) remains decryptable.
- **Credentials are validated before persistence.** The token is verified
  against `GET /rest/api/3/myself` and only stored on success; a failed
  validation or replacement never overwrites an existing valid connection.
- **API tokens are never returned to the frontend** and never logged. Only safe
  connection status (connected flag, site URL, email) is exposed.
- **Tokens may expire or be revoked.** When that happens the connection becomes
  invalid and the user must reconnect; there is no automatic refresh (API tokens
  are not refreshable).
- **The encryption key is required only for Jira connection operations.** When it
  is missing, the Jira endpoints return HTTP 503 `jira_not_configured` while
  health, login, logout, and session restoration continue to work. No fallback
  or development key is ever generated.
- **Deferred (from Milestone 5):** any frontend or Jira connection UI; OAuth 2.0
  / 3LO and token refresh; ticket creation; a disconnect endpoint; and production
  KMS integration or key rotation. The reusable Jira client and project
  validation, originally deferred here, are implemented in Milestone 7 (below);
  Jira project discovery/search remains out of scope.

## Jira integration layer (Milestone 7)

- **The Jira connection belongs to the tenant, not the configuring user.**
  Credential encryption moved from the v1 context `(tenantId,
  configuredByUserId)` to a tenant-only v2 context binding the credential type,
  the credential format version, and `tenantId`. Any user in a tenant uses the
  same shared connection regardless of who configured it.
  - `configured_by_user_id` remains **audit metadata only** and no longer
    participates in encryption or decryption.
  - **Production alternative:** a managed key service (e.g. AWS KMS) with
    envelope encryption and rotation, and tenant-administrator-scoped management
    of the shared integration.
  - **Tradeoff:** tenant-bound AAD makes the shared connection usable by every
    tenant user while still making a ciphertext copied to another tenant
    undecryptable.
- **Existing v1 connections are deleted, not migrated.** Migration 005 is a
  forward-only `DELETE` of all `jira_connections` rows, because v1 ciphertext is
  bound to the configuring user and cannot be decrypted under the tenant-only v2
  context. Affected tenants are disconnected and must reconnect; the next
  connection is stored as v2. This is approved for the local POC — there is no
  backward compatibility with v1 ciphertext and deleting existing local Jira
  connection data is acceptable. No undecryptable row is left appearing
  connected.
- **One central Jira client owns all Jira HTTP behavior.** It targets only the
  already-validated direct `https://<site>.atlassian.net` origin, builds Basic
  authentication in memory (never persisting or logging the plaintext token or
  Authorization header), never follows redirects, applies a timeout that covers
  the full response-body read, validates response shapes at runtime, and returns
  only sanitized outcomes. The M5 credential verifier now reuses this client
  rather than maintaining a second HTTP implementation. It is intentionally not a
  general-purpose Atlassian SDK.
- **Project validation uses Jira Cloud REST API v3.**
  `GET /rest/api/3/project/{projectIdOrKey}?expand=issueTypes` confirms the
  project exists and is accessible to the tenant's shared connection, returns the
  project id and canonical key, and resolves the id of a non-subtask issue type
  named exactly `Task`. The issue type is **fixed** (`Task`); a subtask named
  `Task` is not accepted. A missing or inaccessible project is distinct from a
  project that exists but does not support `Task`.
- **Access is strictly tenant-scoped.** The integration service loads the
  connection only via `findByTenant(context.tenantId)` and never accepts a
  tenantId, userId, connectionId, site URL, email, or ownership value from
  request data, so cross-tenant access is impossible. The stored site URL is
  re-validated before any network call (no request on an invalid URL), and the
  token is decrypted just-in-time using the stored tenant only. Decryption
  failures are collapsed into one sanitized configuration failure.
- **Deferred:** ticket creation; local ticket provenance; recent-tickets;
  any REST endpoint for project validation; external application API-key
  authentication; Jira project discovery or search; configurable issue types;
  custom fields; OAuth/3LO/refresh tokens/rotation; and Jira Server / Data
  Center support.
