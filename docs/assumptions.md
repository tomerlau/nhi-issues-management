# Assumptions and tradeoffs

Approved POC assumptions, the production alternatives they imply, and the
resulting tradeoffs. Behavior already described elsewhere
([architecture.md](architecture.md), [security.md](security.md),
[api.md](api.md)) is not repeated here.

## Scope

- This is a focused proof of concept (POC), not a production system.
- Mandatory functionality has priority over optional functionality.
- The optional **NHI Blog Digest** bonus is **not implemented**.

## Runtime and packaging

- **Local Node.js, no containers.** *Production alternative*: containerized
  deployment with managed routing and infrastructure. *Tradeoff*: lower local
  setup friction; less production parity.
- **npm workspaces with simple root scripts.** *Production alternative*: Nx or
  Turborepo for caching and task orchestration. *Tradeoff*: lower setup
  complexity at the cost of advanced orchestration.

## Persistence

- **SQLite as the local database.** *Production alternative*: a managed
  relational database (e.g. PostgreSQL) with backups, replication, monitoring,
  and operational lifecycle. *Tradeoff*: minimal local setup; SQLite does not
  match production concurrency, scaling, or availability.
- **Synchronous `node:sqlite` API.** *Production alternative*: an
  asynchronous database client and connection pool. *Tradeoff*: avoids a
  SQLite-specific native dependency; synchronous queries block the event loop.
- **In-repo SQL migration runner.** *Production alternative*: an established
  schema-management tool. *Tradeoff*: easy to inspect; intentionally lacks
  advanced migration tooling.

## Tenants and users

- **Tenants and users are seeded demo records with deterministic readable
  IDs and documented demo passwords.** Registration, password reset, password
  change, and account-management flows are not supported. The database
  stores only Argon2id hashes; plaintext passwords are never stored.
  *Production alternative*: a managed tenant and identity lifecycle with
  administrative provisioning, authentication, auditing, and self-service
  flows; opaque UUIDs (preferably UUIDv7) instead of readable IDs.
  *Tradeoff*: makes the POC easy to read, run, and demonstrate; not a
  production user-management solution.
- **One user belongs to exactly one tenant; emails are globally unique.**
  This lets login resolve the tenant from the user without a tenant selector.

## Application authentication

- **Cookie sessions backed by single-instance SQLite.** *Production
  alternative*: a shared session store (e.g. Redis) or signed revocable
  tokens behind a load balancer. *Tradeoff*: sessions survive an API
  restart on the same database file but do not support horizontal scaling.
- **`Secure` cookie depends on `NODE_ENV=production`.** Local HTTP development
  on `localhost` runs without `Secure`. *Production alternative*: TLS at the
  edge and `NODE_ENV=production`. *Tradeoff*: simpler local development.
- **Session restoration is HTTP 200 with `{ user: null }` when unauthenticated.**
  Returning 401 here would surface as a console error on every initial load;
  protected routes and `invalid_credentials` still return 401.
- **Argon2id via the maintained `argon2` package** (a binary runtime
  dependency). *Production alternative*: a managed identity provider may
  own password storage entirely. *Tradeoff*: a thin wrapper avoids custom
  cryptographic formatting and parameter handling.

## Jira connection

- **API-token connection (unscoped Atlassian API token).** The reviewer
  confirmed either API token or OAuth 2.0 / 3LO is acceptable; the simpler
  API token was chosen. *Production alternative*: Atlassian OAuth 2.0
  Authorization Code Flow (3LO) with refresh tokens. *Tradeoff*: significantly
  reduced setup and implementation complexity; the application receives and
  retains a manually provisioned long-lived credential.
- **Jira Cloud only; direct `https://<site>.atlassian.net` origins only.**
  Scoped API tokens (which target `https://api.atlassian.com/ex/jira/<cloudId>`)
  and Jira Server / Data Center are out of scope.
- **The Jira connection is a tenant-wide organization integration.** Exactly
  one connection per tenant, shared by all tenant users. Any authenticated
  tenant user can create or replace it; `configured_by_user_id` is audit
  metadata, not an authorization boundary. *Production alternative*: restrict
  management to tenant administrators with roles and permissions.
  *Tradeoff*: avoids adding roles, permissions, and a tenant-admin model while
  keeping the integration shared at the correct scope.
- **Local encryption key (`JIRA_CREDENTIAL_ENCRYPTION_KEY`) instead of a KMS.**
  AES-256-GCM with tenant-only AAD, versioned `v2.` ciphertext. *Production
  alternative*: a managed key service (e.g. AWS KMS) with envelope encryption
  and rotation. *Tradeoff*: smallest setup that still meets the
  encryption-at-rest requirement.
- **API tokens may expire or be revoked.** When that happens the connection
  becomes invalid and the user must reconnect; there is no automatic refresh.

## Ticket creation

- **Fixed Jira `Task` issue type, no configurable fields.** Configurable
  issue types, labels, components, assignees, custom fields, and rich-text /
  Markdown descriptions are out of scope. The description is rendered as a
  minimal ADF document preserving internal line breaks.
- **Client-side validation is a usability aid, not a security boundary.**
  The backend remains authoritative.
- **Project keys are case-insensitive; entered casing is preserved while
  editing.** The frontend normalizes to uppercase on submit, and the backend
  independently trims and uppercases before validating.
- **Local provenance stores only a minimal pointer; Jira is the source of
  truth.** No ticket title, description, credentials, or raw Jira response
  is stored locally. The `jira_site_url` is a snapshot, so the row keeps
  identifying the issue's site even after the connection is replaced.
- **Sequential creation, not a distributed transaction.** Jira creation and
  SQLite persistence are sequential and not atomic; the application cannot
  guarantee that every issue Jira creates has a local provenance row:
  - Jira confirms creation, provenance insert fails → `persistence_failed`
    (HTTP 500); the Jira issue exists but has no local pointer.
  - Request times out before Jira's response is read → `jira_timeout` (HTTP
    504); the issue may or may not exist.
  *Production alternative*: an idempotent durable creation workflow with
  operation tracking, safe retries, and reconciliation/recovery. *Tradeoff*:
  the synchronous flow keeps the POC small at the cost that ticket creation
  is not idempotent; an immediate retry after an uncertain outcome may
  create a duplicate Jira issue.
- **The frontend treats every post-request failure as an uncertain outcome.**
  Because creation is not idempotent, *any* failure that occurs after the
  request leaves the browser may have happened after Jira already created the
  issue. The UI warns the ticket may exist, tells the user to check Jira
  before retrying, and never retries automatically.
- **Credential rejection during creation maps to 502, not 422.** The
  connection was previously verified at connect time, so a later rejection is
  treated as an upstream failure (`jira_credentials_rejected`), distinct from
  the generic `jira_unreachable`.

## Recent tickets

- **Membership and order from local provenance; values from live Jira.** No
  caching, no background refresh. *Production alternative*: a cached,
  incrementally-refreshed projection of issue metadata. *Tradeoff*: always
  fresh, at the cost of one bulk Jira call per internal batch per request.
- **Tenant-wide visibility, not per-user.** The read is not filtered by
  creating user and not by connection id; the site-URL snapshot is the
  visibility boundary.
- **Fixed internal batching, no user-controlled pagination.** Candidates are
  loaded in batches of 25 using a keyset cursor and capped at ten valid
  results. `limit` and `cursor` are not request inputs.
- **Skips on per-issue gaps; fails closed on malformed responses.** Issues
  Jira omits (deleted, moved, inaccessible) and issues whose current project
  differs from the selected one are skipped; a malformed bulk response is a
  sanitized `unavailable` failure.

## API-key authentication and the external REST API

- **API keys are owned by one application user and tenant.** Ownership is
  derived only from the stored row on each request; request input cannot
  override it.
- **Random high-entropy secrets, hash-only storage.** Format
  `nhi_<keyId>.<secret>`. Only the SHA-256 hash of `secret` is persisted.
  The plaintext full key is shown exactly once during local provisioning.
- **Revocation physically deletes the row.** No `revoked_at`, tombstone,
  or audit history. Revocation is idempotent.
- **All authentication failures return the same generic 401.** No path
  discloses whether a key existed or why it was rejected.
- **No automatic expiration, rotation, last-used tracking, or scoped
  permissions.** *Production alternatives*: time-bounded tokens, automatic
  rotation, last-used tracking, scoped permissions per key, rate limiting,
  a managed key administration UI, a dedicated secrets management service.
- **No REST endpoints for API-key management.** Keys are provisioned and
  revoked only through the local CLI scripts.
- **The external endpoint reuses the existing ticket-creation domain
  service.** There is no second ticket-creation implementation, second Jira
  client, or second provenance repository. The sequential, non-idempotent
  creation tradeoff above applies identically here.

## Frontend boundary

- **React holds no backend secrets.** The frontend talks to the backend only
  over relative `/api/*` requests forwarded by the Vite dev proxy and relies
  entirely on the server-managed `HttpOnly` `nhi_session` cookie. It stores
  no session token, authorization header, or password in `localStorage`,
  `sessionStorage`, the URL, or logs, and derives the authenticated user only
  from the backend session response. There is no UI to select or override a
  user or tenant id.
- **Connection management and ticket creation stay as separate components.**
  No global state library, routing, or broad context abstraction has been
  introduced.

## Out of scope for this POC

Registration, password reset/change, SSO and social login, roles and
permissions, tenant administration UI, API-key management UI, REST endpoints
for API-key lifecycle, rate limiting, account lockout, idempotency keys,
durable workflow / queue / retry orchestration, reconciliation, batch ticket
creation, ticket editing or deletion or transitions, Jira project discovery
or search, configurable issue types, custom fields, OAuth/3LO/refresh tokens,
Jira Server / Data Center support, frontend routing, distributed session
infrastructure, and the optional NHI Blog Digest bonus.
