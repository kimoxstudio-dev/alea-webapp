import createMiddleware from 'next-intl/middleware'
import { getToken } from 'next-auth/jwt'
import { type NextRequest } from 'next/server'
import { ensureCsrfCookie } from './lib/server/shared/security-edge'
import { AUTHJS_SESSION_COOKIE_NAME } from './lib/authjs/config-edge'
import { locales, defaultLocale } from './lib/i18n/config'

const handleI18nRouting = createMiddleware({
  locales,
  defaultLocale,
  localePrefix: 'always',
})

export default async function middleware(request: NextRequest) {
  const response = handleI18nRouting(request)

  // Edge-safe Auth.js (NextAuth v5) session read (KIM-433, F3b login/session
  // cutover). `getToken()` only reads and verifies the JWT cookie — no DB
  // call, so it's Edge-runtime-compatible (unlike `auth()`, which pulls in
  // the full Node config's Credentials provider — see
  // `lib/authjs/config-edge.ts`). Nothing here gates the response on the
  // result (same as the previous Supabase-based read this replaces, which
  // only called `getUser()` to trigger its own cookie refresh side effect
  // and never redirected based on the outcome) — actual route protection
  // happens per-request in route handlers via `requireAuth`/`requireAdmin`
  // (`lib/server/auth/auth.ts`). Auth.js's JWT strategy needs no such
  // refresh step here: the session is fully self-contained in the cookie.
  //
  // `cookieName` MUST match `cookies.sessionToken.name` in the full Node
  // config (`lib/authjs/config.ts`, via the shared
  // `AUTHJS_SESSION_COOKIE_NAME` in `lib/authjs/config-edge.ts`) — Auth.js
  // derives the JWT's encryption salt from that same cookie name, so any
  // divergence here would silently fail to decode every session (see
  // `lib/authjs/config-edge.ts` for the full explanation).
  await getToken({
    req: request,
    secret: process.env.AUTH_SECRET,
    cookieName: AUTHJS_SESSION_COOKIE_NAME,
  })

  return ensureCsrfCookie(request, response)
}

export const config = {
  matcher: ['/((?!api|_next|_vercel|.*\\..*).*)'],
}
