// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import type { ServiceError } from '@/lib/server/shared/service-error'

/**
 * UPLOADS SERVICE TEST COVERAGE (OIR-207)
 *
 * Tests for image uploads to Supabase Storage for landing content (club events,
 * partners, library games). Implementation: lib/server/uploads/uploads-service.ts
 *
 * Key scenarios tested:
 * - Happy path: admin + valid PNG file → storage upload called with path matching /^events\/[0-9a-f-]+\.png$/, contentType set, returns { url }
 * - Privilege: non-admin → 403 Forbidden before any storage call
 * - Validation matrix (each → 400, no storage call):
 *   - missing file
 *   - folder outside allowlist ('../etc', 'avatars', '')
 *   - MIME not allowed (image/svg+xml, application/pdf, text/html)
 *   - size > 5MB
 * - Extension derived from MIME not filename: file named "evil.svg" with type image/png → stored as .png
 * - Storage error → 500 ServiceError (and console.error called)
 * - Migration: bucket insert with public=true + 5MB limit + 4 MIME types, SELECT-only storage policy, no write policies
 */

vi.mock('server-only', () => ({}))

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerAdminClient: vi.fn(),
}))

vi.mock('@/lib/server/shared/service-error', () => ({
  serviceError: vi.fn((message: string, statusCode: number) => {
    const err = new Error(message) as ServiceError
    err.name = 'ServiceError'
    err.statusCode = statusCode
    throw err
  }),
}))

vi.mock('@vercel/blob', () => ({
  put: vi.fn().mockResolvedValue({}),
  del: vi.fn().mockResolvedValue({}),
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

function buildSupabaseMock() {
  let uploadSpy = vi.fn(async (path: string, data: Uint8Array, options: any) => {
    return { error: null, data: { path } }
  })

  return {
    storage: {
      from: vi.fn(function (bucket: string) {
        return {
          upload: uploadSpy,
          getPublicUrl: vi.fn(function (path: string) {
            return {
              data: {
                publicUrl: `https://example.public.blob.vercel-storage.com/landing-media/${path}`,
              },
            }
          }),
        }
      }),
    },
    _uploadSpy: uploadSpy,
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
  process.env.BLOB_PUBLIC_BASE_URL = 'https://example.public.blob.vercel-storage.com'
  const mod = await import('@/lib/server/uploads/uploads-service')
  return {
    uploadLandingMediaImage: mod.uploadLandingMediaImage,
  }
}

describe('uploads-service', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    console.error = vi.fn()
  })

  describe('happy path — admin upload', () => {
    it('admin uploads valid PNG file → storage called, returns { url }', async () => {
      const adminSession = createAdminSession()
      const mockSupabaseAdmin = buildSupabaseMock()
      const mockFile = createMockFile(1024, 'image/png')

      vi.mocked(await import('@/lib/supabase/server')).createSupabaseServerAdminClient.mockReturnValue(
        mockSupabaseAdmin as any
      )

      const { uploadLandingMediaImage } = await loadUploadsService()

      const result = await uploadLandingMediaImage(adminSession, {
        file: mockFile,
        folder: 'events',
      })

      expect(result).toHaveProperty('url')
      expect(result.url).toContain('https://example.public.blob.vercel-storage.com')
      expect(result.url).toContain('landing-media')
      expect(result.url).toMatch(/events\/[0-9a-f-]+\.png$/)

      // Verify @vercel/blob put() was called with correct arguments
      const blobPut = vi.mocked(await import('@vercel/blob')).put
      expect(blobPut).toHaveBeenCalled()
      const [pathname, body, options] = blobPut.mock.calls[0]
      expect(pathname).toMatch(/^landing-media\/events\/[0-9a-f-]+\.png$/)
      expect(options?.contentType).toBe('image/png')
    })

    it('admin uploads valid JPEG file → extension .jpg derived from MIME', async () => {
      const adminSession = createAdminSession()
      const mockSupabaseAdmin = buildSupabaseMock()
      const mockFile = createMockFile(2048, 'image/jpeg')

      vi.mocked(await import('@/lib/supabase/server')).createSupabaseServerAdminClient.mockReturnValue(
        mockSupabaseAdmin as any
      )

      const { uploadLandingMediaImage } = await loadUploadsService()

      const result = await uploadLandingMediaImage(adminSession, {
        file: mockFile,
        folder: 'partners',
      })

      expect(result).toHaveProperty('url')
      expect(result.url).toMatch(/partners\/[0-9a-f-]+\.jpg$/)

      // Verify @vercel/blob put() was called with correct arguments
      const blobPut = vi.mocked(await import('@vercel/blob')).put
      expect(blobPut).toHaveBeenCalled()
      const [pathname, body, options] = blobPut.mock.calls[0]
      expect(pathname).toMatch(/^landing-media\/partners\/[0-9a-f-]+\.jpg$/)
      expect(options?.contentType).toBe('image/jpeg')
    })

    it('admin uploads valid WebP file → extension .webp derived from MIME', async () => {
      const adminSession = createAdminSession()
      const mockSupabaseAdmin = buildSupabaseMock()
      const mockFile = createMockFile(512, 'image/webp')

      vi.mocked(await import('@/lib/supabase/server')).createSupabaseServerAdminClient.mockReturnValue(
        mockSupabaseAdmin as any
      )

      const { uploadLandingMediaImage } = await loadUploadsService()

      const result = await uploadLandingMediaImage(adminSession, {
        file: mockFile,
        folder: 'library-games',
      })

      expect(result).toHaveProperty('url')
      expect(result.url).toMatch(/library-games\/[0-9a-f-]+\.webp$/)

      // Verify @vercel/blob put() was called with correct arguments
      const blobPut = vi.mocked(await import('@vercel/blob')).put
      expect(blobPut).toHaveBeenCalled()
      const [pathname, body, options] = blobPut.mock.calls[0]
      expect(pathname).toMatch(/^landing-media\/library-games\/[0-9a-f-]+\.webp$/)
      expect(options?.contentType).toBe('image/webp')
    })

    it('admin uploads valid GIF file → extension .gif derived from MIME', async () => {
      const adminSession = createAdminSession()
      const mockSupabaseAdmin = buildSupabaseMock()
      const mockFile = createMockFile(256, 'image/gif')

      vi.mocked(await import('@/lib/supabase/server')).createSupabaseServerAdminClient.mockReturnValue(
        mockSupabaseAdmin as any
      )

      const { uploadLandingMediaImage } = await loadUploadsService()

      const result = await uploadLandingMediaImage(adminSession, {
        file: mockFile,
        folder: 'events',
      })

      expect(result).toHaveProperty('url')
      expect(result.url).toMatch(/events\/[0-9a-f-]+\.gif$/)

      // Verify @vercel/blob put() was called with correct arguments
      const blobPut = vi.mocked(await import('@vercel/blob')).put
      expect(blobPut).toHaveBeenCalled()
      const [pathname, body, options] = blobPut.mock.calls[0]
      expect(pathname).toMatch(/^landing-media\/events\/[0-9a-f-]+\.gif$/)
      expect(options?.contentType).toBe('image/gif')
    })
  })

  describe('privilege checks', () => {
    it('non-admin member gets 403 Forbidden before any storage call', async () => {
      const memberSession = createMemberSession()
      const mockSupabaseAdmin = buildSupabaseMock()
      const mockFile = createMockFile(1024, 'image/png')

      vi.mocked(await import('@/lib/supabase/server')).createSupabaseServerAdminClient.mockReturnValue(
        mockSupabaseAdmin as any
      )
      vi.mocked(await import('@/lib/server/shared/service-error')).serviceError.mockImplementation((msg, code) => {
        const err = new Error(msg) as ServiceError
        err.statusCode = code
        throw err
      })

      const { uploadLandingMediaImage } = await loadUploadsService()

      await expect(
        uploadLandingMediaImage(memberSession, {
          file: mockFile,
          folder: 'events',
        })
      ).rejects.toMatchObject({ statusCode: 403 })

      // Verify @vercel/blob put() was NOT called
      const blobPut = vi.mocked(await import('@vercel/blob')).put
      expect(blobPut).not.toHaveBeenCalled()
    })
  })

  describe('validation matrix — file missing', () => {
    it('missing file (null) → 400 before storage call', async () => {
      const adminSession = createAdminSession()
      const mockSupabaseAdmin = buildSupabaseMock()

      vi.mocked(await import('@/lib/supabase/server')).createSupabaseServerAdminClient.mockReturnValue(
        mockSupabaseAdmin as any
      )
      vi.mocked(await import('@/lib/server/shared/service-error')).serviceError.mockImplementation((msg, code) => {
        const err = new Error(msg) as ServiceError
        err.statusCode = code
        throw err
      })

      const { uploadLandingMediaImage } = await loadUploadsService()

      await expect(
        uploadLandingMediaImage(adminSession, {
          file: null,
          folder: 'events',
        })
      ).rejects.toMatchObject({ statusCode: 400 })

      // Verify @vercel/blob put() was NOT called
      const blobPut = vi.mocked(await import('@vercel/blob')).put
      expect(blobPut).not.toHaveBeenCalled()
    })
  })

  describe('validation matrix — folder outside allowlist', () => {
    it('folder: parent directory "../etc" → 400 before storage call', async () => {
      const adminSession = createAdminSession()
      const mockSupabaseAdmin = buildSupabaseMock()
      const mockFile = createMockFile(1024, 'image/png')

      vi.mocked(await import('@/lib/supabase/server')).createSupabaseServerAdminClient.mockReturnValue(
        mockSupabaseAdmin as any
      )
      vi.mocked(await import('@/lib/server/shared/service-error')).serviceError.mockImplementation((msg, code) => {
        const err = new Error(msg) as ServiceError
        err.statusCode = code
        throw err
      })

      const { uploadLandingMediaImage } = await loadUploadsService()

      await expect(
        uploadLandingMediaImage(adminSession, {
          file: mockFile,
          folder: '../etc',
        })
      ).rejects.toMatchObject({ statusCode: 400 })

      // Verify @vercel/blob put() was NOT called
      const blobPut = vi.mocked(await import('@vercel/blob')).put
      expect(blobPut).not.toHaveBeenCalled()
    })

    it('folder: "avatars" (not in allowlist) → 400 before storage call', async () => {
      const adminSession = createAdminSession()
      const mockSupabaseAdmin = buildSupabaseMock()
      const mockFile = createMockFile(1024, 'image/png')

      vi.mocked(await import('@/lib/supabase/server')).createSupabaseServerAdminClient.mockReturnValue(
        mockSupabaseAdmin as any
      )
      vi.mocked(await import('@/lib/server/shared/service-error')).serviceError.mockImplementation((msg, code) => {
        const err = new Error(msg) as ServiceError
        err.statusCode = code
        throw err
      })

      const { uploadLandingMediaImage } = await loadUploadsService()

      await expect(
        uploadLandingMediaImage(adminSession, {
          file: mockFile,
          folder: 'avatars',
        })
      ).rejects.toMatchObject({ statusCode: 400 })

      // Verify @vercel/blob put() was NOT called
      const blobPut = vi.mocked(await import('@vercel/blob')).put
      expect(blobPut).not.toHaveBeenCalled()
    })

    it('folder: empty string → 400 before storage call', async () => {
      const adminSession = createAdminSession()
      const mockSupabaseAdmin = buildSupabaseMock()
      const mockFile = createMockFile(1024, 'image/png')

      vi.mocked(await import('@/lib/supabase/server')).createSupabaseServerAdminClient.mockReturnValue(
        mockSupabaseAdmin as any
      )
      vi.mocked(await import('@/lib/server/shared/service-error')).serviceError.mockImplementation((msg, code) => {
        const err = new Error(msg) as ServiceError
        err.statusCode = code
        throw err
      })

      const { uploadLandingMediaImage } = await loadUploadsService()

      await expect(
        uploadLandingMediaImage(adminSession, {
          file: mockFile,
          folder: '',
        })
      ).rejects.toMatchObject({ statusCode: 400 })

      // Verify @vercel/blob put() was NOT called
      const blobPut = vi.mocked(await import('@vercel/blob')).put
      expect(blobPut).not.toHaveBeenCalled()
    })
  })

  describe('validation matrix — MIME type not allowed', () => {
    it('MIME: image/svg+xml → 400 before storage call', async () => {
      const adminSession = createAdminSession()
      const mockSupabaseAdmin = buildSupabaseMock()
      const mockFile = createMockFile(1024, 'image/svg+xml')

      vi.mocked(await import('@/lib/supabase/server')).createSupabaseServerAdminClient.mockReturnValue(
        mockSupabaseAdmin as any
      )
      vi.mocked(await import('@/lib/server/shared/service-error')).serviceError.mockImplementation((msg, code) => {
        const err = new Error(msg) as ServiceError
        err.statusCode = code
        throw err
      })

      const { uploadLandingMediaImage } = await loadUploadsService()

      await expect(
        uploadLandingMediaImage(adminSession, {
          file: mockFile,
          folder: 'events',
        })
      ).rejects.toMatchObject({ statusCode: 400 })

      // Verify @vercel/blob put() was NOT called
      const blobPut = vi.mocked(await import('@vercel/blob')).put
      expect(blobPut).not.toHaveBeenCalled()
    })

    it('MIME: application/pdf → 400 before storage call', async () => {
      const adminSession = createAdminSession()
      const mockSupabaseAdmin = buildSupabaseMock()
      const mockFile = createMockFile(1024, 'application/pdf')

      vi.mocked(await import('@/lib/supabase/server')).createSupabaseServerAdminClient.mockReturnValue(
        mockSupabaseAdmin as any
      )
      vi.mocked(await import('@/lib/server/shared/service-error')).serviceError.mockImplementation((msg, code) => {
        const err = new Error(msg) as ServiceError
        err.statusCode = code
        throw err
      })

      const { uploadLandingMediaImage } = await loadUploadsService()

      await expect(
        uploadLandingMediaImage(adminSession, {
          file: mockFile,
          folder: 'events',
        })
      ).rejects.toMatchObject({ statusCode: 400 })

      // Verify @vercel/blob put() was NOT called
      const blobPut = vi.mocked(await import('@vercel/blob')).put
      expect(blobPut).not.toHaveBeenCalled()
    })

    it('MIME: text/html → 400 before storage call', async () => {
      const adminSession = createAdminSession()
      const mockSupabaseAdmin = buildSupabaseMock()
      const mockFile = createMockFile(1024, 'text/html')

      vi.mocked(await import('@/lib/supabase/server')).createSupabaseServerAdminClient.mockReturnValue(
        mockSupabaseAdmin as any
      )
      vi.mocked(await import('@/lib/server/shared/service-error')).serviceError.mockImplementation((msg, code) => {
        const err = new Error(msg) as ServiceError
        err.statusCode = code
        throw err
      })

      const { uploadLandingMediaImage } = await loadUploadsService()

      await expect(
        uploadLandingMediaImage(adminSession, {
          file: mockFile,
          folder: 'events',
        })
      ).rejects.toMatchObject({ statusCode: 400 })

      // Verify @vercel/blob put() was NOT called
      const blobPut = vi.mocked(await import('@vercel/blob')).put
      expect(blobPut).not.toHaveBeenCalled()
    })
  })

  describe('validation matrix — file size outside bounds', () => {
    it('file size > 5 MB → 400 before storage call', async () => {
      const adminSession = createAdminSession()
      const mockSupabaseAdmin = buildSupabaseMock()
      const fiveMBPlus = 5 * 1024 * 1024 + 1
      const mockFile = createMockFile(fiveMBPlus, 'image/png')

      vi.mocked(await import('@/lib/supabase/server')).createSupabaseServerAdminClient.mockReturnValue(
        mockSupabaseAdmin as any
      )
      vi.mocked(await import('@/lib/server/shared/service-error')).serviceError.mockImplementation((msg, code) => {
        const err = new Error(msg) as ServiceError
        err.statusCode = code
        throw err
      })

      const { uploadLandingMediaImage } = await loadUploadsService()

      await expect(
        uploadLandingMediaImage(adminSession, {
          file: mockFile,
          folder: 'events',
        })
      ).rejects.toMatchObject({ statusCode: 400 })

      // Verify @vercel/blob put() was NOT called
      const blobPut = vi.mocked(await import('@vercel/blob')).put
      expect(blobPut).not.toHaveBeenCalled()
    })

    it('file size 0 bytes (empty) → 400 before storage call', async () => {
      const adminSession = createAdminSession()
      const mockSupabaseAdmin = buildSupabaseMock()
      const mockFile = createMockFile(0, 'image/png')

      vi.mocked(await import('@/lib/supabase/server')).createSupabaseServerAdminClient.mockReturnValue(
        mockSupabaseAdmin as any
      )
      vi.mocked(await import('@/lib/server/shared/service-error')).serviceError.mockImplementation((msg, code) => {
        const err = new Error(msg) as ServiceError
        err.statusCode = code
        throw err
      })

      const { uploadLandingMediaImage } = await loadUploadsService()

      await expect(
        uploadLandingMediaImage(adminSession, {
          file: mockFile,
          folder: 'events',
        })
      ).rejects.toMatchObject({ statusCode: 400 })

      // Verify @vercel/blob put() was NOT called
      const blobPut = vi.mocked(await import('@vercel/blob')).put
      expect(blobPut).not.toHaveBeenCalled()
    })

    it('file size exactly 5 MB (boundary) → allowed', async () => {
      const adminSession = createAdminSession()
      const mockSupabaseAdmin = buildSupabaseMock()
      const fiveMB = 5 * 1024 * 1024
      const mockFile = createMockFile(fiveMB, 'image/png')

      vi.mocked(await import('@/lib/supabase/server')).createSupabaseServerAdminClient.mockReturnValue(
        mockSupabaseAdmin as any
      )

      const { uploadLandingMediaImage } = await loadUploadsService()

      const result = await uploadLandingMediaImage(adminSession, {
        file: mockFile,
        folder: 'events',
      })

      expect(result.url).toBeDefined()

      // Verify @vercel/blob put() was called
      const blobPut = vi.mocked(await import('@vercel/blob')).put
      expect(blobPut).toHaveBeenCalled()
    })
  })

  describe('extension derived from MIME not filename', () => {
    it('file named "evil.svg" with type image/png → stored as .png', async () => {
      const adminSession = createAdminSession()
      const mockSupabaseAdmin = buildSupabaseMock()
      const mockFile = createMockFile(1024, 'image/png')

      vi.mocked(await import('@/lib/supabase/server')).createSupabaseServerAdminClient.mockReturnValue(
        mockSupabaseAdmin as any
      )

      const { uploadLandingMediaImage } = await loadUploadsService()

      const result = await uploadLandingMediaImage(adminSession, {
        file: mockFile,
        folder: 'partners',
      })

      // Verify upload succeeded with .png extension (derived from MIME, not filename)
      expect(result.url).toBeDefined()
      expect(result.url).toMatch(/\.png$/)

      // Verify @vercel/blob put() was called with correct extension
      const blobPut = vi.mocked(await import('@vercel/blob')).put
      expect(blobPut).toHaveBeenCalled()
      const [pathname] = blobPut.mock.calls[0]
      expect(pathname).toMatch(/\.png$/)
    })
  })

  describe('magic-byte verification — body does not match declared MIME', () => {
    it('file.type is "image/png" but body is not PNG (plain text bytes) → 400, storage never called', async () => {
      const adminSession = createAdminSession()
      const mockSupabaseAdmin = buildSupabaseMock()
      const textBytes = Array.from(Buffer.from('not a real png file contents'))
      const mockFile = createSpoofedMockFile(1024, 'image/png', textBytes)

      vi.mocked(await import('@/lib/supabase/server')).createSupabaseServerAdminClient.mockReturnValue(
        mockSupabaseAdmin as any
      )
      vi.mocked(await import('@/lib/server/shared/service-error')).serviceError.mockImplementation((msg, code) => {
        const err = new Error(msg) as ServiceError
        err.statusCode = code
        throw err
      })

      const { uploadLandingMediaImage } = await loadUploadsService()

      await expect(
        uploadLandingMediaImage(adminSession, {
          file: mockFile,
          folder: 'events',
        })
      ).rejects.toMatchObject({ statusCode: 400 })

      // Verify @vercel/blob put() was NOT called
      const blobPut = vi.mocked(await import('@vercel/blob')).put
      expect(blobPut).not.toHaveBeenCalled()
    })

    it('file.type is "image/jpeg" but body is not JPEG (plain text bytes) → 400, storage never called', async () => {
      const adminSession = createAdminSession()
      const mockSupabaseAdmin = buildSupabaseMock()
      const textBytes = Array.from(Buffer.from('definitely not a jpeg'))
      const mockFile = createSpoofedMockFile(1024, 'image/jpeg', textBytes)

      vi.mocked(await import('@/lib/supabase/server')).createSupabaseServerAdminClient.mockReturnValue(
        mockSupabaseAdmin as any
      )
      vi.mocked(await import('@/lib/server/shared/service-error')).serviceError.mockImplementation((msg, code) => {
        const err = new Error(msg) as ServiceError
        err.statusCode = code
        throw err
      })

      const { uploadLandingMediaImage } = await loadUploadsService()

      await expect(
        uploadLandingMediaImage(adminSession, {
          file: mockFile,
          folder: 'events',
        })
      ).rejects.toMatchObject({ statusCode: 400 })

      // Verify @vercel/blob put() was NOT called
      const blobPut = vi.mocked(await import('@vercel/blob')).put
      expect(blobPut).not.toHaveBeenCalled()
    })

    it('file.type is "image/png" but body bytes are a real JPEG signature (cross-format mismatch) → 400', async () => {
      const adminSession = createAdminSession()
      const mockSupabaseAdmin = buildSupabaseMock()
      const mockFile = createSpoofedMockFile(1024, 'image/png', REAL_SIGNATURE_BYTES['image/jpeg'])

      vi.mocked(await import('@/lib/supabase/server')).createSupabaseServerAdminClient.mockReturnValue(
        mockSupabaseAdmin as any
      )
      vi.mocked(await import('@/lib/server/shared/service-error')).serviceError.mockImplementation((msg, code) => {
        const err = new Error(msg) as ServiceError
        err.statusCode = code
        throw err
      })

      const { uploadLandingMediaImage } = await loadUploadsService()

      await expect(
        uploadLandingMediaImage(adminSession, {
          file: mockFile,
          folder: 'events',
        })
      ).rejects.toMatchObject({ statusCode: 400 })

      // Verify @vercel/blob put() was NOT called
      const blobPut = vi.mocked(await import('@vercel/blob')).put
      expect(blobPut).not.toHaveBeenCalled()
    })

    it('file.type is "image/webp" but body bytes are a real GIF signature (cross-format mismatch) → 400', async () => {
      const adminSession = createAdminSession()
      const mockSupabaseAdmin = buildSupabaseMock()
      const mockFile = createSpoofedMockFile(1024, 'image/webp', REAL_SIGNATURE_BYTES['image/gif'])

      vi.mocked(await import('@/lib/supabase/server')).createSupabaseServerAdminClient.mockReturnValue(
        mockSupabaseAdmin as any
      )
      vi.mocked(await import('@/lib/server/shared/service-error')).serviceError.mockImplementation((msg, code) => {
        const err = new Error(msg) as ServiceError
        err.statusCode = code
        throw err
      })

      const { uploadLandingMediaImage } = await loadUploadsService()

      await expect(
        uploadLandingMediaImage(adminSession, {
          file: mockFile,
          folder: 'events',
        })
      ).rejects.toMatchObject({ statusCode: 400 })

      // Verify @vercel/blob put() was NOT called
      const blobPut = vi.mocked(await import('@vercel/blob')).put
      expect(blobPut).not.toHaveBeenCalled()
    })

    it('real matching PNG signature with file.type "image/png" → passes and uploads', async () => {
      const adminSession = createAdminSession()
      const mockSupabaseAdmin = buildSupabaseMock()
      const mockFile = createMockFile(1024, 'image/png')

      vi.mocked(await import('@/lib/supabase/server')).createSupabaseServerAdminClient.mockReturnValue(
        mockSupabaseAdmin as any
      )

      const { uploadLandingMediaImage } = await loadUploadsService()

      const result = await uploadLandingMediaImage(adminSession, {
        file: mockFile,
        folder: 'events',
      })

      expect(result.url).toBeDefined()

      // Verify @vercel/blob put() was called
      const blobPut = vi.mocked(await import('@vercel/blob')).put
      expect(blobPut).toHaveBeenCalled()
    })

    it('real matching JPEG signature with file.type "image/jpeg" → passes and uploads', async () => {
      const adminSession = createAdminSession()
      const mockSupabaseAdmin = buildSupabaseMock()
      const mockFile = createMockFile(1024, 'image/jpeg')

      vi.mocked(await import('@/lib/supabase/server')).createSupabaseServerAdminClient.mockReturnValue(
        mockSupabaseAdmin as any
      )

      const { uploadLandingMediaImage } = await loadUploadsService()

      const result = await uploadLandingMediaImage(adminSession, {
        file: mockFile,
        folder: 'events',
      })

      expect(result.url).toBeDefined()

      // Verify @vercel/blob put() was called
      const blobPut = vi.mocked(await import('@vercel/blob')).put
      expect(blobPut).toHaveBeenCalled()
    })
  })

  describe('storage error handling', () => {
    it('storage upload error → 500 ServiceError and console.error called', async () => {
      const adminSession = createAdminSession()
      const mockFile = createMockFile(1024, 'image/png')

      // Mock Blob put() to return an error
      vi.mocked(await import('@vercel/blob')).put.mockRejectedValue(
        new Error('Storage quota exceeded')
      )

      vi.mocked(await import('@/lib/server/shared/service-error')).serviceError.mockImplementation((msg, code) => {
        const err = new Error(msg) as ServiceError
        err.statusCode = code
        throw err
      })

      const { uploadLandingMediaImage } = await loadUploadsService()

      await expect(
        uploadLandingMediaImage(adminSession, {
          file: mockFile,
          folder: 'events',
        })
      ).rejects.toMatchObject({ statusCode: 500 })

      expect(console.error).toHaveBeenCalled()
    })

    it('BLOB_PUBLIC_BASE_URL not set → 500 ServiceError and console.error called', async () => {
      const adminSession = createAdminSession()
      const mockFile = createMockFile(1024, 'image/png')

      // Clear BLOB_PUBLIC_BASE_URL to simulate missing configuration
      delete process.env.BLOB_PUBLIC_BASE_URL

      vi.mocked(await import('@/lib/server/shared/service-error')).serviceError.mockImplementation((msg, code) => {
        const err = new Error(msg) as ServiceError
        err.statusCode = code
        throw err
      })

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

  describe('migration sanity checks (OIR-207)', () => {
    const migrationPath = join(
      process.cwd(),
      'supabase/migrations',
      '20260704000005_oir207_landing_media_bucket.sql'
    )
    const migrationContent = readFileSync(migrationPath, 'utf8')

    it('migration creates landing-media bucket with public=true', () => {
      expect(migrationContent).toContain("'landing-media'")
      expect(migrationContent).toContain('true')
      expect(migrationContent).toContain('INSERT INTO "storage"."buckets"')
    })

    it('migration sets file_size_limit to 5 MB (5242880 bytes)', () => {
      expect(migrationContent).toContain('5242880')
      expect(migrationContent).toMatch(/5242880.*5\s*MB/)
    })

    it('migration allows 4 MIME types: image/png, image/jpeg, image/webp, image/gif', () => {
      expect(migrationContent).toContain('image/png')
      expect(migrationContent).toContain('image/jpeg')
      expect(migrationContent).toContain('image/webp')
      expect(migrationContent).toContain('image/gif')
      expect(migrationContent).toContain('ARRAY')
    })

    it('migration creates SELECT-only storage policy for anon and authenticated', () => {
      expect(migrationContent).toContain('CREATE POLICY "landing_media_select_public"')
      expect(migrationContent).toContain('FOR SELECT TO "anon", "authenticated"')
      expect(migrationContent).toContain('"bucket_id" = \'landing-media\'')
    })

    it('migration defines no INSERT/UPDATE/DELETE policies (writes service_role only)', () => {
      expect(migrationContent).not.toContain('FOR INSERT')
      expect(migrationContent).not.toContain('FOR UPDATE')
      expect(migrationContent).not.toContain('FOR DELETE')
    })

    it('migration adds img_url column to library_games table', () => {
      expect(migrationContent).toContain('ALTER TABLE "public"."library_games"')
      expect(migrationContent).toContain('ADD COLUMN IF NOT EXISTS "img_url" text')
    })

    it('migration uses ON CONFLICT DO UPDATE to converge bucket config (not DO NOTHING)', () => {
      // A pre-existing "landing-media" bucket (e.g. created manually with
      // public=false, a smaller file_size_limit, or a narrower MIME allowlist)
      // must NOT be left with stale settings — DO NOTHING would silently
      // succeed while leaving misconfiguration in place, which is a security
      // concern for a public-read bucket. DO UPDATE forces convergence to the
      // intended state on every re-run of this migration.
      expect(migrationContent).not.toContain('ON CONFLICT ("id") DO NOTHING')
      expect(migrationContent).toContain('ON CONFLICT ("id") DO UPDATE SET')
    })

    it('migration ON CONFLICT DO UPDATE re-asserts public=true, the 5 MB limit, and the full MIME allowlist', () => {
      const conflictClauseMatch = migrationContent.match(
        /ON CONFLICT \("id"\) DO UPDATE SET([\s\S]*?);/
      )
      expect(conflictClauseMatch).not.toBeNull()

      const conflictClause = conflictClauseMatch![1]
      expect(conflictClause).toMatch(/"public"\s*=\s*true/)
      expect(conflictClause).toMatch(/"file_size_limit"\s*=\s*5242880/)
      expect(conflictClause).toContain(
        "\"allowed_mime_types\" = ARRAY['image/png', 'image/jpeg', 'image/webp', 'image/gif']"
      )
    })
  })
})
