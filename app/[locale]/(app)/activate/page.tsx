import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import { KeyRound, ShieldAlert, ShieldCheck } from 'lucide-react'
import { ActivationForm } from '@/components/auth/activation-form'
import { getActivationLinkState } from '@/lib/server/auth-service'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('auth')
  return { title: `${t('activationTitle')} -- Alea` }
}

interface ActivationPageProps {
  params: Promise<{ locale: string }>
  searchParams: Promise<{ token?: string }>
}

export default async function ActivationPage({ params, searchParams }: ActivationPageProps) {
  const [{ locale }, { token }] = await Promise.all([params, searchParams])
  const t = await getTranslations('auth')
  const state = await getActivationLinkState(token ?? '')

  const statusCopy = state.status === 'used'
    ? {
      icon: ShieldCheck,
      title: t('activationUsedTitle'),
      body: t('activationUsedBody'),
    }
    : state.status === 'expired'
      ? {
        icon: ShieldAlert,
        title: t('activationExpiredTitle'),
        body: t('activationExpiredBody'),
      }
      : state.status === 'invalid'
        ? {
          icon: ShieldAlert,
          title: t('activationInvalidTitle'),
          body: t('activationInvalidBody'),
        }
        : null
  const StatusIcon = statusCopy?.icon

  return (
    <div className="min-h-[calc(100vh-4rem)] flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <div className="mb-4 flex items-center justify-center gap-3" aria-hidden="true">
            <KeyRound className="h-8 w-8 text-primary" />
            <ShieldCheck className="h-8 w-8 text-primary" />
          </div>
          <h1 className="mb-2 font-cinzel text-3xl font-bold text-gradient-gold">{t('activationTitle')}</h1>
          <p className="text-muted-foreground">
            {state.status === 'valid'
              ? t('activationSubtitle', { memberNumber: state.memberNumber })
              : t('activationErrorSubtitle')}
          </p>
        </div>

        <div className="rpg-card p-8">
          {state.status === 'valid' && token
            ? (
              <>
                <p className="mb-6 text-sm text-muted-foreground">
                  {t('activationIntro', {
                    name: state.fullName ?? state.memberNumber,
                  })}
                </p>
                <ActivationForm locale={locale} token={token} />
              </>
            )
            : statusCopy && StatusIcon && (
              <div className="space-y-4 text-center">
                <StatusIcon className="mx-auto h-10 w-10 text-primary" aria-hidden="true" />
                <div className="space-y-2">
                  <h2 className="font-cinzel text-xl text-foreground">{statusCopy.title}</h2>
                  <p className="text-sm text-muted-foreground">{statusCopy.body}</p>
                </div>
              </div>
            )}
        </div>
      </div>
    </div>
  )
}
