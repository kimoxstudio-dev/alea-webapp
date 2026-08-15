import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import { SignIn } from '@clerk/nextjs'

/**
 * Clerk's own hosted sign-in UI (#299 pass 3 — re-enables the page that was
 * intentionally disabled in #297 pending the Clerk-identity-to-profile
 * mapping, closed by #299 pass 2's `resolveProfileForClerkUser()` /
 * `activateAccount()`).
 *
 * Per explicit product decision this renders Clerk's own prebuilt `<SignIn />`
 * as-is — no bespoke Alea-branded login form, and no re-skinning of Clerk's
 * primitives into a custom screen. `[[...sign-in]]` is Clerk's required
 * catch-all route shape for this component (it owns its own internal
 * multi-step routing).
 *
 * `signUpUrl` points at `/[locale]/register`, which unconditionally redirects
 * back to `/[locale]/login` -> `/[locale]/sign-in` (register has been dead
 * since closed issue #206) — this club has no public self-registration, so
 * the fallback for anyone who reaches a sign-up link fails closed instead of
 * creating a Clerk-only identity with no Alea profile.
 */
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('auth')
  return { title: `${t('login')} — Alea` }
}

interface SignInPageProps {
  params: Promise<{ locale: string }>
  searchParams: Promise<{ redirect_url?: string }>
}

export default async function SignInPage({ params, searchParams }: SignInPageProps) {
  const [{ locale }, { redirect_url: redirectUrl }] = await Promise.all([params, searchParams])

  return (
    <div className="min-h-[calc(100vh-4rem)] flex items-center justify-center p-4">
      <SignIn
        routing="path"
        path={`/${locale}/sign-in`}
        signUpUrl={`/${locale}/register`}
        fallbackRedirectUrl={redirectUrl && redirectUrl.startsWith('/') ? redirectUrl : `/${locale}/rooms`}
      />
    </div>
  )
}
