#!/usr/bin/env node
/**
 * scripts/cutover-rehearsal-runner.mjs — F2 cutover rehearsal (KIM-419).
 *
 * Invoked by scripts/cutover-rehearsal.sh. Exercises the mechanical steps
 * tracked in Linear KIM-420 against synthetic, in-memory fixture data
 * only:
 *
 *   1. dump format validation      (lib/cutover/dump-integrity.mjs)
 *   2. bcrypt hash-copy logic      (lib/cutover/hash-copy.mjs)
 *   3. session-invalidation logic  (lib/cutover/session-invalidation.mjs)
 *
 * This script NEVER connects to a real database, never shells out to
 * `pg_dump`/`pg_restore`/`psql`, and never reads a real `.env*` file. All
 * data below is fabricated for this rehearsal and torn down (i.e. simply
 * discarded — nothing is persisted anywhere) when the process exits.
 *
 * Exit code 0 = every check passed. Non-zero = at least one check failed;
 * see the printed report for which one.
 */
import {
  validateDump,
  planPasswordHashCopy,
  assertByteForByteCopy,
  planSessionInvalidation,
} from '../lib/cutover/index.mjs'

/** @type {string[]} */
const failures = []

/**
 * @param {string} label
 * @param {boolean} condition
 * @param {string} [detail]
 */
function check(label, condition, detail) {
  if (condition) {
    console.log(`  ✓ ${label}`)
  } else {
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`)
    failures.push(label)
  }
}

console.log('=== F2 cutover rehearsal (synthetic fixtures only — no real infra) ===\n')

// ---------------------------------------------------------------------------
// 1. Dump format validation
// ---------------------------------------------------------------------------
console.log('[1/3] pg_dump-style structural validation')

const EXPECTED_TABLES = ['profiles', 'rooms', 'reservations']

// Fabricated plain-text dump fragment — mirrors the shape of a real
// `pg_dump --format=plain` COPY section, but every value here is synthetic.
const syntheticDumpText = `--
-- Synthetic pg_dump fixture — rehearsal only, not real data
--
CREATE TABLE public.profiles (id uuid, member_number varchar, email text);

COPY public.profiles (id, member_number, email) FROM stdin;
11111111-1111-1111-1111-111111111111\tM-0001\tmember-a@example.test
22222222-2222-2222-2222-222222222222\tM-0002\tmember-b@example.test
\\.

COPY public.rooms (id, name) FROM stdin;
33333333-3333-3333-3333-333333333333\tRoom A
\\.

COPY public.reservations (id, room_id, user_id) FROM stdin;
44444444-4444-4444-4444-444444444444\t33333333-3333-3333-3333-333333333333\t11111111-1111-1111-1111-111111111111
\\.
`

const dumpResult = validateDump(syntheticDumpText, EXPECTED_TABLES)

check('all expected tables present in dump', dumpResult.ok, `missing: ${dumpResult.missingTables.join(', ')}`)
check('profiles row count parsed correctly (2)', dumpResult.tableRowCounts.get('profiles') === 2)
check('rooms row count parsed correctly (1)', dumpResult.tableRowCounts.get('rooms') === 1)
check('reservations row count parsed correctly (1)', dumpResult.tableRowCounts.get('reservations') === 1)

// Negative case: a truncated dump missing a table must be caught.
const truncatedDumpText = syntheticDumpText.split('COPY public.reservations')[0]
const truncatedResult = validateDump(truncatedDumpText, EXPECTED_TABLES)
check(
  'truncated dump (missing reservations) is correctly flagged as incomplete',
  !truncatedResult.ok && truncatedResult.missingTables.includes('reservations')
)

console.log('')

// ---------------------------------------------------------------------------
// 2. bcrypt hash-copy logic
// ---------------------------------------------------------------------------
console.log('[2/3] bcrypt hash-copy logic (verbatim copy, no re-hash)')

// Well-known, publicly-published bcrypt test vector (hash of the string
// "password", cost 10) — used across countless bcrypt library test suites.
// This is NOT a real user credential; it exists only to exercise the
// format-validation + verbatim-copy code path.
const SYNTHETIC_BCRYPT_HASH = '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy'

const syntheticAuthUsersRows = [
  { id: 'user-1', encryptedPassword: SYNTHETIC_BCRYPT_HASH },
  { id: 'user-2', encryptedPassword: null }, // e.g. an invited-but-never-logged-in profile
  { id: 'user-3', encryptedPassword: 'not-a-bcrypt-hash' }, // defensive: unexpected format
]

const copyPlan = planPasswordHashCopy(syntheticAuthUsersRows)

check('exactly one row copied', copyPlan.copied.length === 1)
check('copied hash is byte-for-byte identical to source (no re-hash)', copyPlan.copied[0]?.passwordHash === SYNTHETIC_BCRYPT_HASH)
check('null encrypted_password is skipped with correct reason', copyPlan.skipped.some((s) => s.id === 'user-2' && s.reason === 'missing_encrypted_password'))
check('non-bcrypt value is skipped with correct reason', copyPlan.skipped.some((s) => s.id === 'user-3' && s.reason === 'not_bcrypt_format'))

try {
  assertByteForByteCopy(SYNTHETIC_BCRYPT_HASH, copyPlan.copied[0]?.passwordHash ?? '')
  check('assertByteForByteCopy accepts a true verbatim copy', true)
} catch {
  check('assertByteForByteCopy accepts a true verbatim copy', false)
}

try {
  assertByteForByteCopy(SYNTHETIC_BCRYPT_HASH, '$2a$10$differentHashValueThatShouldNeverMatchXXXXXXXXXXXXXXXX')
  check('assertByteForByteCopy rejects a divergent value', false)
} catch {
  check('assertByteForByteCopy rejects a divergent value', true)
}

console.log('')

// ---------------------------------------------------------------------------
// 3. Session-invalidation logic
// ---------------------------------------------------------------------------
console.log('[3/3] Session-invalidation logic (force single re-login post-cutover)')

const cutoverAt = new Date()

const syntheticPreCutoverSessions = [
  { userId: 'user-1', issuedAt: new Date(cutoverAt.getTime() - 60 * 60 * 1000) }, // 1h before cutover
  { userId: 'user-2', issuedAt: new Date(cutoverAt.getTime() - 24 * 60 * 60 * 1000) }, // 1 day before
  { userId: 'user-3', issuedAt: new Date(cutoverAt.getTime() - 1000) }, // 1s before cutover
]

const invalidationPlan = planSessionInvalidation(syntheticPreCutoverSessions, cutoverAt)

check(
  'every pre-cutover session is invalidated',
  invalidationPlan.invalidatedUserIds.length === syntheticPreCutoverSessions.length &&
    invalidationPlan.stillValidUserIds.length === 0
)

// A session freshly re-issued at/after the cutover boundary must be treated
// as valid — this is what "log in once, then you're through" looks like.
const postCutoverSession = { userId: 'user-1', issuedAt: new Date(cutoverAt.getTime() + 5000) }
const postCutoverPlan = planSessionInvalidation([postCutoverSession], cutoverAt)
check('a session re-issued after cutover is treated as valid (not invalidated)', postCutoverPlan.stillValidUserIds.includes('user-1'))

console.log('')
console.log('=== Rehearsal summary ===')
if (failures.length === 0) {
  console.log(`All checks passed (synthetic fixtures only). Cutover epoch used: ${cutoverAt.toISOString()}`)
  process.exit(0)
} else {
  console.log(`${failures.length} check(s) FAILED:`)
  for (const f of failures) {
    console.log(`  - ${f}`)
  }
  process.exit(1)
}
