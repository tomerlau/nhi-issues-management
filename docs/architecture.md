# Architecture

This document describes the architecture that currently exists in Milestone 1.
It intentionally avoids designing later domain layers in detail.

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
  nothing about ports, sockets, or process signals and takes no dependencies.
- `src/server.ts` is the process entry point. It starts the HTTP server on the
  fixed local port 3001 and registers a small SIGINT/SIGTERM handler that closes
  the HTTP server.

This separation lets tests exercise the full Express application in-process with
`supertest`, without binding a real TCP port.

## Health endpoint

`GET /api/health` returns HTTP 200 with exactly `{ "status": "ok" }`. It depends
on no external resource and exposes no configuration, paths, or internals.

## Quality gates and CI

ESLint, TypeScript strict typecheck, Vitest tests, and builds run for both
workspaces via root scripts, and GitHub Actions runs the same checks on pushes
and pull requests.

## Persistence

There is no persistence in Milestone 1. SQLite will be introduced in
Milestone 2 together with the first domain schema. Adding a database connection
now would be infrastructure with no consumer.
