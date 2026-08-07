import createMiddleware from 'next-intl/middleware'
import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server'
import type { NextRequest } from 'next/server'
import { ensureCsrfCookie } from './lib/server/security-edge'
import { locales, defaultLocale } from './lib/i18n/config'

const handleI18nRouting = createMiddleware({
  locales,
  defaultLocale,
  localePrefix: 'always',
})

/**
 * Routes that require an authenticated Clerk session.
 * Mirrors the locale-prefixed pages that already redirect unauthenticated
 * visitors to /login via server-side checks (lib/server/auth.ts).
 */
const isProtectedRoute = createRouteMatcher([
  '/(en|es)/reservations(.*)',
  '/(en|es)/admin(.*)',
  '/(en|es)/check-in(.*)',
  '/(en|es)/rooms(.*)',
])

function localeFromPathname(pathname: string): (typeof locales)[number] {
  const candidate = pathname.match(/^\/([a-z]{2})(?:\/|$)/)?.[1]
  return (locales as readonly string[]).includes(candidate ?? '')
    ? (candidate as (typeof locales)[number])
    : defaultLocale
}

export default clerkMiddleware(async (auth, request: NextRequest) => {
  if (isProtectedRoute(request)) {
    const locale = localeFromPathname(request.nextUrl.pathname)
    const signInUrl = new URL(`/${locale}/sign-in`, request.url)
    signInUrl.searchParams.set('redirect_url', `${request.nextUrl.pathname}${request.nextUrl.search}`)
    await auth.protect({ unauthenticatedUrl: signInUrl.toString() })
  }

  const response = handleI18nRouting(request)
  return ensureCsrfCookie(request, response)
})

export const config = {
  matcher: ['/((?!api|_next|_vercel|.*\\..*).*)'],
}
