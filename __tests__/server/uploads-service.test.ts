// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ServiceError } from '@/lib/server/service-error'

/**
 * UPLOADS SERVICE TEST COVERAGE (#310)
 *
 * Tests for image uploads to Vercel Blob for landing content (club events,
 * partners, library games). Implementation: lib/server/uploads-service.ts
 *
 * Key scenarios tested:
 * - Happy path: admin + valid PNG file → put() called with pathname matching
 *   /^landing-media\/events\/[0-9a-f-]+\.png$/, contentType/access set, returns { url }
 * - Privilege: non-admin → 403 Forbidden before any put() call
 * - Validation matrix (each → 400, no put() call):
 *   - missing file
 *   - folder outside allowlist ('../etc', 'avatars', '')
 *   - MIME not allowed (image/svg+xml, application/pdf, text/html)
 *   - size > 5MB
 * - Extension derived from MIME not filename: file named "evil.svg" with type image/png → stored as .png
 * - Blob put() throwing → 500 ServiceError (and console.error called)
 */

vi.mock('server-only', () => ({}))

const putMock = vi.fn()
vi.mock('@vercel/blob', () => ({
  put: putMock,
}))

vi.mock('@/lib/server/service-error', () => ({
  serviceError: vi.fn((message: string, statusCode: number) => {
    const err = new Error(message) as ServiceError
    err.name = 'ServiceError'
    err.statusCode = statusCode
    throw err
  }),
}))

type SessionUser = {
  id: string
  role: 'admin' | 'member'
  email?: string
}

interface MockFile {
  size: number
  type: string
  arrayBuffer: () => Promise<ArrayBuffer>
}

// Real magic-byte signatures for each allowed image MIME type, used so the
// happy-path fixtures pass the service's magic-byte verification.
const REAL_SIGNATURE_BYTES: Record<string, number[]> = {
  'image/png': [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  'image/jpeg': [0xff, 0xd8, 0xff, 0xe0],
  'image/webp': [0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50],
  'image/gif': [0x47, 0x49, 0x46, 0x38, 0x39, 0x61],
}

/**
 * Builds a mock File-like object whose body bytes are a real, matching magic
 * signature for `type` (when `type` is a known image MIME), padded with
 * zero bytes up to `size`. For non-image / unrecognized `type` values, the
 * body is left as all-zero bytes (no known signature applies).
 */
function createMockFile(size: number, type: string): MockFile {
  const buffer = new ArrayBuffer(size)
  const bytes = new Uint8Array(buffer)
  const signature = REAL_SIGNATURE_BYTES[type]
  if (signature) {
    bytes.set(signature.slice(0, Math.min(signature.length, size)))
  }
  return {
    size,
    type,
    arrayBuffer: async () => buffer,
  }
}

/**
 * Builds a mock File-like object that *claims* `declaredType` via `.type`
 * but whose body bytes carry a different (or no) real signature — used to
 * simulate a spoofed / mismatched upload.
 */
function createSpoofedMockFile(size: number, declaredType: string, actualBytes: number[]): MockFile {
  const buffer = new ArrayBuffer(size)
  const bytes = new Uint8Array(buffer)
  bytes.set(actualBytes.slice(0, Math.min(actualBytes.length, size)))
  return {
    size,
    type: declaredType,
    arrayBuffer: async () => buffer,
  }
}

function createAdminSession(): SessionUser {
  return { id: 'user-admin-1', role: 'admin', email: 'admin@example.com' }
}

function createMemberSession(): SessionUser {
  return { id: 'user-member-1', role: 'member', email: 'member@example.com' }
}

async function loadUploadsService() {
  vi.resetModules()
  const mod = await import('@/lib/server/uploads-service')
  return {
    uploadLandingMediaImage: mod.uploadLandingMediaImage,
  }
}

describe('uploads-service', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    console.error = vi.fn()
    putMock.mockImplementation(async (pathname: string, _body: unknown, options: { contentType?: string }) => ({
      url: `https://example-store.public.blob.vercel-storage.com/${pathname}`,
      downloadUrl: `https://example-store.public.blob.vercel-storage.com/${pathname}?download=1`,
      pathname,
      contentType: options.contentType ?? 'application/octet-stream',
      contentDisposition: `inline; filename="${pathname}"`,
      etag: 'mock-etag',
    }))
  })

  describe('happy path — admin upload', () => {
    it('admin uploads valid PNG file → put() called, returns the URL put() resolved', async () => {
      const adminSession = createAdminSession()
      const mockFile = createMockFile(1024, 'image/png')
      const expectedBytes = new Uint8Array(await mockFile.arrayBuffer())

      const { uploadLandingMediaImage } = await loadUploadsService()

      const result = await uploadLandingMediaImage(adminSession, {
        file: mockFile,
        folder: 'events',
      })

      expect(putMock).toHaveBeenCalledTimes(1)
      const [pathname, body, options] = putMock.mock.calls[0]
      expect(pathname).toMatch(/^landing-media\/events\/[0-9a-f-]+\.png$/)
      // The exact bytes handed to put() must be the validated file body —
      // a regression that uploads e.g. an empty or re-encoded buffer would
      // still pass every other assertion here.
      expect(new Uint8Array(body as ArrayBuffer)).toEqual(expectedBytes)
      expect(options.contentType).toBe('image/png')
      expect(options.access).toBe('public')
      expect(options.addRandomSuffix).toBe(false)

      // The returned URL must be exactly what put() resolved, not just any
      // string that happens to contain the expected path segments.
      await expect(putMock.mock.results[0].value).resolves.toMatchObject({ url: result.url })
    })

    it('admin uploads valid JPEG file → extension .jpg derived from MIME', async () => {
      const adminSession = createAdminSession()
      const mockFile = createMockFile(2048, 'image/jpeg')

      const { uploadLandingMediaImage } = await loadUploadsService()

      await uploadLandingMediaImage(adminSession, {
        file: mockFile,
        folder: 'partners',
      })

      const [pathname] = putMock.mock.calls[0]
      expect(pathname).toMatch(/^landing-media\/partners\/[0-9a-f-]+\.jpg$/)
    })

    it('admin uploads valid WebP file → extension .webp derived from MIME', async () => {
      const adminSession = createAdminSession()
      const mockFile = createMockFile(512, 'image/webp')

      const { uploadLandingMediaImage } = await loadUploadsService()

      await uploadLandingMediaImage(adminSession, {
        file: mockFile,
        folder: 'library-games',
      })

      const [pathname] = putMock.mock.calls[0]
      expect(pathname).toMatch(/^landing-media\/library-games\/[0-9a-f-]+\.webp$/)
    })

    it('admin uploads valid GIF file → extension .gif derived from MIME', async () => {
      const adminSession = createAdminSession()
      const mockFile = createMockFile(256, 'image/gif')

      const { uploadLandingMediaImage } = await loadUploadsService()

      await uploadLandingMediaImage(adminSession, {
        file: mockFile,
        folder: 'events',
      })

      const [pathname] = putMock.mock.calls[0]
      expect(pathname).toMatch(/^landing-media\/events\/[0-9a-f-]+\.gif$/)
    })
  })

  describe('privilege checks', () => {
    it('non-admin member gets 403 Forbidden before any put() call', async () => {
      const memberSession = createMemberSession()
      const mockFile = createMockFile(1024, 'image/png')

      const { uploadLandingMediaImage } = await loadUploadsService()

      await expect(
        uploadLandingMediaImage(memberSession, {
          file: mockFile,
          folder: 'events',
        })
      ).rejects.toMatchObject({ statusCode: 403 })

      expect(putMock).not.toHaveBeenCalled()
    })
  })

  describe('validation matrix — file missing', () => {
    it('missing file (null) → 400 before put() call', async () => {
      const adminSession = createAdminSession()

      const { uploadLandingMediaImage } = await loadUploadsService()

      await expect(
        uploadLandingMediaImage(adminSession, {
          file: null,
          folder: 'events',
        })
      ).rejects.toMatchObject({ statusCode: 400 })

      expect(putMock).not.toHaveBeenCalled()
    })
  })

  describe('validation matrix — folder outside allowlist', () => {
    it('folder: parent directory "../etc" → 400 before put() call', async () => {
      const adminSession = createAdminSession()
      const mockFile = createMockFile(1024, 'image/png')

      const { uploadLandingMediaImage } = await loadUploadsService()

      await expect(
        uploadLandingMediaImage(adminSession, {
          file: mockFile,
          folder: '../etc',
        })
      ).rejects.toMatchObject({ statusCode: 400 })

      expect(putMock).not.toHaveBeenCalled()
    })

    it('folder: "avatars" (not in allowlist) → 400 before put() call', async () => {
      const adminSession = createAdminSession()
      const mockFile = createMockFile(1024, 'image/png')

      const { uploadLandingMediaImage } = await loadUploadsService()

      await expect(
        uploadLandingMediaImage(adminSession, {
          file: mockFile,
          folder: 'avatars',
        })
      ).rejects.toMatchObject({ statusCode: 400 })

      expect(putMock).not.toHaveBeenCalled()
    })

    it('folder: empty string → 400 before put() call', async () => {
      const adminSession = createAdminSession()
      const mockFile = createMockFile(1024, 'image/png')

      const { uploadLandingMediaImage } = await loadUploadsService()

      await expect(
        uploadLandingMediaImage(adminSession, {
          file: mockFile,
          folder: '',
        })
      ).rejects.toMatchObject({ statusCode: 400 })

      expect(putMock).not.toHaveBeenCalled()
    })
  })

  describe('validation matrix — MIME type not allowed', () => {
    it('MIME: image/svg+xml → 400 before put() call', async () => {
      const adminSession = createAdminSession()
      const mockFile = createMockFile(1024, 'image/svg+xml')

      const { uploadLandingMediaImage } = await loadUploadsService()

      await expect(
        uploadLandingMediaImage(adminSession, {
          file: mockFile,
          folder: 'events',
        })
      ).rejects.toMatchObject({ statusCode: 400 })

      expect(putMock).not.toHaveBeenCalled()
    })

    it('MIME: application/pdf → 400 before put() call', async () => {
      const adminSession = createAdminSession()
      const mockFile = createMockFile(1024, 'application/pdf')

      const { uploadLandingMediaImage } = await loadUploadsService()

      await expect(
        uploadLandingMediaImage(adminSession, {
          file: mockFile,
          folder: 'events',
        })
      ).rejects.toMatchObject({ statusCode: 400 })

      expect(putMock).not.toHaveBeenCalled()
    })

    it('MIME: text/html → 400 before put() call', async () => {
      const adminSession = createAdminSession()
      const mockFile = createMockFile(1024, 'text/html')

      const { uploadLandingMediaImage } = await loadUploadsService()

      await expect(
        uploadLandingMediaImage(adminSession, {
          file: mockFile,
          folder: 'events',
        })
      ).rejects.toMatchObject({ statusCode: 400 })

      expect(putMock).not.toHaveBeenCalled()
    })
  })

  describe('validation matrix — file size outside bounds', () => {
    it('file size > 5 MB → 400 before put() call', async () => {
      const adminSession = createAdminSession()
      const fiveMBPlus = 5 * 1024 * 1024 + 1
      const mockFile = createMockFile(fiveMBPlus, 'image/png')

      const { uploadLandingMediaImage } = await loadUploadsService()

      await expect(
        uploadLandingMediaImage(adminSession, {
          file: mockFile,
          folder: 'events',
        })
      ).rejects.toMatchObject({ statusCode: 400 })

      expect(putMock).not.toHaveBeenCalled()
    })

    it('file size 0 bytes (empty) → 400 before put() call', async () => {
      const adminSession = createAdminSession()
      const mockFile = createMockFile(0, 'image/png')

      const { uploadLandingMediaImage } = await loadUploadsService()

      await expect(
        uploadLandingMediaImage(adminSession, {
          file: mockFile,
          folder: 'events',
        })
      ).rejects.toMatchObject({ statusCode: 400 })

      expect(putMock).not.toHaveBeenCalled()
    })

    it('file size exactly 5 MB (boundary) → allowed', async () => {
      const adminSession = createAdminSession()
      const fiveMB = 5 * 1024 * 1024
      const mockFile = createMockFile(fiveMB, 'image/png')

      const { uploadLandingMediaImage } = await loadUploadsService()

      const result = await uploadLandingMediaImage(adminSession, {
        file: mockFile,
        folder: 'events',
      })

      expect(result.url).toBeDefined()
      expect(putMock).toHaveBeenCalled()
    })
  })

  describe('extension derived from MIME not filename', () => {
    it('file named "evil.svg" with type image/png → stored as .png', async () => {
      const adminSession = createAdminSession()
      const mockFile = createMockFile(1024, 'image/png')

      const { uploadLandingMediaImage } = await loadUploadsService()

      await uploadLandingMediaImage(adminSession, {
        file: mockFile,
        folder: 'partners',
      })

      const [pathname] = putMock.mock.calls[0]
      // Path should end with .png, not .svg
      expect(pathname).toMatch(/\.png$/)
      expect(pathname).not.toMatch(/\.svg/)
    })
  })

  describe('magic-byte verification — body does not match declared MIME', () => {
    it('file.type is "image/png" but body is not PNG (plain text bytes) → 400, put() never called', async () => {
      const adminSession = createAdminSession()
      const textBytes = Array.from(Buffer.from('not a real png file contents'))
      const mockFile = createSpoofedMockFile(1024, 'image/png', textBytes)

      const { uploadLandingMediaImage } = await loadUploadsService()

      await expect(
        uploadLandingMediaImage(adminSession, {
          file: mockFile,
          folder: 'events',
        })
      ).rejects.toMatchObject({ statusCode: 400 })

      expect(putMock).not.toHaveBeenCalled()
    })

    it('file.type is "image/jpeg" but body is not JPEG (plain text bytes) → 400, put() never called', async () => {
      const adminSession = createAdminSession()
      const textBytes = Array.from(Buffer.from('definitely not a jpeg'))
      const mockFile = createSpoofedMockFile(1024, 'image/jpeg', textBytes)

      const { uploadLandingMediaImage } = await loadUploadsService()

      await expect(
        uploadLandingMediaImage(adminSession, {
          file: mockFile,
          folder: 'events',
        })
      ).rejects.toMatchObject({ statusCode: 400 })

      expect(putMock).not.toHaveBeenCalled()
    })

    it('file.type is "image/png" but body bytes are a real JPEG signature (cross-format mismatch) → 400', async () => {
      const adminSession = createAdminSession()
      const mockFile = createSpoofedMockFile(1024, 'image/png', REAL_SIGNATURE_BYTES['image/jpeg'])

      const { uploadLandingMediaImage } = await loadUploadsService()

      await expect(
        uploadLandingMediaImage(adminSession, {
          file: mockFile,
          folder: 'events',
        })
      ).rejects.toMatchObject({ statusCode: 400 })

      expect(putMock).not.toHaveBeenCalled()
    })

    it('file.type is "image/webp" but body bytes are a real GIF signature (cross-format mismatch) → 400', async () => {
      const adminSession = createAdminSession()
      const mockFile = createSpoofedMockFile(1024, 'image/webp', REAL_SIGNATURE_BYTES['image/gif'])

      const { uploadLandingMediaImage } = await loadUploadsService()

      await expect(
        uploadLandingMediaImage(adminSession, {
          file: mockFile,
          folder: 'events',
        })
      ).rejects.toMatchObject({ statusCode: 400 })

      expect(putMock).not.toHaveBeenCalled()
    })

    it('real matching PNG signature with file.type "image/png" → passes and uploads', async () => {
      const adminSession = createAdminSession()
      const mockFile = createMockFile(1024, 'image/png')

      const { uploadLandingMediaImage } = await loadUploadsService()

      const result = await uploadLandingMediaImage(adminSession, {
        file: mockFile,
        folder: 'events',
      })

      expect(result.url).toBeDefined()
      expect(putMock).toHaveBeenCalled()
    })

    it('real matching JPEG signature with file.type "image/jpeg" → passes and uploads', async () => {
      const adminSession = createAdminSession()
      const mockFile = createMockFile(1024, 'image/jpeg')

      const { uploadLandingMediaImage } = await loadUploadsService()

      const result = await uploadLandingMediaImage(adminSession, {
        file: mockFile,
        folder: 'events',
      })

      expect(result.url).toBeDefined()
      expect(putMock).toHaveBeenCalled()
    })
  })

  describe('blob error handling', () => {
    it('put() throws → 500 ServiceError and console.error called', async () => {
      const adminSession = createAdminSession()
      const mockFile = createMockFile(1024, 'image/png')

      putMock.mockRejectedValueOnce(new Error('Blob store misconfigured'))

      const { uploadLandingMediaImage } = await loadUploadsService()

      await expect(
        uploadLandingMediaImage(adminSession, {
          file: mockFile,
          folder: 'events',
        })
      ).rejects.toMatchObject({ statusCode: 500 })

      expect(console.error).toHaveBeenCalled()
    })

    it('put() rejects with a non-Error value → 500 ServiceError and console.error called', async () => {
      const adminSession = createAdminSession()
      const mockFile = createMockFile(1024, 'image/png')

      putMock.mockRejectedValueOnce('string failure')

      const { uploadLandingMediaImage } = await loadUploadsService()

      await expect(
        uploadLandingMediaImage(adminSession, {
          file: mockFile,
          folder: 'events',
        })
      ).rejects.toMatchObject({ statusCode: 500 })

      expect(console.error).toHaveBeenCalled()
    })
  })
})
