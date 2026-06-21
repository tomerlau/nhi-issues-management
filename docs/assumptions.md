# Project Assumptions

This document records the assumptions and tradeoffs relevant to the
functionality implemented through the current milestone (Milestone 1). It grows
cumulatively as later milestones add functionality.

## Scope

- This is a focused proof of concept (POC), not a production system.
- Mandatory functionality has priority over optional functionality.
- Milestone 1 contains only the project foundation.
- The optional blog digest is not part of the current implementation.

## Frontend

- React, built with Vite, written in TypeScript.
- A separate frontend application.
- Communicates with the backend only over relative `/api` requests, forwarded by
  the Vite development proxy.

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

## Persistence timing

- **POC assumption:** Milestone 1 has no persistence. SQLite will be introduced
  in Milestone 2 together with the first schema, migrations, repositories, seed
  data, and tenant boundaries.
- **Production alternative:** a managed relational database with production-grade
  lifecycle, backups, availability controls, configuration, and credentials.
- **Tradeoff:** persistence is not validated in Milestone 1, but the repository
  avoids database infrastructure with no current consumer.
