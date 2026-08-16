import 'server-only'
import { auth, currentUser } from '@clerk/nextjs/server'

/**
 * Clerk-backed session helpers.
 *
 * These wrap `@clerk/nextjs/server`'s `auth()`/`currentUser()` so API routes
 * and server components have a single place to read the current Clerk
 * session. This intentionally does NOT resolve app-level identity (member
 * number, role, activation status) — that mapping between a Clerk identity
 * and the member domain model belongs to the users-service migration
 * (see lib/server/auth-service.ts, out of scope here).
 */

export type ClerkSession = {
  userId: string
  sessionId: string
}

/**
 * Returns the current Clerk session, or null if the request is unauthenticated.
 * Safe to call from Route Handlers and Server Components.
 *
 * `sessionId` (added #299 pass 2) is needed for server-side session
 * revocation (see `lib/server/auth-service.ts`'s `logout()`) — Clerk's own
 * client SDK sign-out clears the client-side cookie, but revoking the
 * session server-side too is the direct analog of the old
 * `supabase.auth.signOut()` call it replaces.
 */
export async function getClerkSession(): Promise<ClerkSession | null> {
  const { userId, sessionId } = await auth()
  if (!userId || !sessionId) {
    return null
  }
  return { userId, sessionId }
}

/**
 * Returns the current Clerk session, throwing if unauthenticated.
 * Callers in Route Handlers should catch and map to a 401 response.
 */
export async function requireClerkSession(): Promise<ClerkSession> {
  const session = await getClerkSession()
  if (!session) {
    throw new Error('Unauthorized')
  }
  return session
}

/**
 * Returns the full Clerk user object for the current session (profile data,
 * email addresses, etc.), or null if unauthenticated.
 */
export async function getClerkUser() {
  return currentUser()
}
