import type { DefaultSession } from 'next-auth'

/**
 * Type augmentation for Auth.js (NextAuth v5) — KIM-433, F3b login/session
 * cutover.
 *
 * Adds the `role`/`isActive` claims sourced from `profiles` (see
 * `lib/authjs/credentials-user.ts`) and the `profiles.id` (via the JWT
 * `sub` claim) to the `User`, `JWT`, and `Session.user` shapes so they flow
 * from `authorize()` -> `jwt()` -> `session()` (see `lib/authjs/config.ts`)
 * without `any` casts at call sites.
 */
declare module 'next-auth' {
  interface User {
    role: 'member' | 'admin'
    isActive: boolean
  }

  interface Session {
    user: {
      id: string
      role: 'member' | 'admin'
      isActive: boolean
    } & DefaultSession['user']
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    role?: 'member' | 'admin'
    isActive?: boolean
  }
}
