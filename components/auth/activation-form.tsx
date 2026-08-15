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
 * Claims an admin-issued activation link (#299 pass 3).
 *
 * No password fields anymore — Clerk owns credentials. The caller must
 * already hold an authenticated Clerk session before this can succeed
 * (`activateAccount()` in `lib/server/auth-service.ts` enforces this and
 * matches the session's verified email against the target profile); if
 * they don't, this sends them to Clerk's hosted sign-in with a `redirect_url`
 * pointing back at this exact activation link so they land here again
 * afterwards.
 */
interface ActivationFormProps {
  locale: string
  token: string
}

export function ActivationForm({ locale, token }: ActivationFormProps) {
  const t = useTranslations('auth')
  const router = useRouter()
  const { isLoaded, isSignedIn } = useAuth()
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [serverError, setServerError] = useState<string | null>(null)

  const returnUrl = `/${locale}/activate?token=${encodeURIComponent(token)}`
  const signInUrl = `/${locale}/sign-in?redirect_url=${encodeURIComponent(returnUrl)}`

  const handleActivate = async () => {
    setServerError(null)
    setIsSubmitting(true)
    try {
      await apiClient.post(endpoints.auth.activate, { token })
      router.push(`/${locale}/rooms`)
      router.refresh()
    } catch (error) {
      const message = error instanceof Error
        ? error.message
        : typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string'
          ? error.message
          : null
      setServerError(message ?? t('activationInvalidBody'))
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
        <p className="text-sm text-muted-foreground">{t('activationSignInRequired')}</p>
        <Button asChild className="w-full">
          <a href={signInUrl}>{t('activationSignInAction')}</a>
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

      <Button type="button" className="w-full" disabled={isSubmitting} onClick={handleActivate}>
        {isSubmitting
          ? (
            <span className="inline-flex items-center gap-2">
              <DiceLoader size="sm" />
              <span>{t('activationAction')}...</span>
            </span>
          )
          : t('activationAction')}
      </Button>
    </div>
  )
}
