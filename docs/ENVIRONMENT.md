# Environment Variables

Every environment variable read anywhere in this repo, where it's read, and
where its value comes from. Variable **names** and setting names only — no
actual values appear in this document.

See `.env.example` for the local-dev template (app runtime + scripts).
`qa/e2e/README.md` covers the E2E runner variables in more detail.

---

## Variable reference

Scope:
- **server** — read only in server-side code (Route Handlers, Server Components, `lib/server/`)
- **browser** — `NEXT_PUBLIC_*`, inlined into the client bundle at build time
- **script** — read only by a one-off script under `scripts/`
- **e2e** — read only by the standalone runners under `qa/e2e/*.mjs`, from a dedicated `.env.e2e.local`
- **test** — read/stubbed only inside `__tests__/` or `vitest.setup.ts`

| Variable | Scope | Required? | Purpose | Obtain from |
|---|---|---|---|---|
| `DATABASE_URL` | server | Required | Neon pooled connection string; every query in `lib/db/client.ts` | Neon console → project → Connection Details |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | browser | Required | Clerk publishable key. Read implicitly by `@clerk/nextjs` — no explicit `process.env` reference in this repo | Clerk dashboard → application → API Keys |
| `CLERK_SECRET_KEY` | server | Required | Clerk secret key. Read implicitly by `@clerk/nextjs` (`middleware.ts`, `clerkClient` in `lib/server/auth-service.ts`) and explicitly by `scripts/seed-dev.mjs` | Clerk dashboard → application → API Keys |
| `NEXT_PUBLIC_CLERK_SIGN_IN_URL` | browser | Optional, unset by default | Overrides Clerk's default sign-in route. Read implicitly by `@clerk/nextjs`; unset because sign-in is a locale-prefixed page resolved at request time | Not applicable — set manually if a fixed path is ever needed |
| `NEXT_PUBLIC_CLERK_SIGN_UP_URL` | browser | Optional, unset by default | Same, for sign-up | Same |
| `BLOB_READ_WRITE_TOKEN` | server | Required | Vercel Blob store token. Read implicitly by the `@vercel/blob` SDK's `put()` in `lib/server/uploads-service.ts` (admin image uploads) and `lib/server/tables-service.ts` (table QR codes) | Vercel dashboard → project → Storage → Blob store → `.env.local` tab |
| `NEXT_PUBLIC_APP_URL` | server (see note) | Required for table QR generation | Base URL used to build the QR-code check-in link (`lib/server/tables-service.ts`, `lib/server/rooms-service.ts`). Despite the `NEXT_PUBLIC_` prefix it is only read server-side in this repo — it does **not** drive auth callbacks or cookie flags | Set to the deployment's public URL |
| `COOKIE_SECURE` | server | Optional | Forces the `Secure` flag on auth/CSRF cookies (`lib/server/security-edge.ts`). Evaluated at runtime, not build time. Default: `true` when `NODE_ENV=production`, else `false` | Set explicitly only for local HTTP dev (`false`) |
| `TRUST_PROXY_HEADERS` | server | Optional | Whether to trust `x-forwarded-for`/`x-real-ip` from a reverse proxy for rate limiting (`lib/server/security.ts`). Default: `false` | Set `true` only when the ingress strips and rewrites those headers |
| `TRUSTED_PROXY_CIDRS` | server | Optional | CIDR allowlist for proxies permitted to supply `x-forwarded-for`, used only when `TRUST_PROXY_HEADERS=true` | Set to the ingress's source IP ranges |
| `NEXT_PUBLIC_API_URL` | browser | Optional | API base URL override for the frontend (`lib/api/client.ts`). Default: `/api` | Set only when the browser must call a different API base URL |
| `NEXT_PUBLIC_ASSOCIATION_URL` | browser | Optional | External association link shown in the footer (`components/layout/footer.tsx`). Default: hidden if unset | The club's association URL |
| `CLUB_TIMEZONE` | server | Optional | IANA timezone override (`lib/club-time.ts`). Default: `'Atlantic/Canary'` — a hardcoded fallback, not the server's system timezone | Set to the club's IANA timezone name |
| `NEXT_PUBLIC_CLUB_TIMEZONE` | browser + server | Optional | Same override, exposed to the browser — `lib/club-time.ts` is imported by client components (e.g. `components/rooms/rooms-view.tsx`), so a server-only `CLUB_TIMEZONE` is invisible to them. Takes precedence over `CLUB_TIMEZONE` when both are set | Same |
| `UPSTASH_REDIS_REST_URL` | server | Optional | Rate limiter backing store (`lib/server/security.ts`). When set together with the token below, rate limiting is shared across serverless instances via Upstash Redis; otherwise it falls back to an in-memory `Map` (per-instance only, bypassable in production by rotating instances) | Upstash console → Redis database → REST API |
| `UPSTASH_REDIS_REST_TOKEN` | server | Optional | Paired with `UPSTASH_REDIS_REST_URL` | Same |
| `CRON_SECRET` | server | Present but unused | `POST /api/cron/cancel-pending` unconditionally returns `410` and never reads this. Kept defined pending a decision on whether the route is revived or removed — see `docs/SECRET-ROTATION-CHECKLIST.md` | Not applicable while unused |
| `ALLOW_NON_EMPTY_DB` | script | Optional | `scripts/apply-neon-schema.mjs`: skips the empty-database guard, applying schema files even when tables already exist. Default: guard fails closed | Set `1` only when intentionally re-applying schema to a non-empty dev database |
| `SEED_ADMIN_PASSWORD` | script | Required to run the script | `scripts/seed-dev.mjs`: initial password for the seeded admin Clerk identity | Choose a local-only password |
| `DEV_SEED_CONFIRM` | script | Required to run the script | `scripts/seed-dev.mjs`: exact confirmation string, a safety gate against running against the wrong database. Script also refuses if `DATABASE_URL` looks like it points at anything containing `"prod"` | See the exact expected value in `scripts/seed-dev.mjs` |
| `E2E_BASE_URL` | e2e | Optional | Base URL of the running app the E2E runners hit | Default: `http://localhost:3001` |
| `E2E_DATABASE_HOST` | e2e | Required | Positive hostname allowlist for `DATABASE_URL` — runners refuse to start if the hostname doesn't match exactly (`qa/e2e/db.mjs`) | Copy from the same Neon connection string used for `DATABASE_URL` |
| `E2E_ALLOW_DESTRUCTIVE` | e2e | Required | Must be exactly `1` to acknowledge the runners perform privileged fixture writes/deletes | — |
| `CHROME_PATH` | e2e | Optional | Custom Chrome/Chromium executable path (`qa/e2e/env.mjs`) | Default: Playwright's bundled Chromium |
| `PLAYWRIGHT_QA_USER` | e2e | Required (most runners) | Member number of the admin QA user | A seeded/activated Clerk identity in the dev database |
| `PLAYWRIGHT_QA_PASSWORD` | e2e | Required (most runners) | Password for the admin QA user | Same |
| `PLAYWRIGHT_QA_SECONDARY_USER` | e2e | Required (cancellation/equipment runners) | Member number of a regular, non-admin QA member | Same |
| `PLAYWRIGHT_QA_SECONDARY_PASSWORD` | e2e | Required (cancellation/equipment runners) | Password for the secondary user | Same |
| `DATABASE_URL` (e2e context) | e2e | Required | Same variable as above — the E2E runners connect directly for fixture setup/teardown | Same as the app's `DATABASE_URL` |
| `NODE_ENV` | server, framework-managed | N/A | Standard Next.js/Node variable. Gates `scripts/seed-dev.mjs` (refuses in production) and the `COOKIE_SECURE` default | Set by the runtime, not by a developer |

### Not environment variables (found during this audit, excluded)

The issue's starting grep included a few names that turned out to be
hardcoded constants, not `process.env` reads — listed here so they aren't
re-added by mistake:

- `CLERK_USERNAME_PREFIX` — `const CLERK_USERNAME_PREFIX = 'alea-'` in `components/auth/login-form.tsx`, `lib/server/users-service.ts`, `lib/server/auth-service.ts`, `scripts/seed-dev.mjs`.
- `CLERK_API_BASE` — `const CLERK_API_BASE = 'https://api.clerk.com/v1'` in `scripts/seed-dev.mjs`.
- `SEED_EMAIL_DOMAIN` — `const SEED_EMAIL_DOMAIN = 'devseed.internal'` in `scripts/seed-dev.mjs`.
- `BLOB_BASE_URL` — a test-fixture constant in `__tests__/server/tables-service.test.ts`, not read from the environment.
- `VERCEL_TOKEN` — not read anywhere in this repo; it authenticates the Vercel CLI itself and is supplied by the `vercel` connector in this studio's tooling, not declared by the app.

### Removed: the old Supabase project-URL variable and `SUPABASE_SECRET_DEFAULT_KEY`

Neither is read anywhere in the current codebase — Supabase was fully
removed (#311/#366), and the E2E runners were swapped from Supabase to
Clerk in #312 (merged, PR #367). The only remaining mentions were two
stale references in `docs/SECRET-ROTATION-CHECKLIST.md` describing this as
an open gap; that doc has been updated to reflect the fix. Both variables
are still set on Vercel (see the gap list below) — that's leftover
configuration, not a code dependency.

---

## Vercel environments

Checked via `vercel env ls` (names and environment columns only — no
values) against a project this repo is linked to. Deployment env config is
authoritative on Vercel's side; the code-side "what does the app actually
read" comes from the table above.

### What must differ between Preview and Production

- `DATABASE_URL` (and any Neon-injected siblings actually in use — see the
  stale-injected-vars note below) — each points at a different Neon branch.
- `CLERK_SECRET_KEY` / `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` — Preview should
  use a Clerk **test** instance's keys, Production a separate **live**
  Clerk instance's keys. See "Clerk instance configuration" below for why
  these must be two separate instances, not one instance's two key pairs.
- `NEXT_PUBLIC_APP_URL` — each environment's own public URL.
- `BLOB_READ_WRITE_TOKEN` — each environment's own Blob store token, if
  Preview and Production use separate stores.

### What can be shared

- `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_ASSOCIATION_URL`, `CLUB_TIMEZONE` /
  `NEXT_PUBLIC_CLUB_TIMEZONE`, `TRUST_PROXY_HEADERS`, `TRUSTED_PROXY_CIDRS`,
  `COOKIE_SECURE` — these describe the club/deployment posture, not a
  per-environment secret, and can hold the same value in both unless the
  club timezone or ingress setup genuinely differs.
- `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` — can point at one
  shared Redis database, or be split per environment; either is fine
  since rate-limit state doesn't need to be shared across environments.

### What Vercel injects itself

`VERCEL`, `VERCEL_ENV`, `VERCEL_URL`, `VERCEL_REGION`, and similar
`VERCEL_*` variables are set automatically by the platform at build/runtime
and are not declared anywhere in this repo.

### Gap: read by code, not set on Vercel

- **`BLOB_READ_WRITE_TOKEN`** — not present in `vercel env ls` output for
  Preview or Production. Both `lib/server/uploads-service.ts` (admin image
  uploads) and `lib/server/tables-service.ts` (table QR codes) need it;
  without it those code paths fail. This looks like a real gap, not an
  intentional omission — flagging for the user to confirm and set.
- `NEXT_PUBLIC_CLERK_SIGN_IN_URL` / `NEXT_PUBLIC_CLERK_SIGN_UP_URL`,
  `COOKIE_SECURE`, `NEXT_PUBLIC_CLERK_SIGN_UP_URL` — not set on Vercel
  either, but these are genuinely optional with working defaults, so this
  is expected, not a gap.

### Gap: set on Vercel, nothing reads it

- The old Supabase project-URL variable, its browser publishable-key
  sibling, and `SUPABASE_SECRET_DEFAULT_KEY` — dead, Supabase fully removed
  (see above).
- `AUTH_SESSION_SECRET`, `AUTH_SECRET` — dead, pre-Clerk session
  implementation; `docs/SECRET-ROTATION-CHECKLIST.md` already documents
  `AUTH_SESSION_SECRET` as unreferenced by any code.
- `DATABASE_URL_UNPOOLED`, `PGHOST`, `PGHOST_UNPOOLED`, `PGUSER`,
  `PGDATABASE`, `PGPASSWORD`, `POSTGRES_URL`, `POSTGRES_URL_NON_POOLING`,
  `POSTGRES_USER`, `POSTGRES_HOST`, `POSTGRES_PASSWORD`,
  `POSTGRES_DATABASE`, `POSTGRES_URL_NO_SSL`, `POSTGRES_PRISMA_URL` —
  auto-injected by a Vercel Postgres/Neon integration. Only `DATABASE_URL`
  is read by `lib/db/client.ts`; the rest are unused siblings.
- `PLAYWRIGHT_QA_USER`, `PLAYWRIGHT_QA_PASSWORD`,
  `PLAYWRIGHT_QA_SECONDARY_USER`, `PLAYWRIGHT_QA_SECONDARY_PASSWORD` — only
  read by the standalone `qa/e2e/*.mjs` runners, which load them from a
  dedicated `.env.e2e.local` and are normally run locally against a dev
  server, not as part of a Vercel deployment. Set on Preview/Production
  regardless — worth confirming with the user whether some CI job runs
  these against a Preview deployment, or whether this is leftover.
- `CRON_SECRET` — set, but unused by any route (see the variable table
  above and `docs/SECRET-ROTATION-CHECKLIST.md` section 2).

None of the above were changed, promoted, or deleted — reporting only, per
this repo's DDL/secrets rules (user-only execution).

---

## Clerk instance configuration

### Development instance — verified live, 2026-09-04

Queried directly against the Clerk Frontend API (`GET
https://<frontend-api-host>/v1/environment`, host decoded from the
publishable key in the worktree's `.env.local`) rather than trusted from
the issue text.

| Setting | Live value | Issue #335's claim | Match? |
|---|---|---|---|
| `sign_up.mode` | `restricted` | `restricted` | Yes |
| `attributes.username.enabled` | `false` | "username enabled" | **No** — live instance has username *disabled* as a sign-up attribute (though `used_for_first_factor: true` is still set, and app accounts are provisioned via the Backend API rather than public sign-up, so this may not currently block anything — flagging the mismatch rather than interpreting it) |
| `attributes.email_address.enabled` | `false` | "email_address disabled" | Yes |
| `attributes.password.enabled` | `true` | "password enabled" | Yes |
| `social.oauth_google.enabled` | `true` | Not mentioned in the issue | **New finding** — Google OAuth sign-in is enabled on the dev instance. Not mentioned by #335 and not consistent with the club's no-public-signup identity model (see below) |

Other observed settings, for completeness: `captcha_enabled: true`,
`sign_up.progressive: true`, `sign_up.legal_consent_enabled: false`,
`restrictions.allowlist/blocklist: disabled`,
`username_settings.min_length: 4`, `actions.create_organization: true`.
None of these were claimed by the issue either way.

**Not independently verified:** allowed origins / redirect URLs, MFA
policy beyond the `required: false` flag above, and anything requiring the
Backend API (`api.clerk.com`) rather than the public Frontend API — the
Frontend API's `/v1/environment` endpoint was sufficient for everything in
the table above and needed no secret key.

### Target production instance configuration

Basis: members have no email addresses. Identity is the member number;
admins issue activation links and hand them over through their own
channel. Zero outgoing email (identity model from #299).

| Setting | Target | Rationale |
|---|---|---|
| `sign_up.mode` | `restricted` (no public self-signup) | Members are provisioned by an admin via the activation-link flow, never by visiting a public sign-up page |
| `attributes.username.enabled` | `true`, required | The member number is the sign-in identifier (`alea-<memberNumber>`, see `CLERK_USERNAME_PREFIX` in `lib/server/auth-service.ts`) |
| `attributes.email_address.enabled` | `false` | Members have no email addresses in this system |
| `attributes.password.enabled` | `true` | Password is the only credential members authenticate with |
| Email/SMS verification flows | Disabled | There is no outgoing email or SMS channel to verify through |
| `social.*` (OAuth providers) | All disabled | No provider is part of the identity model; the live dev instance's `oauth_google: true` should not carry into production |

### Development vs. production instance, generally

- Each Clerk instance (dev/prod) has its own key pair with a distinct
  prefix (`pk_test_...`/`sk_test_...` for a test/dev instance vs.
  `pk_live_...`/`sk_live_...` for production) — `scripts/seed-dev.mjs`
  already enforces this by refusing to run against a key matching
  `/^sk_live_/i`.
- Production needs its **own** Clerk instance, not just a second key pair
  on the dev instance — allowed origins, redirect URLs, and the settings
  above (`sign_up.mode`, attribute toggles, social providers) are
  configured per-instance, and a shared instance would apply dev-only
  settings (e.g. the currently-enabled Google OAuth) to production traffic.
- Allowed origins / redirect URLs must be set per-instance to match that
  environment's actual deployment URL(s); not verified live in this pass
  (see "Not independently verified" above).
