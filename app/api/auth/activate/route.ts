import { NextRequest, NextResponse } from 'next/server'
import { activateAccount } from '@/lib/server/auth-service'
import { toServiceErrorResponse } from '@/lib/server/http-error'
import { enforceMutationSecurity, enforceRateLimit, RATE_LIMIT_POLICIES } from '@/lib/server/security'

/**
 * Claims an admin-issued activation link (#299 pass 3).
 *
 * Only takes `{ token }` — the pre-Clerk `{ token, password }` shape is gone.
 * The caller must already hold an authenticated Clerk session (the frontend
 * sequences Clerk sign-up/sign-in before calling this route); `activateAccount()`
 * itself enforces that and matches the session's verified email against the
 * target profile.
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
    const result = await activateAccount({ token: requestBody.token })

    return NextResponse.json(result.user)
  } catch (error) {
    return toServiceErrorResponse(error)
  }
}
