// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import type { CookieOptions } from '@supabase/ssr'

/**
 * Clerk middleware test setup
 *
 * We mock:
 * 1. @clerk/nextjs/server — clerkMiddleware
 * 2. next-intl/middleware — locale routing
 * 3. @supabase/ssr — Supabase client for auth cookie refresh
 * 4. lib/server/security-edge — ensureCsrfCookie
 *
 * The test verifies:
 * - Resource-level auth owns protection; middleware does not redirect pages
 * - Supabase auth-cookie refresh runs on page requests (not /api)
 * - Locale routing still works
 * - /api routes run clerkMiddleware but skip the i18n rewrite and the
 *   Supabase refresh
 */

const createI18nResponse = vi.fn((request: NextRequest) => NextResponse.next())

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
  clerkMiddleware: vi.fn((handler: (auth: () => Promise<{ userId: string | null }>, request: NextRequest) => Promise<NextResponse | undefined>) => {
    return async (request: NextRequest) => {
      // Mirrors the real clerkMiddleware(handler) shape: the handler receives
      // an `auth()` accessor (not a plain object) that resolves to the
      // current session's userId.
      const auth = async () => ({ userId: null })

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

  it('does not redirect page requests; resource-level guards own authentication', async () => {
    const middleware = (await import('@/middleware')).default

    const response = await middleware(new NextRequest('http://localhost:3000/en/reservations'))

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

  it('preserves locale middleware behavior on a page request', async () => {
    // Make i18n mock return a specific locale
    createI18nResponse.mockImplementation((request: NextRequest) => {
      // This simulates the i18n middleware's behavior
      const response = NextResponse.next()
      response.headers.set('x-test-i18n', 'called')
      return response
    })
    const middleware = (await import('@/middleware')).default

    const response = await middleware(new NextRequest('http://localhost:3000/en/rooms'))

    expect(response.status).not.toBe(307)
    expect(response.headers.get('x-test-i18n')).toBe('called')
  })

  it('routes /api requests through clerkMiddleware but skips i18n rewrite and Supabase refresh', async () => {
    const middleware = (await import('@/middleware')).default

    const response = await middleware(new NextRequest('http://localhost:3000/api/admin/health'))

    // i18n middleware should NOT have been called for /api
    expect(createI18nResponse).not.toHaveBeenCalled()
    // Supabase client should NOT have been created for /api
    expect(createServerClientMock).not.toHaveBeenCalled()
    // Route handlers enforce API authentication themselves.
    expect(response.status).toBe(200)
  })
})
