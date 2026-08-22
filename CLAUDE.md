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

## Mandatory exhaustive /code-review before opening any PR

Before `security-reviewer` opens a PR, it must run `/code-review` (high or higher effort — exhaustive, not a quick pass) against the branch's own diff and apply/route any real findings first. This runs **in addition to**, not instead of, the manual security review the agent already does.

**Why:** PR #337 (#332, 2026-08-17) opened after `security-reviewer` approved, and a manual `/code-review` run by the user immediately after found 5 real defects the reviewer missed, then Codex's independent review on the open PR found 3 more (1 overlapping) — 7 unique post-open findings total. All were genuine (verified against production SQL, not false positives) and all were fixable before merge if caught pre-open. Catching them after the PR is open means a second round of push/re-review/inline-reply-to-external-bot churn that an exhaustive review before opening would have avoided.

**Recurrence (PR #338, 2026-08-22):** same failure mode happened again despite this rule already being in place. `security-reviewer`'s mandated `/code-review` pass found real findings, fixed them, and opened the PR — but never re-ran `/code-review` against the fix itself. A user-run manual `/code-review` afterward found 4 more real bugs, one of them (`assertExpectedTablesArePresent` gating) *inside the code the mandated pass had just added*. The rule as written ("only after that review comes back clean") was read as "found issues → fixed them → close enough," not as "run again until a pass finds nothing." That ambiguity is now fixed at the source in `~/.claude/agents/security-reviewer.md` Step 4 (explicit re-run-until-clean loop) — this file's wording below is updated to match so the two don't drift back out of sync.

**How to apply:**
- `security-reviewer`'s prompt must include: run `/code-review` at high/max effort on the diff before opening the PR, not after.
- Any findings from that pass are fixed (per [[fix-findings-dont-file-issues]] — fix immediately, never file a tracking issue), then `/code-review` **runs again** against the updated diff — a fix is new code and hasn't been reviewed yet. Repeat until one full pass returns zero real findings.
- Only after that clean pass does the PR open. Do not treat "issues found and fixed" as equivalent to "clean" — that gap is exactly what let PR #338's fix-of-a-fix bug through.
- This does not replace [[shift-left-review-criteria]] — the implementer's checklist still front-loads conventions/i18n/flow so a late finding is already the exception, not the rule. `/code-review` here is the automated exhaustive net that catches what the checklist and manual read miss, particularly in test-infrastructure logic (mock handler correctness) that isn't covered by the conventions checklist at all.

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

**issueTracker:** `github`

Issues live in GitHub Issues, tracked on Project **#1** of `kimoxstudio-dev` (not the org's Project #5, which is stale and has a duplicate name — see project memory if disambiguation is needed).

The product-manager agent uses this to:
- Fetch issues from GitHub Issues
- Move issues to "In Progress" on the GitHub Project board when work starts
- Update issues with PR links when complete
- Query the backlog for prioritization

Note: PRs targeting `develop` do not auto-close issues via `Closes #N` (GitHub only honors that against the default branch) — close the issue manually and move the board card after each merge.

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

### Narrow exception — development database

Agents MAY, against the **development database only**:
- Run read-only `SELECT` inspection (table listings, row counts, contents).
- Insert, update, and delete **synthetic** test data — a seeded admin profile and fictional member profiles.

Agents MAY also execute **DDL against the development database only** — but ONLY when the user grants permission for that specific migration, in the current turn. See "DDL on the development database" below for the exact conditions.

Still forbidden, without exception:
- Any database that is not the development one — this is a blanket prohibition, not narrowed by statement type. DDL against staging or production is not a special case of it; it's the same rule. Staging and production migrations remain user-only, always, with no equivalent exception.
- `TRUNCATE`, anywhere, including the development database.
- Loading real member data. The club's actual membership file never enters a development database, an agent worktree, or a log. All test data used by agents is invented/synthetic.

**Required before the first write, every time:** a read-only inspection of the target database (list tables, row counts), reported. If it contains anything resembling real membership data, STOP and report instead of seeding on top. The local connection string carries no environment marker in its name, so nothing in the environment proves which database it is — the inspection is what proves it.

Why this exception exists: without a seeded admin account to issue activation links and a pre-registered member profile to redeem them, the [N1] auth migration work (issue #299) cannot be verified end to end, and shipping unverifiable auth changes is exactly what this exception exists to prevent.

### DDL on the development database — permission-gated

Agents MAY write **and execute** schema migrations (`CREATE`, `ALTER`, `DROP`) against the **development** database, but every execution requires the user's explicit permission for that specific migration, given in the current turn.

**Conditions — all of them, every time:**
1. **The user grants permission in the current turn, for that migration.** Not inferred from a previous approval, not from general enthusiasm ("dale", "adelante"), not from the fact that a similar migration was approved earlier. A permission granted for one migration does not carry to the next one — ask again, every time. This mirrors the develop/main merge exceptions in `~/.claude/CLAUDE.md`, deliberately.
2. **The SQL is written and committed to the branch first, and shown to the user**, so they are approving a specific statement rather than an intention.
3. **Development database only.** Confirm the target before executing. Staging and production have no equivalent exception and never will.
4. **Never `TRUNCATE`.** Still forbidden everywhere, no exception.
5. **Destructive DDL is reported before and after** — what it drops, what it changes, and the verified state afterwards.
6. If the migration fails partway, **stop and report**. Do not improvise a repair or a rollback against the live database.

**Why this exists:** added 2026-08-16 during #299. The live development database had drifted from schema-as-code — `profiles.id` still carried a `FOREIGN KEY (id) REFERENCES auth.users(id)` from the Supabase baseline that `003_profiles.sql` claimed was dropped, because `apply-neon-schema.mjs` uses `CREATE TABLE IF NOT EXISTS` and no-ops on an existing table. That single stale constraint made **every** insert into `profiles` fail, blocking both the seed and the real CSV member-import path, and therefore blocking any end-to-end verification of the auth migration. Fixing drift like this is routine migration work on a throwaway dev database, and routing every instance through the user was slowing the migration down for no safety gain.

**Why it is still permission-gated rather than blanket:** the user's standing principle is that exceptions must be written down rather than granted verbally in the moment (established 2026-07-14). The value of the DDL prohibition is that schema changes stay deliberate. Requiring per-migration permission keeps that deliberateness while removing the flat "agents never run DDL" blocker that no longer matched the work. The user asked for exactly this shape: "escríbelo, pero pon también si yo doy permiso."
