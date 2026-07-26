import 'server-only'
import {
  uploadToStorage as putToVercelBlob,
  getPublicStorageUrl as getVercelBlobPublicUrl,
  removeFromStorage as removeFromVercelBlob,
} from './vercel-blob'

/**
 * lib/storage/qr — single seam for storage access, backing both the
 * admin-generated table QR codes (lib/server/tables/tables-service.ts) and
 * admin-uploaded landing-media images (lib/server/uploads/uploads-service.ts).
 *
 * F3 cutover (see Linear KIM-393..422, Supabase→Vercel migration; this file
 * wired up in KIM-431): this seam now delegates to the Vercel Blob adapter
 * (./vercel-blob.ts) rather than Supabase Storage. Call sites are unchanged —
 * this module still exports the same `uploadToStorage` / `getPublicStorageUrl`
 * / `removeFromStorage` signatures and the same `StorageErrorDetail` shape, so
 * lib/server/uploads/uploads-service.ts required no edits to keep working.
 *
 * NOTE on the directory name: this module is named after the migration
 * issue's original shorthand label ("Storage/QR"), but it also backs the
 * general admin-uploaded landing-media images used by
 * lib/server/uploads/uploads-service.ts — that upload is NOT QR-code related. The
 * directory name is fixed per the tracked migration plan; the exported
 * function names below are intentionally generic/accurate rather than
 * QR-specific, since this seam wraps Storage access for more than QR codes.
 */

export interface StorageUploadOptions {
  contentType?: string
  upsert?: boolean
}

/**
 * Structured diagnostic detail preserved from a storage backend error.
 * Mirrors the fields exposed by `StorageError`/`StorageApiError` in
 * @supabase/storage-js (`name`, `message`, `status`, `statusCode`) — the
 * Vercel Blob adapter (./vercel-blob.ts) normalizes its own errors into this
 * same shape — so server-side logs can distinguish permissions, quota, and
 * backend-outage failures instead of collapsing every failure down to a bare
 * message string.
 */
export interface StorageErrorDetail {
  message: string
  name?: string
  status?: number
  statusCode?: string
}

export interface StorageOperationResult {
  error: StorageErrorDetail | null
}

export interface StoragePublicUrlResult {
  publicUrl: string | null
}

/**
 * Maximum accepted upload body size, in bytes (5 MB).
 *
 * Previously enforced by Supabase Storage's per-bucket `file_size_limit`
 * config (see supabase/migrations/20260704000005, "landing-media" bucket).
 * Vercel Blob has no equivalent bucket-level setting, so this seam now
 * enforces the cap in application code before any body reaches the adapter.
 * This is defense-in-depth: lib/server/uploads/uploads-service.ts already
 * validates `file.size` against the same 5 MB limit before calling
 * `uploadToStorage()`, but this check ensures the limit holds for every
 * current and future caller of this seam (e.g.
 * lib/server/tables/tables-service.ts), not just that one call site.
 */
const MAX_UPLOAD_SIZE_BYTES = 5 * 1024 * 1024 // 5 MB

function payloadTooLargeError(byteLength: number): StorageErrorDetail {
  return {
    message: `File exceeds the maximum allowed size of ${MAX_UPLOAD_SIZE_BYTES} bytes (5 MB); received ${byteLength} bytes`,
    name: 'StoragePayloadTooLargeError',
    status: 413,
    statusCode: '413',
  }
}

/**
 * Uploads a file body to the given bucket/path via the Vercel Blob adapter.
 * Rejects bodies over the 5 MB cap (see MAX_UPLOAD_SIZE_BYTES) before
 * delegating to the adapter.
 */
export async function uploadToStorage(
  bucket: string,
  path: string,
  body: Buffer | Uint8Array,
  options: StorageUploadOptions = {},
): Promise<StorageOperationResult> {
  if (body.byteLength > MAX_UPLOAD_SIZE_BYTES) {
    return { error: payloadTooLargeError(body.byteLength) }
  }

  return putToVercelBlob(bucket, path, body, options)
}

/**
 * Resolves the public URL for an object in the given bucket/path via the
 * Vercel Blob adapter.
 */
export function getPublicStorageUrl(bucket: string, path: string): StoragePublicUrlResult {
  return getVercelBlobPublicUrl(bucket, path)
}

/**
 * Removes one or more objects from the given bucket via the Vercel Blob
 * adapter. Not currently called by any service, but included so the seam
 * covers the full upload/get-url/delete surface referenced by the migration
 * plan.
 */
export async function removeFromStorage(bucket: string, paths: string[]): Promise<StorageOperationResult> {
  return removeFromVercelBlob(bucket, paths)
}
