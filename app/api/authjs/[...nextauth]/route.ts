import { NextRequest, NextResponse } from 'next/server'
import { handlers } from '@/lib/authjs/auth'

/**
 * Auth.js (NextAuth v5) route handler — F1 scaffolding only (KIM-416).
 *
 * Deliberately mounted at `/api/authjs/*`, distinct from `/api/auth/*`
 * which is reserved for the existing, live Supabase Auth (GoTrue) flow.
 * Nothing in the app links to or calls this route yet — it is inert until
 * KIM-451 removes the transitional Auth.js runtime in favor of Clerk.
 *
 * Forced to the Node.js runtime because the Credentials provider talks to
 * Postgres via `pg`, which is not Edge-compatible.
 *
 * Guarded behind `AUTH_JS_ENABLED` so this endpoint 404s by default even if
 * `AUTH_SECRET`/`POSTGRES_URL` are already present in an environment ahead of
 * removal — it must not become a publicly reachable, unrate-limited
 * password-guessing surface.
 */
export const runtime = 'nodejs'

function isAuthJsEnabled(): boolean {
  return process.env.AUTH_JS_ENABLED === 'true'
}

export async function GET(request: NextRequest) {
  if (!isAuthJsEnabled()) {
    return new NextResponse(null, { status: 404 })
  }
  return handlers.GET(request)
}

export async function POST(request: NextRequest) {
  if (!isAuthJsEnabled()) {
    return new NextResponse(null, { status: 404 })
  }
  return handlers.POST(request)
}
