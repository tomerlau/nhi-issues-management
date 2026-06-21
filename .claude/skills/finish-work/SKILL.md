---
name: finish-work
description: Validate a milestone iteration before reporting it done — verify the branch, inspect the diff, run the full quality gate, and produce an honest report. Use before claiming completion. Leaves all work uncommitted.
---

# Finish work

Use this workflow before reporting any implementation iteration as complete. It
validates and reports. It never stages, commits, or weakens a check.

## Steps

1. Verify the active branch with `git branch --show-current`. It must not be
   `main`, `master`, or a detached HEAD. If it is, STOP and report.
2. Inspect the work: `git status --short` and the full diff (`git diff` plus
   `git diff --staged` if anything is staged).
3. Run the checks:
   - `git diff --check` (whitespace errors and conflict markers).
   - `npm run check` (the complete quality gate: lint, typecheck, all tests
     including the workflow hook tests, then build).
4. Review the diff against the approved task:
   - scope and acceptance criteria
   - non-goals (nothing out of scope was added)
   - security requirements (no secrets, credentials, or tokens introduced)
   - tests added or updated
   - documentation updated
   - assumptions and tradeoffs
5. Never hide, ignore, or weaken a failing check. Never edit lint, typecheck,
   test, or build configuration merely to suppress a valid failure.
6. Leave every change uncommitted. Do not stage, commit, push, or open a PR.

## Final report

Produce a report containing:

- active branch
- changed files
- a concise implementation summary
- the exact commands run
- pass/fail result for every check
- automated tests added or updated
- documentation updated
- manual validation still required
- assumptions or tradeoffs introduced
- known failures, limitations, or unresolved issues
- the final `git status --short`

Do not claim completion if any required check fails.
