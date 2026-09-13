// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import type { NextFetchEvent } from 'next/server'

/**
 * Clerk middleware test setup
 *
 * We mock:
 * 1. @clerk/nextjs/server — clerkMiddleware
 * 2. next-intl/middleware — locale routing
 * 3. lib/server/security-edge — ensureCsrfCookie
 *
 * The test verifies:
 * - Resource-level auth owns protection; middleware does not redirect pages
 * - Locale routing still works
 * - CSRF cookie handling is unaffected by the removal of the Supabase
 *   auth-cookie refresh (#363)
 * - /api routes run clerkMiddleware but skip the i18n rewrite
 * - The exact locale-root landing paths (`/`, `/es`, `/en`) never invoke
 *   `clerkMiddleware()` at all (#414) — that's the mechanism that removes
 *   Clerk's own auth-context overhead from the public landing page — while
 *   every other route still does. (The mock here only observes whether
 *   `clerkMiddleware()` was invoked; it doesn't model the real handshake
 *   redirect or its headers.)
 */

const createI18nResponse = vi.fn((request: NextRequest) => NextResponse.next())

// Hoisted so the mock factory below (which vi.mock hoists above these
// `const`s) can close over it.
const { clerkMiddlewareInvoked } = vi.hoisted(() => ({
  clerkMiddlewareInvoked: vi.fn(),
}))

vi.mock('next-intl/middleware', () => ({
  default: vi.fn(() => (request: NextRequest) => createI18nResponse(request)),
}))

vi.mock('@clerk/nextjs/server', () => ({
  clerkMiddleware: vi.fn((handler: (auth: () => Promise<{ userId: string | null }>, request: NextRequest) => Promise<NextResponse | undefined>) => {
    return async (request: NextRequest, event: NextFetchEvent) => {
      // Mirrors the real clerkMiddleware(handler) shape: the handler receives
      // an `auth()` accessor (not a plain object) that resolves to the
      // current session's userId. Also asserts the real middleware forwards
      // the `NextFetchEvent` it's given — real Clerk needs it at runtime,
      // and a regression that drops it (e.g. `withClerk(request)` instead
      // of `withClerk(request, event)`) is otherwise invisible here.
      clerkMiddlewareInvoked(request.nextUrl.pathname, event)
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
  })

  it('does not redirect page requests; resource-level guards own authentication', async () => {
    const middleware = (await import('@/middleware')).default

    const response = await middleware(new NextRequest('http://localhost:3000/en/reservations'))

    expect(response.status).not.toBe(307)
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
  })

  it('sets CSRF cookie for non-protected routes even when unauthenticated', async () => {
    const middleware = (await import('@/middleware')).default

    const response = await middleware(new NextRequest('http://localhost:3000/en/public-page'))

    const csrfCookie = response.cookies.get('alea-csrf-token')
    expect(csrfCookie?.value).toBeTruthy()
    expect(csrfCookie?.httpOnly).toBe(false)
    expect(csrfCookie?.sameSite).toBe('lax')
  })

  it('uses secure CSRF cookies when COOKIE_SECURE is set to true', async () => {
    vi.stubEnv('COOKIE_SECURE', 'true')
    vi.resetModules()
    const middleware = (await import('@/middleware')).default

    const response = await middleware(new NextRequest('https://app.alea.club/en/public'))

    expect(response.cookies.get('alea-csrf-token')?.secure).toBe(true)
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

  it('routes /api requests through clerkMiddleware but skips the i18n rewrite', async () => {
    const middleware = (await import('@/middleware')).default

    const response = await middleware(new NextRequest('http://localhost:3000/api/admin/health'))

    // i18n middleware should NOT have been called for /api
    expect(createI18nResponse).not.toHaveBeenCalled()
    // Route handlers enforce API authentication themselves.
    expect(response.status).toBe(200)
  })

  it.each(['/', '/es', '/en'])(
    'skips clerkMiddleware() entirely for the locale-root landing path %s (#414)',
    async (landingPath) => {
      const middleware = (await import('@/middleware')).default

      await middleware(new NextRequest(`http://localhost:3000${landingPath}`))

      expect(clerkMiddlewareInvoked).not.toHaveBeenCalled()
    },
  )

  it.each(['/', '/es'])(
    'still runs i18n routing and issues a CSRF cookie for the landing path %s',
    async (landingPath) => {
      const middleware = (await import('@/middleware')).default

      const response = await middleware(new NextRequest(`http://localhost:3000${landingPath}`))

      expect(createI18nResponse).toHaveBeenCalled()
      expect(response.cookies.get('alea-csrf-token')?.value).toBeTruthy()
    },
  )

  it.each(['/es/rooms', '/en/sign-in', '/api/admin/health'])(
    'still runs clerkMiddleware() for non-landing path %s (#414)',
    async (path) => {
      const middleware = (await import('@/middleware')).default

      const request = new NextRequest(`http://localhost:3000${path}`)
      // Only identity/reference forwarding is asserted below — a plain
      // sentinel is enough and avoids depending on Next's internal
      // `NextFetchEvent` implementation module.
      const event = {} as NextFetchEvent

      await middleware(request, event)

      expect(clerkMiddlewareInvoked).toHaveBeenCalledWith(path, event)
    },
  )
})
