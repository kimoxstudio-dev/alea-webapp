# Environment Variables

The environment contract owned by this repo: variables read directly by app,
script, and E2E code; variables already declared by its templates; and the
required Clerk and Blob credential paths read implicitly by installed SDKs.
Optional SDK customization variables are outside this document's contract;
use the vendors' references for those. Variable **names** and setting names
only — no credential values appear here.

See `.env.example` for the local-dev template (app runtime + scripts).
`qa/e2e/README.md` covers the E2E runner variables in more detail; they are
intentionally not part of `.env.example` (see that file's pointer comment).

---

## Variable reference

Scope:
- **server** — read only in server-side code (Route Handlers, Server Components, `lib/server/`)
- **browser** — `NEXT_PUBLIC_*`, inlined into the client bundle at build time
- **script** — read only by a one-off script under `scripts/`
- **e2e** — read only by the standalone runners under `qa/e2e/*.mjs`, from a dedicated `.env.e2e.local`
- **framework-managed** / **platform-managed** — supplied by Node/Next.js or Vercel rather than configured as an application value

| Variable | Scope | Required? | Purpose | Obtain from |
|---|---|---|---|---|
| `DATABASE_URL` | server, script | Required | Neon pooled connection string; every query in `lib/db/client.ts`. Also read directly by `scripts/seed-dev.mjs:287` and `scripts/apply-neon-schema.mjs:375`. `vitest.setup.ts:6` supplies a dummy value for the test suite when it's otherwise unset | Neon console → project → Connection Details |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | browser + server | Required | Clerk publishable key. Read implicitly by `@clerk/nextjs` — no explicit `process.env` reference in this repo. Despite the `NEXT_PUBLIC_` prefix it's also read server-side: `@clerk/nextjs`'s `server/constants.js` uses it to derive the Backend API URL for every `clerkClient()` call, and `clerkMiddleware()` (`middleware.ts:38`) throws at startup if it's missing | Clerk dashboard → application → API Keys |
| `CLERK_SECRET_KEY` | server, script | Required | Clerk secret key. Read implicitly by `@clerk/nextjs`. The hottest dependency is `lib/server/session.ts`'s `currentUser()` (Backend API `users.getUser`), called on every authenticated request via `requireAuth()`/`requireAdmin()` (`lib/server/auth.ts`, ~33 files) — not just the `clerkClient()` calls in `lib/server/auth-service.ts` and `lib/server/users-service.ts` (activation/recovery/logout). Also read explicitly by `scripts/seed-dev.mjs` | Clerk dashboard → application → API Keys |
| `NEXT_PUBLIC_CLERK_SIGN_IN_URL` | browser | Optional, unset by default | Currently inert in this repo: nothing calls `auth.protect()`, `redirectToSignIn()`, `<SignIn>`/`<SignUp>`, or passes `signInUrl`/`signUpUrl` — `app/layout.tsx` renders a bare `<ClerkProvider>`, and `components/auth/login-form.tsx` authenticates through the headless `useSignIn()` + `router.push()`, which never consults this. Setting it has no observable effect today | Not applicable |
| `NEXT_PUBLIC_CLERK_SIGN_UP_URL` | browser | Optional, unset by default | Same — also inert | Same |
| `BLOB_READ_WRITE_TOKEN` | server | Required locally; optional on Vercel with OIDC | Long-lived Vercel Blob credential. The installed `@vercel/blob` SDK's `put()` uses this when OIDC is unavailable. Local development needs this path; a Vercel deployment can instead use the short-lived OIDC path below | Vercel dashboard → project → Storage → Blob store → `.env.local` tab |
| `VERCEL_OIDC_TOKEN` | server, platform-managed | Required with `BLOB_STORE_ID` when using Blob OIDC | Short-lived Vercel-issued token. `@vercel/blob` tries this path before `BLOB_READ_WRITE_TOKEN`; Vercel injects and rotates it after the Blob store is upgraded to OIDC | Vercel runtime; do not set manually |
| `BLOB_STORE_ID` | server, platform-managed | Required with `VERCEL_OIDC_TOKEN` | Identifies the Blob store for OIDC authentication. Without it, the SDK falls back to `BLOB_READ_WRITE_TOKEN` | Vercel Blob project connection |
| `NEXT_PUBLIC_APP_URL` | server (see note) | Required for table QR generation | Base URL used to build the QR-code check-in link. Despite the `NEXT_PUBLIC_` prefix it is only read server-side in this repo, and does **not** drive auth callbacks or cookie flags. Two call sites behave differently when unset: `lib/server/rooms-service.ts` (table creation) only fires QR generation if this is set, so an unset value means the table is created successfully with no QR code and no error; `lib/server/tables-service.ts`'s `regenerateQrCodes()` (called from `POST /api/tables/[id]/qr`) throws a 500 if unset. `generateTableQrCode()` itself has no production caller — only its own test calls it | Set to the deployment's public URL |
| `COOKIE_SECURE` | server | Optional | Forces the `Secure` flag on the CSRF cookie only (`lib/server/security-edge.ts:35-40` `isSecureContext()`, its one consumer being `getCsrfCookieOptions()` at `:52-58`). The Clerk session cookie's `Secure` flag is set by Clerk itself, not by this variable. Evaluated at runtime, not build time. String comparison against the exact value `'true'` — `1`, `TRUE`, `yes`, or any other value all evaluate as `false`. Default when unset: `true` when `NODE_ENV=production`, else `false` | Set explicitly only for local HTTP dev (`false`) |
| `TRUST_PROXY_HEADERS` | server | Optional | When `false` (the default), only the `x-real-ip` header value is used as the rate-limit key — `x-forwarded-for` is never consulted. When `true`, `x-forwarded-for` is used instead, but only if `x-real-ip`'s value is itself inside `TRUSTED_PROXY_CIDRS` (`getClientAddress()`, `lib/server/security.ts:280-290`; the exact-`'true'` check is `trustProxyHeaders()` at `:271-273`). The CIDR allowlist is checked against the `x-real-ip` **header value**, not the actual socket peer — an ingress that doesn't strip and overwrite both `x-real-ip` and `x-forwarded-for` before the request reaches the app lets a client forge either header. String comparison against the exact value `'true'`, same as `COOKIE_SECURE` above. Default: `false` | Set `true` only when the ingress strips and rewrites both headers |
| `TRUSTED_PROXY_CIDRS` | server | Optional | CIDR allowlist for proxies permitted to supply `x-forwarded-for`, used only when `TRUST_PROXY_HEADERS=true`. Default when unset: `['127.0.0.1/32', '::1/128']` (`DEFAULT_TRUSTED_PROXY_CIDRS`, `lib/server/security.ts:50`) — `.env.example` ships the same value | Set to the ingress's source IP ranges |
| `NEXT_PUBLIC_API_URL` | browser | Optional | API base URL override for the frontend (`lib/api/client.ts`). Default: `/api` | Set only when the browser must call a different API base URL |
| `NEXT_PUBLIC_ASSOCIATION_URL` | browser | Optional | External association link shown in the footer (`components/layout/footer.tsx:17,81-86`). The link always renders — `href={associationUrl ?? '#'}` — unset only means it points at `#` instead of a real URL; `target="_blank"`/`rel`/the external-link icon are what's conditional on it being set | The club's association URL |
| `CLUB_TIMEZONE` | server | Optional | IANA timezone override (`lib/club-time.ts:8-11`). Default: `'Atlantic/Canary'` — a hardcoded fallback, not the server's system timezone. Vitest never loads `.env.local` (no `dotenv`/`loadEnv` anywhere in `vitest.config.mts`/`vitest.setup.ts`); `vitest.config.mts`'s `test.env` block pins both this and `NEXT_PUBLIC_CLUB_TIMEZONE` to `'Europe/Madrid'` for the entire suite instead — both must be pinned, since `lib/club-time.ts` checks `NEXT_PUBLIC_CLUB_TIMEZONE` first | Set to the club's IANA timezone name |
| `NEXT_PUBLIC_CLUB_TIMEZONE` | browser + server | Optional | Same override, exposed to the browser — `lib/club-time.ts` is imported by client components (e.g. `components/rooms/rooms-view.tsx`), so a server-only `CLUB_TIMEZONE` is invisible to them. Takes precedence over `CLUB_TIMEZONE` when both are set | Same |
| `UPSTASH_REDIS_REST_URL` | server | Optional | Rate limiter backing store (`lib/server/security.ts`). When set together with the token below, rate limiting is shared across serverless instances via Upstash Redis; otherwise it falls back to an in-memory `Map` (per-instance only, bypassable in production by rotating instances) | Upstash console → Redis database → REST API |
| `UPSTASH_REDIS_REST_TOKEN` | server | Optional | Paired with `UPSTASH_REDIS_REST_URL` | Same |
| `CRON_SECRET` | server | Present but unused | `POST /api/cron/cancel-pending` unconditionally returns `410` and never reads this. Kept defined pending a decision on whether the route is revived or removed — see `docs/SECRET-ROTATION-CHECKLIST.md` | Not applicable while unused |
| `ALLOW_NON_EMPTY_DB` | script | Optional | `scripts/apply-neon-schema.mjs`: skips the empty-database guard, applying schema files even when tables already exist (`apply-neon-schema.mjs:197`; the `--force` CLI flag is the equivalent). Default: guard fails closed. **Never put this in `.env.local`** — `main()` calls `loadEnvLocal()` before this check runs, so a `.env.local` entry would silently disarm the guard on every future run, not just an explicit one-off | Pass inline in the shell: `ALLOW_NON_EMPTY_DB=1 node scripts/apply-neon-schema.mjs` |
| `SEED_ADMIN_PASSWORD` | script | Required to run the script | `scripts/seed-dev.mjs`: initial password for the seeded admin Clerk identity | Choose a local-only password |
| `DEV_SEED_CONFIRM` | script | Required to run the script | `scripts/seed-dev.mjs`: safety gate against running against the wrong environment — the script refuses unless this exactly equals `YES_SEED_NEON_DEV_DB` (`DEV_SEED_CONFIRM_VALUE`, `scripts/seed-dev.mjs:90,101`). Not a secret — the expected value is printed in the script's own usage comment and in `README.md`'s seeding section. **Never put this in `.env.local`** — the script's own header comment says so explicitly (`scripts/seed-dev.mjs:28-29`), because `main()` calls `loadEnvLocal()` before this check runs, so a `.env.local` entry would silently disarm the guard on every future run | Pass inline in the shell for one run: `DEV_SEED_CONFIRM=YES_SEED_NEON_DEV_DB` |
| `E2E_BASE_URL` | e2e | Optional | Base URL of the running app the E2E runners hit | Default: `http://localhost:3001` |
| `E2E_DATABASE_HOST` | e2e | Required | Positive hostname allowlist for `DATABASE_URL` — runners refuse to start if the hostname doesn't match exactly (`qa/e2e/db.mjs:26-49`). A second, heuristic-only defense also refuses if `DATABASE_URL` matches `/prod/i` regardless of this allowlist (`qa/e2e/db.mjs:56-59`) | Copy from the same Neon connection string used for `DATABASE_URL` |
| `E2E_ALLOW_DESTRUCTIVE` | e2e | Required | Must be exactly `1` to acknowledge the runners perform privileged fixture writes/deletes | — |
| `CHROME_PATH` | e2e | Optional | Custom Chrome/Chromium executable path (`qa/e2e/env.mjs`) | Default: Playwright's bundled Chromium |
| `PLAYWRIGHT_QA_USER` | e2e | Required (all four runners) | Member number of the admin QA user (`qa-reservation-lifecycle.mjs:14`, `qa-reservation-cancellation.mjs:14`, `qa-reservation-equipment.mjs:15`, `qa-no-show-expiry.mjs:19`) | A seeded/activated Clerk identity in the dev database |
| `PLAYWRIGHT_QA_PASSWORD` | e2e | Required (all four runners) | Password for the admin QA user | Same |
| `PLAYWRIGHT_QA_SECONDARY_USER` | e2e | Required (cancellation, equipment runners) | Member number of a regular, non-admin QA member | Same |
| `PLAYWRIGHT_QA_SECONDARY_PASSWORD` | e2e | Required (cancellation, equipment runners) | Password for the secondary user | Same |
| `DATABASE_URL` (e2e context) | e2e | Required | Same variable as above — the E2E runners connect directly for fixture setup/teardown | Same as the app's `DATABASE_URL` |
| `NODE_ENV` | server, script, framework-managed | N/A | Standard Next.js/Node variable. Gates `scripts/seed-dev.mjs` (refuses in production), the `COOKIE_SECURE` default, and a one-time console warning in `lib/server/security.ts:441` when the in-memory rate limiter is used in production | Set by the runtime, not by a developer |

### Optional SDK customization, not part of this inventory

The installed SDKs recognize many optional overrides that this application
does not own or set, including Clerk API/proxy/domain, redirect, JS/UI, and
telemetry controls. They are intentionally not enumerated here: documenting a
partial SDK API as an application inventory would become inaccurate whenever a
dependency adds another override. Consult Clerk's
[environment-variable reference](https://clerk.com/docs/guides/development/clerk-environment-variables)
and `@vercel/blob`'s installed type declarations for the exhaustive SDK
contracts.

Three previously investigated examples remain useful context:

- `NEXT_PUBLIC_CLERK_TELEMETRY_DISABLED` (browser) / `CLERK_TELEMETRY_DISABLED` (server) — Clerk's anonymous telemetry collector (`@clerk/shared`) hard-disables itself for any instance whose publishable key isn't a `pk_test_`/development key (`instanceType !== "development"`), so on a `pk_live_` production instance neither variable has any effect. Only relevant to the dev instance. Not set anywhere in this repo.
- `CLERK_ENCRYPTION_KEY` — the AES key `@clerk/nextjs` needs to propagate a dynamic `secretKey` from `clerkMiddleware()` to server-side helpers; unrelated to data encryption at rest. This repo doesn't pass `secretKey` to `clerkMiddleware()` (`middleware.ts:38`), so it's unused.
- `VERCEL_OIDC_TOKEN` / `BLOB_STORE_ID` — documented in the main table because they form the deployment credential path for the Blob calls this repo makes.

### Not environment variables (found during this audit, excluded)

The initial audit grep included a few names that turned out to be
hardcoded constants, not `process.env` reads — listed here so they aren't
re-added by mistake:

- `CLERK_USERNAME_PREFIX` — `const CLERK_USERNAME_PREFIX = 'alea-'` in `components/auth/login-form.tsx`, `lib/server/users-service.ts`, `lib/server/auth-service.ts`, `scripts/seed-dev.mjs`.
- `CLERK_API_BASE` — `const CLERK_API_BASE = 'https://api.clerk.com/v1'` in `scripts/seed-dev.mjs`.
- `SEED_EMAIL_DOMAIN` — `const SEED_EMAIL_DOMAIN = 'devseed.internal'` in `scripts/seed-dev.mjs`.
- `BLOB_BASE_URL` — a test-fixture constant in `__tests__/server/tables-service.test.ts`, not read from the environment.
- `VERCEL_TOKEN` — not read anywhere in this repo; it authenticates the Vercel CLI itself and is supplied by the `vercel` connector in this studio's tooling, not declared by the app.

### Removed: `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY` / `SUPABASE_SECRET_DEFAULT_KEY`

None of the three are read anywhere in the current codebase — Supabase was
fully removed (#311/#366), and the E2E runners were swapped from Supabase to
Clerk in #312 (merged, PR #367). The only remaining mentions were three
stale references in `docs/SECRET-ROTATION-CHECKLIST.md` describing this as
an open gap; that doc has been updated to reflect the fix. All three
variables are still set on Vercel (see the gap list below) — that's
leftover configuration, not a code dependency.

---

## Vercel environments

Checked via `vercel env ls` (names and environment columns only — no
values) against the project this repo is linked to, on 2026-09-04. Deployment
env config is authoritative on Vercel's side; the code-side "what does the
app actually read" comes from the table above.

### What must differ between Preview and Production

- `DATABASE_URL` — each should point at a different Neon branch.
- `CLERK_SECRET_KEY` / `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` — Preview should
  use a Clerk **test** instance's keys, Production a separate **live**
  Clerk instance's keys. See "Clerk instance configuration" below for why
  these must be two separate instances, not one instance's two key pairs.
- `NEXT_PUBLIC_APP_URL` — each environment's own public URL.
- Blob credential/store selection — if Preview and Production use separate
  stores, split `BLOB_READ_WRITE_TOKEN`; with OIDC, connect each deployment
  target to its intended store so `BLOB_STORE_ID` resolves accordingly.

### What can be shared

- `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_ASSOCIATION_URL`, `CLUB_TIMEZONE` /
  `NEXT_PUBLIC_CLUB_TIMEZONE`, `TRUST_PROXY_HEADERS`, `TRUSTED_PROXY_CIDRS`,
  `COOKIE_SECURE` — these describe the club/deployment posture, not a
  per-environment secret, and can hold the same value in both unless the
  club timezone or ingress setup genuinely differs.
- `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` — can point at one
  shared Redis database, or be split per environment; either is fine
  since rate-limit state doesn't need to be shared across environments.

### Gap: shared between Preview and Production but must differ

Every variable in "What must differ" above appears in `vercel env ls` as a
**single row** whose environments column lists more than one target,
meaning one value is currently assigned to all of them — not split per
environment:

- `DATABASE_URL` — one row, target `Preview, Production`. Preview and
  Production currently run against the same Neon database.
- `NEXT_PUBLIC_APP_URL` — one row, target `Preview, Production`. Preview
  builds QR-code check-in links pointing at Production's URL (or vice
  versa, depending on which was set last).
- `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` — one row, target `Development,
  Preview, Production`.
- `CLERK_SECRET_KEY` — one row, target `Development, Preview, Production`.
  Combined with the row above: Development, Preview, and Production all
  currently authenticate against the same Clerk instance.
- No Blob credential or store identifier appears in `vercel env ls`; see the
  owner-verification item below.

These per-environment splits are tracked for action under issue #336 Phase 4
item 6 (production cutover, user-only) — not actioned here, since this
document is read-only per this repo's DDL/secrets rules.

### Needs owner verification: Blob authentication

- Neither `BLOB_READ_WRITE_TOKEN` nor `BLOB_STORE_ID` appears in `vercel env
  ls`. That listing does not prove the deployment lacks Blob access: after a
  store is upgraded and connected for OIDC, Vercel can inject the short-lived
  `VERCEL_OIDC_TOKEN` and store identifier at runtime. Confirm the project-store
  connection in the Blob dashboard or exercise one upload and one table-QR
  write in Preview. Those paths fail only if neither OIDC (`VERCEL_OIDC_TOKEN`
  plus `BLOB_STORE_ID`) nor `BLOB_READ_WRITE_TOKEN` is available. Tracked for
  action under issue #336 Phase 4 item 6 (production cutover, user-only).

### Not set on Vercel, optional

- `NEXT_PUBLIC_CLERK_SIGN_IN_URL` / `NEXT_PUBLIC_CLERK_SIGN_UP_URL` —
  inert in this repo (see the variable table above); absence has no effect.
- `COOKIE_SECURE` — has a working default (`true` in production); absence
  is expected, not a gap.
- `NEXT_PUBLIC_CLUB_TIMEZONE` — absent, while `CLUB_TIMEZONE` **is** set
  on Vercel (one row, target `Preview, Production`). If that value is ever
  anything other than the default `'Atlantic/Canary'`,
  server code (which reads `CLUB_TIMEZONE`) and client components (which
  read `NEXT_PUBLIC_CLUB_TIMEZONE`, not set, so they fall through to the
  hardcoded default) will compute day boundaries in two different
  timezones. Not harmless if `CLUB_TIMEZONE`'s actual value is non-default.
- `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` — absent. Without
  both, the rate limiter falls back to the in-memory `Map`, which this
  document's own variable table calls "bypassable in production by
  rotating instances." Not harmless — this is the difference between a
  real production rate limit and one an attacker can reset by triggering
  new serverless instances. Tracked for action under issue #336 Phase 4
  item 6 (production cutover, user-only).

### Gap: set on Vercel, nothing reads it

- `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY`,
  `SUPABASE_SECRET_DEFAULT_KEY` — dead, Supabase fully removed (see above).
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
  regardless.
- `CRON_SECRET` — set, but unused by any route (see the variable table
  above and `docs/SECRET-ROTATION-CHECKLIST.md` section 2).

Nothing was changed, promoted, or deleted on Vercel while producing this
document — read-only, per this repo's DDL/secrets rules.

---

## Clerk instance configuration

### Development instance — verified against the live instance on 2026-09-04

Verified directly against the Clerk Frontend API (`GET
https://<frontend-api-host>/v1/environment`, host decoded from the
publishable key), rather than assumed from the issue text. All paths below
are relative to the response's `user_settings` object.

| Setting | Live value | Issue #335's claim | Match? |
|---|---|---|---|
| `sign_up.mode` | `restricted` | `restricted` | Yes |
| `attributes.username.enabled` | `false` | "username enabled" | **No** — the live instance has the username *attribute* disabled for sign-up collection. `attributes.username.used_for_first_factor` is `true` — see "Target production instance configuration" below for why this, not `enabled`, is the setting that matters here |
| `attributes.email_address.enabled` | `false` | "email_address disabled" | Yes |
| `attributes.password.enabled` | `true` | "password enabled" | Yes |
| `social.oauth_google.enabled` | `true` | Not mentioned in the issue | **New finding** — Google OAuth sign-in is enabled on the dev instance. Not mentioned by #335 and not consistent with the club's no-public-signup identity model (see below) |

Other observed settings, for completeness: `sign_up.captcha_enabled: true`,
`sign_up.progressive: true`, `sign_up.legal_consent_enabled: false`,
`sign_up.mfa.required: false`, `sign_in.second_factor.required: false`,
`restrictions.allowlist.enabled: false`, `restrictions.blocklist.enabled:
false`, `username_settings.min_length: 4`, `actions.create_organization:
true`, `attributes.email_address.verifications: []`,
`attributes.email_address.verify_at_sign_up: false`,
`attributes.phone_number.enabled: false`,
`attributes.phone_number.verifications: []`. None of these were claimed by
the issue either way. The last four confirm no email/SMS verification
strategy is configured on the dev instance — the basis for the "Email/SMS
verification flows | Disabled" row in the target production table below.

**Not independently verified:** allowed origins / redirect URLs, and
anything requiring the Backend API (`api.clerk.com`) rather than the public
Frontend API — the Frontend API's `/v1/environment` endpoint was sufficient
for everything in the table above and needed no secret key.

### Target production instance configuration

Basis: members have no email addresses. Identity is the member number;
admins issue activation links and hand them over through their own
channel. Zero outgoing email (identity model from #299).

| Setting | Target | Rationale |
|---|---|---|
| `sign_up.mode` | `restricted` (no public self-signup) | Members are provisioned by an admin via the activation-link flow, never by visiting a public sign-up page |
| `sign_up.captcha_enabled` | `true` | Preserve the verified dev posture as defense in depth if a sign-up surface is exposed accidentally |
| `sign_up.progressive` | `true` | Preserve the verified dev setting; it is inert while sign-up remains restricted |
| `sign_up.legal_consent_enabled` | `false` | The app has no Clerk-hosted public sign-up flow on which to collect this consent |
| `sign_up.mfa.required` | `false` | Members have no configured email, SMS, authenticator, or backup-code enrollment flow |
| `sign_in.second_factor.required` | `false` | Username plus password is the complete supported member authentication flow |
| `attributes.username.enabled` | `false` | Username is not collected through a sign-up form; accounts are provisioned through the Backend API |
| `attributes.username.used_for_first_factor` | `true` | The member number is the sign-in identifier: `components/auth/login-form.tsx:84-85` calls `signIn.create({ identifier: 'alea-<memberNumber>', password })`, and `lib/server/auth-service.ts:395-398` provisions accounts via the Backend API's `client.users.createUser({ username, password })` — never through the public sign-up form. `attributes.username.enabled`/`.required` govern sign-up-form attribute *collection*, which is moot here: sign-up is `restricted` and accounts are always created server-side. The evidence for recommending `used_for_first_factor: true` with `enabled: false` specifically (rather than assuming `enabled: true` is needed) is that this is the verified dev instance's live configuration (see the table above), and username+password login against it is known to work — the standalone E2E runners under `qa/e2e/` sign in this same way (`PLAYWRIGHT_QA_USER` filled into the member-number field, then submitted through this same `login-form.tsx` flow) against that instance |
| `username_settings.min_length` | `4` | Preserve the verified dev constraint; provisioned usernames use the `alea-` prefix and already exceed it |
| `attributes.email_address.enabled` | `false` | Members have no email addresses in this system |
| `attributes.password.enabled` | `true` | Password is the only credential members authenticate with |
| Email/SMS verification flows | Disabled | There is no outgoing email or SMS channel to verify through. Verified on the dev instance: `attributes.email_address.verifications: []`/`verify_at_sign_up: false`, `attributes.phone_number.enabled: false`/`verifications: []` (see "Other observed settings" above) |
| `social.*` (OAuth providers) | All disabled | No provider is part of the identity model; the live dev instance's `oauth_google: true` should not carry into production |
| `restrictions.allowlist.enabled` | `false` | Admin provisioning and the database profile mapping are the membership gate; no separate Clerk allowlist is maintained |
| `restrictions.blocklist.enabled` | `false` | The app's admin-managed user status is the account-control mechanism; no separate Clerk blocklist is maintained |
| `actions.create_organization` | `false` | Alea does not use Clerk Organizations; production should not expose an unrelated organization-creation capability |

The verified dev instance differs from this target on
`social.oauth_google.enabled` and `actions.create_organization`; both are
enabled in dev but must be disabled in production because Alea uses neither
capability. Production should preserve the verified dev values for the other
rows. Any deviation from this table must be smoke-tested under issue #313
before cutover, not assumed safe.

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
