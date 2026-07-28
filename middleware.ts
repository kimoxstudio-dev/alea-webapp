import createMiddleware from 'next-intl/middleware'
import { type NextRequest } from 'next/server'
import { ensureCsrfCookie } from './lib/server/shared/security-edge'
import { locales, defaultLocale } from './lib/i18n/config'

const handleI18nRouting = createMiddleware({
  locales,
  defaultLocale,
  localePrefix: 'always',
})

export default async function middleware(request: NextRequest) {
  const response = handleI18nRouting(request)

  // No Auth.js session read happens here (KIM-433 follow-up): a prior
  // `getToken()` call was added for the F3b cutover but its result was
  // never used for anything (no redirect, no gating), so it was dead code
  // — actual route protection happens per-request in route handlers via
  // `requireAuth`/`requireAdmin` (`lib/server/auth/auth.ts`), not here.

  return ensureCsrfCookie(request, response)
}

export const config = {
  matcher: ['/((?!api|_next|_vercel|.*\\..*).*)'],
}
