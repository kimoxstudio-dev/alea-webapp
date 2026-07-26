import type { NextAuthConfig } from 'next-auth'
import { isSecureContext } from '@/lib/server/shared/security-edge'

/**
 * Auth.js (NextAuth v5) session cookie name — shared, single source of
 * truth between:
 *  - `lib/authjs/config.ts` (the full Node config used by `auth()` /
 *    `signIn()` / `signOut()`, which also determines the salt used to
 *    encrypt/decrypt the JWT — Auth.js derives it from
 *    `cookies.sessionToken.name`)
 *  - `middleware.ts`'s Edge-runtime `getToken()` read
 *
 * Explicitly fixed here (rather than left to NextAuth's own
 * `url.protocol`-based auto-detection of `useSecureCookies`) so both
 * contexts always agree on the exact cookie name — and therefore the same
 * JWT encryption salt — instead of each independently computing a default
 * that could diverge (e.g. if the two contexts ever see the request
 * protocol differently behind a proxy). Driven by the same
 * `isSecureContext()` helper the pre-existing Supabase cookie config used
 * (`getSupabaseCookieOptions()` in this same file), so secure-cookie
 * behavior is consistent with the rest of the app rather than introducing a
 * second, independent source of truth.
 */
export const AUTHJS_SESSION_COOKIE_NAME = isSecureContext()
  ? '__Secure-authjs.session-token'
  : 'authjs.session-token'

/**
 * Edge-runtime-safe subset of the Auth.js config (KIM-433, F3b login/session
 * cutover).
 *
 * Deliberately excludes:
 *  - the Credentials provider (`lib/authjs/config.ts`) — it depends on `pg`
 *    (via `lib/authjs/credentials-user.ts` -> `lib/db`) and `bcryptjs`,
 *    neither of which is Edge-compatible.
 *  - the `jwt`/`session` callbacks that perform a Drizzle lookup — those
 *    also require a Node-only Postgres connection.
 *
 * This object only carries the pieces that MUST match between the Node
 * config and the Edge-runtime session read in `middleware.ts`: session
 * strategy and cookie naming/options. `lib/authjs/config.ts` spreads this
 * object rather than duplicating these fields, so there is exactly one
 * place that defines them.
 */
export const authConfigEdge = {
  session: {
    strategy: 'jwt',
    // Explicit JWT lifetime (KIM-433 follow-up): left unset, NextAuth
    // silently defaults to 30 days, which was never a deliberate choice for
    // this app (develop's Supabase-based session had its own, separately
    // configured lifetime). 7 days is chosen as a defensible balance for an
    // authenticated members' booking app — long enough to avoid forcing
    // frequent re-logins for routine use, short enough to bound how long a
    // stolen/leaked session token stays valid.
    maxAge: 60 * 60 * 24 * 7,
  },
  cookies: {
    sessionToken: {
      name: AUTHJS_SESSION_COOKIE_NAME,
      options: {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        secure: isSecureContext(),
      },
    },
  },
  providers: [],
} satisfies NextAuthConfig
