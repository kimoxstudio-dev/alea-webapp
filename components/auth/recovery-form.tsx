'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useAuth } from '@clerk/nextjs'
import { DiceLoader } from '@/components/ui/dice-loader'
import { Button } from '@/components/ui/button'
import { apiClient } from '@/lib/api/client'
import { endpoints } from '@/lib/api/endpoints'

/**
 * Claims an admin-issued recovery link (#299 pass 3).
 *
 * No password fields anymore — Clerk owns credentials. Unlike activation,
 * recovery re-links the profile's email to whatever Clerk-verified email the
 * caller is currently signed in with (no email-match check server-side —
 * see `recoverAccount()`'s doc comment in `lib/server/auth-service.ts`),
 * so getting here with the RIGHT Clerk account matters: the recovery token
 * is the sole proof of authorization. If the caller isn't signed in at all,
 * this sends them to Clerk's hosted sign-in with a `redirect_url` back to
 * this exact recovery link.
 */
interface RecoveryFormProps {
  locale: string
  token: string
}

export function RecoveryForm({ locale, token }: RecoveryFormProps) {
  const t = useTranslations('auth')
  const router = useRouter()
  const { isLoaded, isSignedIn } = useAuth()
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [serverError, setServerError] = useState<string | null>(null)

  const returnUrl = `/${locale}/recover?token=${encodeURIComponent(token)}`
  const signInUrl = `/${locale}/sign-in?redirect_url=${encodeURIComponent(returnUrl)}`

  const handleRecover = async () => {
    setServerError(null)
    setIsSubmitting(true)
    try {
      await apiClient.post(endpoints.auth.recover, { token })
      router.push(`/${locale}/rooms`)
      router.refresh()
    } catch (error) {
      const message = error instanceof Error
        ? error.message
        : typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string'
          ? error.message
          : null
      setServerError(message ?? t('recoveryInvalidBody'))
      setIsSubmitting(false)
    }
  }

  if (!isLoaded) {
    return (
      <div className="flex justify-center py-4">
        <DiceLoader size="sm" />
      </div>
    )
  }

  if (!isSignedIn) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">{t('recoverySignInRequired')}</p>
        <Button asChild className="w-full">
          <a href={signInUrl}>{t('recoverySignInAction')}</a>
        </Button>
      </div>
    )
  }

  return (
    <div className="space-y-5">
      {serverError && (
        <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/15 px-4 py-3 text-sm text-destructive">
          {serverError}
        </div>
      )}

      <Button type="button" className="w-full" disabled={isSubmitting} onClick={handleRecover}>
        {isSubmitting
          ? (
            <span className="inline-flex items-center gap-2">
              <DiceLoader size="sm" />
              <span>{t('recoveryAction')}...</span>
            </span>
          )
          : t('recoveryAction')}
      </Button>
    </div>
  )
}
