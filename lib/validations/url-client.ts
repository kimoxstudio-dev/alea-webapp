// URL hardening (MEDIUM finding from PR #148 security review, generalised in
// OIR-203 code review as the shared validator — Finding 7): any user-supplied
// URL that will be rendered as an <img src> or <a href> on a public page
// (image_url / link_url today; future OIR-204/205 fields going forward) must
// go through this check. Absolute http(s) URLs and generated same-origin
// landing-media paths are accepted; javascript:, data:, other relative paths,
// and any other scheme are rejected before they can ever be persisted.
//
// Deliberately client-safe (#313 code-review round 2, finding 6): this file
// carries no server-only import, so a `'use client'` component (e.g.
// `components/admin/partners-section.tsx`) can import `isValidOptionalUrl`
// directly without pulling `lib/server/service-error` — and, transitively,
// whatever that file grows to depend on — into the client bundle.
// `lib/validations/url.ts`'s server-side `validateOptionalUrl` imports
// `ALLOWED_URL_PROTOCOLS` from here, not the other way around.
export const ALLOWED_URL_PROTOCOLS = new Set(['http:', 'https:'])
const LANDING_MEDIA_PATH = /^\/api\/media\/(events|partners|library-games)\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|webp|gif)$/i

export function isLandingMediaPath(value: string): boolean {
  return LANDING_MEDIA_PATH.test(value)
}

/**
 * Client-safe shape check for an optional absolute http(s) URL or generated
 * same-origin landing-media path — same accept rule as `validateOptionalUrl`
 * in `lib/validations/url.ts`, without the
 * server-only throw, so client components can surface a field-level error
 * before submit instead of round-tripping to the API for a 400.
 */
export function isValidOptionalUrl(value: string, allowLandingMediaPath = false): boolean {
  const str = value.trim()
  if (str === '') return true
  if (allowLandingMediaPath && isLandingMediaPath(str)) return true
  try {
    return ALLOWED_URL_PROTOCOLS.has(new URL(str).protocol)
  } catch {
    return false
  }
}
