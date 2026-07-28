import 'server-only'
import Credentials from 'next-auth/providers/credentials'
import type { NextAuthConfig } from 'next-auth'
import { verifyCredentials } from '@/lib/authjs/credentials-user'
import { authConfigEdge } from '@/lib/authjs/config-edge'

/**
 * Auth.js (NextAuth v5) configuration.
 *
 * Originally F1 scaffolding (KIM-416), wired into the live session path by
 * KIM-433 (F3b login/session cutover) — see `lib/server/auth/auth.ts` and
 * `lib/server/auth/auth-service.ts` for the call sites.
 *
 * JWT session strategy is used deliberately: no database session adapter
 * is configured, so no session row lookup is needed; the `jwt`/`session`
 * callbacks below add the `role`/`isActive` claims from
 * `lib/authjs/credentials-user.ts` onto the token/session so server code can
 * read them without a second DB round trip for display purposes (the
 * privilege-check DB read in `lib/server/auth/auth.ts` still re-verifies
 * role/active status fresh on every request — see that file's comments).
 *
 * Spreads `authConfigEdge` (session strategy + cookie name/options) rather
 * than duplicating those fields, so the Edge-runtime session read in
 * `middleware.ts` (via `getToken()`) always agrees with this config on the
 * exact cookie name — see `lib/authjs/config-edge.ts` for why that matters.
 *
 * Requires the `AUTH_SECRET` environment variable to be set (see
 * `.env.example`).
 */
export const authConfig: NextAuthConfig = {
  ...authConfigEdge,
  // Matches the actual mount point (`app/api/authjs/[...nextauth]/route.ts`),
  // which is deliberately NOT `/api/auth` (that path is used by this app's
  // own, unrelated Route Handlers — login/logout/activate/recover/me).
  // NextAuth defaults `basePath` to `/api/auth` for backwards compatibility
  // with v4; left unset, that default wouldn't matter for the in-process
  // `signIn()`/`signOut()`/`auth()` calls this issue wires up (they
  // construct and parse their own internal action URLs consistently
  // against whatever `basePath` this config has, regardless of value —
  // never an actual HTTP round trip through Next's router), but it WOULD
  // break the actual mounted `/api/authjs/*` route if it's ever invoked
  // directly over HTTP (e.g. once AUTH_JS_ENABLED is flipped on for a
  // future cutover) — so it's set explicitly here to avoid that latent trap.
  basePath: '/api/authjs',
  providers: [
    Credentials({
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(credentials) {
        const email = typeof credentials?.email === 'string' ? credentials.email : null
        const password = typeof credentials?.password === 'string' ? credentials.password : null

        if (!email || !password) {
          return null
        }

        const user = await verifyCredentials(email, password)

        if (!user) {
          return null
        }

        return {
          id: user.id,
          email: user.email,
          name: user.name ?? undefined,
          role: user.role,
          isActive: user.isActive,
        }
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.role = user.role
        token.isActive = user.isActive
      }
      return token
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.id = token.sub ?? session.user.id
        if (token.role) {
          session.user.role = token.role
        }
        if (typeof token.isActive === 'boolean') {
          session.user.isActive = token.isActive
        }
      }
      return session
    },
  },
}
