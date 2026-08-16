#!/usr/bin/env node
/**
 * scripts/seed-dev.mjs — dev-only seed for the Neon/raw-SQL + Clerk stack
 * (#299 follow-up, ports the orphaned `scripts/seed.ts` from commit
 * 21426aa — not on any branch, blob read via `git show 21426aa:scripts/seed.ts`
 * — to the current schema/auth model).
 *
 * Everything about the old script's DB layer is obsolete post-migration:
 * `lib/db/schema` is now plain SQL (see lib/db/schema/003_profiles.sql,
 * 013_activation_tokens.sql), not Drizzle, and `profiles` no longer has a
 * `password_hash` column — Clerk is the only credential store (see
 * lib/server/auth-service.ts). This script talks to Neon the same way the
 * app does (`@neondatabase/serverless`'s tagged-template `neon()`, mirroring
 * lib/db/client.ts) and creates the ADMIN fixture's Clerk identity directly
 * via the Clerk Backend REST API (plain `fetch`, no SDK import) since admin
 * needs to sign in immediately with no activation-link step.
 *
 * Identity model (locked, see lib/server/auth-service.ts): Clerk username is
 * `alea-<member_number>`, no email involved anywhere, no public
 * self-registration. The member fixture below is inserted pre-activation
 * (`is_active = false`, no Clerk identity) — an admin issues its activation
 * link through the running app exactly like a real admin would.
 *
 * SAFETY: refuses to run unless BOTH `NODE_ENV !== 'production'` AND
 * `DEV_SEED_CONFIRM` is set to the exact confirmation value below, and
 * refuses if `DATABASE_URL` looks like it points at anything other than dev
 * (contains "prod", case-insensitive — a heuristic, not a guarantee, since
 * the connection string carries no reliable environment marker). Never set
 * `DEV_SEED_CONFIRM` anywhere but a local shell for an explicit, one-off run.
 *
 * Idempotency: both profile rows are upserted keyed on `member_number` (the
 * schema's unique column, `profiles_member_number_key`) via
 * `ON CONFLICT ... DO UPDATE`. The member fixture's `is_active`/`active_from`
 * are deliberately left untouched on conflict, so re-running this script
 * after the member has been activated through the real flow does not
 * silently revert their activation state back to pending. The admin
 * fixture's Clerk identity is only created if no Clerk user with that
 * username already exists (checked via a GET before the POST); its password
 * is never reset on a later run.
 *
 * Usage:
 *   DEV_SEED_CONFIRM=YES_SEED_NEON_DEV_DB node scripts/seed-dev.mjs
 *
 * Requires `DATABASE_URL` and `CLERK_SECRET_KEY` in the environment (e.g.
 * sourced from `.env.local`). Never logs, prints, or otherwise surfaces
 * either value. `CLERK_SECRET_KEY` must be a test-mode key (`sk_test_...`)
 * — the script refuses to run against a live key (`sk_live_...`).
 *
 * The admin fixture's initial password MUST be provided via
 * `SEED_ADMIN_PASSWORD` — there is no default and none is hardcoded in this
 * file. The script refuses to run (exits non-zero) if it is unset or empty;
 * see `assertAdminPasswordProvided` below.
 */
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { neon } from '@neondatabase/serverless'

const __dirname = dirname(fileURLToPath(import.meta.url))
const rootDir = join(__dirname, '..')

/** Loads `.env.local` the same way scripts/apply-neon-schema.mjs does, so
 * this script works the same way `pnpm dev` does without requiring callers
 * to export vars manually. Never overrides an already-set env var. */
function loadEnvLocal() {
  const envPath = join(rootDir, '.env.local')
  if (!existsSync(envPath)) return
  const content = readFileSync(envPath, 'utf8')
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx === -1) continue
    const key = trimmed.slice(0, eqIdx).trim()
    let value = trimmed.slice(eqIdx + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (!(key in process.env)) {
      process.env[key] = value
    }
  }
}

const DEV_SEED_CONFIRM_VALUE = 'YES_SEED_NEON_DEV_DB'

function assertDevSeedAllowed(databaseUrl) {
  if (process.env.NODE_ENV === 'production') {
    console.error(
      '[seed] Refusing to run: NODE_ENV=production. This script seeds throwaway dev fixtures ' +
        'and must never run against a production database.'
    )
    process.exit(1)
  }

  if (process.env.DEV_SEED_CONFIRM !== DEV_SEED_CONFIRM_VALUE) {
    console.error(
      '[seed] Refusing to run: missing or incorrect DEV_SEED_CONFIRM.\n' +
        `  Set DEV_SEED_CONFIRM=${DEV_SEED_CONFIRM_VALUE} to confirm you intend to seed the ` +
        'database currently configured via DATABASE_URL.\n' +
        '  Never set this variable in a shared, staging, or production environment.'
    )
    process.exit(1)
  }

  // Heuristic-only defense in depth: the connection string carries no
  // reliable environment marker, but refusing on an obvious "prod" hint
  // costs nothing and catches the most common mistake (pasting the wrong
  // value). This is NOT a substitute for the read-only inspection required
  // before every write — see CLAUDE.md's "Narrow exception — development
  // database" section.
  if (/prod/i.test(databaseUrl)) {
    console.error(
      '[seed] Refusing to run: DATABASE_URL appears to reference a production database ' +
        '(matched "prod"). Point this script at the dev database only.'
    )
    process.exit(1)
  }
}

// Heuristic-only defense in depth, mirroring the DATABASE_URL "prod" check
// above: Clerk secret keys are prefixed by mode (`sk_live_...` vs
// `sk_test_...`), so refusing on a live-key prefix catches the common
// mistake of `.env.local` accidentally pointing at the production Clerk
// instance. Only runs the check when the key is actually set — a missing
// key is already handled separately in clerkFetch().
function assertClerkKeyIsDev(clerkSecretKey) {
  if (clerkSecretKey && /^sk_live_/i.test(clerkSecretKey)) {
    console.error(
      '[seed] Refusing to run: CLERK_SECRET_KEY looks like a live/production Clerk key ' +
        '(starts with "sk_live_"). This script must only run against a test-mode Clerk ' +
        'instance (key prefix "sk_test_"). Check .env.local.'
    )
    process.exit(1)
  }
}

// Fails closed: the admin fixture's password must be supplied explicitly via
// SEED_ADMIN_PASSWORD (e.g. sourced from .env.local). No default/fallback
// value is used here — a hardcoded literal in source is a committed
// credential regardless of how "dev-only" it's labeled, so this guard
// refuses to run rather than silently reusing one.
function assertAdminPasswordProvided(adminPassword) {
  if (!adminPassword || adminPassword.trim() === '') {
    console.error(
      '[seed] Refusing to run: SEED_ADMIN_PASSWORD is not set. Choose a password and set it ' +
        '(e.g. in .env.local) before running this script — no default value is provided.'
    )
    process.exit(1)
  }
}

// --- Synthetic fixture data -------------------------------------------------
// Deliberately out of any plausible real member-number range and tagged in
// full_name/email so nothing here can be mistaken for a real club member.
const SEED_EMAIL_DOMAIN = 'devseed.internal'
const CLERK_USERNAME_PREFIX = 'alea-'

const ADMIN_MEMBER_NUMBER = '900000'
const ADMIN_FULL_NAME = '[SEED FIXTURE] Dev Admin (not a real member)'

const MEMBER_MEMBER_NUMBER = '900001'
const MEMBER_FULL_NAME = '[SEED FIXTURE] Dev Member One (not a real member, pending activation)'

function toClerkUsername(memberNumber) {
  return `${CLERK_USERNAME_PREFIX}${memberNumber}`
}

function seedEmailFor(memberNumber) {
  return `seed-${memberNumber}@${SEED_EMAIL_DOMAIN}`
}

async function upsertAdminProfile(sql) {
  const email = seedEmailFor(ADMIN_MEMBER_NUMBER)
  const rows = await sql`
    INSERT INTO profiles (id, member_number, full_name, auth_email, email, role, is_active, active_from, psw_changed)
    VALUES (gen_random_uuid(), ${ADMIN_MEMBER_NUMBER}, ${ADMIN_FULL_NAME}, ${email}, ${email}, 'admin', true, now(), now())
    ON CONFLICT (member_number) DO UPDATE SET
      full_name = EXCLUDED.full_name,
      auth_email = EXCLUDED.auth_email,
      email = EXCLUDED.email,
      role = 'admin',
      is_active = true,
      updated_at = now()
    RETURNING id, member_number
  `
  return rows[0]
}

async function upsertPendingMemberProfile(sql) {
  const email = seedEmailFor(MEMBER_MEMBER_NUMBER)
  const rows = await sql`
    INSERT INTO profiles (id, member_number, full_name, auth_email, email, role, is_active, active_from, psw_changed)
    VALUES (gen_random_uuid(), ${MEMBER_MEMBER_NUMBER}, ${MEMBER_FULL_NAME}, ${email}, ${email}, 'member', false, NULL, NULL)
    ON CONFLICT (member_number) DO UPDATE SET
      full_name = EXCLUDED.full_name,
      auth_email = EXCLUDED.auth_email,
      email = EXCLUDED.email,
      role = 'member',
      updated_at = now()
    RETURNING id, member_number, is_active
  `
  return rows[0]
}

const CLERK_API_BASE = 'https://api.clerk.com/v1'

async function clerkFetch(path, options = {}) {
  const secretKey = process.env.CLERK_SECRET_KEY
  if (!secretKey) {
    console.error('[seed] Refusing to run: CLERK_SECRET_KEY is not set (needed to create the admin Clerk identity).')
    process.exit(1)
  }
  return fetch(`${CLERK_API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${secretKey}`,
      'Content-Type': 'application/json',
      ...(options.headers ?? {}),
    },
  })
}

/**
 * Creates the admin's real, working Clerk identity if one doesn't already
 * exist for `alea-<ADMIN_MEMBER_NUMBER>`. No email attribute, per the
 * locked identity model. Idempotent: never resets the password on an
 * existing identity. `adminPassword` must already have been validated by
 * `assertAdminPasswordProvided`.
 */
async function ensureAdminClerkIdentity(adminPassword) {
  const username = toClerkUsername(ADMIN_MEMBER_NUMBER)

  const listRes = await clerkFetch(`/users?username=${encodeURIComponent(username)}`)
  if (!listRes.ok) {
    throw new Error(`[seed] Failed to query Clerk for existing admin identity (status ${listRes.status})`)
  }
  const existing = await listRes.json()
  if (Array.isArray(existing) && existing.length > 0) {
    console.log(`[seed] Clerk identity ${username} already exists — leaving password untouched.`)
    return { created: false, username }
  }

  const createRes = await clerkFetch('/users', {
    method: 'POST',
    body: JSON.stringify({
      username,
      password: adminPassword,
      skip_password_checks: false,
    }),
  })
  if (!createRes.ok) {
    const text = await createRes.text()
    throw new Error(`[seed] Failed to create Clerk identity ${username}: ${createRes.status} ${text}`)
  }
  console.log(`[seed] created Clerk identity ${username}`)
  return { created: true, username }
}

async function main() {
  loadEnvLocal()

  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    console.error('[seed] Refusing to run: DATABASE_URL is not set. Configure it in .env.local (see .env.example).')
    process.exit(1)
  }

  assertDevSeedAllowed(databaseUrl)
  assertClerkKeyIsDev(process.env.CLERK_SECRET_KEY)
  assertAdminPasswordProvided(process.env.SEED_ADMIN_PASSWORD)

  const sql = neon(databaseUrl)

  const admin = await upsertAdminProfile(sql)
  console.log(`[seed] admin profile ready — member_number=${admin.member_number}`)

  await ensureAdminClerkIdentity(process.env.SEED_ADMIN_PASSWORD)

  const member = await upsertPendingMemberProfile(sql)
  console.log(
    `[seed] member profile ready — member_number=${member.member_number} is_active=${member.is_active}`
  )

  console.log('[seed] done — dev fixtures seeded successfully.')
  console.log(`[seed] Admin sign-in identifier (bare member number): ${ADMIN_MEMBER_NUMBER}`)
  console.log(`[seed] Pending member fixture (needs an admin-issued activation link): ${MEMBER_MEMBER_NUMBER}`)
}

main().catch((error) => {
  console.error('[seed] failed:', error instanceof Error ? error.message : error)
  process.exit(1)
})
