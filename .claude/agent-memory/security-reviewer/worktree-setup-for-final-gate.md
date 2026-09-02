---
name: worktree-setup-for-final-gate
description: A freshly created security-reviewer worktree in this repo has no node_modules and no .env.local — both are needed before typecheck/lint/test/build (and the pre-push CI hook) will succeed.
metadata:
  type: project
---

When setting up an isolated worktree (`git worktree add`) to run the mandatory final `/code-review` gate + validation before opening a PR in this repo:

- `node_modules` is not present — run `pnpm install --frozen-lockfile` inside the worktree first (fast, uses the shared pnpm store). This is safe: it's the reviewer's *own* isolated worktree, not the shared main checkout, so it doesn't violate the "never `pnpm install` in the shared checkout" rule.
- `.env.local` is gitignored and not present either. `npm run build` fails with `DATABASE_URL is not set` (and similar) without it. Copy it from the main checkout: `cp /Users/samuelromeroarbelo/Projects/Alea/alea-webapp/.env.local <worktree>/.env.local`. Never paste its contents into chat — copy the file directly.
- The repo has a pre-push hook that runs a local CI (typecheck → lint → test → build) — pushing from the worktree will fail loudly with the same missing-env/missing-deps symptoms if either step above is skipped, before any git error.

**Why:** hit this in PR #339 (#330, Clerk middleware hardening) — `git push` failed on the build step of the pre-push hook with a `DATABASE_URL is not set` error that had nothing to do with the actual code change, costing a debugging detour before realizing it was just missing worktree setup, not a real regression.

**How to apply:** do both `pnpm install` and the `.env.local` copy as the very first steps after `git worktree add`, before running any validation, to avoid mistaking a missing-env symptom for a real build regression.
