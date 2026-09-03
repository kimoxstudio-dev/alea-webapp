import 'server-only'
import { timingSafeEqual, createHash } from 'crypto'
import { NextRequest, NextResponse } from 'next/server'
import type { Redis } from '@upstash/redis'
import type { Ratelimit } from '@upstash/ratelimit'

// Re-export all Edge-safe helpers so that existing route-handler imports from
// `@/lib/server/security` continue to work without any call-site changes.
export {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  isSecureContext,
  createCsrfToken,
  getCsrfCookieOptions,
  ensureCsrfCookie,
} from './security-edge'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RateLimitPolicy = {
  bucket: string
  limit: number
  windowMs: number
}

type RateLimitEntry = {
  count: number
  resetAt: number
}

type ParsedIpAddress = {
  bits: 32 | 128
  value: bigint
}

type ParsedCidr = ParsedIpAddress & {
  mask: bigint
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
const ALLOWED_FETCH_SITES = new Set(['same-origin', 'same-site', 'none'])
const TRUST_PROXY_HEADERS_ENV = 'TRUST_PROXY_HEADERS'
const TRUSTED_PROXY_CIDRS_ENV = 'TRUSTED_PROXY_CIDRS'
const DEFAULT_TRUSTED_PROXY_CIDRS = ['127.0.0.1/32', '::1/128'] as const

// ---------------------------------------------------------------------------
// Rate limit store (in-memory fallback)
// ---------------------------------------------------------------------------

const RATE_LIMIT_STORE_KEY = '__aleaRateLimitStore'

const globalRateLimitStore = globalThis as typeof globalThis & {
  [RATE_LIMIT_STORE_KEY]?: Map<string, RateLimitEntry>
}

function getRateLimitStore() {
  if (!globalRateLimitStore[RATE_LIMIT_STORE_KEY]) {
    globalRateLimitStore[RATE_LIMIT_STORE_KEY] = new Map<string, RateLimitEntry>()
  }

  return globalRateLimitStore[RATE_LIMIT_STORE_KEY]
}

export function resetRateLimitStoreForTests() {
  globalRateLimitStore[RATE_LIMIT_STORE_KEY]?.clear()
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function forbidden(message: string) {
  return NextResponse.json({ message, statusCode: 403 }, { status: 403 })
}

function tooManyRequests(retryAfterSeconds: number) {
  const response = NextResponse.json(
    { message: 'Too many requests', statusCode: 429 },
    { status: 429 },
  )
  response.headers.set('Retry-After', String(retryAfterSeconds))
  return response
}

function isUnsafeMethod(method: string) {
  return !SAFE_METHODS.has(method.toUpperCase())
}

function normalizeIp(value: string | null) {
  if (!value) return null

  const [first] = value.split(',')
  const candidate = first?.trim().replace(/^"|"$/g, '')
  if (!candidate) return null

  const bracketedIpv6 = /^\[([^\]]+)\](?::\d+)?$/.exec(candidate)
  if (bracketedIpv6) {
    return bracketedIpv6[1]
  }

  const lastColon = candidate.lastIndexOf(':')
  const lastDot = candidate.lastIndexOf('.')
  if (lastDot > -1 && lastColon > lastDot) {
    return candidate.slice(0, lastColon)
  }

  return candidate
}

function parseIpv4(ip: string): ParsedIpAddress | null {
  const octets = ip.split('.')
  if (octets.length !== 4) return null

  let value = BigInt(0)
  for (const octet of octets) {
    if (!/^\d+$/.test(octet)) return null

    const numericOctet = Number(octet)
    if (numericOctet < 0 || numericOctet > 255) return null

    value = (value << BigInt(8)) | BigInt(numericOctet)
  }

  return { bits: 32, value }
}

function parseIpv6Segment(segment: string) {
  if (!/^[\da-f]{1,4}$/i.test(segment)) return null
  return Number.parseInt(segment, 16)
}

function parseIpv6Parts(part: string) {
  if (!part) return []

  const rawSegments = part.split(':')
  if (rawSegments.some((segment) => segment.length === 0)) {
    return [null]
  }

  return rawSegments.flatMap((segment) => {
    if (!segment.includes('.')) {
      const parsedSegment = parseIpv6Segment(segment)
      return parsedSegment === null ? [null] : [parsedSegment]
    }

    const parsedIpv4 = parseIpv4(segment)
    if (!parsedIpv4) return [null]

    return [
      Number((parsedIpv4.value >> BigInt(16)) & BigInt(0xffff)),
      Number(parsedIpv4.value & BigInt(0xffff)),
    ]
  })
}

function expandIpv6Segments(ip: string) {
  if (ip.includes(':::')) return null

  const hasCompression = ip.includes('::')
  const compressionParts = ip.split('::')
  if (compressionParts.length > 2) return null

  const [head, tail] = compressionParts
  if (hasCompression && tail === undefined) return null

  const headSegments = parseIpv6Parts(head ?? '')
  const tailSegments = parseIpv6Parts(tail ?? '')
  if (headSegments.some((segment) => segment === null)) return null
  if (tailSegments.some((segment) => segment === null)) return null

  const totalSegments = headSegments.length + tailSegments.length
  if ((!hasCompression && totalSegments !== 8) || totalSegments > 8) {
    return null
  }

  const zerosToInsert = hasCompression ? 8 - totalSegments : 0
  return [
    ...(headSegments as number[]),
    ...new Array(zerosToInsert).fill(0),
    ...(tailSegments as number[]),
  ]
}

function parseIpv6(ip: string): ParsedIpAddress | null {
  const segments = expandIpv6Segments(ip)
  if (!segments) return null

  let value = BigInt(0)
  for (const segment of segments) {
    value = (value << BigInt(16)) | BigInt(segment)
  }

  return { bits: 128, value }
}

function parseIpAddress(ip: string) {
  return parseIpv4(ip) ?? parseIpv6(ip)
}

function getValidIp(value: string | null) {
  const candidate = normalizeIp(value)
  return candidate && parseIpAddress(candidate) ? candidate : null
}

function createMask(bits: 32 | 128, prefixLength: number) {
  if (prefixLength === 0) return BigInt(0)

  const hostBits = BigInt(bits - prefixLength)
  const fullMask = (BigInt(1) << BigInt(bits)) - BigInt(1)
  return (fullMask << hostBits) & fullMask
}

function parseCidr(cidr: string) {
  const trimmed = cidr.trim()
  if (!trimmed) return null

  const parts = trimmed.split('/')
  if (parts.length !== 2) return null

  const [rawIp, rawPrefix] = parts
  const ip = getValidIp(rawIp)
  if (!ip) return null

  const parsedIp = parseIpAddress(ip)
  if (!parsedIp) return null

  const prefixLength = Number.parseInt(rawPrefix, 10)
  if (!Number.isInteger(prefixLength) || prefixLength < 0 || prefixLength > parsedIp.bits) {
    return null
  }

  const mask = createMask(parsedIp.bits, prefixLength)

  return {
    ...parsedIp,
    value: parsedIp.value & mask,
    mask,
  } satisfies ParsedCidr
}

function isIpInCidr(ip: string, cidr: string) {
  const parsedIp = getValidIp(ip)
  const parsedCidr = parseCidr(cidr)
  if (!parsedIp || !parsedCidr) {
    return false
  }

  const parsedIpAddress = parseIpAddress(parsedIp)
  if (!parsedIpAddress || parsedIpAddress.bits !== parsedCidr.bits) return false

  return (parsedIpAddress.value & parsedCidr.mask) === parsedCidr.value
}

function getTrustedProxyCidrs() {
  const configuredCidrs = process.env[TRUSTED_PROXY_CIDRS_ENV]
  const cidrs = configuredCidrs
    ? configuredCidrs.split(/[,\s]+/)
    : [...DEFAULT_TRUSTED_PROXY_CIDRS]

  return cidrs
    .map((cidr) => cidr.trim())
    .filter(Boolean)
}

function trustProxyHeaders() {
  return process.env[TRUST_PROXY_HEADERS_ENV] === 'true'
}

function isTrustedProxySourceIp(ip: string | null) {
  if (!ip) return false
  return getTrustedProxyCidrs().some((cidr) => isIpInCidr(ip, cidr))
}

function getClientAddress(request: NextRequest) {
  const realIp = getValidIp(request.headers.get('x-real-ip'))
  const forwardedFor = getValidIp(request.headers.get('x-forwarded-for'))

  // This trust path is opt-in and assumes the ingress strips and rewrites both
  // x-real-ip and x-forwarded-for before the request reaches the app runtime.
  if (trustProxyHeaders() && forwardedFor && isTrustedProxySourceIp(realIp)) {
    return forwardedFor
  }

  return realIp || 'local'
}

// ---------------------------------------------------------------------------
// Node-only crypto helpers (NOT safe for Edge Runtime)
// ---------------------------------------------------------------------------

export function tokensMatch(a: string, b: string): boolean {
  // Hash both strings to a fixed 32-byte length so timingSafeEqual can always
  // run, eliminating the length side-channel entirely while keeping constant-time
  // guarantees.
  const hashA = createHash('sha256').update(a).digest()
  const hashB = createHash('sha256').update(b).digest()
  return timingSafeEqual(hashA, hashB)
}

// ---------------------------------------------------------------------------
// Mutation security (Node runtime only — uses tokensMatch → Node crypto)
// ---------------------------------------------------------------------------

export function enforceMutationSecurity(request: NextRequest): NextResponse | null {
  if (!isUnsafeMethod(request.method)) return null

  const fetchSite = request.headers.get('sec-fetch-site')
  if (fetchSite && !ALLOWED_FETCH_SITES.has(fetchSite)) {
    return forbidden('Cross-site requests are not allowed')
  }

  const origin = request.headers.get('origin')
  if (!origin) {
    return forbidden('Invalid request origin')
  }

  try {
    const requestOrigin = new URL(request.url).origin
    if (new URL(origin).origin !== requestOrigin) {
      return forbidden('Invalid request origin')
    }
  } catch {
    return forbidden('Invalid request origin')
  }

  const csrfCookie = request.cookies.get('alea-csrf-token')?.value
  const csrfHeader = request.headers.get('x-csrf-token')

  if (!csrfCookie || !csrfHeader) {
    return forbidden('Invalid CSRF token')
  }

  if (!tokensMatch(csrfCookie, csrfHeader)) {
    return forbidden('Invalid CSRF token')
  }

  return null
}

/**
 * @deprecated Use `enforceMutationSecurity` instead. This helper now enforces
 * Fetch Metadata, same-origin `Origin` validation, and double-submit CSRF
 * protection, so the old name is preserved only for backwards compatibility.
 */
export function enforceSameOriginForMutation(request: NextRequest): NextResponse | null {
  return enforceMutationSecurity(request)
}

// ---------------------------------------------------------------------------
// Rate limiting (KIM-401)
//
// When UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are both set, uses
// @upstash/ratelimit with a sliding-window algorithm backed by Upstash Redis —
// shared across all serverless instances.
//
// Otherwise falls back to the in-memory Map on globalThis. In production
// without Redis the fallback emits a one-time console.warn (per instance)
// because rate limit state is not shared across instances.
// ---------------------------------------------------------------------------

export const RATE_LIMIT_POLICIES = {
  authLogin: { bucket: 'auth-login', limit: 5, windowMs: 60_000 },
  authActivate: { bucket: 'auth-activate', limit: 5, windowMs: 60_000 },
  authRegister: { bucket: 'auth-register', limit: 3, windowMs: 60_000 },
  authLogout: { bucket: 'auth-logout', limit: 10, windowMs: 60_000 },
  adminMutation: { bucket: 'admin-mutation', limit: 30, windowMs: 60_000 },
  reservationMutation: { bucket: 'reservation-mutation', limit: 20, windowMs: 60_000 },
} satisfies Record<string, RateLimitPolicy>

// One-time warning flag (per process instance) for the in-memory fallback path.
let _warnedAboutInMemoryRateLimit = false

function isRedisRateLimitConfigured(): boolean {
  return !!(
    process.env.UPSTASH_REDIS_REST_URL &&
    process.env.UPSTASH_REDIS_REST_TOKEN
  )
}

// ---------------------------------------------------------------------------
// Redis + Ratelimit singletons (lazy, module-level)
//
// Dynamic imports keep @upstash/* tree-shaken from builds that don't set the
// Redis env vars. Once initialised the same Redis client and per-bucket
// Ratelimit instances are reused across requests — no reconnect overhead.
// ---------------------------------------------------------------------------

let _redisClient: Redis | null = null
const _ratelimitCache = new Map<string, Ratelimit>()

async function getRatelimitForPolicy(policy: RateLimitPolicy): Promise<Ratelimit> {
  const { Redis } = await import('@upstash/redis')
  const { Ratelimit } = await import('@upstash/ratelimit')

  if (!_redisClient) {
    _redisClient = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL!,
      token: process.env.UPSTASH_REDIS_REST_TOKEN!,
    })
  }

  let ratelimit = _ratelimitCache.get(policy.bucket)
  if (!ratelimit) {
    ratelimit = new Ratelimit({
      redis: _redisClient,
      limiter: Ratelimit.slidingWindow(policy.limit, `${policy.windowMs}ms`),
      prefix: `alea:rl:${policy.bucket}`,
    })
    _ratelimitCache.set(policy.bucket, ratelimit)
  }

  return ratelimit
}

async function enforceRateLimitRedis(
  request: NextRequest,
  policy: RateLimitPolicy,
): Promise<NextResponse | null> {
  const ratelimit = await getRatelimitForPolicy(policy)
  const identifier = getClientAddress(request)
  const result = await ratelimit.limit(identifier)

  if (!result.success) {
    const retryAfterSeconds = Math.max(1, Math.ceil((result.reset - Date.now()) / 1000))
    return tooManyRequests(retryAfterSeconds)
  }

  return null
}

function enforceRateLimitMemory(
  request: NextRequest,
  policy: RateLimitPolicy,
): NextResponse | null {
  if (!_warnedAboutInMemoryRateLimit && process.env.NODE_ENV === 'production') {
    _warnedAboutInMemoryRateLimit = true
    console.warn(
      '[security] Rate limiting is running in-memory (per-instance). ' +
        'Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN to enable a shared rate limit store.',
    )
  }

  const store = getRateLimitStore()
  const now = Date.now()

  if (store.size > 5000) {
    for (const [key, value] of store.entries()) {
      if (value.resetAt <= now) {
        store.delete(key)
      }
    }
  }

  const key = `${policy.bucket}:${getClientAddress(request)}`
  const current = store.get(key)

  if (!current || current.resetAt <= now) {
    store.set(key, {
      count: 1,
      resetAt: now + policy.windowMs,
    })
    return null
  }

  current.count += 1
  if (current.count > policy.limit) {
    const retryAfterSeconds = Math.max(1, Math.ceil((current.resetAt - now) / 1000))
    return tooManyRequests(retryAfterSeconds)
  }

  return null
}

/**
 * Enforces a rate limit policy for the incoming request.
 *
 * When UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN are set, uses
 * Upstash Redis (shared across serverless instances).
 * Otherwise uses the in-memory fallback (per-instance, sufficient for dev/test).
 */
export async function enforceRateLimit(
  request: NextRequest,
  policy: RateLimitPolicy,
): Promise<NextResponse | null> {
  if (isRedisRateLimitConfigured()) {
    return enforceRateLimitRedis(request, policy)
  }
  return enforceRateLimitMemory(request, policy)
}
