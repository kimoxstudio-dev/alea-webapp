import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import { SignUp } from '@clerk/nextjs'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('auth')
  return { title: `${t('register')} — Alea` }
}

interface SignUpPageProps {
  params: Promise<{ locale: string }>
}

export default async function SignUpPage({ params }: SignUpPageProps) {
  const { locale } = await params

  return (
    <div className="min-h-dvh flex items-center justify-center p-8">
      <SignUp
        path={`/${locale}/sign-up`}
        routing="path"
        signInUrl={`/${locale}/sign-in`}
        fallbackRedirectUrl={`/${locale}/rooms`}
      />
    </div>
  )
}
