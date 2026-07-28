import { NextRequest, NextResponse } from 'next/server'
import { enforceMutationSecurity, enforceRateLimit, RATE_LIMIT_POLICIES } from '@/lib/server/shared/security'

export async function POST(request: NextRequest) {
  const securityError = enforceMutationSecurity(request)
  if (securityError) return securityError

  const rateLimitError = await enforceRateLimit(request, RATE_LIMIT_POLICIES.authLogin)
  if (rateLimitError) return rateLimitError

  return NextResponse.json(
    { message: 'Interactive login is handled by Clerk on the client', statusCode: 410 },
    { status: 410 },
  )
}
