import 'server-only'
import { put } from '@vercel/blob'
import { serviceError } from '@/lib/server/service-error'
import type { SessionUser } from '@/lib/server/auth'

// ---------------------------------------------------------------------------
// Image uploads to Vercel Blob (#310, ported off Supabase Storage / OIR-207)
//
// Privilege checks (role === 'admin') live here in the service layer, not in
// the route handler, same pattern as the other admin services. Vercel Blob
// has no RLS-equivalent client policy layer — the write is authorized by
// possessing BLOB_READ_WRITE_TOKEN (server-only env var), which the admin
// check above gates access to.
// ---------------------------------------------------------------------------

const LANDING_MEDIA_PREFIX = 'landing-media'
const MAX_UPLOAD_SIZE_BYTES = 5 * 1024 * 1024 // 5 MB

// Extension is derived from the (validated) MIME type, never from the
// caller-supplied filename — an attacker-controlled filename must never
// influence the stored object's extension/content-type handling.
const MIME_TO_EXTENSION: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

export type UploadFolder = 'events' | 'partners' | 'library-games'
const ALLOWED_FOLDERS = new Set<UploadFolder>(['events', 'partners', 'library-games'])

function requireAdminSession(session: SessionUser): void {
  if (session.role !== 'admin') serviceError('Forbidden', 403)
}

/**
 * Minimal shape we need from the multipart "file" field — matches the Web
 * File/Blob API surface without depending on the DOM lib's `File` type,
 * which isn't guaranteed in the Node server runtime.
 */
export interface UploadFileLike {
  size: number
  type: string
  arrayBuffer: () => Promise<ArrayBuffer>
}

export interface UploadInput {
  file: UploadFileLike | null
  folder: unknown
}

function requireValidFolder(folder: unknown): UploadFolder {
  if (typeof folder !== 'string' || !ALLOWED_FOLDERS.has(folder as UploadFolder)) {
    serviceError('folder must be one of: events, partners, library-games', 400)
  }
  return folder as UploadFolder
}

// ---------------------------------------------------------------------------
// Magic-byte (file signature) verification.
//
// `File.type` is a client-supplied MIME type — a caller can set it to
// "image/png" while sending an arbitrary (or malicious) byte stream. Because
// the uploaded object is written with public access and later rendered
// directly (landing page / admin previews), we must not trust that value
// alone. Before writing anything to Blob we re-derive the type from the
// first bytes of the actual body and require it to match one of the allowed
// image formats *and* match the MIME type the client declared.
//
// This is a small, dependency-free signature check — no full image
// decoder/probe library is needed for this use case.
// ---------------------------------------------------------------------------

type ImageMime = keyof typeof MIME_TO_EXTENSION

const MAGIC_BYTE_SIGNATURES: Record<ImageMime, (bytes: Uint8Array) => boolean> = {
  'image/png': (bytes) => startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  'image/jpeg': (bytes) => startsWith(bytes, [0xff, 0xd8, 0xff]),
  'image/webp': (bytes) =>
    // "RIFF" <4-byte size, ignored> "WEBP"
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    bytes.length >= 12 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50,
  'image/gif': (bytes) =>
    // "GIF87a" or "GIF89a"
    startsWith(bytes, [0x47, 0x49, 0x46, 0x38]) &&
    bytes.length >= 6 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61,
}

function startsWith(bytes: Uint8Array, signature: number[]): boolean {
  if (bytes.length < signature.length) return false
  return signature.every((byte, index) => bytes[index] === byte)
}

/**
 * Detects the actual image format from the leading bytes of the file body,
 * regardless of what the client claims via `File.type`.
 */
function detectImageMimeFromBytes(bytes: Uint8Array): ImageMime | null {
  for (const mime of Object.keys(MAGIC_BYTE_SIGNATURES) as ImageMime[]) {
    if (MAGIC_BYTE_SIGNATURES[mime](bytes)) return mime
  }
  return null
}

/**
 * Verifies the file body's magic bytes match a known image signature AND
 * match the MIME type the client declared via `File.type`. Must be called
 * with the already-read body bytes, before anything is written to Blob.
 */
function requireMatchingMagicBytes(bytes: Uint8Array, declaredType: string): void {
  const detected = detectImageMimeFromBytes(bytes)
  if (!detected || detected !== declaredType) {
    serviceError('file must be one of: image/png, image/jpeg, image/webp, image/gif', 400)
  }
}

function requireValidFile(file: UploadFileLike | null): { file: UploadFileLike; extension: string } {
  if (!file) serviceError('file is required', 400)

  const extension = MIME_TO_EXTENSION[file.type]
  if (!extension) {
    serviceError('file must be one of: image/png, image/jpeg, image/webp, image/gif', 400)
  }

  // NOTE: by the time we get here, request.formData() has already buffered
  // the entire multipart body into memory — this check is a validation gate
  // on the parsed size, not a memory-exhaustion defense. Request size is
  // bounded upstream by requireAdmin() (auth-gated) and the adminMutation
  // rate limit; this MAX_UPLOAD_SIZE_BYTES check is what enforces the 5 MB
  // cap (Vercel Blob has no bucket-level size limit to also enforce it).
  if (file.size <= 0 || file.size > MAX_UPLOAD_SIZE_BYTES) {
    serviceError('file must be between 1 byte and 5 MB', 400)
  }

  return { file, extension }
}

/**
 * Validate and upload an admin-supplied image to Vercel Blob, returning its
 * public URL. Used to back the image field of club events, partners and
 * library games from the admin dashboard.
 */
export async function uploadLandingMediaImage(session: SessionUser, input: UploadInput): Promise<{ url: string }> {
  requireAdminSession(session)

  const folder = requireValidFolder(input.folder)
  const { file, extension } = requireValidFile(input.file)

  const bytes = new Uint8Array(await file.arrayBuffer())
  // Re-verify the actual file signature BEFORE writing anything to Blob —
  // the client-supplied `file.type` alone is not trustworthy (see
  // requireMatchingMagicBytes doc comment above).
  requireMatchingMagicBytes(bytes, file.type)

  const objectPath = `${LANDING_MEDIA_PREFIX}/${folder}/${crypto.randomUUID()}.${extension}`

  try {
    // put() accepts ArrayBuffer directly — bytes.buffer is the same backing
    // buffer `new Uint8Array(await file.arrayBuffer())` was constructed from,
    // so this is a type-satisfying reinterpretation, not a copy.
    const blob = await put(objectPath, bytes.buffer, {
      access: 'public',
      contentType: file.type,
      addRandomSuffix: false,
    })
    return { url: blob.url }
  } catch (error) {
    // Do NOT swallow the underlying Blob error — log it server-side so
    // failures (missing token, store outage, etc.) are diagnosable. Only a
    // generic message is ever returned to the client.
    console.error(
      '[uploads-service] Vercel Blob upload failed:',
      error instanceof Error ? error.message : error
    )
    serviceError('Internal server error', 500)
  }
}
