// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'

const getMock = vi.fn()

vi.mock('server-only', () => ({}))
vi.mock('@vercel/blob', () => ({ get: getMock }))

describe('getPrivateImage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('streams a private image with its verified content type and cache policy', async () => {
    getMock.mockResolvedValue({
      statusCode: 200,
      stream: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1])); controller.close() } }),
      blob: { contentType: 'image/png', etag: 'image-etag' },
    })
    const { getPrivateImage } = await import('@/lib/server/private-blob')

    const response = await getPrivateImage('landing-media/events/image.png', 'public, max-age=3600', 'image-etag')

    expect(getMock).toHaveBeenCalledWith('landing-media/events/image.png', {
      access: 'private',
      ifNoneMatch: 'image-etag',
    })
    expect(response?.headers.get('content-type')).toBe('image/png')
    expect(response?.headers.get('cache-control')).toBe('public, max-age=3600')
    expect(response?.headers.get('x-content-type-options')).toBe('nosniff')
  })

  it('does not serve a Blob response with an unexpected content type', async () => {
    getMock.mockResolvedValue({
      statusCode: 200,
      stream: new ReadableStream(),
      blob: { contentType: 'text/html', etag: 'unsafe' },
    })
    const { getPrivateImage } = await import('@/lib/server/private-blob')

    await expect(getPrivateImage('landing-media/events/image.png', 'public, max-age=3600')).resolves.toBeNull()
  })

  it('returns a conditional 304 before checking the cached response content type', async () => {
    getMock.mockResolvedValue({
      statusCode: 304,
      blob: { contentType: null, etag: 'unchanged' },
    })
    const { getPrivateImage } = await import('@/lib/server/private-blob')

    const response = await getPrivateImage('table-qr-codes/table.png', 'private, no-cache', 'unchanged', false)

    expect(response?.status).toBe(304)
    expect(getMock).toHaveBeenCalledWith('table-qr-codes/table.png', {
      access: 'private',
      ifNoneMatch: 'unchanged',
      useCache: false,
    })
  })
})
