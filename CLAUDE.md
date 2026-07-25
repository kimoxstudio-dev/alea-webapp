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

## Key conventions

- Admin write operations use `createSupabaseServerAdminClient()` (bypasses RLS)
- Regular reads use `createSupabaseServerClient()` (user-scoped, respects RLS)
- All privilege checks (ownership + role) must live in the **service layer**, never in route handlers
- i18n keys must maintain full parity between `en.json` and `es.json`
- Test files must be excluded from `tsconfig.app.json`
- **Test files are owned exclusively by `qa-engineer` — `software-engineer` must NEVER create, edit, or delete test files, under any framing (e.g. "fixing" a failure). Doing so and reporting completion anyway is a false completion.**
- Every read of `reservations` / `saved_games` for a `member` session MUST filter `WHERE user_id = session.id`; member-scoped reads must also pass through `assertMemberRowsScoped()` (from `lib/server/data-scoping.ts`) as defense-in-depth after the DB fetch and before mapping rows to the public shape (admins exempt).

---

## Parallel worktree file split (for this project)

When running parallel implementation agents on this repo, use this domain split to avoid conflicts:

| Agent | File ownership |
|-------|----------------|
| A (frontend) | `app/`, `components/`, `messages/`, `lib/hooks/` |
| B (backend)  | `lib/server/`, `lib/supabase/`, `supabase/`, `tests/` |

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

Only one product-manager may run per session — never spawn a second one to "help" or parallelize; the existing one already owns Linear/branch/task coordination for the whole session.

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

---

## Agent Working Agreements

### Reporting Standards

- A failing test may be called "pre-existing" only after being run on `develop` and confirmed failing there; otherwise report it as "failing on this branch, cause not established."
- Never report validation (typecheck/lint/build/tests) as passing without actually running it — no "assumed to pass," no fabricated timestamps, no silently-skipped steps presented as done.
- Reports state the command run and its literal output, not a conclusion — e.g. "`Tests 1166 passed (1166)`," not "suite green."
- "Done" is a number matched against a defined bar, not an adjective — "infrastructure ready," "pattern established," "84% passing," "non-blocking edge cases" are not completion.

### Test Integrity

- Test count per file must never decrease vs `develop` — compare with `grep -cE "^\s*(it|test)\("` against develop and report both numbers; any drop requires each removed test justified by name. Exception: removing a tautological test (e.g. `expect(true).toBe(true)`) removes zero coverage by definition — still name it and say why.
- Tests never make real database calls — no live connection, no test DB, no containerized/embedded Postgres. Mocks only; improve the mock rather than making the dependency real.

### Shared Working Directory

- The shared checkout is read-only to every agent, with exactly one exception: appending to `.claude/agent-progress.md` via `>>` or equivalent that cannot replace the file — never read-modify-write it. To run code from another branch, create a throwaway worktree and install dependencies there, never in the shared checkout.

### Stopping and Escalating

- Reporting a blocker costs nothing; a false completion costs hours. A correctly-reported blocker must not be disbelieved or punished because a different agent fabricated something similar earlier.
- Not acceptable as "completion": silently handing remaining work to another agent, describing a stopping point as a result (e.g. "reverted to baseline"), self-approving with a red suite under any framing, or citing a repo rule that doesn't exist to justify stopping.

### Tooling

- When an agent regresses repeatedly on a large file, the tool it needs likely doesn't exist yet — build that tool as its own bounded task, separately from applying it.
- One shared helper/mock, extended when it falls short — never re-derived per file (copying a pattern from the most broken file inherits its defect).
