# Manual validation

One end-to-end checklist for verifying the application against a real Jira
Cloud site. Steps that create a real Jira issue require a real Jira Cloud
site, an Atlassian account email, an **unscoped** API token, and a project the
account can create `Task` issues in.

The "manual" cookie jars below (`alice.cookies`, `bob.cookies`,
`globex.cookies`) are local files that `curl` will create on first use; they
are git-ignored.

## 1. Setup and startup

```bash
nvm use && npm ci
cp apps/api/.env.example apps/api/.env
# Generate JIRA_CREDENTIAL_ENCRYPTION_KEY and paste it into apps/api/.env:
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"

# Optional: reset the local database to start clean.
rm -f apps/api/data/app.db apps/api/data/app.db-wal apps/api/data/app.db-shm

npm run seed       # apply migrations, insert demo data
npm run dev        # API on :3001, web on :5173
```

Confirm:

- The API logs `[api] jira credential encryption configured`.
- `GET http://localhost:3001/api/health` returns `{"status":"ok"}`.
- The web app loads at <http://localhost:5173> and shows the login screen.

## 2. Login, logout, and session restoration

In the browser at <http://localhost:5173>:

- Sign in as `alice@example.com` / `acme-alice-demo`; the shell appears.
- Refresh — session is restored without re-entering credentials.
- Sign out — returns to the login screen.
- Reload — login screen stays.
- Wrong password → single generic error; the password field clears.
- Stop the API, reload — a retryable "couldn't verify your session" message
  appears (not the login screen). Restart and click **Try again**.

CLI smoke-test for the cookie flow:

```bash
curl -i -c alice.cookies -X POST http://localhost:3001/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"alice@example.com","password":"acme-alice-demo"}'
curl -i -b alice.cookies http://localhost:3001/api/auth/session
curl -i -b alice.cookies -c alice.cookies -X POST http://localhost:3001/api/auth/logout
curl -i -b alice.cookies http://localhost:3001/api/auth/session   # {"user":null}
```

## 3. Jira connection and replacement

Real Jira credentials needed. Log in as Alice in the UI:

- The header shows "Jira not connected" (red dot) and the inline connect form.
- Submit the site URL, Atlassian email, and unscoped API token. The header
  switches to "Jira connected" (green dot).
- The token field clears immediately on submit and never returns.
- Open the manage modal (gear icon). Submit with an invalid token; the
  connection stays visible and active, the modal stays open, and the token
  must be re-entered.
- Disconnected/connected display never shows internal IDs, account IDs, the
  encrypted token, or audit metadata.

## 4. Same-tenant sharing

In a separate browser profile or private window, sign in as
`bob@example.com` / `acme-bob-demo` (same tenant as Alice):

- Bob sees the same connected Jira status that Alice configured.
- Bob replaces it through the manage modal; reload as Alice — she sees Bob's
  replacement.
- A failed replacement (invalid token) preserves the previously valid
  connection unchanged.

## 5. Cross-tenant isolation

Sign in as `alice@globex.example.com` / `globex-alice-demo` in a third
profile:

- Globex starts disconnected; Acme's connection is not visible.
- Connect Globex independently. Two Jira connection rows now exist — one per
  tenant.
- A second Acme session never sees Globex's connection, and vice versa, even
  when configured to the same Jira site.

## 6. Ticket creation (UI)

As an Acme user with a valid Jira connection:

- Enter a valid project key in the project selector. The recent-tickets panel
  loads. If the project has no app-created tickets yet, the inline "Create
  your first Jira ticket!" form is shown.
- Create a ticket with a title and a multi-line description. Confirm:
  - The Jira issue appears in the correct project as a `Task`.
  - The summary equals the title; the description preserves internal line
    breaks.
  - The UI shows the returned issue key (e.g. `SCRUM-6`).
- Enter the project key in lowercase (`scrum`). The input preserves the
  entered casing; on submit the request sends `SCRUM` and creation succeeds.

## 7. Recent ticket loading and links

After creating one or more tickets:

- The recent-tickets list shows up to ten newest-first.
- Each title link opens the issue at
  `https://<site>.atlassian.net/browse/<issueKey>` in a new tab.
- Renaming the title in Jira and refreshing updates the list. Moving the
  issue to another project removes it from this project's list. Deleting in
  Jira removes it.
- A second user in the same tenant sees the same tenant-owned list.

## 8. API-key provisioning, external ticket creation, and revocation

```bash
# Provision a key for Alice.
npm run api-key:create --workspace apps/api -- --email alice@example.com
# Save the printed full key as API_KEY.

# Create a ticket via the external endpoint.
curl -i -X POST http://localhost:3001/api/v1/tickets \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"projectKey":"SCRUM","title":"External finding","description":"From the external API."}'

# Spoofed ownership fields are ignored; the row records Alice/Acme.
curl -i -X POST http://localhost:3001/api/v1/tickets \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"projectKey":"SCRUM","title":"t","description":"d","tenantId":"tenant-globex","userId":"user-globex-alice","siteUrl":"https://evil.atlassian.net"}'

# Revoke by the public key id printed during provisioning.
npm run api-key:revoke --workspace apps/api -- --key-id <keyId>

# After revocation, the same key returns 401.
curl -i -X POST http://localhost:3001/api/v1/tickets \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"projectKey":"SCRUM","title":"t","description":"d"}'
```

Confirm in the database that ownership came from the key, not the spoofed
fields, and that nothing sensitive leaks:

```bash
sqlite3 apps/api/data/app.db \
  'SELECT tenant_id, created_by_user_id, jira_site_url, jira_project_key, jira_issue_key
     FROM jira_ticket_provenance ORDER BY created_at DESC LIMIT 5;'
```

## 9. Validation and meaningful failure paths

| Action                                                | Expected                                        |
| ----------------------------------------------------- | ----------------------------------------------- |
| `POST /api/jira/connection` with `http://...`         | 400 `invalid_request`                           |
| `POST /api/jira/connection` with a wrong API token    | 422 `jira_credentials_rejected`; existing row preserved |
| `POST /api/tickets` with no Jira connection           | 409 `jira_not_connected`; no Jira call          |
| `POST /api/tickets` with an inaccessible project key  | 422 `jira_project_inaccessible`                 |
| `POST /api/v1/tickets` without `Authorization`        | 401 `unauthenticated`                           |
| `POST /api/v1/tickets` with a revoked key             | 401 `unauthenticated` (same envelope)           |
| `GET /api/tickets` with no `projectKey`               | 400 `invalid_request`                           |
| `GET /api/tickets?projectKey=ab-cd`                   | 400 `invalid_request`                           |

UI duplicate-creation guard: click the **Create ticket** button repeatedly
while the request is in flight; DevTools Network shows exactly one
`POST /api/tickets`.

UI uncertain-outcome warning: simulate a slow upstream or kill the API mid
request. The UI states the ticket may have been created, advises checking
Jira, warns about duplicates on retry, and does not retry automatically. No
raw Jira/backend text is shown.

## 10. Secret-leak checks

Using browser DevTools and shell tooling, confirm:

- `localStorage`, `sessionStorage`, and IndexedDB hold no Jira token,
  password, session token, or API key.
- The `nhi_session` cookie **is** the session token by design. Confirm it
  exists with the expected security attributes (`HttpOnly`, `SameSite=Lax`,
  `Path=/`, and `Secure` when `NODE_ENV=production`) and that
  `document.cookie` evaluated in the DevTools console does **not** include
  `nhi_session` (the `HttpOnly` flag is enforced).
- The raw session token appears only in the `Set-Cookie` response header of
  `POST /api/auth/login` and in the outbound `Cookie` request header on
  same-origin `/api/*` calls. It must not appear in any JSON response body,
  the DOM, the URL, the console, or application logs.
- API responses never contain the Jira token, the `Authorization` header
  value, the encrypted ciphertext, the encryption key, the API-key plaintext,
  the password hash, or raw Jira bodies.
- The DOM does not retain the Jira token or login password after submission.
- `git status` shows no `.env`, cookie jars, or saved keys staged.
- The database stores only safe values — in particular, the `sessions` table
  stores only the SHA-256 hash of each token, never the raw token:

  ```bash
  sqlite3 apps/api/data/app.db \
    'SELECT tenant_id, configured_by_user_id, site_url, email,
            substr(encrypted_token,1,3) AS prefix
       FROM jira_connections;'              # prefix should be v2.

  sqlite3 apps/api/data/app.db \
    'SELECT user_id, substr(password_hash,1,11) AS hash_prefix
       FROM user_credentials;'              # $argon2id$

  sqlite3 apps/api/data/app.db \
    'SELECT id, tenant_id, user_id, substr(secret_hash,1,8) AS hash_prefix, created_at
       FROM api_keys;'                      # secret_hash never the plaintext

  sqlite3 apps/api/data/app.db \
    'SELECT token_hash, tenant_id, user_id, expires_at FROM sessions;'  # SHA-256 hex
  ```
