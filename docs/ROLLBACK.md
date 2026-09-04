# Rollback Procedure — Alea WebApp

This document describes how to roll back a deployment of the Alea WebApp to a previously known-good state.

---

## What "Rollback" Means

Rolling back means reverting the running application to the code and database schema of a previous stable git tag or branch. It does **not** automatically undo database data changes (rows inserted/deleted by users). Schema changes are also not automatically reverted; rolling them back requires restoring a backup or applying a new migration that reverses the prior schema change.

---

## Pre-Deployment Checklist

Before every deployment, verify the following:

- [ ] `pnpm lint` passes with no errors
- [ ] `pnpm typecheck` passes with no type errors
- [ ] `pnpm test` passes (all tests green)
- [ ] `pnpm build` completes successfully
- [ ] All required environment variables are set in the deployment target (see [Environment Variable Checklist](#environment-variable-checklist))
- [ ] Neon schema changes (`lib/db/schema/*.sql`) have been reviewed and applied to a Neon dev branch via `node scripts/apply-neon-schema.mjs`
- [ ] The current git HEAD is tagged (e.g. `git tag v0.x.y && git push origin v0.x.y`)
- [ ] The previous stable tag is known and documented

---

## Rollback Steps

### 1. Identify the last stable tag

```bash
git tag --sort=-creatordate | head -10
```

Note the tag you want to roll back to (e.g. `v0.3.2`).

### 2. Create a rollback branch from the stable tag

```bash
git checkout -b rollback/v0.3.2 v0.3.2
```

### 3. Verify the rollback branch builds cleanly

```bash
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Fix any issues before proceeding. Do not deploy a rollback branch that does not build.

### 4. Deploy the rollback branch

Follow your normal deployment process, targeting the `rollback/v0.3.2` branch instead of `main`/`develop`.

If using Vercel or a similar platform, redeploy from the rollback branch or promote the previous deployment.

### 5. Verify the rollback is live

- Smoke test key flows: login, room listing, reservation creation.
- Confirm the correct version is running (e.g. check a version endpoint or git SHA in logs).

---

## Neon Schema Rollback

### Understanding migrations

Schema is versioned as forward-only SQL files in `lib/db/schema/*.sql`, applied via `node scripts/apply-neon-schema.mjs`. There are no paired down migrations. The script (see its own header comment) tracks what has been applied in a `schema_migrations` ledger table, keyed by filename with a SHA-256 checksum of that file's content:

- A file whose checksum still matches the ledger is skipped as a verified no-op.
- A file whose content changed since it was last applied ("drifted") makes the script **abort the whole run** rather than silently re-applying or skipping it — see `assertDatabaseIsCleanOrOwned`/the drifted-files check in `scripts/apply-neon-schema.mjs`. This means you cannot roll back by editing an already-applied file in place and re-running the script; the script is specifically designed to refuse that.
- The script also runs a preflight check that aborts if the target database isn't empty or already fully owned by these schema files (`assertDatabaseIsCleanOrOwned` in `scripts/apply-neon-schema.mjs`), so it cannot be pointed at an arbitrary non-empty database by accident.

### Rolling back a single schema change (dev)

Neon dev is a shared, hosted database — not a local Postgres instance managed by a CLI reset command, so there is no equivalent of a one-command "wipe and re-apply everything" reset. Two options, depending on what's needed:

1. **Restore the Neon branch to a point in time before the change.** Neon supports point-in-time restore per branch and creating a new branch from a timestamp/LSN (Neon Console → your project → Branches → the affected branch → Restore, or create a new branch from an earlier point). This is the closest Neon-native equivalent to `supabase db reset`, but exactly which branch/restore workflow this project uses in practice is **not yet documented** — treat that as a gap, not settled process, until it's decided and written down here.
2. **Write and apply a new reversal SQL file.** Add a new file to `lib/db/schema/` (e.g. `NNN_revert_<what>.sql`) containing the `DROP`/`ALTER` statements that undo the change, and run `node scripts/apply-neon-schema.mjs` again. Because of the drift check above, this must be a *new* file — do not edit the already-applied original file, the script will treat that as unaccounted drift and abort.

### Rolling back a schema change in production

Neon does not support automatic down migrations any more than Supabase did. To roll back a schema change:

1. Write a new SQL file in `lib/db/schema/` that reverses the change (e.g. `DROP COLUMN`, `DROP TABLE`, restore constraints) — never edit the original applied file (see drift detection above).
2. Apply it:

   ```bash
   node scripts/apply-neon-schema.mjs
   ```

3. Verify the schema directly — e.g. `\d <table>` against `DATABASE_URL` via `psql`, or the Neon Console → SQL Editor. Unlike Supabase Studio, there is no bundled GUI schema browser in this repo's tooling; the SQL Editor in the Neon Console is the closest equivalent.

> **Warning:** Dropping columns or tables that contain data is destructive. Always confirm a Neon branch restore point or an explicit `pg_dump` backup exists before applying reversal SQL in production.

### Taking a database backup (Neon)

Neon retains automatic point-in-time recovery per branch (retention window depends on the Neon plan) — Neon Console → Branches → the branch → Restore. For a portable, explicit backup file, use `pg_dump`. Only the pooled connection string is configured in this repo (`DATABASE_URL`, `.env.example:12`) — there is no unpooled variable defined anywhere. For a `pg_dump` (a long-running operation that can be unreliable over the pooled/PgBouncer endpoint), copy the unpooled connection string manually from Neon Console → your project → Connection Details → toggle "Pooled connection" off, then run:

```bash
pg_dump "<unpooled-connection-string-from-neon-console>" > backup-$(date +%Y%m%d).sql
```

---

## Environment Variable Checklist

Ensure these variables are correctly set in the target environment before deploying or rolling back. See `docs/ENVIRONMENT.md` for the full reference (scope, defaults, and where each value is obtained) — this table only covers what's relevant to a rollback decision.

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | Yes | Neon pooled Postgres connection string (`?sslmode=require`), used by `lib/db/client.ts` for all application queries. |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | Yes | Clerk publishable key (format: `pk_test_*`/`pk_live_*`); safe to expose in the browser. |
| `CLERK_SECRET_KEY` | Yes | Clerk secret key (format: `sk_test_*`/`sk_live_*`); server only. |
| `BLOB_READ_WRITE_TOKEN` | Yes | Vercel Blob read/write token used by `lib/server/uploads-service.ts` and `lib/server/tables-service.ts`. |
| `AUTH_SESSION_SECRET` | No | Dead — no code consumer in the current Clerk-based runtime (see `docs/SECRET-ROTATION-CHECKLIST.md` section 1). Listed here only because a rollback to a pre-M3, pre-Clerk implementation would need it. |
| `NEXT_PUBLIC_APP_URL` | No | Public app base URL (e.g. `https://app.alea.club`). Despite the name, only read server-side, to build table QR-code check-in links — it does not drive auth callbacks or redirects. See `docs/ENVIRONMENT.md` for the exact unset-value behavior. |
| `COOKIE_SECURE` | No | Controls the `Secure` flag on the CSRF cookie (`lib/server/security-edge.ts:52-58`); defaults to `true` when `NODE_ENV=production`, `false` otherwise. The Clerk session cookie's `Secure` flag is set by Clerk, not by this variable. Leave unset in production. |
| `TRUST_PROXY_HEADERS` | No | Set to `true` only when the ingress strips and rewrites both `x-real-ip` and `x-forwarded-for` before requests reach the app. |
| `TRUSTED_PROXY_CIDRS` | No | Comma-separated CIDR allowlist for reverse proxies that are allowed to supply `x-forwarded-for` when `TRUST_PROXY_HEADERS=true`. Requests outside these source-IP ranges fall back to `x-real-ip` for rate limiting; the ingress must also strip and overwrite inbound `x-real-ip` and `x-forwarded-for`. |
| `NEXT_PUBLIC_API_URL` | No | Optional API base URL override for the frontend; defaults to `/api`. |
| `NEXT_PUBLIC_ASSOCIATION_URL` | No | External URL for the association link in the footer. |
| `CLUB_TIMEZONE` | No | IANA timezone override; defaults to `'Atlantic/Canary'` (`lib/club-time.ts:1`). `NEXT_PUBLIC_CLUB_TIMEZONE` takes precedence over this value. |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | No | When both are set, rate limiting uses shared Upstash Redis instead of an in-memory Map. |
| `CRON_SECRET` | No | Not currently a bearer token anything checks: `POST /api/cron/cancel-pending` (`app/api/cron/cancel-pending/route.ts`) returns `410 Gone` unconditionally and never reads this value — it is effectively unused by app runtime code as of this writing; see `docs/SECRET-ROTATION-CHECKLIST.md` for the fuller note on this gap. |

> **Security:** `CLERK_SECRET_KEY`, `AUTH_SESSION_SECRET`, and `DATABASE_URL` must never be exposed to the browser or committed to git. Unlike a Supabase project URL, Neon's `DATABASE_URL` embeds a password — treat a leaked connection string as a credential exposure, not just a config leak.

For local development, copy `.env.example` to `.env.local` and replace the placeholders with your own Neon, Clerk, and Blob values (see `.env.example`'s inline comments for where to find each one in its respective dashboard).

---

## Security Implications

Rolling back a deployment can have security consequences that must be addressed before or immediately after redeployment.

### Rolling back past a security fix

If the rollback target predates a security patch (e.g. a credential exposure or input validation fix), **rotate all affected credentials before redeploying**. Redeploying a version with a known vulnerability without rotating secrets leaves the system in a worse state than the original incident.

### `AUTH_SESSION_SECRET` rollback

If rolling back to a pre-M3 implementation that uses `AUTH_SESSION_SECRET` to sign application sessions, restoring an older secret value can invalidate sessions issued under the newer value, requiring users to re-authenticate. For the current Clerk-based runtime, `AUTH_SESSION_SECRET` is not referenced and changing it will not affect active sessions.

### Never rollback to a version with known secret exposure

If the rollback target is a version where secrets were exposed (e.g. accidentally committed to git, leaked in logs), **rotate the exposed credentials first**. Only then redeploy. Rolling back without rotation leaves the exposed values active.

Credentials to rotate if any exposure is suspected:

- `AUTH_SESSION_SECRET` — generate a new secret (min 32 chars)
- `CLERK_SECRET_KEY` — rotate via Clerk Dashboard > Configure > API Keys
- `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` — rotate if the publishable key was abused or exposed
- `DATABASE_URL` — rotate the Neon role password (Neon Console > your project > Roles) if the connection string itself could have leaked; unlike a Supabase project URL, this value embeds a password

### Clerk secret key rotation on auth architecture rollback

If the rollback affects auth architecture (e.g. rolling back past the Clerk auth migration, issue #297), **rotate the Clerk secret key** before redeployment. This prevents the old key from being usable if it was cached or logged during the affected window.

```bash
# After rotating the key in the Clerk dashboard, update your deployment environment:
# CLERK_SECRET_KEY=<new-key>
# Then redeploy.
```

---

## Post-Rollback Verification

After rolling back, verify:

- [ ] App loads at the expected URL
- [ ] Login works (member number and email login)
- [ ] Rooms and tables load correctly
- [ ] Reservation creation and cancellation work
- [ ] Admin dashboard loads for admin users
- [ ] No console errors related to environment variables, Neon (`DATABASE_URL`) connectivity, or Clerk auth
