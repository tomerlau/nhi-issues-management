# Development workflow

This document describes how this proof of concept (POC) is built, milestone by
milestone, and how the three collaborators divide responsibility. It is the
single source of truth for the process; the committed Claude Code configuration
(`.claude/`) enforces the parts that can be enforced automatically.

## Principles

- The repository is built one milestone at a time and stays small.
- One branch and one pull request per milestone. No direct implementation on
  `main`.
- No abstractions are introduced solely for future milestones.
- Relevant tests, documentation, UX, error handling, security, and manual
  validation are part of each milestone — not deferred to a vague "later".
- Automated and manual validation are complementary: passing checks do not by
  themselves prove a milestone is correct, and manual review does not replace
  the quality gate.
- Assumptions and POC-versus-production tradeoffs are documented in
  `docs/assumptions.md` when they become relevant.
- A milestone is not complete while blockers, required improvements, failing
  checks, missing documentation, or missing manual validation remain.
- Everything written in the repository is in English.

## Roles

### ChatGPT (planning and review)

- Reads the canonical project sources.
- Inspects the actual GitHub state rather than assuming it.
- Proposes and reviews milestone plans.
- Provides the approved Claude Code prompt for each milestone.
- Reviews the implementation: scope, tests, security, isolation, documentation,
  and manual validation.
- Classifies findings as blockers, required improvements, or optional
  improvements.
- Does not mark a requirement complete without evidence.

### Claude Code (implementation)

- Starts from current `main` using the **start-milestone** skill.
- Creates a `milestone/<number>-<slug>` branch before changing any files.
- Implements only the approved scope.
- Stays on the same milestone branch for fix iterations instead of branching
  again.
- Runs focused checks during development.
- Runs the full quality gate (`npm run check`) before finishing, via the
  **finish-work** skill.
- Leaves all work uncommitted.
- Reports results and remaining manual validation honestly, and never weakens or
  skips a check to make it pass.

### Developer (ownership)

- Approves the milestone plan.
- Runs the Claude Code prompt.
- Reviews the generated changes.
- Performs the required manual validation.
- Creates commits.
- Pushes branches.
- Opens or updates the pull request.
- Merges only after the completion criteria are met.

## How a milestone runs

1. **Plan.** ChatGPT proposes the milestone scope, acceptance criteria, and
   non-goals; the developer approves it and an approved Claude Code prompt is
   produced.
2. **Start.** Claude runs the start-milestone skill: it requires a clean working
   tree, fast-forwards `main` from `origin/main`, creates the milestone branch,
   loads repository context, and summarizes the plan and likely changes.
3. **Implement.** Claude implements only the approved scope on the milestone
   branch, running focused checks as it goes.
4. **Fix iterations.** Follow-up fixes stay on the same milestone branch — no new
   branch is created for corrections within the milestone.
5. **Finish.** Claude runs the finish-work skill: it confirms the branch is not
   protected, inspects the diff, runs `git diff --check` and `npm run check`,
   reviews the work against the approved task, and reports honestly. All changes
   stay uncommitted.
6. **Review and own.** ChatGPT reviews; the developer performs manual
   validation, then commits, pushes, and opens the pull request.

## Enforced guardrails

The committed Claude Code configuration enforces the rules that can be automated:

- `.claude/hooks/guard-branch.mjs` (a `PreToolUse` hook) blocks file edits on
  `main`, `master`, a detached HEAD, or when the branch cannot be determined. It
  fails closed.
- `.claude/hooks/run-quality-gates.mjs` (a `Stop` hook) runs `git diff --check`
  and `npm run check` when relevant local changes exist, and blocks Claude from
  finishing while a required check fails.
- `.claude/settings.json` denies Git and GitHub commands that would stage,
  commit, push, merge, rebase, cherry-pick, revert, tag, force-update history,
  or create/modify/merge/close pull requests and releases. Read-only Git
  inspection and the narrow branch-preparation commands remain allowed.

The branch-decision logic is unit-tested (`.claude/hooks/branch-decision.test.mjs`)
and runs as part of `npm run check`.

## Canonical commands

- `npm run dev` — run both applications.
- `npm run check` — the canonical local quality gate: lint, typecheck, all tests
  (including the workflow hook tests), then build, fail-fast in that order.
