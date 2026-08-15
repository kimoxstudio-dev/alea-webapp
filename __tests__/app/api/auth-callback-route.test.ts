// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'

const exchangeCodeForSessionMock = vi.fn()

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseRouteHandlerClient: vi.fn((request: NextRequest) => ({
    supabase: {
      auth: {
        exchangeCodeForSession: exchangeCodeForSessionMock,
      },
    },
    applyCookies: (response: NextResponse) => {
      response.cookies.set('sb-access-token', 'test-session')
      return response
    },
  })),
}))

describe('GET /api/auth/callback', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    exchangeCodeForSessionMock.mockResolvedValue({ data: {}, error: null })
  })

  it('sanitizes callback redirects and exchanges the PKCE code when present', async () => {
    const { GET } = await import('@/app/api/auth/callback/route')

    // Test 1: With code - should exchange and redirect to sanitized next URL
    const withCode = await GET(
      new NextRequest('http://localhost:3000/api/auth/callback?code=pkce-code&next=%2Frooms'),
    )
    expect(exchangeCodeForSessionMock).toHaveBeenCalledWith('pkce-code')
    expect(withCode.headers.get('location')).toBe('http://localhost:3000/rooms')
    expect(withCode.cookies.get('sb-access-token')?.value).toBe('test-session')

    // Test 2: Without code - should redirect to sanitized next URL
    const accepted = await GET(
      new NextRequest('http://localhost:3000/api/auth/callback?next=%2Frooms'),
    )
    expect(accepted.headers.get('location')).toBe('http://localhost:3000/rooms')

    // Test 3: With absolute URL - should reject open redirect and fallback to home
    const rejected = await GET(
      new NextRequest('http://localhost:3000/api/auth/callback?next=https://evil.example'),
    )
    expect(rejected.headers.get('location')).toBe('http://localhost:3000/')

    // Test 4: With control character in URL - should reject and fallback to home
    const sanitized = await GET(
      new NextRequest('http://localhost:3000/api/auth/callback?next=%2Frooms%0Aevil'),
    )
    expect(sanitized.headers.get('location')).toBe('http://localhost:3000/')

    // Test 5: With bare slash - should accept and redirect to home
    const bareSlash = await GET(
      new NextRequest('http://localhost:3000/api/auth/callback?next=%2F'),
    )
    expect(bareSlash.headers.get('location')).toBe('http://localhost:3000/')
  })

  it('redirects to a safe error page when the PKCE code exchange fails', async () => {
    const { GET } = await import('@/app/api/auth/callback/route')
    exchangeCodeForSessionMock.mockResolvedValueOnce({
      data: { session: null, user: null },
      error: { message: 'Invalid auth code' },
    })

    const response = await GET(
      new NextRequest('http://localhost:3000/api/auth/callback?code=expired-code&next=%2Frooms'),
    )

    expect(response.status).toBe(307)
    expect(response.headers.get('location')).toBe('http://localhost:3000/?authError=callback')
    expect(response.cookies.get('sb-access-token')?.value).toBe('test-session')
  })

  it('redirects to a safe error page when the PKCE exchange throws unexpectedly', async () => {
    const { GET } = await import('@/app/api/auth/callback/route')
    exchangeCodeForSessionMock.mockRejectedValueOnce(new Error('network broke'))

    const response = await GET(
      new NextRequest('http://localhost:3000/api/auth/callback?code=broken-code&next=%2Frooms'),
    )

    expect(response.status).toBe(307)
    expect(response.headers.get('location')).toBe('http://localhost:3000/?authError=callback')
    expect(response.cookies.get('sb-access-token')?.value).toBe('test-session')
  })
})
