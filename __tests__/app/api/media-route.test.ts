// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'

const getPrivateImageMock = vi.fn()

vi.mock('@/lib/server/private-blob', () => ({ getPrivateImage: getPrivateImageMock }))

describe('GET /api/media/[folder]/[filename]', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('serves only generated landing-media pathnames without authentication', async () => {
    getPrivateImageMock.mockResolvedValue(new NextResponse('image'))
    const { GET } = await import('@/app/api/media/[folder]/[filename]/route')
    const request = new NextRequest('http://localhost/api/media/events/123e4567-e89b-12d3-a456-426614174000.png')

    const response = await GET(request, {
      params: Promise.resolve({ folder: 'events', filename: '123e4567-e89b-12d3-a456-426614174000.png' }),
    })

    expect(response.status).toBe(200)
    expect(getPrivateImageMock).toHaveBeenCalledWith(
      'landing-media/events/123e4567-e89b-12d3-a456-426614174000.png',
      'public, max-age=3600, s-maxage=3600',
      undefined,
    )
  })

  it('rejects an arbitrary Blob pathname before reading storage', async () => {
    const { GET } = await import('@/app/api/media/[folder]/[filename]/route')
    const response = await GET(new NextRequest('http://localhost/api/media/events/private-report.pdf'), {
      params: Promise.resolve({ folder: 'events', filename: 'private-report.pdf' }),
    })

    expect(response.status).toBe(404)
    expect(getPrivateImageMock).not.toHaveBeenCalled()
  })
})
