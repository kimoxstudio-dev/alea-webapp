import { NextRequest, NextResponse } from 'next/server'
import { revalidateTag } from 'next/cache'
import { requireAdmin } from '@/lib/server/auth'
import { createClubEvent, listAdminClubEvents } from '@/lib/server/club-events-service'
import { toServiceErrorResponse } from '@/lib/server/http-error'
import { enforceMutationSecurity, enforceRateLimit, RATE_LIMIT_POLICIES } from '@/lib/server/security'

export async function GET(request: NextRequest) {
  const admin = await requireAdmin(request)
  if (admin instanceof NextResponse) return admin

  try {
    return admin.applyCookies(NextResponse.json(await listAdminClubEvents(admin.session)))
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
    const event = await createClubEvent(admin.session, body)
    return admin.applyCookies(NextResponse.json(event, { status: 201 }))
  } catch (error) {
    return admin.applyCookies(toServiceErrorResponse(error))
  } finally {
    // Event writes can commit before a read-back or compensation fails (#424).
    revalidateTag('landing-club-events')
  }
}
