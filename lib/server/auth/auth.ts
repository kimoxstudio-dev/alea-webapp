import 'server-only'
import { NextRequest, NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { auth as clerkAuth } from '@clerk/nextjs/server'
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

function identityApplyCookies(response: NextResponse): NextResponse {
  return response
}

async function getSessionUser(): Promise<SessionUser | null> {
  const { userId } = await clerkAuth()

  if (!userId) {
    return null
  }

  const db = getDrizzleDb()
  const [profile] = await db
    .select({ id: profiles.id, role: profiles.role, isActive: profiles.isActive })
    .from(profiles)
    .where(eq(profiles.clerkUserId, userId))
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
