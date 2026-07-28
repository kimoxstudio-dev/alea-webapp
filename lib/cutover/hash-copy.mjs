/**
 * lib/cutover/hash-copy.mjs — F2 cutover prep/tooling (KIM-419).
 *
 * Pure, dependency-free logic backing step (c) of
 * Linear KIM-420: copying `auth.users.encrypted_password`
 * (Supabase/GoTrue, standard bcrypt) verbatim into `profiles.password_hash`
 * (read by lib/authjs/credentials-user.ts via bcryptjs on the F1 branch).
 *
 * IMPORTANT — this module never hashes, re-hashes, or otherwise transforms
 * a password or a hash. It only *validates the shape* of an existing bcrypt
 * hash string and passes it through byte-for-byte. Supabase Auth and
 * bcryptjs both produce/consume the standard `$2a$/$2b$/$2y$` bcrypt format,
 * so no conversion is needed or performed — see the runbook for the
 * rationale. This is intentionally NOT wired to any real database; it is
 * plain data-shape logic that the real F2 cutover (KIM-420, user-only) can
 * import, and that scripts/cutover-rehearsal.sh exercises against synthetic
 * fixtures only.
 */

/**
 * Standard bcrypt hash format: `$2a$`, `$2b$`, or `$2y$` version tag,
 * a 2-digit cost factor, then a 53-character base64-like salt+digest.
 * Both Supabase's GoTrue (Go bcrypt) and Node's bcryptjs emit this exact
 * shape, which is why the copy step needs no re-hash.
 */
export const BCRYPT_HASH_RE = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/

/** @param {unknown} value */
export function isBcryptHash(value) {
  return typeof value === 'string' && BCRYPT_HASH_RE.test(value)
}

/**
 * Builds a copy plan from source rows (shape of `auth.users`) to the
 * `profiles.password_hash` column, without ever hashing anything.
 *
 * @param {Array<{ id: string; encryptedPassword: string | null | undefined }>} rows
 * @returns {{
 *   copied: Array<{ id: string; passwordHash: string }>,
 *   skipped: Array<{ id: string; reason: 'missing_encrypted_password' | 'not_bcrypt_format' }>,
 * }}
 */
export function planPasswordHashCopy(rows) {
  const copied = []
  const skipped = []

  for (const row of rows) {
    if (row.encryptedPassword === null || row.encryptedPassword === undefined || row.encryptedPassword === '') {
      skipped.push({ id: row.id, reason: 'missing_encrypted_password' })
      continue
    }

    if (!isBcryptHash(row.encryptedPassword)) {
      skipped.push({ id: row.id, reason: 'not_bcrypt_format' })
      continue
    }

    // Verbatim copy — no re-hash. `passwordHash` is byte-for-byte equal to
    // the source value.
    copied.push({ id: row.id, passwordHash: row.encryptedPassword })
  }

  return { copied, skipped }
}

/**
 * Defensive assertion used by the rehearsal script (and available to the
 * real cutover script) to prove a given copy step really was byte-for-byte,
 * i.e. that nothing re-hashed or mutated the value in transit.
 *
 * @param {string} sourceHash
 * @param {string} copiedHash
 */
export function assertByteForByteCopy(sourceHash, copiedHash) {
  if (sourceHash !== copiedHash) {
    throw new Error('hash-copy: copied value diverged from source — this must always be a verbatim copy, never a re-hash')
  }
}
