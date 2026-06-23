# External Ticket REST API

External systems can create Jira tickets through one endpoint authenticated by
an application-issued API key. The endpoint is separate from the
session-authenticated `/api/tickets` used by the web UI and does **not** accept
session cookies.

For provisioning behavior see [setup.md](setup.md); for security properties
see [security.md](security.md).

## Endpoint

```
POST /api/v1/tickets
```

## Authentication

```
Authorization: Bearer <full-api-key>
```

- The header is required and the scheme must be `Bearer`.
- A session cookie without a valid API key is rejected.
- All authentication failures return the same generic `401 Unauthenticated`
  with `Cache-Control: no-store`. No failure path reveals *why* the request
  was rejected.

Provision a key:

```bash
npm run api-key:create --workspace apps/api -- --email alice@example.com
```

Revoke a key by its public key ID:

```bash
npm run api-key:revoke --workspace apps/api -- --key-id <keyId>
```

The full key follows the format `nhi_<keyId>.<secret>` and is shown exactly
once when provisioned. Only the SHA-256 hash of the secret is stored.

## Request

`Content-Type: application/json` is required. Maximum body size 10 KB.

```json
{
  "projectKey": "SCRUM",
  "title": "Stale Service Account: svc-deploy-prod",
  "description": "Finding details"
}
```

| Field         | Type   | Required | Constraints                                                                                                       |
| ------------- | ------ | -------- | ----------------------------------------------------------------------------------------------------------------- |
| `projectKey`  | string | Yes      | Trimmed and uppercased; matches `^[A-Z][A-Z0-9]+$`; 2–10 chars after normalization. Case-insensitive (`scrum` → `SCRUM`). |
| `title`       | string | Yes      | Non-empty after trimming; ≤ 255 chars.                                                                            |
| `description` | string | Yes      | Non-empty after trimming; ≤ 5000 chars; internal line breaks preserved.                                           |

Any additional fields (including `tenantId`, `userId`, `connectionId`,
`siteUrl`, `issueType`) are **silently ignored**. The tenant, user, Jira
connection, site URL, credentials, and issue type are all resolved from the
stored API key and tenant state — never from the request body.

The Jira issue type is always the project's non-subtask `Task`.

## Success response

`HTTP 201 Created`:

```json
{ "issueId": "10500", "issueKey": "SCRUM-42" }
```

## Error envelope

All errors use the same structured envelope:

```json
{
  "error": {
    "code": "<error-code>",
    "message": "<human-readable message>"
  }
}
```

All responses set `Cache-Control: no-store`.

| Status | Code                          | Meaning                                                                                                  |
| ------ | ----------------------------- | -------------------------------------------------------------------------------------------------------- |
| 201    | —                             | Ticket created. Body contains `issueId` and `issueKey`.                                                  |
| 400    | `invalid_request`             | Malformed JSON, oversized body, or missing/invalid/empty/overlong field.                                 |
| 401    | `unauthenticated`             | Missing `Authorization` header, wrong scheme, malformed key, unknown id, wrong secret, or revoked key.   |
| 409    | `jira_not_connected`          | The API-key owner's tenant has no Jira connection configured.                                            |
| 422    | `jira_project_inaccessible`   | The requested project does not exist or is not accessible to the tenant's Jira connection.               |
| 422    | `jira_task_unsupported`       | The requested project does not support the fixed `Task` issue type.                                      |
| 500    | `internal_error`              | Jira confirmed creation but local provenance persistence failed (see POC limitation below).              |
| 502    | `jira_credentials_rejected`   | The stored Jira credentials were rejected. Reconnect Jira and try again.                                 |
| 502    | `jira_unreachable`            | Jira was unreachable, returned a malformed response, or returned a 5xx.                                  |
| 503    | `jira_not_configured`         | The Jira encryption key is missing or the stored token cannot be decrypted.                              |
| 504    | `jira_timeout`                | The Jira request timed out.                                                                              |

## curl examples

Create a ticket:

```bash
curl -X POST http://localhost:3001/api/v1/tickets \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "projectKey": "SCRUM",
    "title": "Stale Service Account: svc-deploy-prod",
    "description": "Found a stale service account credential with broad permissions."
  }'
```

Missing key (expect 401):

```bash
curl -i -X POST http://localhost:3001/api/v1/tickets \
  -H "Content-Type: application/json" \
  -d '{"projectKey":"SCRUM","title":"Test","description":"Test"}'
```

Spoofed ownership fields (ignored; the API-key owner's tenant and user are
used):

```bash
curl -i -X POST http://localhost:3001/api/v1/tickets \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "projectKey":"SCRUM","title":"Test","description":"Test",
    "tenantId":"tenant-globex","userId":"user-globex-alice",
    "siteUrl":"https://evil.atlassian.net"
  }'
```

## Tenant and ownership behavior

- Ownership (`tenantId`, `userId`) derives exclusively from the stored API-key
  record. The mapping is fixed at key creation and cannot be changed.
- The ticket is always created against the resolved tenant's shared Jira
  connection.
- The provenance row records the API-key owner's `tenantId` and `userId`.
- An API key from tenant A never accesses tenant B's Jira connection or
  provenance, even if tenant B's connection id, site URL, or user is known.

## Security guidance

- Store the full key as a secret (environment variable, secrets manager, or
  CI/CD secrets vault). Never commit it.
- The key is shown only once when created and cannot be recovered. If lost,
  revoke it and provision a new one.
- Never log the `Authorization` header, the full key, or any part of the
  secret component.
- Revoke keys that are no longer needed, may have been exposed, or belong to
  users who have left the organization. Revocation is immediate, permanent,
  and idempotent; the deleted row is indistinguishable from an unknown key.

## POC limitation: ticket creation is not idempotent

Jira issue creation and local provenance persistence are sequential and not
atomic. Two edge cases can leave an issue untracked:

1. **Confirmed creation, failed provenance (HTTP 500)**: Jira confirms the
   creation and returns the issue key, but the subsequent provenance insert
   fails. The Jira issue exists but has no local provenance row.
2. **Timeout before confirmation (HTTP 504)**: The application times out
   waiting for Jira's response. The issue may or may not have been created;
   the application cannot determine which.

**Retrying after a timeout or an uncertain Jira response may create a
duplicate.** Check Jira directly before retrying.

There is no idempotency key, durable operation tracking, safe-retry mechanism,
or reconciliation worker in this POC. See [assumptions.md](assumptions.md) for
the production alternative.

For broader manual validation (login, Jira connection, sharing, isolation,
tickets, API keys), see [manual-validation.md](manual-validation.md).
