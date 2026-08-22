import createMiddleware from 'next-intl/middleware'
import { clerkMiddleware } from '@clerk/nextjs/server'
import { createServerClient, type CookieOptions } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import { ensureCsrfCookie, getSupabaseCookieOptions } from './lib/server/security-edge'
import { locales, defaultLocale } from './lib/i18n/config'
import { getSupabaseUrl, getSupabasePublishableKey } from './lib/supabase/config.client'

const handleI18nRouting = createMiddleware({
  locales,
  defaultLocale,
  localePrefix: 'always',
})

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
 * Clerk is installed and wired here (#297) so `auth()` / `currentUser()`
 * (lib/server/session.ts) are populated. Protected Server Components and
 * Route Handlers enforce their own resource-level authentication and
 * authorization. This avoids path-matcher auth gates (#340), which Clerk
 * deprecated because their URL matching can diverge from Next.js routing.
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
export default clerkMiddleware(async (_auth, request: NextRequest) => {
  if (request.nextUrl.pathname.startsWith('/api')) {
    return NextResponse.next()
  }

  const response = handleI18nRouting(request)
  const supabase = createMiddlewareSupabaseClient(request, response)

  await supabase.auth.getUser()

  return ensureCsrfCookie(request, response)
})

export const config = {
  matcher: ['/((?!_next|_vercel|.*\\..*).*)'],
}
