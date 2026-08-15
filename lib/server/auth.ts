import 'server-only'
import { NextRequest, NextResponse } from 'next/server'
import { getClerkSession, getClerkUser } from '@/lib/server/session'
import { resolveProfileForClerkUser } from '@/lib/server/auth-service'
export { enforceSameOriginForMutation } from '@/lib/server/security'

/**
 * Route-handler auth gates (#299).
 *
 * Session identity comes from Clerk (`lib/server/session.ts`) instead of
 * Supabase Auth cookies. The `profiles` row itself lives in Neon and is
 * resolved via `resolveProfileForClerkUser()` in `lib/server/auth-service.ts`
 * — READ-ONLY as of #299 pass 2 (see that function's doc comment): this club
 * has no open self-registration (closed issue #206), so a Clerk identity
 * with no matching, already-active `profiles` row never gets a session here,
 * and no row is ever created as a side effect of a request. The only way a
 * profile becomes active is `activateAccount()` in auth-service.ts, gated on
 * an admin-issued activation token.
 *
 * `request`/`applyCookies` are kept in every signature below purely for
 * source compatibility with the ~30 existing call sites across `app/` (all
 * out of scope for this backend-only change) — Clerk's `auth()`/`currentUser()`
 * read the session from Next.js's request context directly and do not need
 * an explicit `NextRequest`, and cookie refresh is handled by
 * `clerkMiddleware()` in `middleware.ts`, not here. `applyCookies` is now a
 * no-op passthrough.
 */

export type SessionUser = {
  id: string
  role: 'member' | 'admin'
}

type RouteSessionResult = {
  session: SessionUser | null
  applyCookies: (response: NextResponse) => NextResponse
}

type AuthContext = {
  session: SessionUser
  applyCookies: (response: NextResponse) => NextResponse
}

function passthroughApplyCookies(response: NextResponse): NextResponse {
  return response
}

async function resolveClerkSessionUser(): Promise<SessionUser | null> {
  const clerkSession = await getClerkSession()
  if (!clerkSession) {
    return null
  }

  const clerkUser = await getClerkUser()
  const email = clerkUser?.primaryEmailAddress?.emailAddress ?? null
  if (!email) {
    // No verified/primary email on the Clerk identity — cannot correlate to
    // a profiles row (email is the only correlation key today, see
    // resolveProfileForClerkUser). Treat as unauthenticated.
    return null
  }

  return resolveProfileForClerkUser({ email })
}

export async function getSessionFromRequest(_request: NextRequest): Promise<RouteSessionResult> {
  return {
    session: await resolveClerkSessionUser(),
    applyCookies: passthroughApplyCookies,
  }
}

export async function getSessionFromServerCookies(): Promise<SessionUser | null> {
  return resolveClerkSessionUser()
}

export async function requireAuth(request: NextRequest): Promise<AuthContext | NextResponse> {
  const { session, applyCookies } = await getSessionFromRequest(request)
  if (!session) {
    return applyCookies(NextResponse.json({ message: 'Unauthorized', statusCode: 401 }, { status: 401 }))
  }
  return { session, applyCookies }
}

export async function requireAdmin(request: NextRequest): Promise<AuthContext | NextResponse> {
  const auth = await requireAuth(request)
  if (auth instanceof NextResponse) return auth
  if (auth.session.role !== 'admin') {
    return auth.applyCookies(NextResponse.json({ message: 'Forbidden', statusCode: 403 }, { status: 403 }))
  }
  return auth
}
