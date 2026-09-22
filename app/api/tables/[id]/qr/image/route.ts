import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/server/auth'
import { getPrivateImage } from '@/lib/server/private-blob'

const TABLE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const admin = await requireAdmin(request)
  if (admin instanceof NextResponse) return admin

  const { id } = await params
  if (!TABLE_ID.test(id)) {
    return admin.applyCookies(NextResponse.json({ message: 'Not found', statusCode: 404 }, { status: 404 }))
  }

  const response = await getPrivateImage(
    `table-qr-codes/${id}.png`,
    'private, no-cache',
    request.headers.get('if-none-match') ?? undefined,
    false,
  )
  return admin.applyCookies(response ?? NextResponse.json({ message: 'Not found', statusCode: 404 }, { status: 404 }))
}
