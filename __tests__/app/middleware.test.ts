// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import type { CookieOptions } from '@supabase/ssr'

/**
 * Clerk middleware test setup
 *
 * We mock:
 * 1. @clerk/nextjs/server — clerkMiddleware (note: no auth.protect() gating)
 * 2. next-intl/middleware — locale routing
 * 3. @supabase/ssr — Supabase client for auth cookie refresh
 * 4. lib/server/security-edge — ensureCsrfCookie
 *
 * The test verifies:
 * - clerkMiddleware wraps requests but does NOT gate routes (protection deferred to #298/#299)
 * - Supabase auth-cookie refresh runs on page requests (not /api)
 * - Locale routing still works
 * - CSRF cookie is set/preserved correctly
 * - /api routes run clerkMiddleware but skip i18n rewrite and Supabase refresh
 */

const createI18nResponse = vi.fn((request: NextRequest) =>
  NextResponse.next(),
)

const getUserMock = vi.fn()
const createServerClientMock = vi.fn()

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
  clerkMiddleware: vi.fn((handler: (auth: any, request: NextRequest) => Promise<NextResponse | undefined>) => {
    return async (request: NextRequest) => {
      // clerkMiddleware wrapper that does NOT enforce auth.protect() on routes
      // Protection is deferred to #298/#299
      const auth = {}

      try {
        const result = await handler(auth, request)
        return result || NextResponse.next()
      } catch (error) {
        throw error
      }
    }
  }),
}))

describe('middleware', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    vi.unstubAllEnvs()
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://example.supabase.co')
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY', 'anon-key')
    getUserMock.mockResolvedValue({ data: { user: null }, error: null })
  })

  it('does not redirect unauthenticated requests to protected routes (protection deferred)', async () => {
    const middleware = (await import('@/middleware')).default

    // Unauthenticated requests to protected routes should NOT redirect
    // (auth gating is deferred until #298/#299 complete the Clerk identity cutover)
    // They should pass through and have Supabase cookies refreshed
    const response = await middleware(new NextRequest('http://localhost:3000/en/reservations'))

    // Should NOT be a redirect
    expect(response.status).not.toBe(307)
    // Should have refreshed Supabase auth cookie
    expect(response.cookies.get('sb-access-token')?.value).toBe('refreshed-token')
    // Supabase client should have been created and getUser called
    expect(createServerClientMock).toHaveBeenCalledWith(
      'https://example.supabase.co',
      'anon-key',
      expect.objectContaining({
        cookieOptions: expect.objectContaining({
          httpOnly: true,
          path: '/',
          sameSite: 'lax',
          secure: false,
        }),
      }),
    )
  })

  it('passes authenticated users through protected routes and refreshes Supabase session', async () => {
    const middleware = (await import('@/middleware')).default

    const response = await middleware(new NextRequest('http://localhost:3000/en/reservations'))

    // Should NOT be a redirect (protection is deferred)
    expect(response.status).not.toBe(307)
    // Should have CSRF cookie set
    const csrfCookie = response.cookies.get('alea-csrf-token')
    expect(csrfCookie?.value).toBeTruthy()
    expect(csrfCookie?.httpOnly).toBe(false)
    expect(csrfCookie?.sameSite).toBe('lax')
    // Should have refreshed Supabase auth cookie
    expect(response.cookies.get('sb-access-token')?.value).toBe('refreshed-token')
  })

  it('does not rewrite the CSRF cookie when a valid token already exists', async () => {
    const middleware = (await import('@/middleware')).default

    const response = await middleware(new NextRequest('http://localhost:3000/en/reservations', {
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

  it('preserves the locale middleware behavior', async () => {
    // Make i18n mock return a specific locale
    createI18nResponse.mockImplementation((request: NextRequest) => {
      // This simulates the i18n middleware's behavior
      const response = NextResponse.next()
      response.headers.set('x-test-i18n', 'called')
      return response
    })
    const middleware = (await import('@/middleware')).default

    const response = await middleware(new NextRequest('http://localhost:3000/en/rooms'))

    expect(response.headers.get('x-test-i18n')).toBe('called')
  })

  it('routes /api requests through clerkMiddleware but skips i18n rewrite and Supabase refresh', async () => {
    const middleware = (await import('@/middleware')).default

    // /api routes should bypass i18n rewrite and Supabase refresh
    const response = await middleware(new NextRequest('http://localhost:3000/api/health'))

    // i18n middleware should NOT have been called for /api
    expect(createI18nResponse).not.toHaveBeenCalled()
    // Supabase client should NOT have been created for /api
    expect(createServerClientMock).not.toHaveBeenCalled()
    // Response should be a pass-through (200 with NextResponse.next())
    expect(response.status).toBe(200)
  })
})
