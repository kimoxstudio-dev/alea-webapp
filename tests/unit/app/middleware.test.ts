// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'

const createI18nResponse = vi.fn((request: NextRequest) =>
  NextResponse.redirect(new URL('/es', request.url)),
)

vi.mock('next-intl/middleware', () => ({
  default: vi.fn(() => (request: NextRequest) => createI18nResponse(request)),
}))

vi.mock('@clerk/nextjs/server', () => ({
  clerkMiddleware: vi.fn((handler: (auth: unknown, request: NextRequest) => Response | Promise<Response>) =>
    (request: NextRequest) => handler({}, request)),
}))

describe('middleware', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
  })

  it('preserves the locale middleware response while setting a CSRF cookie', async () => {
    const middleware = (await import('@/middleware')).default

    const response = await middleware(new NextRequest('http://localhost:3000/rooms'))

    expect(response.headers.get('location')).toBe('http://localhost:3000/es')
    const csrfCookie = response.cookies.get('alea-csrf-token')
    expect(csrfCookie?.value).toBeTruthy()
    expect(csrfCookie?.httpOnly).toBe(false)
    expect(csrfCookie?.sameSite).toBe('lax')
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

  it('sets the CSRF cookie for matched api requests too', async () => {
    const middleware = (await import('@/middleware')).default

    const response = await middleware(new NextRequest('http://localhost:3000/api/auth/me'))

    expect(response.cookies.get('alea-csrf-token')?.value).toBeTruthy()
  })
})
