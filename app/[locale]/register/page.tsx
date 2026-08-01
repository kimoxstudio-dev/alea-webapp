import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import { Sword, Scroll } from 'lucide-react'
import { RegisterForm } from '@/components/auth/register-form'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('auth')
  return { title: `${t('register')} — Alea` }
}

interface RegisterPageProps {
  params: Promise<{ locale: string }>
}

export default async function RegisterPage({ params }: RegisterPageProps) {
  const { locale } = await params
  const t = await getTranslations('auth')

  return (
    <div className="min-h-[calc(100vh-4rem)] flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="flex items-center justify-center gap-3 mb-4" aria-hidden="true">
            <Scroll className="h-8 w-8 text-primary" />
            <Sword className="h-8 w-8 text-primary" />
          </div>
          <h1 className="font-cinzel text-3xl font-bold text-gradient-gold mb-2">{t('register')}</h1>
          <p className="text-muted-foreground">{t('registerSubtitle')}</p>
        </div>
        <div className="rpg-card p-8">
          <RegisterForm locale={locale} />
        </div>
      </div>
    </div>
  )
}
