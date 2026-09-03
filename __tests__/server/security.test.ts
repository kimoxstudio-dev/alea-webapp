// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

// ---------------------------------------------------------------------------
// @upstash/redis + @upstash/ratelimit mocks (KIM-401 Redis-backed rate limit)
//
// `enforceRateLimit` dynamically imports these packages only when
// UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN are set. `vi.mock` is
// hoisted above imports, so it intercepts the dynamic `import()` calls too.
// ---------------------------------------------------------------------------

const mockLimit = vi.fn()
const mockRedisConstructor = vi.fn()
const mockRatelimitConstructor = vi.fn()
const mockSlidingWindow = vi.fn().mockReturnValue({ type: 'sliding-window-mock' })

vi.mock('@upstash/redis', () => ({
  Redis: class {
    constructor(...args: unknown[]) {
      mockRedisConstructor(...args)
    }
  },
}))

vi.mock('@upstash/ratelimit', () => ({
  Ratelimit: Object.assign(
    class {
      limit: typeof mockLimit
      constructor(...args: unknown[]) {
        mockRatelimitConstructor(...args)
        this.limit = mockLimit
      }
    },
    { slidingWindow: mockSlidingWindow },
  ),
}))

describe('server security helpers', () => {
  beforeEach(async () => {
    vi.resetModules()
    vi.unstubAllEnvs()
    mockLimit.mockReset()
    mockRedisConstructor.mockReset()
    mockRatelimitConstructor.mockReset()
    mockSlidingWindow.mockClear()
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

  describe('Redis-backed rate limiting (Upstash)', () => {
    beforeEach(() => {
      vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://example.upstash.io')
      vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 'test-token')
    })

    it('allows the request through when Upstash reports the client is within limits', async () => {
      mockLimit.mockResolvedValueOnce({
        success: true,
        limit: 5,
        remaining: 4,
        reset: Date.now() + 60_000,
      })

      const { enforceRateLimit } = await import('@/lib/server/security')
      const policy = { bucket: 'test-redis-allowed', limit: 5, windowMs: 60_000 }

      const result = await enforceRateLimit(
        new NextRequest('http://localhost:3000/api/auth/login', {
          method: 'POST',
          headers: { 'x-real-ip': '203.0.113.90' },
        }),
        policy,
      )

      expect(result).toBeNull()
      expect(mockRedisConstructor).toHaveBeenCalledWith(
        expect.objectContaining({
          url: 'https://example.upstash.io',
          token: 'test-token',
        }),
      )
      expect(mockSlidingWindow).toHaveBeenCalledWith(policy.limit, `${policy.windowMs}ms`)
      expect(mockLimit).toHaveBeenCalledWith('203.0.113.90')
    })

    it('returns 429 with the Upstash-derived Retry-After header when the client is blocked', async () => {
      const resetAt = Date.now() + 42_000
      mockLimit.mockResolvedValueOnce({
        success: false,
        limit: 5,
        remaining: 0,
        reset: resetAt,
      })

      const { enforceRateLimit } = await import('@/lib/server/security')
      const policy = { bucket: 'test-redis-blocked', limit: 5, windowMs: 60_000 }

      const result = await enforceRateLimit(
        new NextRequest('http://localhost:3000/api/auth/login', {
          method: 'POST',
          headers: { 'x-real-ip': '203.0.113.91' },
        }),
        policy,
      )

      expect(result?.status).toBe(429)
      const retryAfter = Number(result?.headers.get('retry-after'))
      expect(retryAfter).toBeGreaterThan(0)
      expect(retryAfter).toBeLessThanOrEqual(42)
    })

    it('reuses a single Redis client and per-bucket Ratelimit instance across requests', async () => {
      mockLimit.mockResolvedValue({
        success: true,
        limit: 5,
        remaining: 4,
        reset: Date.now() + 60_000,
      })

      const { enforceRateLimit } = await import('@/lib/server/security')
      const policy = { bucket: 'test-redis-singleton', limit: 5, windowMs: 60_000 }
      const makeRequest = () =>
        new NextRequest('http://localhost:3000/api/auth/login', {
          method: 'POST',
          headers: { 'x-real-ip': '203.0.113.92' },
        })

      await enforceRateLimit(makeRequest(), policy)
      await enforceRateLimit(makeRequest(), policy)

      expect(mockRedisConstructor).toHaveBeenCalledTimes(1)
      expect(mockRatelimitConstructor).toHaveBeenCalledTimes(1)
      expect(mockLimit).toHaveBeenCalledTimes(2)
    })

    it('persists rate-limit counter state across a simulated serverless cold start', async () => {
      // `sharedCounter` stands in for the real Upstash Redis server: it lives
      // in the *test file's* module scope, which `vi.resetModules()` does not
      // clear. This is what a real cold start's persistent Redis store would
      // be relative to two independent Lambda/Edge instances.
      const sharedCounter = new Map<string, number>()
      const LIMIT = 2

      mockLimit.mockImplementation(async (identifier: string) => {
        const newCount = (sharedCounter.get(identifier) ?? 0) + 1
        sharedCounter.set(identifier, newCount)

        return {
          success: newCount <= LIMIT,
          limit: LIMIT,
          remaining: Math.max(0, LIMIT - newCount),
          reset: Date.now() + 60_000,
        }
      })

      const policy = { bucket: 'test-cold-start-persist', limit: LIMIT, windowMs: 60_000 }
      const clientIp = '203.0.113.95'
      const makeRequest = () =>
        new NextRequest('http://localhost:3000/api/test', {
          method: 'POST',
          headers: { 'x-real-ip': clientIp },
        })

      // --- "Instance A": first serverless invocation ---
      // vi.resetModules() clears the module registry, exactly like a fresh
      // cold start discards the previous instance's module-level
      // `_redisClient` / `_ratelimitCache` singletons. Re-importing gives us
      // a brand-new module instance to exercise.
      vi.resetModules()
      const instanceA = await import('@/lib/server/security')

      const resultA1 = await instanceA.enforceRateLimit(makeRequest(), policy)
      const resultA2 = await instanceA.enforceRateLimit(makeRequest(), policy)

      expect(resultA1).toBeNull() // count=1, allowed
      expect(resultA2).toBeNull() // count=2, allowed (at limit)

      // --- "Instance B": second serverless invocation (new cold start) ---
      // Reset the module registry again and re-import. `instanceB` has its
      // own fresh `_redisClient` / `_ratelimitCache` module-level bindings —
      // if `enforceRateLimit` regressed to counting requests in local module
      // memory instead of delegating to the (mocked) Upstash-backed
      // `ratelimit.limit()` call, this fresh instance would start back at
      // zero and wrongly allow the next request.
      vi.resetModules()
      const instanceB = await import('@/lib/server/security')

      // Sanity check that this really is a distinct module instance and not
      // the same cached export object.
      expect(instanceB.enforceRateLimit).not.toBe(instanceA.enforceRateLimit)

      const resultB1 = await instanceB.enforceRateLimit(makeRequest(), policy)

      // The externally persisted (mocked Upstash) counter is already at the
      // limit from Instance A, so Instance B — despite being a fresh module
      // with no local memory of prior requests — must still reject.
      expect(resultB1?.status).toBe(429)
      expect(sharedCounter.get(clientIp)).toBe(3)
      expect(mockLimit).toHaveBeenCalledTimes(3)
    })
  })
})
