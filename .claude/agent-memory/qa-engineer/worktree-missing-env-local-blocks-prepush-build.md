---
name: worktree-missing-env-local-blocks-prepush-build
description: A fresh git worktree lacks .env.local (gitignored) so `pnpm run build` fails on DATABASE_URL-is-not-set during "Collecting page data" — pre-push hook runs build, so push is blocked until the worktree gets its own copy
metadata:
  type: project
---

git worktrees do not share gitignored files with the main checkout. `.env.local` (holding `DATABASE_URL` etc.) exists in the main repo checkout but not in `.claude/worktrees/agent-*/`, so `pnpm run build` in a worktree fails at "Collecting page data" with `DATABASE_URL is not set` for whichever API route happens to get collected first (varies by route order — seen `/api/equipment/[id]`, `/api/events/[id]`, `/api/auth/recover` across different runs, not a fixed route). The repo's pre-push hook runs the full local CI (typecheck/lint/test/build), so this silently blocks `git push` from any worktree with no diagnostic pointing at the real cause.

**Why:** confirmed via a throwaway `git worktree add` of `origin/develop` itself (removed after) that the identical failure reproduces on the unmodified base branch when `.env.local` is absent — this proves it's an environment gap, not a regression in the branch being validated. Don't waste time bisecting the diff for a build "regression" that's actually just a missing local file.

**How to apply:** before running `pnpm run build` (or trusting `git push`'s pre-push hook) in a worktree, check whether `.env.local` exists there. If missing, copy it from the main checkout's absolute path (`/Users/samuelromeroarbelo/Projects/Alea/alea-webapp/.env.local`) into the worktree root — it's gitignored so this never gets committed or pushed, it's purely a local file needed to make the build step of validation/pre-push pass. This is not a "config file" edit in the sense the file-writing-scope restriction means (tracked repo config) — it's an untracked local dev-environment file, same as what already sits in the main checkout for the same purpose.
