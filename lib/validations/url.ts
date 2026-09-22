import { serviceError } from '@/lib/server/service-error'
import { ALLOWED_URL_PROTOCOLS, isLandingMediaPath } from '@/lib/validations/url-client'

/**
 * Validate an optional, user-supplied absolute http(s) URL or generated
 * same-origin landing-media path.
 *
 * Server-only (imports `serviceError`) — the client-safe shape check this
 * shares its accept rule with (`isValidOptionalUrl`) lives in
 * `lib/validations/url-client.ts`; import it from there directly rather than
 * through this file, so a client component never pulls in this file's
 * server-only import (#313 code-review round 2, finding 6).
 *
 * Returns `null` when the value is empty/undefined/null (URL is optional).
 * Throws a 400 ServiceError via `serviceError` when the value is present but
 * is not a valid absolute http(s) URL or generated landing-media path.
 */
export function validateOptionalUrl(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null
  const str = String(value).trim()
  if (str === '') return null
  if (field === 'imageUrl' && isLandingMediaPath(str)) return str

  let parsed: URL
  try {
    parsed = new URL(str)
  } catch {
    serviceError(`${field} must be a valid URL`, 400)
  }
  if (!ALLOWED_URL_PROTOCOLS.has(parsed.protocol)) {
    serviceError(`${field} must be a valid URL`, 400)
  }
  return str
}
