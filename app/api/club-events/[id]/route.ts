import { NextRequest, NextResponse } from 'next/server'
import { revalidateTag } from 'next/cache'
import { requireAdmin } from '@/lib/server/auth'
import { deleteClubEvent, updateClubEvent } from '@/lib/server/club-events-service'
import { toServiceErrorResponse } from '@/lib/server/http-error'
import { enforceMutationSecurity, enforceRateLimit, RATE_LIMIT_POLICIES } from '@/lib/server/security'

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const securityError = enforceMutationSecurity(request)
  if (securityError) return securityError

  const rateLimitError = await enforceRateLimit(request, RATE_LIMIT_POLICIES.adminMutation)
  if (rateLimitError) return rateLimitError

  const admin = await requireAdmin(request)
  if (admin instanceof NextResponse) return admin

  try {
    const [{ id }, body] = await Promise.all([params, request.json()])
    return admin.applyCookies(NextResponse.json(await updateClubEvent(admin.session, id, body)))
  } catch (error) {
    return admin.applyCookies(toServiceErrorResponse(error))
  } finally {
    // Event writes can commit before a read-back or compensation fails (#424).
    revalidateTag('landing-club-events')
  }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const securityError = enforceMutationSecurity(request)
  if (securityError) return securityError

  const rateLimitError = await enforceRateLimit(request, RATE_LIMIT_POLICIES.adminMutation)
  if (rateLimitError) return rateLimitError

  const admin = await requireAdmin(request)
  if (admin instanceof NextResponse) return admin

  try {
    const { id } = await params
    await deleteClubEvent(admin.session, id)
    return admin.applyCookies(new NextResponse(null, { status: 204 }))
  } catch (error) {
    return admin.applyCookies(toServiceErrorResponse(error))
  } finally {
    revalidateTag('landing-club-events')
  }
}
