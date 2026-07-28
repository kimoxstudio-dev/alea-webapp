/**
 * lib/cutover/session-invalidation.mjs — F2 cutover prep/tooling (KIM-419).
 *
 * Pure, dependency-free logic backing step (d) of
 * Linear KIM-420: forcing every existing session to become
 * invalid at the moment of cutover, so every user must re-login exactly
 * once against the new Auth.js + Neon stack.
 *
 * This module does not touch cookies, JWTs, or any real session store — it
 * only models "was this session issued before or after the cutover
 * boundary", which is the same decision a real invalidation mechanism
 * (secret rotation, session-epoch column, etc.) has to make. See the
 * runbook for how this maps to the real mechanism.
 */

/**
 * The cutover boundary as a millisecond epoch. Any session/token issued
 * strictly before this instant is considered invalid post-cutover.
 *
 * @param {Date} cutoverAt
 * @returns {number}
 */
export function computeCutoverEpoch(cutoverAt) {
  return cutoverAt.getTime()
}

/**
 * A session is valid after cutover only if it was issued at/after the
 * cutover boundary — i.e. it was established via a fresh re-login against
 * the new stack, not carried over from the old one.
 *
 * @param {number} sessionIssuedAtMs
 * @param {number} cutoverEpochMs
 * @returns {boolean}
 */
export function isSessionValidAfterCutover(sessionIssuedAtMs, cutoverEpochMs) {
  return sessionIssuedAtMs >= cutoverEpochMs
}

/**
 * Given a snapshot of pre-cutover sessions and the cutover instant, returns
 * which user sessions get invalidated vs. which (if any) remain valid.
 * In the real cutover every existing session must land in `invalidatedUserIds`
 * — a non-empty `stillValidUserIds` indicates the invalidation mechanism
 * failed to cover some session and cutover must not be declared complete.
 *
 * @param {Array<{ userId: string; issuedAt: Date }>} sessions
 * @param {Date} cutoverAt
 * @returns {{
 *   invalidatedUserIds: string[],
 *   stillValidUserIds: string[],
 *   cutoverEpochMs: number,
 * }}
 */
export function planSessionInvalidation(sessions, cutoverAt) {
  const cutoverEpochMs = computeCutoverEpoch(cutoverAt)
  const invalidated = new Set()
  const stillValid = new Set()

  for (const session of sessions) {
    const issuedAtMs = session.issuedAt.getTime()

    if (isSessionValidAfterCutover(issuedAtMs, cutoverEpochMs)) {
      stillValid.add(session.userId)
    } else {
      invalidated.add(session.userId)
    }
  }

  return {
    invalidatedUserIds: [...invalidated],
    stillValidUserIds: [...stillValid],
    cutoverEpochMs,
  }
}
