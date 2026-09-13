import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import { KeyRound, ShieldAlert, ShieldCheck } from 'lucide-react'
import { RecoveryForm } from '@/components/auth/recovery-form'
import { getRecoveryLinkState } from '@/lib/server/auth-service'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('auth')
  return { title: `${t('recoveryTitle')} -- Alea` }
}

interface RecoveryPageProps {
  params: Promise<{ locale: string }>
  searchParams: Promise<{ token?: string }>
}

export default async function RecoveryPage({ params, searchParams }: RecoveryPageProps) {
  const [{ locale }, { token }] = await Promise.all([params, searchParams])
  const t = await getTranslations('auth')
  const state = await getRecoveryLinkState(token ?? '')

  const statusCopy = state.status === 'used'
    ? {
      icon: ShieldCheck,
      title: t('recoveryUsedTitle'),
      body: t('recoveryUsedBody'),
    }
    : state.status === 'expired'
      ? {
        icon: ShieldAlert,
        title: t('recoveryExpiredTitle'),
        body: t('recoveryExpiredBody'),
      }
      : state.status === 'invalid'
        ? {
          icon: ShieldAlert,
          title: t('recoveryInvalidTitle'),
          body: t('recoveryInvalidBody'),
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
          <h1 className="mb-2 font-cinzel text-3xl font-bold text-gradient-gold">{t('recoveryTitle')}</h1>
          <p className="text-muted-foreground">
            {state.status === 'valid'
              ? t('recoverySubtitle', { memberNumber: state.memberNumber })
              : t('recoveryErrorSubtitle')}
          </p>
        </div>

        <div className="rpg-card p-8">
          {state.status === 'valid' && token
            ? (
              <>
                <p className="mb-6 text-sm text-muted-foreground">
                  {t('recoveryIntro', {
                    name: state.fullName ?? state.memberNumber,
                  })}
                </p>
                <RecoveryForm locale={locale} token={token} />
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
