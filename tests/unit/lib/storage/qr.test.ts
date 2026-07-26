// @vitest-environment node
import { describe, expect, it, vi, beforeEach } from 'vitest'

/**
 * Test coverage for lib/storage/qr — the seam for storage access backing both
 * admin-generated table QR codes and admin-uploaded landing-media images.
 *
 * F3 cutover (KIM-431): As of this version, the seam delegates to the Vercel
 * Blob adapter (lib/storage/qr/vercel-blob.ts) rather than Supabase Storage.
 * Tests verify the adapter behavior and integration with call sites like
 * lib/server/tables/tables-service.ts (now using getPublicStorageUrl for URL resolution).
 */

vi.mock('@vercel/blob', () => ({
  put: vi.fn(),
  del: vi.fn(),
}))

describe('lib/storage/qr seam (size validation)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('uploadToStorage() enforces 5MB size cap, rejecting oversized payloads', async () => {
    const { uploadToStorage } = await import('@/lib/storage/qr')

    const oversizedBuffer = Buffer.alloc(5 * 1024 * 1024 + 1) // 5MB + 1 byte
    const result = await uploadToStorage('bucket', 'large-file.bin', oversizedBuffer)

    expect(result.error).toBeDefined()
    expect(result.error?.name).toBe('StoragePayloadTooLargeError')
    expect(result.error?.status).toBe(413)
    expect(result.error?.statusCode).toBe('413')
    expect(result.error?.message).toContain('exceeds the maximum allowed size')
  })

  it('uploadToStorage() accepts payloads at exactly 5MB', async () => {
    const { uploadToStorage } = await import('@/lib/storage/qr')
    const { put } = await import('@vercel/blob')

    vi.mocked(put).mockResolvedValue({} as never)

    const exactBuffer = Buffer.alloc(5 * 1024 * 1024) // Exactly 5MB
    const result = await uploadToStorage('bucket', 'max-file.bin', exactBuffer)

    expect(result.error).toBeNull()
    expect(vi.mocked(put)).toHaveBeenCalled()
  })

  it('uploadToStorage() accepts payloads under 5MB', async () => {
    const { uploadToStorage } = await import('@/lib/storage/qr')
    const { put } = await import('@vercel/blob')

    vi.mocked(put).mockResolvedValue({} as never)

    const smallBuffer = Buffer.alloc(1024) // 1KB
    const result = await uploadToStorage('bucket', 'small-file.bin', smallBuffer)

    expect(result.error).toBeNull()
    expect(vi.mocked(put)).toHaveBeenCalled()
  })
})

describe('lib/storage/qr/vercel-blob (F3 adapter)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('uploadToStorage() calls put() with pathname joined from bucket+path', async () => {
    const { uploadToStorage } = await import('@/lib/storage/qr/vercel-blob')
    const { put } = await import('@vercel/blob')

    vi.mocked(put).mockResolvedValue({} as never)

    const buffer = Buffer.from([1, 2, 3])
    await uploadToStorage('my-bucket', 'path/to/file.png', buffer)

    expect(vi.mocked(put)).toHaveBeenCalledWith(
      'my-bucket/path/to/file.png',
      buffer,
      expect.objectContaining({ access: 'public' }),
    )
  })

  it('uploadToStorage() maps options.upsert to allowOverwrite', async () => {
    const { uploadToStorage } = await import('@/lib/storage/qr/vercel-blob')
    const { put } = await import('@vercel/blob')

    vi.mocked(put).mockResolvedValue({} as never)

    const buffer = Buffer.from([1, 2, 3])
    await uploadToStorage('bucket', 'path.png', buffer, { upsert: true })

    const callArgs = vi.mocked(put).mock.calls[0]
    expect(callArgs[2]?.allowOverwrite).toBe(true)
  })

  it('uploadToStorage() defaults upsert to false (allowOverwrite: false)', async () => {
    const { uploadToStorage } = await import('@/lib/storage/qr/vercel-blob')
    const { put } = await import('@vercel/blob')

    vi.mocked(put).mockResolvedValue({} as never)

    const buffer = Buffer.from([1, 2, 3])
    await uploadToStorage('bucket', 'path.png', buffer)

    const callArgs = vi.mocked(put).mock.calls[0]
    expect(callArgs[2]?.allowOverwrite).toBe(false)
  })

  it('uploadToStorage() forwards contentType option', async () => {
    const { uploadToStorage } = await import('@/lib/storage/qr/vercel-blob')
    const { put } = await import('@vercel/blob')

    vi.mocked(put).mockResolvedValue({} as never)

    const buffer = Buffer.from([1, 2, 3])
    await uploadToStorage('bucket', 'path.png', buffer, { contentType: 'image/png' })

    const callArgs = vi.mocked(put).mock.calls[0]
    expect(callArgs[2]?.contentType).toBe('image/png')
  })

  it('uploadToStorage() converts Uint8Array to Buffer before put()', async () => {
    const { uploadToStorage } = await import('@/lib/storage/qr/vercel-blob')
    const { put } = await import('@vercel/blob')

    vi.mocked(put).mockResolvedValue({} as never)

    const uint8Array = new Uint8Array([1, 2, 3])
    await uploadToStorage('bucket', 'path.png', uint8Array)

    const callArgs = vi.mocked(put).mock.calls[0]
    const passedBody = callArgs[1]
    expect(Buffer.isBuffer(passedBody)).toBe(true)
  })

  it('uploadToStorage() returns { error: null } on success', async () => {
    const { uploadToStorage } = await import('@/lib/storage/qr/vercel-blob')
    const { put } = await import('@vercel/blob')

    vi.mocked(put).mockResolvedValue({} as never)

    const result = await uploadToStorage('bucket', 'path.png', Buffer.from([1, 2, 3]))

    expect(result).toEqual({ error: null })
  })

  it('uploadToStorage() wraps Vercel Blob errors with structured fields', async () => {
    const { uploadToStorage } = await import('@/lib/storage/qr/vercel-blob')
    const { put } = await import('@vercel/blob')

    const blobError = {
      name: 'BlobError',
      message: 'Upload failed',
      status: 500,
      statusCode: '500',
    }
    vi.mocked(put).mockRejectedValue(blobError)

    const result = await uploadToStorage('bucket', 'path.png', Buffer.from([1, 2, 3]))

    expect(result.error).toEqual({
      name: 'BlobError',
      message: 'Upload failed',
      status: 500,
      statusCode: '500',
    })
  })

  it('uploadToStorage() handles errors with partial fields (only message for non-object errors)', async () => {
    const { uploadToStorage } = await import('@/lib/storage/qr/vercel-blob')
    const { put } = await import('@vercel/blob')

    vi.mocked(put).mockRejectedValue(new Error('Network timeout'))

    const result = await uploadToStorage('bucket', 'path.png', Buffer.from([1, 2, 3]))

    expect(result.error?.message).toBe('Network timeout')
  })

  it('getPublicStorageUrl() returns null when BLOB_PUBLIC_BASE_URL is unset', async () => {
    const { getPublicStorageUrl } = await import('@/lib/storage/qr/vercel-blob')

    const originalEnv = process.env.BLOB_PUBLIC_BASE_URL
    delete process.env.BLOB_PUBLIC_BASE_URL

    const result = getPublicStorageUrl('bucket', 'path.png')

    expect(result.publicUrl).toBeNull()

    process.env.BLOB_PUBLIC_BASE_URL = originalEnv
  })

  it('getPublicStorageUrl() constructs URL from BLOB_PUBLIC_BASE_URL + encoded pathname', async () => {
    const { getPublicStorageUrl } = await import('@/lib/storage/qr/vercel-blob')

    const originalEnv = process.env.BLOB_PUBLIC_BASE_URL
    process.env.BLOB_PUBLIC_BASE_URL = 'https://example.public.blob.vercel-storage.com'

    const result = getPublicStorageUrl('my-bucket', 'file.png')

    expect(result.publicUrl).toBe('https://example.public.blob.vercel-storage.com/my-bucket/file.png')

    process.env.BLOB_PUBLIC_BASE_URL = originalEnv
  })

  it('getPublicStorageUrl() encodes pathname segments with encodeURIComponent (spaces -> %20)', async () => {
    const { getPublicStorageUrl } = await import('@/lib/storage/qr/vercel-blob')

    const originalEnv = process.env.BLOB_PUBLIC_BASE_URL
    process.env.BLOB_PUBLIC_BASE_URL = 'https://example.public.blob.vercel-storage.com'

    const result = getPublicStorageUrl('bucket', 'path/file with spaces.png')

    // Each segment of path should be encoded: 'path' -> 'path', 'file with spaces.png' -> 'file%20with%20spaces.png'
    expect(result.publicUrl).toBe('https://example.public.blob.vercel-storage.com/bucket/path/file%20with%20spaces.png')

    process.env.BLOB_PUBLIC_BASE_URL = originalEnv
  })

  it('getPublicStorageUrl() encodes special URL-reserved characters in pathname segments (# -> %23, ? -> %3F)', async () => {
    const { getPublicStorageUrl } = await import('@/lib/storage/qr/vercel-blob')

    const originalEnv = process.env.BLOB_PUBLIC_BASE_URL
    process.env.BLOB_PUBLIC_BASE_URL = 'https://example.public.blob.vercel-storage.com'

    const result = getPublicStorageUrl('bucket', 'path/file#with?special.png')

    // '#' -> '%23', '?' -> '%3F'
    expect(result.publicUrl).toBe('https://example.public.blob.vercel-storage.com/bucket/path/file%23with%3Fspecial.png')

    process.env.BLOB_PUBLIC_BASE_URL = originalEnv
  })

  it('getPublicStorageUrl() preserves / path separators when encoding (does not encode the slashes themselves)', async () => {
    const { getPublicStorageUrl } = await import('@/lib/storage/qr/vercel-blob')

    const originalEnv = process.env.BLOB_PUBLIC_BASE_URL
    process.env.BLOB_PUBLIC_BASE_URL = 'https://example.public.blob.vercel-storage.com'

    const result = getPublicStorageUrl('bucket', 'deep/nested/path/file.png')

    // Path separators should NOT be encoded
    expect(result.publicUrl).toBe('https://example.public.blob.vercel-storage.com/bucket/deep/nested/path/file.png')

    process.env.BLOB_PUBLIC_BASE_URL = originalEnv
  })

  it('getPublicStorageUrl() strips trailing slashes from base URL and bucket', async () => {
    const { getPublicStorageUrl } = await import('@/lib/storage/qr/vercel-blob')

    const originalEnv = process.env.BLOB_PUBLIC_BASE_URL
    process.env.BLOB_PUBLIC_BASE_URL = 'https://example.public.blob.vercel-storage.com/'

    const result = getPublicStorageUrl('bucket/', 'file.png')

    expect(result.publicUrl).toBe('https://example.public.blob.vercel-storage.com/bucket/file.png')

    process.env.BLOB_PUBLIC_BASE_URL = originalEnv
  })

  it('removeFromStorage() calls del() with pathname array', async () => {
    const { removeFromStorage } = await import('@/lib/storage/qr/vercel-blob')
    const { del } = await import('@vercel/blob')

    vi.mocked(del).mockResolvedValue({} as never)

    const paths = ['path1.png', 'path2.png']
    await removeFromStorage('my-bucket', paths)

    const expectedPathnames = ['my-bucket/path1.png', 'my-bucket/path2.png']
    expect(vi.mocked(del)).toHaveBeenCalledWith(expectedPathnames)
  })

  it('removeFromStorage() returns { error: null } on success', async () => {
    const { removeFromStorage } = await import('@/lib/storage/qr/vercel-blob')
    const { del } = await import('@vercel/blob')

    vi.mocked(del).mockResolvedValue({} as never)

    const result = await removeFromStorage('bucket', ['path.png'])

    expect(result).toEqual({ error: null })
  })

  it('removeFromStorage() wraps Vercel Blob del() errors with structured fields', async () => {
    const { removeFromStorage } = await import('@/lib/storage/qr/vercel-blob')
    const { del } = await import('@vercel/blob')

    const blobError = {
      name: 'BlobError',
      message: 'Delete failed',
      status: 404,
      statusCode: '404',
    }
    vi.mocked(del).mockRejectedValue(blobError)

    const result = await removeFromStorage('bucket', ['missing.png'])

    expect(result.error).toEqual({
      name: 'BlobError',
      message: 'Delete failed',
      status: 404,
      statusCode: '404',
    })
  })
})

/**
 * Integration test verifying the F3 cutover: lib/server/tables/tables-service.ts
 * now calls getPublicStorageUrl() from the storage seam to resolve QR code URLs.
 *
 * This is the F3 CUTOVER follow-up work (KIM-431): tables-service.ts was refactored
 * to use getPublicStorageUrl() instead of manually constructing Supabase Storage URLs.
 * This test verifies that the call path now exercises the seam for URL resolution.
 */
describe('lib/server/tables/tables-service (F3 cutover integration)', () => {
  it('generateTableQrCode() calls uploadToStorage() and getPublicStorageUrl() via the seam', async () => {
    const storageQr = await import('@/lib/storage/qr')
    
    // Set up environment for the call path
    const originalBlobBaseUrl = process.env.BLOB_PUBLIC_BASE_URL
    const originalAppUrl = process.env.NEXT_PUBLIC_APP_URL
    process.env.BLOB_PUBLIC_BASE_URL = 'https://example.public.blob.vercel-storage.com'
    process.env.NEXT_PUBLIC_APP_URL = 'https://example.com'

    // Mock both seam functions
    const uploadSpy = vi.spyOn(storageQr, 'uploadToStorage').mockResolvedValue({ error: null })
    const getUrlSpy = vi.spyOn(storageQr, 'getPublicStorageUrl').mockReturnValue({
      publicUrl: 'https://example.public.blob.vercel-storage.com/table-qr-codes/a1b2c3d4-e5f6-7890-abcd-ef1234567890.png',
    })

    try {
      const tablesService = await import('@/lib/server/tables/tables-service')
      const tableId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'
      const adminSession = { id: 'admin-1', role: 'admin' as const, email: 'admin@example.com' }

      const result = await tablesService.generateTableQrCode(adminSession, tableId)

      // Verify uploadToStorage() was called for the QR code generation
      expect(uploadSpy).toHaveBeenCalledWith(
        'table-qr-codes',
        `${tableId}.png`,
        expect.any(Buffer),
        expect.objectContaining({ contentType: 'image/png', upsert: true })
      )

      // Verify getPublicStorageUrl() WAS called (F3 cutover completed)
      expect(getUrlSpy).toHaveBeenCalledWith('table-qr-codes', `${tableId}.png`)

      // Verify the returned URL is from the seam, not manually constructed
      expect(result).toBe('https://example.public.blob.vercel-storage.com/table-qr-codes/a1b2c3d4-e5f6-7890-abcd-ef1234567890.png')
    } finally {
      uploadSpy.mockRestore()
      getUrlSpy.mockRestore()
      process.env.BLOB_PUBLIC_BASE_URL = originalBlobBaseUrl
      process.env.NEXT_PUBLIC_APP_URL = originalAppUrl
    }
  })
})
