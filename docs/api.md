# External Ticket API

This document describes the external REST API introduced in Milestone 13. It
covers provisioning, authentication, request/response contracts, status codes,
and secret-handling guidance.

## Overview

External systems can create NHI finding Jira tickets by calling one endpoint
with an application-issued API key. The endpoint is separate from the
session-authenticated `POST /api/tickets` used by the web UI, and does not
accept session cookies.

## API-key provisioning

Keys are provisioned locally through a CLI script. There is no REST endpoint for
key creation. Run the command in the `apps/api` workspace, substituting the email
address of an existing seeded user:

```bash
npm run api-key:create --workspace apps/api -- --email alice@example.com
```

The script prints the full plaintext key exactly once:

```
API key created successfully.
Key ID:   <keyId>
Full key: nhi_<keyId>.<secret>

IMPORTANT: This key cannot be retrieved again. Store it securely.
```

The key follows the format `nhi_<keyId>.<secret>`:
- `keyId` — 22-character base64url public selector (stored in the database).
- `secret` — 43-character base64url secret component (only its SHA-256 hash is
  stored). The plaintext is shown only at creation and is never recoverable.

The key is always owned by the user resolved from the email. Ownership (tenant
and user) cannot be supplied as CLI arguments or request fields.

## API-key revocation

Revoke a key by its public key ID:

```bash
npm run api-key:revoke --workspace apps/api -- --key-id <keyId>
```

Revocation is permanent and immediate. The deleted row is indistinguishable from
an unknown key. All subsequent requests using the revoked key return `401
Unauthenticated`. Revocation is idempotent — revoking a key ID that was already
removed exits cleanly.

## Endpoint

```
POST /api/v1/tickets
```

### Authentication

```
Authorization: Bearer <full-api-key>
```

The `Authorization` header is required. The scheme must be `Bearer`. A session
cookie without a valid API key is rejected. All authentication failures return
the same sanitized `401 Unauthenticated` response (see status table below).

### Request body

```json
{
  "projectKey": "SCRUM",
  "title": "Stale Service Account: svc-deploy-prod",
  "description": "Finding details"
}
```

| Field        | Type   | Required | Constraints                                                                        |
| ------------ | ------ | -------- | ---------------------------------------------------------------------------------- |
| `projectKey` | string | Yes      | 2–10 characters after trimming and uppercasing; matches `[A-Z][A-Z0-9]+`. Case-insensitive — `scrum` becomes `SCRUM`. |
| `title`      | string | Yes      | Non-empty after trimming; maximum 255 characters.                                  |
| `description`| string | Yes      | Non-empty after trimming; maximum 5000 characters; internal line breaks preserved. |

Fields beyond `projectKey`, `title`, and `description` are silently ignored. The
tenant, user, Jira connection, site URL, credentials, and issue type are all
resolved from the stored API key and tenant state — never from the request body.

The request body must be valid JSON and must not exceed 10 KB. A `Content-Type:
application/json` header is required.

### Successful response

HTTP `201 Created`:

```json
{
  "issueId": "10500",
  "issueKey": "SCRUM-42"
}
```

### Error envelope

All error responses use the same structured envelope:

```json
{
  "error": {
    "code": "<error-code>",
    "message": "<human-readable message>"
  }
}
```

### HTTP status table

| Status | Code                         | Meaning                                                                                              |
| ------ | ---------------------------- | ---------------------------------------------------------------------------------------------------- |
| 201    | —                            | Ticket created successfully. Body contains `issueId` and `issueKey`.                                 |
| 400    | `invalid_request`            | Malformed JSON, oversized body, or missing/invalid/empty/overlong field.                             |
| 401    | `unauthenticated`            | Missing `Authorization` header, wrong scheme, malformed key, unknown ID, wrong secret, or revoked key. |
| 409    | `jira_not_connected`         | The API-key owner's tenant has no Jira connection configured.                                        |
| 422    | `jira_project_inaccessible`  | The requested project does not exist or is not accessible to the tenant's Jira connection.           |
| 422    | `jira_task_unsupported`      | The requested project does not support the fixed `Task` issue type.                                  |
| 500    | `internal_error`             | Jira confirmed ticket creation but local provenance persistence failed (see POC limitation below).   |
| 502    | `jira_credentials_rejected`  | The stored Jira credentials were rejected by Jira. Reconnect Jira and try again.                     |
| 502    | `jira_unreachable`           | Jira was unreachable, returned a malformed response, or returned a 5xx.                              |
| 503    | `jira_not_configured`        | The Jira encryption key is missing or the stored token cannot be decrypted.                          |
| 504    | `jira_timeout`               | The Jira request timed out.                                                                          |

All responses include `Cache-Control: no-store`.

### curl example

```bash
# Create a ticket (replace values as needed):
curl -X POST http://localhost:3001/api/v1/tickets \
  -H "Authorization: Bearer nhi_<keyId>.<secret>" \
  -H "Content-Type: application/json" \
  -d '{
    "projectKey": "SCRUM",
    "title": "Stale Service Account: svc-deploy-prod",
    "description": "Found a stale service account credential with broad permissions."
  }'
```

## Tenant and ownership behavior

- Ownership (tenant and user) derives exclusively from the stored API-key record.
- The API key resolves to exactly one tenant and one user at key-creation time.
  That mapping cannot change.
- The ticket is created against the resolved tenant's shared Jira connection.
- The provenance row records the API-key owner's `tenantId` and `userId`.
- An API key from tenant A never accesses tenant B's Jira connection or
  provenance, even if tenant B's connection ID, site URL, or user is known.
- Request fields beyond `projectKey`, `title`, and `description` — including
  `tenantId`, `userId`, `connectionId`, `siteUrl`, or similar — are silently
  ignored and cannot change the resolved context.

## Secret-handling guidance

- Store the full key as a secret (for example in environment variables, a secrets
  manager, or a CI/CD secrets vault). Never commit it to source control.
- The key is shown only once at creation. It cannot be recovered. If lost,
  revoke the old key and provision a new one.
- Never log the `Authorization` header, the full key, or any part of the secret
  component.
- The endpoint returns `Cache-Control: no-store` so intermediate caches never
  store a response that might contain sensitive metadata.
- Revoke keys that are no longer needed, that may have been exposed, or that
  belong to users who have left the organization.

## Revocation behavior

- Revoking a key permanently deletes the database row.
- There is no tombstone, `revoked_at` value, or audit history of revoked keys.
- After revocation the key ID is indistinguishable from an unknown key.
- All subsequent requests with the revoked key return `401 Unauthenticated`.
- Revocation is idempotent; revoking a key that no longer exists exits cleanly.

## POC limitations

### Ticket creation is not idempotent

Jira issue creation and local provenance persistence are sequential and are not
a distributed transaction. Two edge cases can leave an issue untracked:

1. **Confirmed creation, failed provenance (HTTP 500)**: Jira confirms the
   creation and returns the issue key, but the subsequent provenance insert fails.
   The Jira issue exists but has no local provenance row.

2. **Timeout before confirmation (HTTP 504)**: The application times out waiting
   for Jira's response. The issue may or may not have been created; the
   application cannot determine this and records no provenance.

**Warning**: retrying after a timeout or an uncertain Jira response may create a
duplicate Jira issue. Check Jira directly before retrying.

There is no idempotency key, durable operation tracking, safe-retry mechanism,
or reconciliation worker in this POC.

## Manual validation commands

### 1. Provision an API key for a seeded user

```bash
npm run api-key:create --workspace apps/api -- --email alice@example.com
# Save the printed key as API_KEY=nhi_<keyId>.<secret>
```

### 2. Create a ticket with curl

```bash
curl -si -X POST http://localhost:3001/api/v1/tickets \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"projectKey":"SCRUM","title":"Stale svc-deploy-prod","description":"Found."}'
```

### 3. Call without a key (expect 401)

```bash
curl -si -X POST http://localhost:3001/api/v1/tickets \
  -H "Content-Type: application/json" \
  -d '{"projectKey":"SCRUM","title":"Test","description":"Test"}'
```

### 4. Call with an invalid key (expect 401)

```bash
curl -si -X POST http://localhost:3001/api/v1/tickets \
  -H "Authorization: Bearer nhi_invalid.key" \
  -H "Content-Type: application/json" \
  -d '{"projectKey":"SCRUM","title":"Test","description":"Test"}'
```

### 5. Call after revocation (expect 401)

```bash
# Revoke using the key ID printed during provisioning:
npm run api-key:revoke --workspace apps/api -- --key-id <keyId>

# The key now returns 401:
curl -si -X POST http://localhost:3001/api/v1/tickets \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"projectKey":"SCRUM","title":"Test","description":"Test"}'
```

### 6. Call with an inaccessible project (expect 422)

```bash
curl -si -X POST http://localhost:3001/api/v1/tickets \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"projectKey":"NOACCESS","title":"Test","description":"Test"}'
```

### 7. Attempt ownership spoofing (spoofed fields are ignored)

```bash
curl -si -X POST http://localhost:3001/api/v1/tickets \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "projectKey": "SCRUM",
    "title": "Test",
    "description": "Test",
    "tenantId": "tenant-globex",
    "userId": "user-globex-alice",
    "siteUrl": "https://evil.atlassian.net"
  }'
# The response will use the API key owner's tenant and user, not the spoofed values.
# Check provenance to confirm:
```

### 8. Inspect local provenance without displaying secrets

```bash
# Query provenance rows directly (contains no credentials or key material):
sqlite3 apps/api/data/app.db \
  "SELECT id, tenant_id, created_by_user_id, jira_site_url, jira_issue_key, created_at FROM jira_ticket_provenance;"
```

### 9. Confirm no secrets appear in logs, responses, or source control

- Responses never contain the full API key, the `Authorization` header value,
  Jira API tokens, or raw Jira response bodies — verify by inspecting curl output.
- Source files never contain plaintext keys; keys are generated at runtime and
  stored only as SHA-256 hashes in the database.
- The database stores only `secret_hash` (a SHA-256 hash), never the plaintext
  secret component.
- The `jira_ticket_provenance` table stores no title, description, or credential.
