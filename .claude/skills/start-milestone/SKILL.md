---
name: start-milestone
description: Prepare an updated main and a fresh milestone branch, then load repository context before any milestone implementation. Use this before editing files for a new milestone.
---

# Start milestone

Use this workflow before implementing a new milestone. It only prepares and
validates the branch and context — it does not implement anything.

For a **fix iteration inside an existing milestone**, do NOT run this skill and
do NOT create another branch. Stay on the existing `milestone/<n>-<slug>` branch.

## Inputs

- The approved milestone number and a short kebab-case slug, used to build the
  branch name `milestone/<number>-<short-kebab-case-slug>`. Derive the slug from
  the approved milestone title if it was not given explicitly.

## Steps

1. Inspect state: run `git status --porcelain` and `git branch --show-current`.
2. If there are any tracked or untracked local changes, STOP and report them.
   Do not continue.
   - Never use `git stash`, `git reset`, `git clean`, checkout-based discarding,
     or file deletion to clear local changes. The developer resolves them.
3. Run `git fetch origin`.
4. Switch to main: `git switch main` (or `git checkout main`).
5. Fast-forward only: `git pull --ff-only origin main`. If this fails, STOP and
   report — do not force or rebase.
6. Verify the update: `git rev-parse main` must equal `git rev-parse origin/main`.
7. Choose the branch name `milestone/<number>-<short-kebab-case-slug>` and check
   it does not already exist:
   - `git branch --list "<name>"`
   - `git ls-remote --heads origin "<name>"`
   - If it exists locally or remotely, STOP and report. Never overwrite, reset,
     delete, or reuse it.
8. Create and switch to it: `git switch -c "<name>"` (or `git checkout -b`).
9. Confirm the new branch is active with `git branch --show-current` before any
   implementation.

## Load context

Read the current repository context (skip files that do not exist):

- `CLAUDE.md`
- `README.md`
- `docs/architecture.md`
- `docs/assumptions.md`
- root `package.json`
- the relevant application package files (`apps/api/package.json`,
  `apps/web/package.json`)
- the files and tests relevant to the approved milestone

## Summarize

Report back, then stop:

- active branch
- base commit SHA (`git rev-parse HEAD`)
- current implemented state
- approved milestone scope
- files likely to change
- any detected inconsistencies or blockers

Do not begin implementation until the new branch is confirmed active and the
summary is reported.
