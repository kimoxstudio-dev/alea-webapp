import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import Link from 'next/link'
import { ShieldAlert } from 'lucide-react'

/**
 * Public Clerk sign-in is intentionally disabled for this increment (#297).
 *
 * Clerk's <SignIn /> component completes a live, Clerk-only session with no
 * corresponding Alea profile/role — that mapping (Clerk identity -> member
 * domain model) doesn't exist until #298/#299 land. Every existing
 * authenticated page still requires the legacy Supabase session, so a
 * successful Clerk sign-in today would dead-end back at the legacy /login
 * route. This fails closed, mirroring the sign-up page: no form is
 * rendered, and visitors are pointed to the legacy sign-in flow instead.
 */
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('auth')
  return { title: `${t('login')} — Alea` }
}

interface SignInPageProps {
  params: Promise<{ locale: string }>
}

export default async function SignInPage({ params }: SignInPageProps) {
  const { locale } = await params
  const t = await getTranslations('auth')

  return (
    <div className="min-h-[calc(100vh-4rem)] flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="rpg-card p-8 space-y-4 text-center">
          <ShieldAlert className="mx-auto h-10 w-10 text-primary" aria-hidden="true" />
          <div className="space-y-2">
            <h1 className="font-cinzel text-xl text-foreground">
              {t('signInUnavailableTitle')}
            </h1>
            <p className="text-sm text-muted-foreground">
              {t('signInUnavailableBody')}
            </p>
          </div>
          <Link
            href={`/${locale}/login`}
            className="inline-block text-sm font-medium text-primary underline-offset-4 hover:underline"
          >
            {t('login')}
          </Link>
        </div>
      </div>
    </div>
  )
}
