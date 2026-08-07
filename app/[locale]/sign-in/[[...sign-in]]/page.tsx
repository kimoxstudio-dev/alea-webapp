import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import { SignIn } from '@clerk/nextjs'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('auth')
  return { title: `${t('login')} — Alea` }
}

interface SignInPageProps {
  params: Promise<{ locale: string }>
}

export default async function SignInPage({ params }: SignInPageProps) {
  const { locale } = await params

  return (
    <div className="min-h-dvh flex items-center justify-center p-8">
      <SignIn
        path={`/${locale}/sign-in`}
        routing="path"
        signUpUrl={`/${locale}/sign-up`}
        fallbackRedirectUrl={`/${locale}/rooms`}
      />
    </div>
  )
}
