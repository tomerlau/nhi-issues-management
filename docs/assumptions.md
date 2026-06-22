# Project Assumptions

This document records the assumptions and tradeoffs relevant to the
functionality implemented through the current milestone (Milestone 6). It grows
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
- Milestone 6 adds the frontend Jira connection UI on top of the Milestone 5
  backend, without changing the backend Jira contract.
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
- The Jira connection UI (Milestone 6) follows the same boundary. The Atlassian
  API token is entered through an uncontrolled secret input, read only via a DOM
  ref at submit time, cleared from the input immediately when an actual POST
  request begins (a client-side validation failure before a request retains the
  input value so the user can correct the other fields), and never
  placed in React state or any browser storage (`localStorage`, `sessionStorage`,
  IndexedDB, cookies, URLs, or logs). It exists only transiently in the submit
  call and the outgoing request body, is never retained for a retry, and is never
  returned by the backend. `siteUrl` and `email` use ordinary local React state.
  The UI displays only the safe connection status (connected flag, site URL,
  email) and never renders internal IDs, account IDs, audit metadata, encrypted
  data, or credential material.

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
- **Deferred:** OAuth 2.0 / 3LO and token refresh; a reusable Jira API client
  (Milestone 7); Jira project discovery or validation; ticket creation; a
  disconnect endpoint; and production KMS integration or key rotation.

## Jira connection UI (Milestone 6)

- **Frontend only.** The UI consumes the unchanged Milestone 5 backend contract
  (`GET`/`POST /api/jira/connection`); no backend behavior changed.
- **Any authenticated tenant user may create or replace the shared connection,**
  matching the backend authorization model: `configured_by_user_id` is audit
  metadata only, not an authorization boundary, so the UI offers the
  create/replace action to every authenticated tenant user.
  - **Production alternative:** restrict creating or replacing the shared
    integration to authorized tenant administrators with roles and permissions.
  - **Tradeoff:** allowing every tenant user keeps roles and tenant
    administration out of this POC while keeping the integration shared at the
    tenant scope.
- **The token is a transient browser secret.** It is entered through an
  uncontrolled `type="password"` input, read only via a DOM ref at submit time,
  cleared immediately when an actual POST request begins, never stored in
  React state or any browser storage, and never retained for a retry. If
  client-side validation fails before a request is made, the uncontrolled input
  retains its value so the user can correct the other fields. It is
  expected to appear transiently only in the outgoing request body, which is
  visible to the browser's own user.
  - **Transport (POC assumption):** local development accesses the frontend and
    API through `localhost` over plain HTTP, so the local request is **not**
    protected by TLS.
  - **Production alternative:** any non-local or production deployment must use
    HTTPS/TLS so the token is not exposed in transit.
  - **Tradeoff:** plain-HTTP local access keeps setup friction low; the
    not-stored-in-the-browser guarantees hold regardless of transport, but
    transport encryption is a deployment responsibility, not a client-state one.
- **Errors and status are safe by construction.** The UI maps backend error
  codes (including each distinct status-load failure: configuration,
  authentication, network, Jira availability, timeout, and unexpected-server)
  to safe category-specific copy, never renders raw backend/Jira messages or
  technical error codes, and a failed replacement leaves the previously loaded
  connection visible and active.
- **Deferred:** Jira project input/discovery/validation; ticket creation and a
  recent-tickets view; a disconnect button; roles, permissions, or a
  tenant-admin UI; API-key functionality; browser credential persistence; global
  frontend state; and frontend routing.
