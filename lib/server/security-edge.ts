/**
 * Edge-safe security helpers.
 *
 * This module contains ONLY helpers that are safe to run in the Edge Runtime:
 * - No Node.js built-ins (`crypto`, `buffer`, etc.)
 * - Uses Web Crypto API (`crypto.getRandomValues`) which is available everywhere
 *
 * `middleware.ts` imports from here directly to keep its transitive dependency
 * graph free of Node-only modules.
 *
 * Node-only helpers (`tokensMatch`, `enforceMutationSecurity`, rate limiting)
 * stay in `security.ts`, which re-exports everything from this file so that
 * existing route-handler imports from `@/lib/server/security` are unaffected.
 */
import { NextRequest, NextResponse } from 'next/server'

/** The subset of cookie options this module sets. */
type CookieOptions = {
  httpOnly?: boolean
  path?: string
  sameSite?: 'lax' | 'strict' | 'none'
  secure?: boolean
}

export const CSRF_COOKIE_NAME = 'alea-csrf-token'
export const CSRF_HEADER_NAME = 'x-csrf-token'

/**
 * Determines whether cookies should have the Secure flag at RUNTIME.
 * Uses COOKIE_SECURE env var (explicit opt-in/out) or falls back to NODE_ENV.
 * This avoids the build-time inlining problem with NEXT_PUBLIC_APP_URL, which
 * would bake the wrong value into a build artifact deployed across environments
 * (e.g. a single build used on both HTTP staging and HTTPS prod).
 */
export function isSecureContext(): boolean {
  if (process.env.COOKIE_SECURE !== undefined) {
    return process.env.COOKIE_SECURE === 'true'
  }
  return process.env.NODE_ENV === 'production'
}

/**
 * Generates a cryptographically random CSRF token using the Web Crypto API.
 * Safe in both Edge and Node runtimes.
 */
export function createCsrfToken() {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function getCsrfCookieOptions() {
  return {
    httpOnly: false,
    path: '/',
    sameSite: 'lax',
    secure: isSecureContext(),
  } satisfies CookieOptions
}

export function ensureCsrfCookie(request: NextRequest, response: NextResponse) {
  const currentToken = request.cookies.get(CSRF_COOKIE_NAME)?.value
  const shouldSetCookie = !currentToken || currentToken.length < 32
  const token = shouldSetCookie ? createCsrfToken() : currentToken

  if (shouldSetCookie) {
    request.cookies.set(CSRF_COOKIE_NAME, token)
    response.cookies.set(CSRF_COOKIE_NAME, token, getCsrfCookieOptions())
  }

  return response
}
