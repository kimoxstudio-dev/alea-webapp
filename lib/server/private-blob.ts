import 'server-only'
import { get } from '@vercel/blob'
import { NextResponse } from 'next/server'

const IMAGE_CONTENT_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

export async function getPrivateImage(
  pathname: string,
  cacheControl: string,
  ifNoneMatch?: string,
  useCache?: boolean,
): Promise<NextResponse | null> {
  const result = await get(pathname, {
    access: 'private',
    ifNoneMatch,
    ...(useCache === false ? { useCache: false } : {}),
  })
  if (result?.statusCode === 304) {
    return new NextResponse(null, {
      status: 304,
      headers: { 'Cache-Control': cacheControl, ETag: result.blob.etag },
    })
  }

  const contentType = result?.blob.contentType
  if (!result || !contentType || !IMAGE_CONTENT_TYPES.has(contentType)) return null

  const headers = new Headers({
    'Cache-Control': cacheControl,
    ETag: result.blob.etag,
    'X-Content-Type-Options': 'nosniff',
  })

  if (result.statusCode !== 200) return null

  headers.set('Content-Type', contentType)
  return new NextResponse(result.stream, { headers })
}
