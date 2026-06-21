# IdentityHub to Jira

A focused proof of concept for integrating Oasis Security IdentityHub with Jira.

This repository is built in milestones. The current milestone establishes the
project foundation: a clean monorepo with a separated frontend and backend, a
minimal backend health endpoint, and a frontend that displays backend
availability. No domain functionality is implemented yet.

## Current milestone scope (Milestone 1: Project Foundation)

Implemented:

- npm-workspaces monorepo with separate `apps/api` (backend) and `apps/web` (frontend).
- One command (`npm run dev`) to run both applications locally.
- Express backend in TypeScript exposing `GET /api/health`.
- React + Vite frontend that shows loading, connected, and unavailable states with a retry action.
- Quality gates: ESLint, TypeScript strict typecheck, Vitest tests, build.
- GitHub Actions CI running the same checks.

Explicitly **not** implemented in this milestone (planned for later work):

- Persistence (SQLite is introduced in Milestone 2), schema, migrations, or seed data.
- Users, tenants, sessions, login/logout, authentication or authorization.
- Jira OAuth, Jira API access, or credential encryption.
- Ticket creation, recent tickets, or API keys.
- External REST ticket creation or Jira project validation.
- Docker, deployment configuration, or UI component libraries.
- End-to-end browser tests.

## Prerequisites

- **Node.js 24** (see `.nvmrc`). With `nvm`, run `nvm use`.
- npm 10+ (bundled with Node.js 24).

## Clean-clone setup

No environment file is required in Milestone 1.

```bash
git clone https://github.com/tomerlau/nhi-issues-management.git
cd nhi-issues-management
nvm use            # or otherwise ensure Node.js 24 is active
npm ci
npm run dev
```

## Development

`npm run dev` starts both applications together:

- Frontend: http://localhost:5173
- Backend: http://localhost:3001
- Health endpoint: http://localhost:3001/api/health (or http://localhost:5173/api/health through the proxy)

`GET /api/health` returns HTTP 200 with exactly `{ "status": "ok" }`.

Stop the backend (or run only `npm run dev --workspace apps/web`) to see the
frontend switch to its unavailable state; use the retry action after restarting
the backend.

## Quality gate commands

Run from the repository root; each delegates to both workspaces:

```bash
npm run lint        # ESLint across both apps
npm run typecheck   # TypeScript strict typecheck for both apps
npm test            # Vitest unit tests for both apps
npm run build       # Build backend (tsc) and frontend (vite build)
```

## How the Vite proxy works

The frontend never calls the backend by absolute URL. It requests the relative
path `/api/health`. In development, the Vite dev server (`apps/web/vite.config.ts`)
proxies any request beginning with `/api` to `http://localhost:3001`. This keeps
the browser talking only to the Vite origin, so no permissive CORS configuration
is required on the backend.

## Repository structure

```
/
├── apps/
│   ├── api/                 # Express + TypeScript backend
│   │   ├── src/
│   │   │   ├── app.ts       # Express application construction
│   │   │   └── server.ts    # process startup and listening
│   │   └── test/            # backend Vitest tests
│   └── web/                 # React + Vite frontend
│       ├── src/
│       │   ├── api/         # typed backend API functions
│       │   ├── App.tsx      # backend-availability UI
│       │   └── main.tsx     # React entry point
│       └── test/            # frontend Vitest tests
├── docs/
│   ├── architecture.md
│   └── assumptions.md
├── .github/workflows/ci.yml
├── .nvmrc
└── package.json             # npm workspaces + root scripts
```

## Further reading

- [docs/architecture.md](docs/architecture.md) — structure, separation, and request flow.
- [docs/assumptions.md](docs/assumptions.md) — project assumptions and production tradeoffs.
