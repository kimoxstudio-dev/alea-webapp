import { NextRequest, NextResponse } from 'next/server'
import { createSupabaseRouteHandlerClient } from '@/lib/supabase/server'
import { resolveSafeRedirect } from '@/lib/safe-redirect'

/**
 * Supabase PKCE auth callback handler.
 * This route is called by Supabase after OAuth or magic link authentication.
 * The full implementation is wired in M3 (auth cutover).
 *
 * @see https://supabase.com/docs/guides/auth/server-side/nextjs
 */
export async function GET(request: NextRequest) {
  const requestUrl = new URL(request.url)
  const code = requestUrl.searchParams.get('code')
  const raw = requestUrl.searchParams.get('next')
  const callbackErrorRedirect = new URL('/', requestUrl.origin)
  callbackErrorRedirect.searchParams.set('authError', 'callback')

  // Same-origin, relative-path validation (#299 review finding 4) — see
  // lib/safe-redirect.ts for what this rejects/accepts.
  const finalRedirect = resolveSafeRedirect(raw, '/')

  if (code) {
    const client = createSupabaseRouteHandlerClient(request)

    try {
      const { error } = await client.supabase.auth.exchangeCodeForSession(code)

      if (error) {
        return client.applyCookies(NextResponse.redirect(callbackErrorRedirect))
      }

      return client.applyCookies(NextResponse.redirect(new URL(finalRedirect, requestUrl.origin)))
    } catch {
      return client.applyCookies(NextResponse.redirect(callbackErrorRedirect))
    }
  }

  return NextResponse.redirect(new URL(finalRedirect, requestUrl.origin))
}
