// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'

/**
 * Clerk middleware test setup
 *
 * We mock:
 * 1. @clerk/nextjs/server — clerkMiddleware, createRouteMatcher, auth
 * 2. next-intl/middleware — locale routing
 * 3. lib/server/security-edge — ensureCsrfCookie
 *
 * The test verifies:
 * - Protected routes redirect unauthenticated to /[locale]/sign-in
 * - Authenticated users pass through without redirect
 * - Locale routing still works
 * - CSRF cookie is set/preserved correctly
 */

const createI18nResponse = vi.fn((request: NextRequest) =>
  NextResponse.next(),
)

let isAuthenticated = false

vi.mock('next-intl/middleware', () => ({
  default: vi.fn(() => (request: NextRequest) => createI18nResponse(request)),
}))

vi.mock('@clerk/nextjs/server', () => ({
  clerkMiddleware: vi.fn((handler: (auth: any, request: NextRequest) => Promise<NextResponse | undefined>) => {
    return async (request: NextRequest) => {
      class RedirectError extends Error {
        constructor(public url: string) {
          super('redirect')
        }
      }

      const auth = {
        protect: async ({ unauthenticatedUrl }: { unauthenticatedUrl?: string } = {}) => {
          if (!isAuthenticated && unauthenticatedUrl) {
            throw new RedirectError(unauthenticatedUrl)
          }
        },
      }

      try {
        const result = await handler(auth, request)
        return result || NextResponse.next()
      } catch (error) {
        if (error instanceof RedirectError) {
          return NextResponse.redirect(error.url)
        }
        throw error
      }
    }
  }),
  createRouteMatcher: vi.fn((patterns: string[]) => {
    return (request: NextRequest) => {
      const pathname = request.nextUrl.pathname

      return patterns.some((pattern) => {
        // Convert Clerk pattern to regex
        // Pattern examples: '/(en|es)/reservations(.*)', '/(en|es)/admin(.*)'

        let regexStr = pattern
          // Handle (.* ) first before other ( replacements
          .replace(/\(\.\*\)/g, 'WILDCARD_MARKER')
          // Escape literal dots (if any outside of groups)
          .replace(/\./g, '\\.')
          // Make all remaining capturing groups non-capturing
          .replace(/\(/g, '(?:')
          // Replace wildcard marker with .*
          .replace(/WILDCARD_MARKER/g, '.*')
          // Escape forward slashes for regex
          .replace(/\//g, '\\/')

        const regex = new RegExp(`^${regexStr}`)
        return regex.test(pathname)
      })
    }
  }),
}))

describe('middleware', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    vi.unstubAllEnvs()
    isAuthenticated = false
  })

  it('redirects unauthenticated requests to protected routes to locale-specific sign-in', async () => {
    isAuthenticated = false
    const middleware = (await import('@/middleware')).default

    // Test /en/reservations redirect
    const response1 = await middleware(new NextRequest('http://localhost:3000/en/reservations'))
    expect(response1.status).toBe(307) // Redirect status
    const location1 = response1.headers.get('location')
    expect(location1).toContain('/en/sign-in')
    expect(location1).toContain('redirect_url=%2Fen%2Freservations')

    // Test /es/admin redirect
    const response2 = await middleware(new NextRequest('http://localhost:3000/es/admin'))
    expect(response2.status).toBe(307)
    const location2 = response2.headers.get('location')
    expect(location2).toContain('/es/sign-in')
    expect(location2).toContain('redirect_url=%2Fes%2Fadmin')

    // Test /en/rooms redirect
    const response3 = await middleware(new NextRequest('http://localhost:3000/en/rooms'))
    expect(response3.status).toBe(307)
    const location3 = response3.headers.get('location')
    expect(location3).toContain('/en/sign-in')

    // Test /es/check-in redirect
    const response4 = await middleware(new NextRequest('http://localhost:3000/es/check-in'))
    expect(response4.status).toBe(307)
    const location4 = response4.headers.get('location')
    expect(location4).toContain('/es/sign-in')
  })

  it('allows authenticated users to pass through protected routes without redirect', async () => {
    isAuthenticated = true
    const middleware = (await import('@/middleware')).default

    const response = await middleware(new NextRequest('http://localhost:3000/en/reservations'))

    // Should NOT be a redirect
    expect(response.status).not.toBe(307)
    // Should have CSRF cookie set
    const csrfCookie = response.cookies.get('alea-csrf-token')
    expect(csrfCookie?.value).toBeTruthy()
    expect(csrfCookie?.httpOnly).toBe(false)
    expect(csrfCookie?.sameSite).toBe('lax')
  })

  it('does not rewrite the CSRF cookie when a valid token already exists', async () => {
    isAuthenticated = true
    const middleware = (await import('@/middleware')).default

    const response = await middleware(new NextRequest('http://localhost:3000/en/reservations', {
      headers: {
        cookie: 'alea-csrf-token=1234567890abcdef1234567890abcdef',
      },
    }))

    // Should not set a new CSRF cookie if one already exists
    expect(response.cookies.get('alea-csrf-token')).toBeUndefined()
  })

  it('sets CSRF cookie for non-protected routes even when unauthenticated', async () => {
    isAuthenticated = false
    const middleware = (await import('@/middleware')).default

    const response = await middleware(new NextRequest('http://localhost:3000/en/public-page'))

    const csrfCookie = response.cookies.get('alea-csrf-token')
    expect(csrfCookie?.value).toBeTruthy()
    expect(csrfCookie?.httpOnly).toBe(false)
    expect(csrfCookie?.sameSite).toBe('lax')
  })

  it('uses secure cookies when COOKIE_SECURE is set to true', async () => {
    vi.stubEnv('COOKIE_SECURE', 'true')
    isAuthenticated = false
    vi.resetModules()
    const middleware = (await import('@/middleware')).default

    const response = await middleware(new NextRequest('https://app.alea.club/en/public'))

    const csrfCookie = response.cookies.get('alea-csrf-token')
    expect(csrfCookie?.secure).toBe(true)
  })

  it('preserves the locale middleware behavior', async () => {
    isAuthenticated = true
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
})
