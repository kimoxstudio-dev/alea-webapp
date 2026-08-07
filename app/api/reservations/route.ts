import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/server/auth'
import { toServiceErrorResponse } from '@/lib/server/http-error'
import { createReservationForSession, listVisibleReservations } from '@/lib/server/reservations-service'
import { markExpiredReservationsAsNoShow } from '@/lib/server/reservation-no-show'
import { enforceMutationSecurity, enforceRateLimit, RATE_LIMIT_POLICIES } from '@/lib/server/security'

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request)
  if (auth instanceof NextResponse) return auth

  try {
    await markExpiredReservationsAsNoShow()
  } catch (error) {
    console.error('Failed to mark no-show reservations on reservations load', error)
  }

  try {
    const { searchParams } = new URL(request.url)
    return auth.applyCookies(NextResponse.json(
      await listVisibleReservations({
        session: auth.session,
        userId: searchParams.get('userId'),
        tableId: searchParams.get('tableId'),
        date: searchParams.get('date'),
      }),
    ))
  } catch (error) {
    return auth.applyCookies(toServiceErrorResponse(error))
  }
}

export async function POST(request: NextRequest) {
  const securityError = enforceMutationSecurity(request)
  if (securityError) return securityError

  const rateLimitError = await enforceRateLimit(request, RATE_LIMIT_POLICIES.reservationMutation)
  if (rateLimitError) return rateLimitError

  const auth = await requireAuth(request)
  if (auth instanceof NextResponse) return auth

  try {
    const body = await request.json()
    return auth.applyCookies(NextResponse.json(
      await createReservationForSession(auth.session, body),
      { status: 201 },
    ))
  } catch (error) {
    return auth.applyCookies(toServiceErrorResponse(error))
  }
}
