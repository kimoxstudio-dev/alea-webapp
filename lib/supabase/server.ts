import 'server-only'
import { createClient } from '@supabase/supabase-js'
import { createServerClient, type CookieOptions } from '@supabase/ssr'
import { cookies } from 'next/headers'
import type { NextRequest, NextResponse } from 'next/server'
import { getSupabaseCookieOptions } from '@/lib/server/security'
import { getSupabaseUrl, getSupabasePublishableKey } from './config.client'
import { getSupabaseSecretKey } from './config'
import type { Database } from './types'

export async function createSupabaseServerClient() {
  const cookieStore = await cookies()

  return createServerClient<Database>(getSupabaseUrl(), getSupabasePublishableKey(), {
    cookieOptions: getSupabaseCookieOptions(),
    cookies: {
      getAll() {
        return cookieStore.getAll()
      },
      setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
        try {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options),
          )
        } catch {
          // setAll called from a Server Component — cookies are read-only.
          // Session refresh cookies set here are silently dropped; the next
          // Route Handler or Server Action call refreshes them instead.
        }
      },
    },
  })
}

export function createSupabaseRouteHandlerClient(request: NextRequest) {
  const cookiesToSet: { name: string; value: string; options: CookieOptions }[] = []

  const supabase = createServerClient<Database>(getSupabaseUrl(), getSupabasePublishableKey(), {
    cookieOptions: getSupabaseCookieOptions(),
    cookies: {
      getAll() {
        return request.cookies.getAll()
      },
      setAll(nextCookies: { name: string; value: string; options: CookieOptions }[]) {
        nextCookies.forEach((cookie) => {
          cookiesToSet.push(cookie)
        })
      },
    },
  })

  return {
    supabase,
    applyCookies(response: NextResponse) {
      cookiesToSet.forEach(({ name, value, options }) => {
        response.cookies.set(name, value, options)
      })
      return response
    },
  }
}

/**
 * Stateless Supabase admin client using the secret default key.
 * Bypasses RLS entirely — use only in server-side code (Route Handlers, Server Actions).
 * NEVER import this in Client Components or expose it to the browser.
 */
export function createSupabaseServerAdminClient() {
  return createClient<Database>(getSupabaseUrl(), getSupabaseSecretKey(), {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  })
}
