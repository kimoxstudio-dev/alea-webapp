import 'server-only'
import { del, put } from '@vercel/blob'
import type {
  StorageErrorDetail,
  StorageOperationResult,
  StoragePublicUrlResult,
  StorageUploadOptions,
} from './index'

/**
 * lib/storage/qr/vercel-blob — Vercel Blob-backed implementation of the same
 * seam interface exposed by lib/storage/qr/index.ts.
 *
 * As of the F3 cutover (KIM-431, see Linear KIM-393..422, Supabase→Vercel
 * migration), lib/storage/qr/index.ts imports and delegates to the functions
 * below for every call — this is now the sole active storage backend for
 * both admin QR code generation and admin landing-media uploads. Requires a
 * live Vercel Blob store with `BLOB_READ_WRITE_TOKEN` (write) and
 * `BLOB_PUBLIC_BASE_URL` (public URL construction) configured in the
 * deployment environment; see .env.example.
 *
 * Vercel Blob has no "bucket" concept — a read-write token is scoped to a
 * single store with a flat pathname namespace. To preserve call-site parity
 * with the previous Supabase-backed implementation (which took a `bucket`
 * and a `path`), this adapter joins the two into a single blob pathname
 * (`${bucket}/${path}`).
 *
 * `put()`/`del()` below use the default `BLOB_READ_WRITE_TOKEN` env var
 * (Vercel's standard SDK convention) rather than accepting a client instance,
 * since `@vercel/blob` exposes module-level functions instead of a
 * client/from() builder like `@supabase/storage-js`.
 */

function toPathname(bucket: string, path: string): string {
  return `${bucket.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`
}

/**
 * Percent-encodes a Blob pathname for safe inclusion in a URL, without
 * encoding the `/` path separators. Splits on `/` and runs each segment
 * through `encodeURIComponent` individually rather than encoding the whole
 * pathname at once, since a naive full-string encode would also escape the
 * separators and break the path structure.
 *
 * This is needed because `getPublicStorageUrl()` below reconstructs the
 * public URL from `BLOB_PUBLIC_BASE_URL` + pathname rather than reading it
 * from a `put()`/`head()` response (see that function's doc comment for why
 * it can't do the latter while keeping this seam method synchronous).
 * Without per-segment encoding, a pathname containing spaces, `#`, `?`, or
 * other reserved/reserved-adjacent characters would produce a URL that
 * diverges from the canonical one Vercel Blob would actually serve.
 */
function encodePathnameForUrl(pathname: string): string {
  return pathname
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')
}

/**
 * Extracts structured diagnostic fields from a Vercel Blob error without
 * leaking a non-serializable error instance across the seam boundary.
 * Mirrors `toStorageErrorDetail()` in lib/storage/qr/index.ts so both
 * backends surface the same `{ message, name, status, statusCode }` shape.
 */
function toStorageErrorDetail(error: unknown): StorageErrorDetail | null {
  if (!error) return null

  if (typeof error === 'object') {
    const candidate = error as { message?: unknown; name?: unknown; status?: unknown; statusCode?: unknown }
    return {
      message: typeof candidate.message === 'string' ? candidate.message : String(error),
      name: typeof candidate.name === 'string' ? candidate.name : undefined,
      status: typeof candidate.status === 'number' ? candidate.status : undefined,
      statusCode: typeof candidate.statusCode === 'string' ? candidate.statusCode : undefined,
    }
  }

  return { message: String(error) }
}

/**
 * Uploads a file body to Vercel Blob under `${bucket}/${path}`. Wraps
 * `put()` from `@vercel/blob`. All objects are uploaded with `access:
 * 'public'`, matching today's public QR/landing-media buckets on Supabase
 * Storage. `options.upsert` maps to Blob's `allowOverwrite`.
 */
export async function uploadToStorage(
  bucket: string,
  path: string,
  body: Buffer | Uint8Array,
  options: StorageUploadOptions = {},
): Promise<StorageOperationResult> {
  try {
    const blobBody = Buffer.isBuffer(body) ? body : Buffer.from(body)
    await put(toPathname(bucket, path), blobBody, {
      access: 'public',
      contentType: options.contentType,
      allowOverwrite: options.upsert ?? false,
    })

    return { error: null }
  } catch (error) {
    return { error: toStorageErrorDetail(error) }
  }
}

/**
 * Resolves the public URL for an object at `${bucket}/${path}`.
 *
 * Unlike Supabase Storage's `getPublicUrl()`, Vercel Blob does not expose a
 * synchronous, offline URL-construction helper — the canonical URL is only
 * returned by `put()`/`head()` at request time. To preserve this seam
 * method's synchronous signature, the public base URL is read from
 * `BLOB_PUBLIC_BASE_URL` (the store's stable public base, e.g.
 * `https://<store-id>.public.blob.vercel-storage.com`), which the real F3
 * cutover step is expected to configure. Returns `publicUrl: null` when that
 * env var is unset, matching the Supabase implementation's null-safe return
 * shape.
 *
 * The pathname is percent-encoded per segment (see `encodePathnameForUrl()`)
 * before being appended to the base URL, so paths containing spaces, `#`,
 * `?`, or other reserved characters still produce a URL that matches the one
 * Vercel Blob's own `put()`/`head()` response would return for that object.
 */
export function getPublicStorageUrl(bucket: string, path: string): StoragePublicUrlResult {
  const baseUrl = process.env.BLOB_PUBLIC_BASE_URL
  if (!baseUrl) return { publicUrl: null }

  const pathname = encodePathnameForUrl(toPathname(bucket, path))
  return { publicUrl: `${baseUrl.replace(/\/+$/, '')}/${pathname}` }
}

/**
 * Removes one or more objects (each identified by `bucket` + `path`) from
 * Vercel Blob. Wraps `del()` from `@vercel/blob`.
 */
export async function removeFromStorage(bucket: string, paths: string[]): Promise<StorageOperationResult> {
  try {
    await del(paths.map((path) => toPathname(bucket, path)))
    return { error: null }
  } catch (error) {
    return { error: toStorageErrorDetail(error) }
  }
}
