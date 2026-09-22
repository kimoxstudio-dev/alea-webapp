import { NextRequest, NextResponse } from 'next/server'
import { getPrivateImage } from '@/lib/server/private-blob'

const FOLDERS = new Set(['events', 'partners', 'library-games'])
const FILENAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|webp|gif)$/i

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ folder: string; filename: string }> },
) {
  const { folder, filename } = await params
  if (!FOLDERS.has(folder) || !FILENAME.test(filename)) {
    return NextResponse.json({ message: 'Not found', statusCode: 404 }, { status: 404 })
  }

  const response = await getPrivateImage(
    `landing-media/${folder}/${filename}`,
    'public, max-age=3600, s-maxage=3600',
    request.headers.get('if-none-match') ?? undefined,
  )
  return response ?? NextResponse.json({ message: 'Not found', statusCode: 404 }, { status: 404 })
}
