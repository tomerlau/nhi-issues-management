# Architecture

This document describes the architecture that currently exists through
Milestone 2. It intentionally avoids designing later domain layers in detail.

## Monorepo structure

The repository is an npm-workspaces monorepo with two independent applications:

- `apps/api` — the Node.js/TypeScript backend (Express).
- `apps/web` — the React/Vite frontend (TypeScript).

Shared tooling configuration (TypeScript base config, ESLint flat config) lives
at the repository root so both applications stay consistent. Application runtime
dependencies are scoped to their respective workspaces: the frontend never
depends on backend packages and vice versa. No shared code package exists yet,
because there is no genuine cross-application code to share.

## Frontend / backend separation

The frontend and backend are separate applications with separate dependency
trees, build outputs, and lifecycles. They communicate only over HTTP. The
frontend holds no backend secrets or configuration; the only thing it knows is
the relative endpoint `/api/health`.

## Local request flow

```
Browser
  -> Vite development server (5173)
  -> /api proxy
  -> Express GET /api/health (3001)
  -> { "status": "ok" }
```

In development the Vite dev server proxies any `/api/*` request to the backend.
This keeps the browser on a single origin and removes any need for permissive
CORS on the backend.

## Backend application / startup separation

The backend separates application construction from process startup:

- `src/app.ts` exports `createApp()`, which builds and configures the Express
  application (disables `x-powered-by`, registers `GET /api/health`). It knows
  nothing about ports, sockets, process signals, or the database, and takes no
  dependencies.
- `src/server.ts` is the process entry point. It resolves the database location,
  initializes the database (open, verify foreign keys, run migrations), starts
  the HTTP server on the fixed local port 3001, and registers a SIGINT/SIGTERM
  handler that closes the HTTP server and then the database.

This separation lets tests exercise the full Express application in-process with
`supertest`, without binding a real TCP port or opening a database.

## Health endpoint

`GET /api/health` returns HTTP 200 with exactly `{ "status": "ok" }`. It depends
on no external resource and exposes no configuration, paths, or internals.

## Quality gates and CI

ESLint, TypeScript strict typecheck, Vitest tests, and builds run for both
workspaces via root scripts, and GitHub Actions runs the same checks on pushes
and pull requests.

## Persistence

Milestone 2 introduces persistence with SQLite, using the built-in Node.js 24
`node:sqlite` module. No ORM, query builder, or external SQLite dependency is
used.

### Connection lifecycle

`src/database/connection.ts` exports `openDatabase(location)`, the single factory
for every connection the application creates. It ensures the parent directory
exists for file-backed databases, executes `PRAGMA foreign_keys = ON`, and then
reads the pragma back to verify enforcement is actually on, failing fast if not.
Because foreign keys are a per-connection setting in SQLite, routing all
connections through this factory is what guarantees referential integrity is
always active.

`src/config/database.ts` resolves the location: `DATABASE_PATH` when set,
otherwise the default `apps/api/data/app.db`. The literal `:memory:` selects an
in-memory database, used throughout tests. `src/database/lifecycle.ts` composes
the factory with the migrator (`initializeDatabase`), and `src/server.ts` calls
it on startup and closes the connection during graceful shutdown.

### Migration flow

`src/database/migrator.ts` is a minimal runner. It ensures a `schema_migrations`
table, lists numbered `*.sql` files from `apps/api/migrations/` in deterministic
order, and applies only those not already recorded. Each migration runs inside
its own transaction: on success it is recorded in `schema_migrations` and
committed; on failure it is rolled back and left unrecorded, so the next run
retries it and partially applied schema never persists. Re-running is therefore
idempotent and safe. Migration files are plain SQL — there is no programmatic
migration framework.

### Tenant and user schema

`001_initial_schema.sql` creates two `STRICT` tables:

- `tenants(id TEXT PK, name, created_at)`.
- `users(id TEXT PK, tenant_id, email, display_name, created_at)` with
  `tenant_id` referencing `tenants(id)` and a `UNIQUE (tenant_id, email)`
  constraint.

A user belongs to exactly one tenant. Email uniqueness is scoped to the tenant,
so the same address can exist in different tenants. No cascading delete is
defined; deletion is out of scope for this milestone.

### Tenant-scoped repositories

`src/repositories/` holds two small, explicit repositories. `TenantRepository`
creates, finds, and lists tenants. `UserRepository` requires the owning
`tenantId` on every method (`create`, `findById`, `findByEmail`, `list`), and
every query includes `tenant_id` in its `WHERE` clause. There is deliberately no
unscoped accessor such as `findUserById(userId)` or `listAllUsers()`. All values
are passed as bound parameters via prepared statements.

### Foreign-key integrity vs. tenant authorization

These are two distinct guarantees and neither replaces the other. Foreign keys
provide *referential integrity*: a user row cannot reference a tenant that does
not exist. Tenant-scoped repository queries provide *authorization isolation*: a
caller operating in tenant A's context cannot read or list tenant B's users,
even though both rows are valid and the foreign keys are satisfied. A user ID
alone is never treated as sufficient scope; the tenant boundary is always
required.

### Why no ORM or generic repository layer

The schema is intentionally tiny and the queries are simple and explicit. A
plain `node:sqlite` connection with hand-written SQL keeps the persistence layer
easy to read and audit, avoids native build dependencies, and makes the tenant
boundary visible in every query. An ORM or a generic base repository would add
abstraction and indirection with no payoff at this scope, and a generic layer
risks hiding the very tenant-scoping the design depends on.
