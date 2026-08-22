// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import type { CookieOptions } from '@supabase/ssr'
import { defaultLocale } from '@/lib/i18n/config'

/**
 * Clerk middleware test setup
 *
 * We mock:
 * 1. @clerk/nextjs/server — clerkMiddleware + createRouteMatcher (#330 deny-by-default gate)
 * 2. next-intl/middleware — locale routing
 * 3. @supabase/ssr — Supabase client for auth cookie refresh
 * 4. lib/server/security-edge — ensureCsrfCookie
 *
 * The test verifies:
 * - createRouteMatcher-driven deny-by-default gate: unauthenticated requests to
 *   /admin, /reservations, /check-in, /rooms (all locale variants) redirect to
 *   /{locale}/sign-in?redirect_url=<original path+query>
 * - Authenticated requests (present userId) pass through protected routes
 * - Routes outside the protected set are unaffected regardless of auth state
 * - The CSRF cookie (ensureCsrfCookie) is still set on the redirect response
 * - Supabase auth-cookie refresh runs on page requests (not /api)
 * - Locale routing still works
 * - /api routes run clerkMiddleware but skip i18n rewrite, the protected-route
 *   gate, and the Supabase refresh
 */

const createI18nResponse = vi.fn((request: NextRequest) => NextResponse.next())

const getUserMock = vi.fn()
const createServerClientMock = vi.fn()

// Mutable holder so individual tests can flip the simulated Clerk session
// without needing to re-mock the module.
const authState: { userId: string | null } = { userId: null }

vi.mock('next-intl/middleware', () => ({
  default: vi.fn(() => (request: NextRequest) => createI18nResponse(request)),
}))

vi.mock('@supabase/ssr', () => ({
  createServerClient: createServerClientMock.mockImplementation((_url: string, _key: string, options: {
    cookieOptions?: CookieOptions & { name?: string }
    cookies: {
      setAll: (cookiesToSet: { name: string; value: string; options: CookieOptions }[]) => void
    }
  }) => ({
    auth: {
      getUser: vi.fn(async () => {
        options.cookies.setAll([
          {
            name: 'sb-access-token',
            value: 'refreshed-token',
            options: { path: '/', httpOnly: true, sameSite: 'lax' },
          },
        ])

        return getUserMock()
      }),
    },
  })),
}))

vi.mock('@clerk/nextjs/server', () => ({
  clerkMiddleware: vi.fn((handler: (auth: () => Promise<{ userId: string | null }>, request: NextRequest) => Promise<NextResponse | undefined>) => {
    return async (request: NextRequest) => {
      // Mirrors the real clerkMiddleware(handler) shape: the handler receives
      // an `auth()` accessor (not a plain object) that resolves to the
      // current session's userId.
      const auth = async () => ({ userId: authState.userId })

      try {
        const result = await handler(auth, request)
        return result || NextResponse.next()
      } catch (error) {
        throw error
      }
    }
  }),
  // Mirrors createRouteMatcher's real contract: takes an array of
  // path-to-regexp-style patterns (the real middleware.ts patterns already
  // use plain `(.*)` capture groups, which are valid regex source as-is) and
  // returns a matcher function tested against the request pathname. The `i`
  // flag mirrors Clerk's real createRouteMatcher, which compiles
  // case-insensitive regexes (see the `localeFromPathname` doc comment in
  // middleware.ts, #330 round 2 finding 2) — without it, a case-variant
  // locale segment (e.g. `/EN/admin`) would never reach the matcher's
  // fallback branch under test, silently hiding that scenario.
  createRouteMatcher: vi.fn((patterns: string[]) => {
    const regexes = patterns.map((pattern) => new RegExp(`^${pattern}$`, 'i'))
    return (request: NextRequest) => regexes.some((regex) => regex.test(request.nextUrl.pathname))
  }),
}))

const PROTECTED_SEGMENTS = ['admin', 'reservations', 'check-in', 'rooms'] as const
const LOCALES = ['en', 'es'] as const

describe('middleware', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    vi.unstubAllEnvs()
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://example.supabase.co')
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY', 'anon-key')
    getUserMock.mockResolvedValue({ data: { user: null }, error: null })
    authState.userId = null
  })

  describe('deny-by-default protected routes (#330)', () => {
    it.each(
      LOCALES.flatMap((locale) => PROTECTED_SEGMENTS.map((segment) => [locale, segment] as const)),
    )('redirects unauthenticated requests to /%s/%s to the localized sign-in page', async (locale, segment) => {
      const middleware = (await import('@/middleware')).default

      const response = await middleware(new NextRequest(`http://localhost:3000/${locale}/${segment}`))

      expect(response.status).toBe(307)
      const location = response.headers.get('location')
      expect(location).not.toBeNull()
      const redirectUrl = new URL(location!)
      expect(redirectUrl.pathname).toBe(`/${locale}/sign-in`)
      expect(redirectUrl.searchParams.get('redirect_url')).toBe(`/${locale}/${segment}`)
    })

    it('preserves the query string in redirect_url', async () => {
      const middleware = (await import('@/middleware')).default

      const response = await middleware(
        new NextRequest('http://localhost:3000/en/reservations?date=2026-08-22&court=1'),
      )

      expect(response.status).toBe(307)
      const redirectUrl = new URL(response.headers.get('location')!)
      expect(redirectUrl.searchParams.get('redirect_url')).toBe(
        '/en/reservations?date=2026-08-22&court=1',
      )
    })

    it('matches nested sub-paths under a protected segment', async () => {
      const middleware = (await import('@/middleware')).default

      const response = await middleware(
        new NextRequest('http://localhost:3000/es/admin/members/42'),
      )

      expect(response.status).toBe(307)
      const redirectUrl = new URL(response.headers.get('location')!)
      expect(redirectUrl.pathname).toBe('/es/sign-in')
      expect(redirectUrl.searchParams.get('redirect_url')).toBe('/es/admin/members/42')
    })

    it('sets the CSRF cookie on the redirect response itself', async () => {
      const middleware = (await import('@/middleware')).default

      const response = await middleware(new NextRequest('http://localhost:3000/en/admin'))

      expect(response.status).toBe(307)
      const csrfCookie = response.cookies.get('alea-csrf-token')
      expect(csrfCookie?.value).toBeTruthy()
      expect(csrfCookie?.httpOnly).toBe(false)
      expect(csrfCookie?.sameSite).toBe('lax')
    })

    it('does not run the Supabase refresh or i18n rewrite when redirecting unauthenticated traffic', async () => {
      const middleware = (await import('@/middleware')).default

      const response = await middleware(new NextRequest('http://localhost:3000/en/rooms'))

      expect(response.status).toBe(307)
      expect(createI18nResponse).not.toHaveBeenCalled()
      expect(createServerClientMock).not.toHaveBeenCalled()
    })

    it.each(LOCALES)('passes authenticated users through protected routes (%s) and refreshes the Supabase session', async (locale) => {
      authState.userId = 'user_123'
      const middleware = (await import('@/middleware')).default

      const response = await middleware(new NextRequest(`http://localhost:3000/${locale}/reservations`))

      expect(response.status).not.toBe(307)
      const csrfCookie = response.cookies.get('alea-csrf-token')
      expect(csrfCookie?.value).toBeTruthy()
      expect(response.cookies.get('sb-access-token')?.value).toBe('refreshed-token')
      expect(createServerClientMock).toHaveBeenCalled()
    })
  })

  describe('anchored route matching rejects look-alike prefixes (#330 round 2, finding 1)', () => {
    // PR #339 anchored the protected-route patterns as
    // `/${locale}/${segment}(/.*)?` instead of the old unanchored
    // `/${locale}/${segment}.*` style. A look-alike path that merely starts
    // with a protected segment name (no separating `/` before the rest of
    // the path) must NOT be treated as protected — only an anchored regex
    // correctly excludes it.
    it.each(
      LOCALES.flatMap((locale) =>
        PROTECTED_SEGMENTS.map((segment) => [locale, `${segment}XYZ`] as const),
      ),
    )('does not gate the look-alike path /%s/%s as a protected route', async (locale, lookalike) => {
      const middleware = (await import('@/middleware')).default

      const response = await middleware(
        new NextRequest(`http://localhost:3000/${locale}/${lookalike}`),
      )

      expect(response.status).not.toBe(307)
      // Confirms the request fell through to normal (non-gated) handling
      // rather than merely happening to avoid a redirect for some other
      // reason.
      expect(createServerClientMock).toHaveBeenCalled()
    })
  })

  describe('case-variant locale segment safely falls back (#330 round 2, finding 2)', () => {
    // Clerk's createRouteMatcher compiles case-insensitive regexes, so a
    // case-variant locale segment (e.g. `/EN/admin`) still matches
    // isProtectedRoute. localeFromPathname's lowercase-only `.includes()`
    // check does not match it though, so it falls back to defaultLocale.
    // That fallback must stay safe: it should still force the sign-in
    // redirect (deny access), never grant it.
    it('still redirects a case-variant locale segment to sign-in, falling back to the default locale', async () => {
      const middleware = (await import('@/middleware')).default

      const response = await middleware(new NextRequest('http://localhost:3000/EN/admin'))

      expect(response.status).toBe(307)
      const redirectUrl = new URL(response.headers.get('location')!)
      expect(redirectUrl.pathname).toBe(`/${defaultLocale}/sign-in`)
      expect(redirectUrl.searchParams.get('redirect_url')).toBe('/EN/admin')
    })
  })

  it('does not redirect unauthenticated requests to routes outside the protected set', async () => {
    const middleware = (await import('@/middleware')).default

    const response = await middleware(new NextRequest('http://localhost:3000/en/public-page'))

    expect(response.status).not.toBe(307)
    expect(response.cookies.get('sb-access-token')?.value).toBe('refreshed-token')
  })

  it('does not rewrite the CSRF cookie when a valid token already exists', async () => {
    const middleware = (await import('@/middleware')).default

    const response = await middleware(new NextRequest('http://localhost:3000/en/public-page', {
      headers: {
        cookie: 'alea-csrf-token=1234567890abcdef1234567890abcdef',
      },
    }))

    // Should not set a new CSRF cookie if one already exists
    expect(response.cookies.get('alea-csrf-token')).toBeUndefined()
    // Supabase refresh should still run
    expect(response.cookies.get('sb-access-token')?.value).toBe('refreshed-token')
  })

  it('sets CSRF cookie for non-protected routes even when unauthenticated', async () => {
    const middleware = (await import('@/middleware')).default

    const response = await middleware(new NextRequest('http://localhost:3000/en/public-page'))

    const csrfCookie = response.cookies.get('alea-csrf-token')
    expect(csrfCookie?.value).toBeTruthy()
    expect(csrfCookie?.httpOnly).toBe(false)
    expect(csrfCookie?.sameSite).toBe('lax')
    // Supabase refresh should still run on all page routes
    expect(response.cookies.get('sb-access-token')?.value).toBe('refreshed-token')
  })

  it('uses secure cookies when COOKIE_SECURE is set to true', async () => {
    vi.stubEnv('COOKIE_SECURE', 'true')
    vi.resetModules()
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://example.supabase.co')
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY', 'anon-key')
    const middleware = (await import('@/middleware')).default

    await middleware(new NextRequest('https://app.alea.club/en/public'))

    // Supabase client should be called with secure: true
    expect(createServerClientMock).toHaveBeenCalledWith(
      'https://example.supabase.co',
      'anon-key',
      expect.objectContaining({
        cookieOptions: expect.objectContaining({
          httpOnly: true,
          path: '/',
          sameSite: 'lax',
          secure: true,
        }),
      }),
    )
  })

  it('preserves the locale middleware behavior on an authenticated protected route', async () => {
    // Make i18n mock return a specific locale
    createI18nResponse.mockImplementation((request: NextRequest) => {
      // This simulates the i18n middleware's behavior
      const response = NextResponse.next()
      response.headers.set('x-test-i18n', 'called')
      return response
    })
    authState.userId = 'user_123'
    const middleware = (await import('@/middleware')).default

    const response = await middleware(new NextRequest('http://localhost:3000/en/rooms'))

    expect(response.status).not.toBe(307)
    expect(response.headers.get('x-test-i18n')).toBe('called')
  })

  it('routes /api requests through clerkMiddleware but skips i18n rewrite, the protected-route gate, and the Supabase refresh', async () => {
    const middleware = (await import('@/middleware')).default

    // /api/admin would match the protected-route matcher's pathname shape if
    // the /api early-return did not run first — this confirms it does.
    const response = await middleware(new NextRequest('http://localhost:3000/api/admin/health'))

    // i18n middleware should NOT have been called for /api
    expect(createI18nResponse).not.toHaveBeenCalled()
    // Supabase client should NOT have been created for /api
    expect(createServerClientMock).not.toHaveBeenCalled()
    // Response should be a pass-through (200 with NextResponse.next()), not a
    // sign-in redirect, even though this is an unauthenticated request and
    // even though the path resembles a protected segment.
    expect(response.status).toBe(200)
  })
})
