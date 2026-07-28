import { NextRequest, NextResponse } from 'next/server'
import { activateAccount } from '@/lib/server/auth/auth-service'
import { toServiceErrorResponse } from '@/lib/server/shared/http-error'
import { enforceMutationSecurity, enforceRateLimit, RATE_LIMIT_POLICIES } from '@/lib/server/shared/security'

export async function POST(request: NextRequest) {
  const securityError = enforceMutationSecurity(request)
  if (securityError) return securityError

  const rateLimitError = await enforceRateLimit(request, RATE_LIMIT_POLICIES.authActivate)
  if (rateLimitError) return rateLimitError

  try {
    let body: unknown

    try {
      body = await request.json()
    } catch {
      return NextResponse.json({
        message: 'Invalid JSON request body.',
        statusCode: 400,
      }, { status: 400 })
    }

    const requestBody = typeof body === 'object' && body !== null
      ? body as Record<string, unknown>
      : {}
    // KIM-451 retires server-side session establishment from this route.
    // Activation still returns the updated profile so the client can
    // redirect the member into the Clerk-driven login flow.
    const result = await activateAccount({
      token: requestBody.token,
      password: requestBody.password,
    })

    // Keep this compatibility branch until activation/recovery UI no longer
    // expects the legacy result shape during the auth migration.
    return NextResponse.json(result.user)
  } catch (error) {
    return toServiceErrorResponse(error)
  }
}
