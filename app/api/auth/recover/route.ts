import { NextRequest, NextResponse } from 'next/server'
import { recoverAccount } from '@/lib/server/auth/auth-service'
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
    // recoverAccount() now establishes the post-recovery Auth.js session
    // itself (see lib/server/auth/auth-service.ts) — no client/cookie
    // plumbing needed here.
    const result = await recoverAccount({
      token: requestBody.token,
      password: requestBody.password,
    })

    if (result.signInFailed) {
      return NextResponse.json({
        message: 'Password updated, but automatic sign-in failed. Please sign in with your member number and new password.',
        statusCode: 500,
      }, { status: 500 })
    }

    return NextResponse.json(result.user)
  } catch (error) {
    return toServiceErrorResponse(error)
  }
}
