import { serviceError } from '@/lib/server/service-error'

// URL hardening (MEDIUM finding from PR #148 security review, generalised in
// OIR-203 code review as the shared validator — Finding 7): any user-supplied
// URL that will be rendered as an <img src> or <a href> on a public page
// (image_url / link_url today; future OIR-204/205 fields going forward) must
// go through THIS validator. Only absolute http(s) URLs are accepted (or
// empty/omitted) — javascript:, data:, relative paths, and any other scheme
// are rejected before they can ever be persisted.
const ALLOWED_URL_PROTOCOLS = new Set(['http:', 'https:'])

/**
 * Client-safe shape check for an optional absolute http(s) URL — same accept
 * rule as `validateOptionalUrl` below, without the server-only throw, so
 * client components can surface a field-level error before submit instead of
 * round-tripping to the API for a 400.
 */
export function isValidOptionalUrl(value: string): boolean {
  const str = value.trim()
  if (str === '') return true
  try {
    return ALLOWED_URL_PROTOCOLS.has(new URL(str).protocol)
  } catch {
    return false
  }
}

/**
 * Validate an optional, user-supplied absolute http(s) URL.
 *
 * Returns `null` when the value is empty/undefined/null (URL is optional).
 * Throws a 400 ServiceError via `serviceError` when the value is present but
 * is not a valid absolute http(s) URL.
 */
export function validateOptionalUrl(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null
  const str = String(value).trim()
  if (str === '') return null

  let parsed: URL
  try {
    parsed = new URL(str)
  } catch {
    serviceError(`${field} must be an absolute http(s) URL`, 400)
  }
  if (!ALLOWED_URL_PROTOCOLS.has(parsed.protocol)) {
    serviceError(`${field} must be an absolute http(s) URL`, 400)
  }
  return str
}
