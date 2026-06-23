# Security

This document covers the security properties of the implemented application.
For component-level mechanics see [architecture.md](architecture.md); for the
external API contract see [api.md](api.md).

## Trust boundaries

- **Untrusted input**: HTTP requests, including bodies, query strings, path
  parameters, and headers. Validation precedes any downstream effect.
- **Authenticated principal**: derived solely from the stored session row
  (cookie auth) or stored API-key record (Bearer auth). No request input can
  assert or override `tenantId` or `userId` after authentication.
- **Outbound Jira target**: derived solely from the stored, re-validated
  connection record for the authenticated tenant. The request URL is built
  from the validated origin plus an application-controlled path; Jira response
  URLs are never used for follow-up requests.

## Session security

- The session cookie is `nhi_session`: `HttpOnly`, `SameSite=Lax`, `Path=/`,
  `Max-Age` matching the eight-hour TTL. `Secure` is set when
  `NODE_ENV=production` and unset for local HTTP development.
- Session tokens are 256-bit opaque random values. The database stores only
  the SHA-256 hash of each token; the raw token lives only in the cookie. A
  leaked database row cannot be replayed as a session.
- `POST /api/auth/logout` deletes only the row matching the current token
  hash; other sessions are unaffected.
- All `/api/auth/*` responses set `Cache-Control: no-store`.

## Password handling

- Passwords are hashed with Argon2id via the maintained `argon2` package, in
  PHC format (`$argon2id$...`). The application does not parse hashes or
  manage parameters itself.
- Login distinguishes only `valid credentials` from `invalid credentials`.
  Unknown email, missing credential row, and wrong password all return the
  same generic HTTP 401 `invalid_credentials`, so a client cannot probe which
  emails exist.

## Tenant and user isolation

- Every tenant-owned read or write requires the owning `tenantId`. The
  deliberate exception is the global `findByEmailForAuthentication` used only
  at login, from which the tenant is then derived.
- Foreign keys provide referential integrity; tenant-scoped repository
  queries provide authorization isolation. A user id alone is never
  sufficient authorization scope.
- The Jira connection table enforces exactly one row per tenant (`UNIQUE
  (tenant_id)`). Users in other tenants can never read, use, or replace it.
- The `jira_ticket_provenance` table is scoped by `(tenant_id,
  jira_site_url)`, and uniqueness prevents recording the same Jira issue
  twice for a tenant and site.

## Jira credential validation and encryption

- The submitted Jira site URL must be a normalized direct
  `https://<site>.atlassian.net` origin. HTTP, non-Atlassian hosts, deceptive
  suffixes (`x.atlassian.net.attacker.com`), bare `atlassian.net`, embedded
  credentials, explicit ports, paths, query strings, fragments, IP addresses,
  `localhost`, and malformed URLs are rejected before any network call.
- The submitted credential must be an **unscoped** Atlassian API token used
  with Jira Cloud Basic authentication against the direct site origin.
  Scoped tokens are not supported because they target
  `https://api.atlassian.com/ex/jira/<cloudId>`, outside this POC's
  direct-origin model.
- Credentials are validated against `GET /rest/api/3/myself` before
  persistence. A failed validation or replacement never overwrites an
  existing valid connection.
- The token is encrypted with AES-256-GCM using
  `JIRA_CREDENTIAL_ENCRYPTION_KEY` (canonical standard base64, decoding to
  exactly 32 bytes) before storage. Each ciphertext uses a fresh 12-byte
  nonce and is stored as a versioned, dot-separated value (`v2.<nonce>.
  <ciphertext>.<authTag>`).
- Additional authenticated data binds the ciphertext to the credential type,
  the format version, and the **tenant only**. A ciphertext copied to another
  tenant fails the auth-tag check; any tampering does too.
- The encryption key is required only for Jira operations. A missing key
  leaves login, health, and session restoration working; Jira endpoints
  return HTTP 503 `jira_not_configured`. A malformed key fails startup with
  a sanitized error. The key value is never logged.
- The API token is never returned to any client and never logged. Only safe
  connection status (`connected`, `siteUrl`, `email`) is exposed.

## Frontend handling of the Jira API token

- The token input is `type="password"`, uncontrolled, and read only via a DOM
  ref at submit time. It is cleared from the input immediately when an
  actual `POST` request begins.
- The token is never placed in React state, props, context, a store, or any
  browser storage (`localStorage`, `sessionStorage`, IndexedDB, cookies),
  and never appears in URLs, logs, errors, analytics, or rendered output.
- The token is never retained for a retry. A completed POST attempt
  (successful or failed) requires re-entering the token.
- The form uses `autocomplete="off"` plus Jira-specific input names so the
  browser password manager does not autofill the application password into
  the API-token field.
- The token exists only transiently in the outgoing request body. Local
  development runs over plain HTTP on `localhost`; **any non-local or
  production deployment must use HTTPS/TLS** so the token is not exposed in
  transit.

## SSRF protections

The Jira HTTP client targets only the already-validated direct
`https://<site>.atlassian.net` origin:

- `site-url.ts` rejects everything else *before* any network call (the SSRF
  boundary).
- `jira-client.ts` constructs request URLs only from that validated origin
  plus application-controlled paths, percent-encoding dynamic project
  identifiers safely.
- `redirect: 'manual'` and the client never follows redirects; a redirect
  response is a failure outcome, not a follow-up request.
- A response's own URL (self / location) is never used to build a follow-up.

## API-key generation, hashing, authentication, and revocation

- Format: `nhi_<keyId>.<secret>` with `keyId` 22-char base64url (16 random
  bytes) and `secret` 43-char base64url (32 random bytes, ≥ 256 bits of
  entropy). The `.` separator is not in the base64url alphabet, so the
  format is unambiguous.
- Only the SHA-256 hash of the `secret` is persisted (`api_keys.secret_hash`).
  The plaintext full key is shown exactly once during local provisioning and
  cannot be recovered. The CLI prints a clear warning.
- `createRequireApiKeyAuth` parses the `Authorization: Bearer <key>` header,
  looks up the row by `keyId`, and performs a timing-safe comparison of the
  SHA-256 hashes. Every failure — missing header, wrong scheme, malformed
  key, unknown id, wrong secret, deleted key — returns the same generic 401
  `unauthenticated` with `Cache-Control: no-store`. No failure path
  discloses *why* the request was rejected.
- Ownership (`tenantId`, `userId`) derives exclusively from the stored row.
  Request headers, body, query, and path cannot override it. There is no
  caller-selectable tenant or user.
- Revocation (`api-key:revoke`) physically deletes the row. There is no
  `revoked_at`, tombstone, or audit history; a revoked key is permanently
  indistinguishable from an unknown key. The command is idempotent.

## Sensitive-data and logging boundaries

- No code path logs the plaintext Jira token, the encrypted ciphertext, the
  `Authorization` header, the encryption key, the API-key plaintext, the
  session token, the session token hash, or password hashes.
- Error responses never include raw Jira bodies, network error text, stack
  traces, redirect locations, internal exception messages, or credentials.
- The `Cache-Control: no-store` header is set on every response from
  `/api/auth/*`, `/api/jira/*`, `/api/tickets/*`, and `/api/v1/tickets/*` —
  including body-parser failures and the terminal `internal_error` handler —
  so no intermediate cache stores credential-bearing responses.
- The `jira_ticket_provenance` table stores no ticket title, description, or
  raw Jira response. The `api_keys` table stores no plaintext key. The
  `sessions` table stores no raw token. The `user_credentials` table stores
  no plaintext password.
- Browser `localStorage` holds only the per-`(tenantId, userId)` last-valid
  Jira project key (`nhi:last-project:<tenantId>:<userId>`) — a non-sensitive
  identifier, not a secret. No Jira token, email, site URL, session value,
  ticket data, or other user-profile data is stored client-side. A missing or
  inaccessible `localStorage` collapses safely to an empty preference; the
  Jira-connected gate remains authoritative before any recent-tickets request
  is issued. See `docs/architecture.md` § *Project preference*.

## Local provisioning posture

- Demo passwords (`acme-alice-demo`, etc.) are deterministic, public test
  credentials for the local POC only; the database stores only their
  Argon2id hashes.
- The Jira encryption key is local: it lives in `apps/api/.env`, which is
  git-ignored, and is never committed.
- API keys are provisioned and revoked only through the local CLI scripts;
  there is no management UI or REST endpoint.

## POC limitations and production alternatives

- **No HTTPS/TLS on local development.** Local access is over plain HTTP on
  `localhost`. *Production alternative*: terminate TLS at the edge and run
  the API on HTTPS; set `NODE_ENV=production` so the cookie is `Secure`.
- **API token instead of OAuth 2.0 / 3LO.** The reviewer confirmed either
  approach is acceptable. *Production alternative*: Atlassian OAuth 2.0
  Authorization Code Flow.
- **Local encryption key instead of a managed KMS.** *Production
  alternative*: a managed key service (e.g. AWS KMS) with envelope encryption
  and rotation.
- **Any authenticated tenant user may create or replace the shared Jira
  connection.** *Production alternative*: restrict to tenant administrators
  with roles and permissions.
- **SQLite-backed single-instance sessions.** *Production alternative*: a
  shared session store (e.g. Redis) or signed, revocable tokens behind a load
  balancer.
- **API keys do not expire, rotate automatically, or track last-used.**
  *Production alternatives*: time-bounded tokens, automatic rotation,
  last-used tracking, scoped permissions, rate limiting.
- **No rate limiting or account-lockout** on login or API-key auth.
  *Production alternative*: rate limiting and lockout policies at the edge
  and/or in the application.
- **Ticket creation is not idempotent.** Retrying after a timeout or
  uncertain response may create a duplicate Jira issue. *Production
  alternative*: an idempotent durable creation workflow with operation
  tracking, safe retries, and reconciliation.

See [assumptions.md](assumptions.md) for the full list of POC assumptions and
tradeoffs.
