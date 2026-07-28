import { NextRequest, NextResponse } from 'next/server'
import { enforceMutationSecurity, enforceRateLimit, RATE_LIMIT_POLICIES } from '@/lib/server/shared/security'
import { login } from '@/lib/server/auth/auth-service'
import { toServiceErrorResponse } from '@/lib/server/shared/http-error'

export async function POST(request: NextRequest) {
  const securityError = enforceMutationSecurity(request)
  if (securityError) return securityError

  const rateLimitError = await enforceRateLimit(request, RATE_LIMIT_POLICIES.authLogin)
  if (rateLimitError) return rateLimitError

  try {
    const body = await request.json()
    const user = await login(body)
    // Auth.js's `signIn()` (called inside `login()`) sets the session cookie
    // itself via `next/headers`, which attaches directly to this Route
    // Handler's response — no manual cookie propagation needed here, unlike
    // the previous Supabase route-handler client this replaced.
    return NextResponse.json(user)
  } catch (error) {
    return toServiceErrorResponse(error)
  }
}
