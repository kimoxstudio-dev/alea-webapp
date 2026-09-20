// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

describe('server security helpers', () => {
  beforeEach(async () => {
    vi.resetModules()
    vi.unstubAllEnvs()
    const { resetRateLimitStoreForTests } = await import('@/lib/server/security')
    resetRateLimitStoreForTests()
  })

  it('uses secure:false when COOKIE_SECURE is explicitly set to false', async () => {
    vi.stubEnv('COOKIE_SECURE', 'false')
    const security = await import('@/lib/server/security')

    expect(security.getCsrfCookieOptions()).toMatchObject({
      httpOnly: false,
      sameSite: 'lax',
      secure: false,
      path: '/',
    })
  })

  it('uses secure:true when COOKIE_SECURE is explicitly set to true', async () => {
    vi.stubEnv('COOKIE_SECURE', 'true')
    const security = await import('@/lib/server/security')

    expect(security.getCsrfCookieOptions()).toMatchObject({
      httpOnly: false,
      sameSite: 'lax',
      secure: true,
      path: '/',
    })
  })

  it('uses secure:true when COOKIE_SECURE is unset and NODE_ENV is production', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('COOKIE_SECURE', undefined)
    const security = await import('@/lib/server/security')

    expect(security.getCsrfCookieOptions()).toMatchObject({
      httpOnly: false,
      sameSite: 'lax',
      secure: true,
      path: '/',
    })
  })

  it('uses secure:false when COOKIE_SECURE is unset and NODE_ENV is not production', async () => {
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('COOKIE_SECURE', undefined)
    const security = await import('@/lib/server/security')

    expect(security.getCsrfCookieOptions()).toMatchObject({
      httpOnly: false,
      sameSite: 'lax',
      secure: false,
      path: '/',
    })
  })

  it('returns 429 when a client exceeds the configured rate limit window', async () => {
    vi.stubEnv('TRUST_PROXY_HEADERS', 'true')
    vi.stubEnv('TRUSTED_PROXY_CIDRS', '127.0.0.1/32')
    const { enforceRateLimit } = await import('@/lib/server/security')
    const policy = { bucket: 'test-rate-limit', limit: 2, windowMs: 60_000 }

    const first = await enforceRateLimit(
      new NextRequest('http://localhost:3000/api/auth/login', {
        method: 'POST',
        headers: {
          'x-forwarded-for': '203.0.113.77',
          'x-real-ip': '127.0.0.1',
        },
      }),
      policy,
    )
    const second = await enforceRateLimit(
      new NextRequest('http://localhost:3000/api/auth/login', {
        method: 'POST',
        headers: {
          'x-forwarded-for': '203.0.113.77',
          'x-real-ip': '127.0.0.1',
        },
      }),
      policy,
    )
    const third = await enforceRateLimit(
      new NextRequest('http://localhost:3000/api/auth/login', {
        method: 'POST',
        headers: {
          'x-forwarded-for': '203.0.113.77',
          'x-real-ip': '127.0.0.1',
        },
      }),
      policy,
    )

    expect(first).toBeNull()
    expect(second).toBeNull()
    expect(third?.status).toBe(429)
    expect(third?.headers.get('retry-after')).toBeTruthy()
  })

  it('trusts x-forwarded-for only when the request comes through a trusted proxy IP', async () => {
    vi.stubEnv('TRUST_PROXY_HEADERS', 'true')
    vi.stubEnv('TRUSTED_PROXY_CIDRS', '127.0.0.1/32')
    const { enforceRateLimit } = await import('@/lib/server/security')
    const policy = { bucket: 'test-trusted-forwarded-for', limit: 1, windowMs: 60_000 }

    const first = await enforceRateLimit(
      new NextRequest('http://localhost:3000/api/auth/login', {
        method: 'POST',
        headers: {
          'x-forwarded-for': '203.0.113.10',
          'x-real-ip': '127.0.0.1',
        },
      }),
      policy,
    )
    const second = await enforceRateLimit(
      new NextRequest('http://localhost:3000/api/auth/login', {
        method: 'POST',
        headers: {
          'x-forwarded-for': '203.0.113.11',
          'x-real-ip': '127.0.0.1',
        },
      }),
      policy,
    )

    expect(first).toBeNull()
    expect(second).toBeNull()
  })

  it('ignores spoofed x-forwarded-for headers from untrusted clients', async () => {
    vi.stubEnv('TRUST_PROXY_HEADERS', 'true')
    vi.stubEnv('TRUSTED_PROXY_CIDRS', '127.0.0.1/32')
    const { enforceRateLimit } = await import('@/lib/server/security')
    const policy = { bucket: 'test-untrusted-forwarded-for', limit: 1, windowMs: 60_000 }

    const first = await enforceRateLimit(
      new NextRequest('http://localhost:3000/api/auth/login', {
        method: 'POST',
        headers: {
          'x-forwarded-for': '203.0.113.10',
          'x-real-ip': '198.51.100.25',
        },
      }),
      policy,
    )
    const second = await enforceRateLimit(
      new NextRequest('http://localhost:3000/api/auth/login', {
        method: 'POST',
        headers: {
          'x-forwarded-for': '203.0.113.11',
          'x-real-ip': '198.51.100.25',
        },
      }),
      policy,
    )

    expect(first).toBeNull()
    expect(second?.status).toBe(429)
  })

  it('falls back to local when forwarded headers are present without a trusted source IP', async () => {
    const { enforceRateLimit } = await import('@/lib/server/security')
    const policy = { bucket: 'test-missing-real-ip', limit: 1, windowMs: 60_000 }

    const first = await enforceRateLimit(
      new NextRequest('http://localhost:3000/api/auth/login', {
        method: 'POST',
        headers: {
          'x-forwarded-for': '203.0.113.40',
        },
      }),
      policy,
    )
    const second = await enforceRateLimit(
      new NextRequest('http://localhost:3000/api/auth/login', {
        method: 'POST',
        headers: {
          'x-forwarded-for': '203.0.113.41',
        },
      }),
      policy,
    )

    expect(first).toBeNull()
    expect(second?.status).toBe(429)
  })

  it('does not trust platform-style headers on their own', async () => {
    vi.stubEnv('TRUST_PROXY_HEADERS', 'true')
    vi.stubEnv('TRUSTED_PROXY_CIDRS', '127.0.0.1/32')
    const { enforceRateLimit } = await import('@/lib/server/security')
    const policy = { bucket: 'test-forged-platform-header', limit: 1, windowMs: 60_000 }

    const first = await enforceRateLimit(
      new NextRequest('http://localhost:3000/api/auth/login', {
        method: 'POST',
        headers: {
          'x-forwarded-for': '203.0.113.20',
          'x-real-ip': '198.51.100.30',
          'x-vercel-id': 'cdg1::iad1::test',
        },
      }),
      policy,
    )
    const second = await enforceRateLimit(
      new NextRequest('http://localhost:3000/api/auth/login', {
        method: 'POST',
        headers: {
          'x-forwarded-for': '203.0.113.21',
          'x-real-ip': '198.51.100.30',
          'x-vercel-id': 'cdg1::iad1::test',
        },
      }),
      policy,
    )

    expect(first).toBeNull()
    expect(second?.status).toBe(429)
  })

  it('rejects malformed IPv6 proxy source values when deciding whether to trust x-forwarded-for', async () => {
    vi.stubEnv('TRUST_PROXY_HEADERS', 'true')
    vi.stubEnv('TRUSTED_PROXY_CIDRS', '::1/128')
    const { enforceRateLimit } = await import('@/lib/server/security')
    const policy = { bucket: 'test-invalid-ipv6-source', limit: 1, windowMs: 60_000 }

    const first = await enforceRateLimit(
      new NextRequest('http://localhost:3000/api/auth/login', {
        method: 'POST',
        headers: {
          'x-forwarded-for': '203.0.113.60',
          'x-real-ip': '2001::db8::1',
        },
      }),
      policy,
    )
    const second = await enforceRateLimit(
      new NextRequest('http://localhost:3000/api/auth/login', {
        method: 'POST',
        headers: {
          'x-forwarded-for': '203.0.113.61',
          'x-real-ip': '2001::db8::1',
        },
      }),
      policy,
    )

    expect(first).toBeNull()
    expect(second?.status).toBe(429)
  })

  it('rejects malformed non-compressed IPv6 values with empty segments', async () => {
    vi.stubEnv('TRUST_PROXY_HEADERS', 'true')
    vi.stubEnv('TRUSTED_PROXY_CIDRS', '::1/128')
    const { enforceRateLimit } = await import('@/lib/server/security')
    const policy = { bucket: 'test-invalid-ipv6-empty-segment', limit: 1, windowMs: 60_000 }

    const first = await enforceRateLimit(
      new NextRequest('http://localhost:3000/api/auth/login', {
        method: 'POST',
        headers: {
          'x-forwarded-for': '203.0.113.70',
          'x-real-ip': ':1:2:3:4:5:6:7:8',
        },
      }),
      policy,
    )
    const second = await enforceRateLimit(
      new NextRequest('http://localhost:3000/api/auth/login', {
        method: 'POST',
        headers: {
          'x-forwarded-for': '203.0.113.71',
          'x-real-ip': ':1:2:3:4:5:6:7:8',
        },
      }),
      policy,
    )

    expect(first).toBeNull()
    expect(second?.status).toBe(429)
  })

  it('does not trust x-forwarded-for unless proxy header trust is explicitly enabled', async () => {
    // Explicitly disabled (not just "not stubbed") because the ambient shell/
    // .env.local environment may set TRUST_PROXY_HEADERS=true for local dev —
    // vi.unstubAllEnvs() in beforeEach restores that ambient value, it does not
    // clear it. This test's entire premise is TRUST_PROXY_HEADERS being off, so
    // it must pin that explicitly rather than relying on it being unset.
    vi.stubEnv('TRUST_PROXY_HEADERS', 'false')
    vi.stubEnv('TRUSTED_PROXY_CIDRS', '127.0.0.1/32')
    const { enforceRateLimit } = await import('@/lib/server/security')
    const policy = { bucket: 'test-proxy-trust-disabled', limit: 1, windowMs: 60_000 }

    const first = await enforceRateLimit(
      new NextRequest('http://localhost:3000/api/auth/login', {
        method: 'POST',
        headers: {
          'x-forwarded-for': '203.0.113.80',
          'x-real-ip': '127.0.0.1',
        },
      }),
      policy,
    )
    const second = await enforceRateLimit(
      new NextRequest('http://localhost:3000/api/auth/login', {
        method: 'POST',
        headers: {
          'x-forwarded-for': '203.0.113.81',
          'x-real-ip': '127.0.0.1',
        },
      }),
      policy,
    )

    expect(first).toBeNull()
    expect(second?.status).toBe(429)
  })

  it('enforces auth activation limits in production without a shared store', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    const { enforceRateLimit, RATE_LIMIT_POLICIES } = await import('@/lib/server/security')
    const request = () =>
      new NextRequest('http://localhost:3000/api/auth/activate', {
        method: 'POST',
        headers: { 'x-real-ip': '203.0.113.50' },
      })

    for (let attempt = 0; attempt < RATE_LIMIT_POLICIES.authActivate.limit; attempt += 1) {
      await expect(enforceRateLimit(request(), RATE_LIMIT_POLICIES.authActivate)).resolves.toBeNull()
    }

    const blocked = await enforceRateLimit(request(), RATE_LIMIT_POLICIES.authActivate)

    expect(blocked?.status).toBe(429)
    expect(blocked?.headers.get('retry-after')).toBeTruthy()
  })
})
