import createMiddleware from 'next-intl/middleware'
import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server'
import { createServerClient, type CookieOptions } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import { ensureCsrfCookie, getSupabaseCookieOptions } from './lib/server/security-edge'
import { locales, defaultLocale, type Locale } from './lib/i18n/config'
import { getSupabaseUrl, getSupabasePublishableKey } from './lib/supabase/config.client'

const handleI18nRouting = createMiddleware({
  locales,
  defaultLocale,
  localePrefix: 'always',
})

/**
 * Deny-by-default gate (#330) for app routes that require an authenticated
 * Clerk session. Patterns are locale-prefixed because next-intl's
 * `localePrefix: 'always'` means every real page path carries an explicit
 * `/en` or `/es` segment (see `lib/i18n/config.ts` for the fixed locale
 * list).
 */
const isProtectedRoute = createRouteMatcher(
  locales.flatMap((locale) => [
    `/${locale}/admin(/.*)?`,
    `/${locale}/reservations(/.*)?`,
    `/${locale}/check-in(/.*)?`,
    `/${locale}/rooms(/.*)?`,
  ]),
)

/**
 * Extracts the locale prefix from a matched protected-route pathname, falling
 * back to the default locale for a malformed/unexpected path. This fallback
 * branch IS reachable today: Clerk's `createRouteMatcher` compiles
 * case-insensitive patterns, so a case-variant locale segment (e.g.
 * `/EN/admin`, `/Es/rooms`) still matches `isProtectedRoute` above, but the
 * lowercase-only `.includes()` check here does not match it. The pathname
 * then falls through to `defaultLocale`, which is safe — it still forces the
 * sign-in redirect flow rather than granting access.
 */
function localeFromPathname(pathname: string): Locale {
  const segment = pathname.split('/')[1]
  return (locales as readonly string[]).includes(segment) ? (segment as Locale) : defaultLocale
}

function createMiddlewareSupabaseClient(request: NextRequest, response: NextResponse) {
  return createServerClient(
    getSupabaseUrl(),
    getSupabasePublishableKey(),
    {
      cookieOptions: getSupabaseCookieOptions(),
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
          cookiesToSet.forEach(({ name, value }) => {
            request.cookies.set(name, value)
          })

          cookiesToSet.forEach(({ name, value, options }) => {
            response.cookies.set(name, value, options)
          })
        },
      },
    },
  )
}

/**
 * Clerk + Supabase middleware.
 *
 * Clerk is installed and wired here (#297) and now enforces deny-by-default
 * route protection (#330) via `isProtectedRoute` (`createRouteMatcher`,
 * above) for `/admin`, `/reservations`, `/check-in` and `/rooms`: the old
 * blocker on gating those routes is gone now that #298 (app-layer
 * authorization seam, merged #326) and #299 (Clerk identity -> Alea
 * profile/role mapping via `resolveProfileForClerkUser()`,
 * `lib/server/auth-service.ts`) have both landed.
 *
 * This middleware gate only checks that a Clerk session exists (`userId`
 * from `auth()`) — it does NOT resolve the Clerk identity to an Alea
 * profile/role. That fuller mapping requires a Neon SQL lookup
 * (`resolveProfileForClerkUser()`) whose module also uses Node-only
 * `node:crypto` APIs elsewhere, which Next statically rejects in Edge
 * Middleware (this file runs on the Edge Runtime — no `export const
 * runtime` override is set). Each protected page already performs that full
 * profile/role resolution itself via `getSessionFromServerCookies()` (see
 * e.g. `app/[locale]/admin/page.tsx`, which additionally redirects non-admin
 * members away) and redirects accordingly. This middleware gate is a
 * coarse, defense-in-depth front door — it denies bare
 * Clerk-unauthenticated traffic before it ever reaches those pages — not a
 * replacement for the page-level checks.
 *
 * `clerkMiddleware()` still wraps every non-API-excluded request (see
 * `config.matcher` below, which now also covers `/api`) so `auth()` /
 * `currentUser()` (lib/server/session.ts) are populated for any Route
 * Handler that opts into reading a Clerk session.
 *
 * The Supabase auth-cookie refresh (`supabase.auth.getUser()`) that existed
 * before Clerk was introduced is preserved unchanged: several services not
 * yet migrated off Supabase (e.g. `lib/server/rooms-service.ts`,
 * `lib/server/equipment-service.ts`) still read a user-scoped Supabase
 * client that depends on this cookie refresh.
 *
 * `/api` requests are intentionally routed around the next-intl rewrite,
 * the deny-by-default page gate above, and the Supabase cookie refresh
 * below (they are not locale-prefixed pages and already resolve their own
 * Clerk/Supabase session per-request via `requireAuth()`/`requireAdmin()`
 * in `lib/server/auth.ts`) — they only need `clerkMiddleware()` to run so
 * Clerk's auth context is populated.
 */
export default clerkMiddleware(async (auth, request: NextRequest) => {
  if (request.nextUrl.pathname.startsWith('/api')) {
    return NextResponse.next()
  }

  if (isProtectedRoute(request)) {
    const { userId } = await auth()

    if (!userId) {
      const locale = localeFromPathname(request.nextUrl.pathname)
      const signInUrl = new URL(`/${locale}/sign-in`, request.url)
      signInUrl.searchParams.set(
        'redirect_url',
        `${request.nextUrl.pathname}${request.nextUrl.search}`,
      )

      // CSRF cookie scope (#330): a redirect here bypasses the normal
      // page-response path below, but every non-API response — including
      // this one — must still carry a valid CSRF cookie, or a visitor whose
      // very first request lands on a protected route would reach the
      // sign-in page (and any subsequent unsafe request) without one.
      return ensureCsrfCookie(request, NextResponse.redirect(signInUrl))
    }
  }

  const response = handleI18nRouting(request)
  const supabase = createMiddlewareSupabaseClient(request, response)

  await supabase.auth.getUser()

  return ensureCsrfCookie(request, response)
})

export const config = {
  matcher: ['/((?!_next|_vercel|.*\\..*).*)'],
}
