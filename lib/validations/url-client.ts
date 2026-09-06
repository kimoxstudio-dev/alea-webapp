// URL hardening (MEDIUM finding from PR #148 security review, generalised in
// OIR-203 code review as the shared validator — Finding 7): any user-supplied
// URL that will be rendered as an <img src> or <a href> on a public page
// (image_url / link_url today; future OIR-204/205 fields going forward) must
// go through this check. Only absolute http(s) URLs are accepted (or
// empty/omitted) — javascript:, data:, relative paths, and any other scheme
// are rejected before they can ever be persisted.
//
// Deliberately client-safe (#313 code-review round 2, finding 6): this file
// carries no server-only import, so a `'use client'` component (e.g.
// `components/admin/partners-section.tsx`) can import `isValidOptionalUrl`
// directly without pulling `lib/server/service-error` — and, transitively,
// whatever that file grows to depend on — into the client bundle.
// `lib/validations/url.ts`'s server-side `validateOptionalUrl` imports
// `ALLOWED_URL_PROTOCOLS` from here, not the other way around.
export const ALLOWED_URL_PROTOCOLS = new Set(['http:', 'https:'])

/**
 * Client-safe shape check for an optional absolute http(s) URL — same accept
 * rule as `validateOptionalUrl` in `lib/validations/url.ts`, without the
 * server-only throw, so client components can surface a field-level error
 * before submit instead of round-tripping to the API for a 400.
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
