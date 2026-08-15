# Claude Code — Alea Webapp

All process rules (language, agent pipeline, worktrees, git, documentation discipline) are defined in
`~/.claude/CLAUDE.md` and apply here without modification. This file only adds project-specific context.

---

## Stack

- **Frontend:** Next.js 15 (App Router), TypeScript, Tailwind CSS, shadcn/ui
- **Backend:** Next.js Route Handlers (API routes)
- **Database:** Supabase (Postgres + RLS)
- **Auth:** Supabase Auth + custom session layer
- **i18n:** next-intl — locale files in `messages/en.json` and `messages/es.json`
- **Tests:** Vitest + Testing Library
- **Package manager:** pnpm

---

## GitHub communication language

All GitHub-facing text **must be written in English** — this includes:
- PR comment replies
- Inline review responses
- Issue comments
- Commit messages

The user may write prompts in any language; replies to the user are in their language. All GitHub artifacts are in English.

---

## PR Inline Comment Replies — Individual Thread Responses

**CRITICAL RULE:** When responding to PR inline review comments (especially from automated reviewers like Copilot), post individual threaded replies to EACH comment. Never post a single consolidated response addressing all issues.

**Why:** Individual threaded replies keep feedback organized, allow reviewers to mark specific comments as resolved, and prevent threads from becoming confusing.

**How to apply:**
- For each inline comment on a PR, post a reply directly to that comment's thread
- Use GitHub API: `POST /repos/owner/repo/pulls/{pr}/comments/{comment_id}/replies`
- Each reply addresses ONLY that specific comment — no batching
- Mark fix-related replies with ✅ when issue is fixed
- Never post a single general PR comment trying to address multiple inline comments

---

## Commit identity

This repo is owned by `KimoxStudio` and deploys to Vercel (`kimox-studio` team, Hobby plan) — the global commit-identity rule (`~/.claude/CLAUDE.md`) applies: commits authored as `kimoxstudio-dev <kimoxstudio@gmail.com>`, message ends with `(Oiranca)` instead of the default `Co-Authored-By` trailer. This isn't just a preference — Vercel Hobby rejects deploys whose commit author isn't the project owner, so a wrong-author commit blocks the build. Identity setup (`~/.gitconfig-kimoxstudio` + conditional include) is done locally by the user, not by Claude — see the global rule for the exact steps and for the fix procedure if a wrong-author commit slips through.

---

## Key conventions

- Admin write operations use `createSupabaseServerAdminClient()` (bypasses RLS)
- Regular reads use `createSupabaseServerClient()` (user-scoped, respects RLS)
- All privilege checks (ownership + role) must live in the **service layer**, never in route handlers
- i18n keys must maintain full parity between `en.json` and `es.json`
- Test files must be excluded from `tsconfig.app.json`
- Test files are owned exclusively by `qa-engineer` — `software-engineer` must never create or modify test files
- Every read of `reservations` / `saved_games` for a `member` session MUST filter `WHERE user_id = session.id`; member-scoped reads must also pass through `assertMemberRowsScoped()` (from `lib/server/data-scoping.ts`) as defense-in-depth after the DB fetch and before mapping rows to the public shape (admins exempt).

---

## Parallel worktree file split (for this project)

When running parallel implementation agents on this repo, use this domain split to avoid conflicts:

| Agent | File ownership |
|-------|----------------|
| A (frontend) | `app/`, `components/`, `messages/`, `lib/hooks/` |
| B (backend)  | `lib/server/`, `lib/supabase/`, `supabase/`, `__tests__/` |

If a task touches both domains, run agents **sequentially**.

---

## Issue Tracking Platform

**issueTracker:** `linear`

The product-manager agent uses this to:
- Fetch issues from Linear
- Move issues to "In Progress" when work starts
- Update issues with PR links when complete
- Query backlog for prioritization

If this field is missing, product-manager will ask you where issues are tracked.

---

## Agent Logging for Alea Webapp

Progress logging (per `~/.claude/CLAUDE.md` Agent Progress Logging) applies here. Agents append to `.claude/agent-progress.md`.

**Local-only, gitignored (as of #324):** `.claude/agent-progress.md` is no longer tracked in git — it is gitignored and lives only on disk in the main repo checkout. Tracking it in git caused a merge conflict on every branch and left the shared checkout permanently dirty, since every worktree agent appended to its own copy and those copies diverged. Agents must always append to the log using the **absolute path of the MAIN repo checkout**: `/Users/samuelromeroarbelo/Projects/Alea/alea-webapp/.claude/agent-progress.md` — never a worktree-relative copy (e.g. never `.claude/agent-progress.md` resolved from inside `.claude/worktrees/agent-*/`). This ensures the main session's `Monitor` on that file keeps seeing live progress from every agent, and no worktree branch ever re-commits log lines into git.

**What to log:**
- product-manager: Linear issue fetch, branch creation, team-lead spawn, completion
- team-lead: task handoffs (impl → qa → security), blocking issues
- software-engineer: file changes (count + key paths), build/typecheck results, commits pushed
- qa-engineer: test files created/modified, test run results (pass/fail counts), blocking failures
- security-reviewer: review findings, PR open + link

**Log template per agent:**

```markdown
#### [TASK_ID] {agent-name} — {task}
- [HH:MM] Started
- [HH:MM] {milestone or significant change}
- [HH:MM] ✅ Complete — {result} or ⚠️ BLOCKED — {error}
```

---

## Team Coordination for Alea Webapp

### Always Use Product Manager (Universal Entry Point)

For **every issue** — regardless of size or scope:

1. User: "start KIM-366"
2. Spawn product-manager agent
3. Product-manager:
   - Reads Linear issue
   - Moves to "In Progress"
   - Creates feature branch
   - Spawns team-lead agent
4. Team-lead orchestrates: impl → qa → security → PR opens
5. Product-manager returns: "KIM-366 done — PR #XXX"
6. User merges manually to develop

This is the standard workflow — no exceptions.

**CRITICAL RULE:** Product-manager NEVER spawns software-engineer, qa-engineer, or security-reviewer directly. Product-manager ALWAYS spawns team-lead to orchestrate the pipeline. Team-lead then manages: impl → qa → security → PR. This preserves agent isolation: product-manager = coordinator, team-lead = orchestrator, impl agents = workers.

---

## Database Migrations — User-Only Execution

**CRITICAL RULE:** Claude agents NEVER execute database migrations or modify database state.

- `supabase db push` — forbidden
- `supabase db pull` — forbidden
- Direct SQL execution — forbidden

**Correct workflow:**
1. Agent prepares migration files, commits to branch
2. User reviews locally (`supabase db reset` to test)
3. User manually executes `supabase db push`
4. User verifies in Supabase dashboard

Agent prepares + validates. User applies.
