import { NextRequest, NextResponse } from 'next/server'
import { revalidateTag } from 'next/cache'
import { requireAdmin } from '@/lib/server/auth'
import { createLibraryGame, listAdminLibraryGames } from '@/lib/server/library-games-service'
import { toServiceErrorResponse } from '@/lib/server/http-error'
import { enforceMutationSecurity, enforceRateLimit, RATE_LIMIT_POLICIES } from '@/lib/server/security'

export async function GET(request: NextRequest) {
  const admin = await requireAdmin(request)
  if (admin instanceof NextResponse) return admin

  try {
    return admin.applyCookies(NextResponse.json(await listAdminLibraryGames(admin.session)))
  } catch (error) {
    return admin.applyCookies(toServiceErrorResponse(error))
  }
}

export async function POST(request: NextRequest) {
  const securityError = enforceMutationSecurity(request)
  if (securityError) return securityError

  const rateLimitError = await enforceRateLimit(request, RATE_LIMIT_POLICIES.adminMutation)
  if (rateLimitError) return rateLimitError

  const admin = await requireAdmin(request)
  if (admin instanceof NextResponse) return admin

  try {
    const body = await request.json()
    const game = await createLibraryGame(admin.session, body)
    revalidateTag('landing-library-games')
    return admin.applyCookies(NextResponse.json(game, { status: 201 }))
  } catch (error) {
    return admin.applyCookies(toServiceErrorResponse(error))
  }
}
