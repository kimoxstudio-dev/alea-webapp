import 'server-only'
import { NextRequest, NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { auth as authJsAuth } from '@/lib/authjs/auth'
import { getDrizzleDb } from '@/lib/db'
import { profiles } from '@/lib/db/schema'
export { enforceSameOriginForMutation } from '@/lib/server/shared/security'

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

/**
 * Auth.js (JWT strategy, no adapter) never needs to rewrite/refresh the
 * session cookie on a plain read — unlike the Supabase Auth client this
 * replaces, which could rotate the access/refresh token pair on
 * `auth.getUser()` and needed `applyCookies` to propagate that onto the
 * response. Kept as a no-op identity function (rather than removed) so
 * every call site across the app that destructures `applyCookies` off the
 * `requireAuth`/`requireAdmin` result keeps working unchanged.
 */
function identityApplyCookies(response: NextResponse): NextResponse {
  return response
}

/**
 * Resolves the current session user.
 *
 * Reads the Auth.js JWT session (`auth()` — see `lib/authjs/auth.ts`) to
 * get the authenticated user id (`session.user.id`, sourced from the JWT
 * `sub` claim), then — same as the previous Supabase-based implementation —
 * always re-fetches `profiles.role` / `profiles.is_active` fresh from the
 * database on every call. This is intentional, preserved behavior: role and
 * active-status changes (e.g. an admin demoted, a member suspended) must
 * take effect immediately, not only once a JWT the size of the session
 * lifetime expires, so the JWT's own `role`/`isActive` claims (added for
 * display purposes in `lib/authjs/config.ts`'s `session()` callback) are
 * deliberately NOT trusted here as an authorization source.
 */
async function getSessionUser(): Promise<SessionUser | null> {
  const session = await authJsAuth()
  const userId = session?.user?.id

  if (!userId) {
    return null
  }

  const db = getDrizzleDb()
  const [profile] = await db
    .select({ id: profiles.id, role: profiles.role, isActive: profiles.isActive })
    .from(profiles)
    .where(eq(profiles.id, userId))
    .limit(1)

  if (!profile || !profile.isActive) {
    return null
  }

  return {
    id: profile.id,
    role: profile.role,
  } satisfies SessionUser
}

export async function getSessionFromRequest(_request: NextRequest): Promise<RouteSessionResult> {
  return {
    session: await getSessionUser(),
    applyCookies: identityApplyCookies,
  }
}

export async function getSessionFromServerCookies(): Promise<SessionUser | null> {
  return getSessionUser()
}

export async function requireAuth(request: NextRequest): Promise<AuthContext | NextResponse> {
  const { session, applyCookies } = await getSessionFromRequest(request)
  if (!session) {
    return applyCookies(NextResponse.json({ message: 'Unauthorized', statusCode: 401 }, { status: 401 }))
  }
  return { session, applyCookies }
}

export async function requireAdmin(request: NextRequest): Promise<AuthContext | NextResponse> {
  const authContext = await requireAuth(request)
  if (authContext instanceof NextResponse) return authContext
  if (authContext.session.role !== 'admin') {
    return authContext.applyCookies(NextResponse.json({ message: 'Forbidden', statusCode: 403 }, { status: 403 }))
  }
  return authContext
}
