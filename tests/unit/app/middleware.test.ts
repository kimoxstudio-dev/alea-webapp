// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'

const createI18nResponse = vi.fn((request: NextRequest) =>
  NextResponse.redirect(new URL('/es', request.url)),
)
const getTokenMock = vi.fn()

vi.mock('next-intl/middleware', () => ({
  default: vi.fn(() => (request: NextRequest) => createI18nResponse(request)),
}))

vi.mock('next-auth/jwt', () => ({
  getToken: getTokenMock,
}))

vi.mock('@/lib/authjs/config-edge', () => ({
  AUTHJS_SESSION_COOKIE_NAME: 'authjs.session-token',
}))

describe('middleware', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    vi.unstubAllEnvs()
    vi.stubEnv('AUTH_SECRET', 'test-secret')
    getTokenMock.mockResolvedValue(null)
  })

  it('preserves the locale middleware response while reading Auth.js JWT session', async () => {
    const middleware = (await import('@/middleware')).default

    const response = await middleware(new NextRequest('http://localhost:3000/rooms'))

    expect(response.headers.get('location')).toBe('http://localhost:3000/es')
    const csrfCookie = response.cookies.get('alea-csrf-token')
    expect(csrfCookie?.value).toBeTruthy()
    expect(csrfCookie?.httpOnly).toBe(false)
    expect(csrfCookie?.sameSite).toBe('lax')
    expect(getTokenMock).toHaveBeenCalledWith(
      expect.objectContaining({
        req: expect.any(NextRequest),
        secret: 'test-secret',
        cookieName: 'authjs.session-token',
      }),
    )
  })

  it('does not rewrite the CSRF cookie when a valid token already exists', async () => {
    const middleware = (await import('@/middleware')).default

    const response = await middleware(new NextRequest('http://localhost:3000/rooms', {
      headers: {
        cookie: 'alea-csrf-token=1234567890abcdef1234567890abcdef',
      },
    }))

    expect(response.cookies.get('alea-csrf-token')).toBeUndefined()
  })

  it('reads Auth.js session token with correct configuration when AUTH_SECRET is set', async () => {
    vi.stubEnv('AUTH_SECRET', 'custom-secret')
    const middleware = (await import('@/middleware')).default

    await middleware(new NextRequest('https://app.alea.club/rooms'))

    expect(getTokenMock).toHaveBeenCalledWith(
      expect.objectContaining({
        req: expect.any(NextRequest),
        secret: 'custom-secret',
        cookieName: 'authjs.session-token',
      }),
    )
  })
})
