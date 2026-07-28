// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'

describe('authConfigEdge', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('resolves AUTHJS_SESSION_COOKIE_NAME to __Secure- prefixed name when COOKIE_SECURE=true', async () => {
    vi.stubEnv('COOKIE_SECURE', 'true')
    const { AUTHJS_SESSION_COOKIE_NAME } = await import('@/lib/authjs/config-edge')
    expect(AUTHJS_SESSION_COOKIE_NAME).toBe('__Secure-authjs.session-token')
  })

  it('resolves AUTHJS_SESSION_COOKIE_NAME to unprefixed name when COOKIE_SECURE=false', async () => {
    vi.stubEnv('COOKIE_SECURE', 'false')
    const { AUTHJS_SESSION_COOKIE_NAME } = await import('@/lib/authjs/config-edge')
    expect(AUTHJS_SESSION_COOKIE_NAME).toBe('authjs.session-token')
  })

  it('sets session.strategy to jwt', async () => {
    const { authConfigEdge } = await import('@/lib/authjs/config-edge')
    expect(authConfigEdge.session.strategy).toBe('jwt')
  })

  it('sets session.maxAge to 7 days (604800 seconds)', async () => {
    const { authConfigEdge } = await import('@/lib/authjs/config-edge')
    expect(authConfigEdge.session.maxAge).toBe(60 * 60 * 24 * 7)
    expect(authConfigEdge.session.maxAge).toBe(604800)
  })

  it('sets sessionToken cookie name to match AUTHJS_SESSION_COOKIE_NAME', async () => {
    const { authConfigEdge, AUTHJS_SESSION_COOKIE_NAME } = await import('@/lib/authjs/config-edge')
    expect(authConfigEdge.cookies.sessionToken.name).toBe(AUTHJS_SESSION_COOKIE_NAME)
  })

  it('sets sessionToken cookie options with httpOnly: true', async () => {
    const { authConfigEdge } = await import('@/lib/authjs/config-edge')
    expect(authConfigEdge.cookies.sessionToken.options.httpOnly).toBe(true)
  })

  it('sets sessionToken cookie options with sameSite: lax', async () => {
    const { authConfigEdge } = await import('@/lib/authjs/config-edge')
    expect(authConfigEdge.cookies.sessionToken.options.sameSite).toBe('lax')
  })

  it('sets sessionToken cookie options with path: /', async () => {
    const { authConfigEdge } = await import('@/lib/authjs/config-edge')
    expect(authConfigEdge.cookies.sessionToken.options.path).toBe('/')
  })

  it('sets sessionToken cookie secure flag to true when COOKIE_SECURE=true', async () => {
    vi.stubEnv('COOKIE_SECURE', 'true')
    const { authConfigEdge } = await import('@/lib/authjs/config-edge')
    expect(authConfigEdge.cookies.sessionToken.options.secure).toBe(true)
  })

  it('sets sessionToken cookie secure flag to false when COOKIE_SECURE=false', async () => {
    vi.stubEnv('COOKIE_SECURE', 'false')
    const { authConfigEdge } = await import('@/lib/authjs/config-edge')
    expect(authConfigEdge.cookies.sessionToken.options.secure).toBe(false)
  })

  it('keeps providers array empty (Edge-runtime safety)', async () => {
    const { authConfigEdge } = await import('@/lib/authjs/config-edge')
    expect(authConfigEdge.providers).toEqual([])
    expect(authConfigEdge.providers.length).toBe(0)
  })
})
