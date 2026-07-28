import { NextRequest, NextResponse } from 'next/server'
import { enforceMutationSecurity, enforceRateLimit, RATE_LIMIT_POLICIES } from '@/lib/server/shared/security'
import { logoutWithClient } from '@/lib/server/auth/auth-service'
import { toServiceErrorResponse } from '@/lib/server/shared/http-error'

export async function POST(request: NextRequest) {
  const securityError = enforceMutationSecurity(request)
  if (securityError) return securityError

  const rateLimitError = await enforceRateLimit(request, RATE_LIMIT_POLICIES.authLogout)
  if (rateLimitError) return rateLimitError

  try {
    // Auth.js's `signOut()` (called inside `logoutWithClient()`) clears the
    // session cookie itself via `next/headers`, attaching directly to this
    // Route Handler's response — no client/cookie plumbing needed here.
    const body = await logoutWithClient()
    return NextResponse.json(body)
  } catch (error) {
    return toServiceErrorResponse(error)
  }
}
