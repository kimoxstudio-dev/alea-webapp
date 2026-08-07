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
 * Clerk is installed and wired here (#297) but does NOT gate app routes yet.
 * `/reservations`, `/admin`, `/check-in` and `/rooms` still resolve their
 * session via Supabase (see lib/server/auth.ts) because the Clerk identity
 * -> Alea profile/role mapping doesn't exist until #298/#299 land. Enforcing
 * `auth.protect()` on those routes today would create a redirect loop: a
 * Clerk-authenticated visitor would be sent to a page that then demands a
 * Supabase session it never had, bouncing them back to the legacy /login.
 *
 * `clerkMiddleware()` still wraps every non-API-excluded request (see
 * `config.matcher` below, which now also covers `/api`) so `auth()` /
 * `currentUser()` (lib/server/session.ts) are populated for any Route
 * Handler that opts into reading a Clerk session. It's just not enforced
 * as a blanket gate here.
 *
 * The Supabase auth-cookie refresh (`supabase.auth.getUser()`) that existed
 * before Clerk was introduced is preserved unchanged: pages/API routes still
 * depend on Supabase sessions until #298/#299 land.
 *
 * `/api` requests are intentionally routed around the next-intl rewrite and
 * the Supabase cookie refresh below (they are not locale-prefixed pages and
 * already resolve their own Supabase session per-request) — they only need
 * `clerkMiddleware()` to run so Clerk's auth context is populated.
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
