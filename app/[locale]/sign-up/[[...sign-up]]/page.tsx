import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import Link from 'next/link'
import { ShieldAlert } from 'lucide-react'

/**
 * Public Clerk sign-up is intentionally disabled for this increment (#297).
 *
 * Clerk's <SignUp /> component would let any visitor create a live,
 * Clerk-only account with no corresponding Alea profile/role — that mapping
 * (Clerk identity -> member domain model) doesn't exist until #298/#299
 * land. Rendering the real sign-up form here today would produce orphaned
 * auth accounts, so this fails closed: no form is rendered, and visitors are
 * pointed to sign-in instead.
 */
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('auth')
  return { title: `${t('register')} — Alea` }
}

interface SignUpPageProps {
  params: Promise<{ locale: string }>
}

export default async function SignUpPage({ params }: SignUpPageProps) {
  const { locale } = await params
  const t = await getTranslations('auth')

  return (
    <div className="min-h-[calc(100vh-4rem)] flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="rpg-card p-8 space-y-4 text-center">
          <ShieldAlert className="mx-auto h-10 w-10 text-primary" aria-hidden="true" />
          <div className="space-y-2">
            <h1 className="font-cinzel text-xl text-foreground">
              {t('registerUnavailableTitle')}
            </h1>
            <p className="text-sm text-muted-foreground">
              {t('registerUnavailableBody')}
            </p>
          </div>
          <Link
            href={`/${locale}/sign-in`}
            className="inline-block text-sm font-medium text-primary underline-offset-4 hover:underline"
          >
            {t('login')}
          </Link>
        </div>
      </div>
    </div>
  )
}
