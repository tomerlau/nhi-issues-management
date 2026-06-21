# CLAUDE.md

Repository-wide guidance for Claude Code. This file holds only stable
instructions. Milestone-specific scope, assumptions, acceptance criteria, and
non-goals come from the current approved task prompt, never from this file.

## Repository purpose

A focused POC of Non-Human Identity Issues Management System. The repository is built one milestone at a time and intentionally stays
small.

## Structure

An npm-workspaces monorepo with a clear frontend/backend separation:

- `apps/api` — Express + TypeScript backend.
- `apps/web` — React + Vite + TypeScript frontend.
- `docs/` — `architecture.md` and `assumptions.md`.

The frontend and backend are separate applications. The frontend talks to the
backend only over relative `/api` requests via the Vite dev proxy.

## Runtime requirements

- Node.js 24 (`>=24 <25`, see `.nvmrc`).
- npm 10+ (bundled with Node.js 24).

## Commands (run from the repository root)

- `npm run dev` — run both applications.
- `npm run lint` — ESLint across the repo.
- `npm run typecheck` — TypeScript strict typecheck for both apps.
- `npm test` — Vitest unit tests for both apps.
- `npm run test:workflow` — Node test runner for the Claude workflow hooks.
- `npm run build` — build both apps.
- `npm run check` — the canonical quality gate: lint, typecheck, all tests
  (including the workflow hook tests), then build, fail-fast in that order.

## How to work in this repository

- Use the `start-milestone` skill before any milestone implementation.
- Use the `finish-work` skill before reporting an implementation iteration done.
- Implement only the approved scope. Prefer the smallest implementation that
  satisfies the current milestone.
- Do not introduce abstractions solely for future milestones.
- Tests, documentation, security, UX, error handling, and manual validation
  belong to the milestone whose scope they support — not to speculative future
  work.
- Repository documentation must describe implemented behavior, not speculative
  architecture.

## Hard rules

- Never stage, commit, push, merge, rebase, cherry-pick, revert, create tags,
  or create/update pull requests. The developer owns all Git history and PRs.
- Never modify files while on `main`, `master`, or a detached HEAD. Start a
  milestone branch first.
- Never resolve a dirty working tree by stashing, resetting, cleaning, or
  discarding changes.
- Never expose secrets, credentials, tokens, API keys, passwords, sessions, or
  authorization headers in code, logs, tests, or generated text.

## Language

All repository code, comments, documentation, command examples, and generated
text must be written in English.
