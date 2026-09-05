# Secret Rotation Checklist (Pre-Migration, P0)

This is an investigation + checklist artifact only. **No agent may rotate any secret.**
Rotation is a manual, user-executed action in the Vercel and Clerk dashboards (and the Neon
console, for `DATABASE_URL`).
Variable **names** only are referenced below — no actual secret values appear in this
document or were printed/logged while producing it.

Related issue spec: `docs/issues/migration-pre-04-rotate-p0-secrets.md`

---

## 1. `AUTH_SESSION_SECRET` — dead / legacy config

- **Where it is set:** Not present in `.env.example`. Historically would have been set in
  `.env.local` for local dev / Vercel project env for deploy, under a pre-M3 (pre-Clerk,
  pre-Supabase) session implementation.
- **Code consumers:** **None.** A repo-wide grep for the literal string `AUTH_SESSION_SECRET`
  across all file types (excluding `node_modules` and `.git`) found no
  `.ts`/`.tsx`/`.js`/`.mjs`/`.cjs` file that reads or references
  `process.env.AUTH_SESSION_SECRET` or the string `AUTH_SESSION_SECRET` in any form — the
  remaining matches are documentation only: `docs/ROLLBACK.md` (lines 121, 132, 146, 148, 156),
  `docs/MIGRATION-supabase-to-neon.md:52,93`, and
  `docs/issues/migration-pre-04-rotate-p0-secrets.md:1,3,4,5`.
- **`.env.example` status:** Confirmed **not present** — there is nothing to remove there.
- **What breaks if rotated without updating dependents:** Nothing in the current Clerk-based
  runtime. `docs/ROLLBACK.md:148` explicitly notes: "For the current Clerk-based runtime,
  `AUTH_SESSION_SECRET` is not referenced and changing it will not affect active sessions."
- **Recommendation:** Keep the `docs/ROLLBACK.md` reference as historical rollback
  documentation (it only matters if the team ever rolls back to a pre-M3, pre-Clerk session
  implementation). Flag for the user to decide whether to drop the `ROLLBACK.md` reference
  entirely, since there is no live config or code path tied to it today. No action needed for
  `.env.local`, `.env.example`, or any schema file — there is nothing to rotate.

---

## 2. `CRON_SECRET` — currently unused by app runtime code (gap, not fixed here)

- **Where it is set:** Present in `.env.example` (`.env.example:132`, comment context at
  `.env.example:129-131`). Set in `.env.local` for local dev, and in the Vercel project env
  (and whatever external cron scheduler calls the endpoint, e.g. cron-job.org) for deploy.
- **Code consumers — this section changed since the original P0 audit:** the route this
  section originally described, `app/api/cron/mark-no-show/route.ts`, **no longer exists**
  (confirmed via `find` — not present anywhere in the repo, including `__tests__/`). The only
  cron route now is `app/api/cron/cancel-pending/route.ts`, and its full body is:

  ```ts
  export async function POST() {
    return NextResponse.json(
      { error: 'Endpoint deprecated', message: 'Cron-based auto-cancellation replaced with lazy evaluation at query time (KIM-366)' },
      { status: 410 },
    )
  }
  ```

  It always returns `410 Gone` and never reads `process.env.CRON_SECRET` or checks an
  `Authorization` header at all. `.env.example:129-131`'s comment is accurate as of this
  writing — it already states the route "never reads this header." A repo-wide grep for
  `CRON_SECRET` (`git grep -n CRON_SECRET -- ':!node_modules'`, re-run against the final
  tree of this branch) turns up **no remaining app-runtime (`app/`, `lib/`) consumer**.
  The rest of the hits split into two groups:
  - **Accurate, not stale:** `.env.example:129-132` (this section's own template entry
    and comment), `docs/ENVIRONMENT.md:45,206`, `docs/ROLLBACK.md:130` (all three added
    or verified in the same pass as this checklist update, and correctly describe the
    variable as present-but-unused), and this document's own section 2.
  - **Stale** (predate the discovery that the route is dead, and read as if the variable
    were still live): `docs/MIGRATION-supabase-to-neon.md:52` (lists it among secrets to
    rotate before cutover, with no note that it's currently unused),
    `docs/issues/migration-pre-03-register-cron-vercel-json.md:4` (describes reviving the
    now-deleted `mark-no-show` route and verifying its `CRON_SECRET` check), and
    `docs/issues/migration-pre-04-rotate-p0-secrets.md:3` (same "needs rotation" framing,
    no unused-variable note). All three are historical migration-issue specs, not live
    documentation — left as-is; not rewritten in this docs-only pass.
  - `qa/e2e/qa-no-show-expiry.mjs:4` is neither: a code comment, not documentation,
    correctly noting the deleted `CRON_SECRET`-gated `POST /api/cron/mark-no-show` route
    as the reason this runner now exercises the lazy no-show expiry path instead.
- **What breaks if rotated without updating dependents:** **Nothing in app runtime code
  today** — there is no live route checking this value. Rotating it changes nothing except
  matching (or no longer matching) whatever an external cron scheduler still sends, which
  currently hits an endpoint that unconditionally returns 410 regardless of the header.
- **Recommendation (not applied — out of scope for this doc pass):** this is a real drift
  between `.env.example`/`README.md`/`qa/e2e/*` and the actual route code, independent of the
  Supabase→Neon/Clerk migration this checklist was written for. It needs its own decision:
  either restore a CRON_SECRET-checked route if scheduled no-show/cancellation handling is
  still wanted, or remove `CRON_SECRET` and the stale QA e2e script together. Flagging here
  rather than silently rewriting the QA tooling or `.env.example`, both of which are outside
  this document's scope.

---

## 3. `CLERK_SECRET_KEY`

`lib/supabase/server.ts` and `lib/supabase/config.ts` — the files this section originally
cited — are **deleted** on this branch (`git log --oneline -- lib/supabase/server.ts` shows
its removal in the Supabase-cleanup commit; `ls lib/supabase/` now contains only
`types.ts`). Auth is fully on Clerk (`@clerk/nextjs`); the closest equivalent secret is
`CLERK_SECRET_KEY`.

- **Where it is set:** Present in `.env.example` (`.env.example:32`, comment context at
  `.env.example:24-31` — sourced from Clerk Dashboard → Configure → API Keys → Secret keys).
  Set in `.env.local` for local dev, Vercel project env for deploy.
- **Code consumers:** unlike the old Supabase secret key, this repo has **no explicit
  `process.env.CLERK_SECRET_KEY` read** — `@clerk/nextjs` reads it directly from the
  environment inside its own SDK code. The app-code call sites that depend on it being
  correctly set are:
  - `middleware.ts:38` — `clerkMiddleware()` wraps every matched request (see
    `config.matcher`, `middleware.ts:48-50`), populating `auth()`/`currentUser()` for the
    rest of the app.
  - `lib/server/auth-service.ts:6` imports `clerkClient` from `@clerk/nextjs/server`; it is
    called at `lib/server/auth-service.ts:395` (account activation — `client.users.createUser()`),
    `:432` (rollback cleanup — `client.users.deleteUser()`), `:518` and `:530` (recovery —
    `client.users.getUserList()` and `client.users.updateUser()` respectively), and `:666-680`
    (`logout()`, with `client.sessions.revokeSession()` at `:674`).
  - `lib/server/users-service.ts:408,457,492,589` also calls `clerkClient()` — the same
    Backend API dependency, separate call sites from `auth-service.ts`.
  - `scripts/seed-dev.mjs:214,294` reads `process.env.CLERK_SECRET_KEY` directly (not via the
    SDK) to create the seeded admin Clerk identity, and refuses to run if the key looks like a
    live/production key (`scripts/seed-dev.mjs:133` — the `/^sk_live_/i` check; the error
    message itself is at `:135-139`) — dev-only tooling, not a runtime code path.
  - Also referenced in tests: `__tests__/scripts/seed-dev.test.ts:22,28` (stubbed test value).
- **What breaks if rotated without updating dependents:** every Clerk Backend API call the
  app makes server-side — `clerkMiddleware()`'s session resolution, and every
  `clerkClient()` call in `lib/server/auth-service.ts` listed above (activation, recovery,
  logout/session-revocation). If the key is rotated in the Clerk Dashboard without updating
  the deployment environment (Vercel project env) and any local `.env.local`, those calls
  will fail to authenticate against Clerk's Backend API and auth/activation/recovery/logout
  will start erroring.
- **Resolved (was a known stale reference, tracked by #312):** `qa/e2e/qa-reservation-cancellation.mjs`,
  `qa/e2e/qa-reservation-lifecycle.mjs`, `qa/e2e/qa-no-show-expiry.mjs`,
  `qa/e2e/qa-reservation-equipment.mjs`, and `qa/e2e/env.mjs` used to reference
  `SUPABASE_SECRET_DEFAULT_KEY` and the old Supabase project-URL variable for privileged fixture writes. Issue
  **#312 "[N4] Swap test/E2E auth from Supabase to Clerk"** (PR #367) has since merged — the
  runners now authenticate as Clerk identities via `PLAYWRIGHT_QA_USER`/`PLAYWRIGHT_QA_PASSWORD`
  (see `docs/ENVIRONMENT.md`), and neither Supabase variable is read anywhere in the repo
  anymore. (The `CRON_SECRET` gap above has no matching open issue and is still open.)

---

## 4. QA credentials

`.env.example` carries only a one-line pointer naming these prefixes (`E2E_*`,
`PLAYWRIGHT_QA_*`) — it does not declare or default any of them. They are documented in full
in `qa/e2e/README.md` (lines 27-36) as belonging to a dedicated `.env.e2e.local` file at the
repo root — the E2E runners intentionally do not load the app's `.env.local` because they
perform privileged fixture writes/deletes.

- **Variables (names only):**
  - `PLAYWRIGHT_QA_USER` — member number of the admin QA user.
  - `PLAYWRIGHT_QA_PASSWORD` — password for the admin QA user.
  - `PLAYWRIGHT_QA_SECONDARY_USER` — member number of a regular (non-admin) QA member.
  - `PLAYWRIGHT_QA_SECONDARY_PASSWORD` — password for the secondary QA user.
  - `E2E_ALLOW_DESTRUCTIVE` — not a credential, but a required env var (must be `1`) to
    acknowledge privileged fixture writes/deletes performed by the E2E runners.
- **Where set:** `.env.e2e.local` at the repo root (local dev / CI runner only — not part of
  the deployed app's runtime env).
- **Code consumers:** the standalone Playwright/Node E2E runners under `qa/e2e/*.mjs`
  (`qa/e2e/qa-reservation-lifecycle.mjs:14,58-59,107`,
  `qa/e2e/qa-reservation-equipment.mjs:15-16,91-92,154-155`,
  `qa/e2e/qa-no-show-expiry.mjs:19,88-89,97`,
  `qa/e2e/qa-reservation-cancellation.mjs:14-15,49-50,106`). Not consumed by any app runtime
  code (`app/`, `lib/`) or by the Vitest unit tests under `__tests__/`.
- **What breaks if rotated without updating dependents:** the corresponding QA/member account
  credentials (Clerk identities + Neon `profiles` rows) must be updated to match, and
  `.env.e2e.local` on every machine/CI runner that executes the `qa/e2e/*.mjs` scripts must be
  updated, or those E2E runs will fail to log in / authenticate. The Supabase-based fixture
  writes noted in an earlier version of this section were resolved by #312 (see section 3
  above) — the runners no longer touch Supabase at all.

---

## Rotation procedure (user-executed)

Rotation is a **manual, user-only** action. No agent performs any of the following steps:

1. In the Clerk dashboard (Configure → API Keys), regenerate the secret key backing
   `CLERK_SECRET_KEY`.
2. In the Vercel project settings, update `CLERK_SECRET_KEY` for every environment
   (Production, Preview, Development) that needs it. `CRON_SECRET` is currently not checked
   by any live route (see section 2 above) — rotate it only if/when that gap is separately
   resolved.
3. Update local `.env.local` to match.
4. Decide whether to drop the now-dead `AUTH_SESSION_SECRET` reference from
   `docs/ROLLBACK.md` (optional — no code or config action required either way), and whether
   to address the `CRON_SECRET` gap noted above (separate from this rotation).
5. Verify in the Clerk dashboard and via a smoke test (e.g. login, account activation, or
   logout) that the app authenticates correctly after rotation.

This document intentionally does not, and must never, contain any actual secret value.
