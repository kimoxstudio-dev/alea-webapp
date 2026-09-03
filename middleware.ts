import createMiddleware from 'next-intl/middleware'
import { clerkMiddleware } from '@clerk/nextjs/server'
import { NextResponse, type NextRequest } from 'next/server'
import { ensureCsrfCookie } from './lib/server/security-edge'
import { locales, defaultLocale } from './lib/i18n/config'

const handleI18nRouting = createMiddleware({
  locales,
  defaultLocale,
  localePrefix: 'always',
})

/**
 * Clerk middleware + CSRF cookie issuance.
 *
 * Clerk is installed and wired here (#297) so `auth()` / `currentUser()`
 * (lib/server/session.ts) are populated. Protected Server Components and
 * Route Handlers enforce their own resource-level authentication and
 * authorization. This avoids path-matcher auth gates (#340), which Clerk
 * deprecated because their URL matching can diverge from Next.js routing.
 *
 * `clerkMiddleware()` still wraps every matched request, including `/api`
 * (see `config.matcher` below), so `auth()` /
 * `currentUser()` (lib/server/session.ts) are populated for any Route
 * Handler that opts into reading a Clerk session.
 *
 * The handler also calls `ensureCsrfCookie()` on page requests, issuing a
 * non-`httpOnly` CSRF token cookie (or reusing a valid existing one) that
 * `enforceMutationSecurity()` (lib/server/security.ts) later checks against
 * the `x-csrf-token` header on unsafe route-handler requests.
 *
 * `/api` requests are intentionally routed around the next-intl rewrite
 * (they are not locale-prefixed pages and already resolve their own
 * Clerk session per-request via `requireAuth()` / `requireAdmin()` in
 * `lib/server/auth.ts`). They only need `clerkMiddleware()` so Clerk's
 * auth context is populated.
 */
export default clerkMiddleware(async (_auth, request: NextRequest) => {
  if (request.nextUrl.pathname.startsWith('/api')) {
    return NextResponse.next()
  }

  const response = handleI18nRouting(request)

  return ensureCsrfCookie(request, response)
})

export const config = {
  matcher: ['/((?!_next|_vercel|.*\\..*).*)'],
}
