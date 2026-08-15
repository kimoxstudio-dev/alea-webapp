import { NextRequest, NextResponse } from 'next/server'
import { recoverAccount } from '@/lib/server/auth-service'
import { toServiceErrorResponse } from '@/lib/server/http-error'
import { enforceMutationSecurity, enforceRateLimit, RATE_LIMIT_POLICIES } from '@/lib/server/security'

/**
 * Claims an admin-issued recovery link (#299 pass 3).
 *
 * Takes `{ token, password }` — the member sets a new password directly in
 * this call, which is applied to their existing Clerk identity. There is no
 * pre-existing Clerk session precondition; `recoverAccount()` enforces the
 * token's validity itself.
 */
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
    const result = await recoverAccount({ token: requestBody.token, password: requestBody.password })

    return NextResponse.json(result.user)
  } catch (error) {
    return toServiceErrorResponse(error)
  }
}
