import { NextRequest, NextResponse } from 'next/server'
import { enforceMutationSecurity, enforceRateLimit, RATE_LIMIT_POLICIES } from '@/lib/server/security'

/**
 * Password-based login is permanently disabled (#299 pass 3).
 *
 * `login()` was removed from `lib/server/auth-service.ts` in pass 2 — there
 * is no password column left on `profiles` to check against, and Clerk (not
 * this route) is now the only credential store. Sign-in happens entirely
 * through Clerk's hosted UI (`/[locale]/sign-in`); this endpoint only exists
 * so old clients calling it get a clear, stable response instead of a 404 or
 * a runtime crash.
 */
export async function POST(request: NextRequest) {
  const securityError = enforceMutationSecurity(request)
  if (securityError) return securityError

  const rateLimitError = await enforceRateLimit(request, RATE_LIMIT_POLICIES.authLogin)
  if (rateLimitError) return rateLimitError

  return NextResponse.json(
    { message: 'Password-based login is disabled. Sign in with your Clerk account instead.', statusCode: 410 },
    { status: 410 },
  )
}
