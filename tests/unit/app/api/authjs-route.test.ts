// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

describe('retired Auth.js route', () => {
  beforeEach(() => {
    vi.unstubAllEnvs()
  })

  it('returns 404 for GET requests', async () => {
    const { GET } = await import('@/app/api/authjs/[...nextauth]/route')
    const response = await GET(new NextRequest('http://localhost:3000/api/authjs/session'))

    expect(response.status).toBe(404)
  })

  it('returns 404 for POST requests', async () => {
    const { POST } = await import('@/app/api/authjs/[...nextauth]/route')
    const response = await POST(new NextRequest('http://localhost:3000/api/authjs/session', {
      method: 'POST',
    }))

    expect(response.status).toBe(404)
  })

  it('cannot be re-enabled through AUTH_JS_ENABLED for GET requests', async () => {
    vi.stubEnv('AUTH_JS_ENABLED', 'true')
    const { GET } = await import('@/app/api/authjs/[...nextauth]/route')

    expect((await GET(new NextRequest('http://localhost:3000/api/authjs/session'))).status).toBe(404)
  })

  it('cannot be re-enabled through AUTH_JS_ENABLED for POST requests', async () => {
    vi.stubEnv('AUTH_JS_ENABLED', 'true')
    const { POST } = await import('@/app/api/authjs/[...nextauth]/route')

    expect((await POST(new NextRequest('http://localhost:3000/api/authjs/session', {
      method: 'POST',
    }))).status).toBe(404)
  })

  it('returns an empty response without session cookies', async () => {
    const { GET } = await import('@/app/api/authjs/[...nextauth]/route')
    const request = new NextRequest('http://localhost:3000/api/authjs/session')
    const response = await GET(request)

    await expect(response.text()).resolves.toBe('')
    expect(response.headers.get('set-cookie')).toBeNull()
  })
})
