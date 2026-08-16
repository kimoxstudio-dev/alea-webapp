/**
 * Shared same-origin redirect-path validation (#299 review finding 4).
 *
 * Used everywhere a `redirect_url` / `next` query param is trusted to send
 * the browser somewhere after authentication (sign-in page, login form,
 * auth callback route). A naive `value.startsWith('/')` check is NOT
 * sufficient: it accepts protocol-relative URLs (`//evil.com`) and
 * backslash variants (`/\evil.com`) that the WHATWG URL parser — and
 * therefore every browser, since browsers implement the same algorithm —
 * silently normalizes into an absolute, cross-origin URL before navigating.
 *
 * Approach: resolve the candidate against a fixed sentinel base using the
 * same URL parsing algorithm a browser uses, then check the resolved origin
 * didn't change. This single check subsumes explicit backslash detection,
 * because the parser itself performs the same normalization a browser would
 * (backslash -> `/` for special schemes, tab/CR/LF stripped from anywhere in
 * the input) before the origin comparison runs — verified against Node's
 * WHATWG-compliant `URL` implementation. A real request/browser origin is
 * intentionally not required: any fixed base works for this check, since we
 * only care whether the *origin changes* after resolution, not what the
 * origin actually is.
 *
 * Isomorphic — safe to import from both server code (route handlers, server
 * components) and client components ('use client'), since it only relies on
 * the standard `URL` global, not on any Node- or browser-only API.
 */

const SENTINEL_ORIGIN = 'https://redirect-guard.invalid'

/**
 * Returns true only for a well-formed, same-origin relative path:
 * - Not empty/null/undefined.
 * - Contains no ASCII control characters (defense-in-depth; also rejects
 *   embedded null bytes, which the URL parser alone does not strip).
 * - Starts with a single `/` followed by a character that is not `/` or
 *   `\` (rejects protocol-relative `//host` and backslash variants
 *   `/\host`, `\\host` up front).
 * - Resolves, via the standard URL parser, to the same origin as the
 *   sentinel base (rejects absolute URLs and any input a browser would
 *   normalize into a different origin, e.g. embedded tab/CR/LF).
 */
export function isSafeRedirectPath(value: string | null | undefined): value is string {
  if (!value) return false
  // eslint-disable-next-line no-control-regex -- intentional control-char rejection
  if (/[\x00-\x1f]/.test(value)) return false
  if (!/^\/[^/\\]/.test(value)) return false

  try {
    const resolved = new URL(value, SENTINEL_ORIGIN)
    return resolved.origin === SENTINEL_ORIGIN
  } catch {
    return false
  }
}

/**
 * Convenience wrapper: returns `value` if it passes `isSafeRedirectPath`,
 * otherwise `fallback`.
 */
export function resolveSafeRedirect(value: string | null | undefined, fallback: string): string {
  return isSafeRedirectPath(value) ? value : fallback
}
