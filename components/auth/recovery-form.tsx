'use client'

import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { DiceLoader } from '@/components/ui/dice-loader'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { PasswordInput } from '@/components/ui/password-input'
import { PasswordStrengthIndicator } from '@/components/auth/password-strength-indicator'
import { activationSchema, getPasswordRequirementChecks, type RecoveryFormData } from '@/lib/validations/auth'
import { apiClient } from '@/lib/api/client'
import { endpoints } from '@/lib/api/endpoints'
import { getAuthServiceErrorMessageKey, extractErrorCode } from '@/lib/auth/service-error-messages'

/**
 * Claims an admin-issued recovery link (#299 pass 3).
 *
 * Collects a new password (and confirmation) directly — there is no more
 * "sign in with Clerk first, then redeem" precondition. The admin-issued,
 * single-use token is the sole proof of authorization; this sets a new
 * password on the member's existing Clerk identity
 * (`recoverAccount()` in `lib/server/auth-service.ts`).
 *
 * Uses `activationSchema` client-side (`RecoveryFormData` is a type alias of
 * `ActivationFormData` in `lib/validations/auth.ts` — same password +
 * confirmPassword shape).
 */
interface RecoveryFormProps {
  locale: string
  token: string
}

export function RecoveryForm({ locale, token }: RecoveryFormProps) {
  const t = useTranslations('auth')
  const router = useRouter()
  const [serverError, setServerError] = useState<string | null>(null)

  const { register, handleSubmit, watch, formState: { errors, isSubmitting } } = useForm<RecoveryFormData>({
    resolver: zodResolver(activationSchema),
  })

  const passwordValue = watch('password', '')
  const allPasswordChecksPassed = getPasswordRequirementChecks(passwordValue).every((c) => c.passed)

  const onSubmit = async (data: RecoveryFormData) => {
    setServerError(null)
    try {
      await apiClient.post(endpoints.auth.recover, { token, password: data.password })
      router.push(`/${locale}/rooms`)
      router.refresh()
    } catch (error) {
      const code = extractErrorCode(error)
      // The server's `message` is always a machine-readable `ERROR_CODES.AUTH_*`
      // code, never end-user text — mapped to a translated message here so
      // no raw English string ever reaches this Spanish-capable page (#313).
      const messageKey = getAuthServiceErrorMessageKey(code)
      setServerError(messageKey ? t(messageKey as Parameters<typeof t>[0]) : t('recoveryInvalidBody'))
    }
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} noValidate className="space-y-5">
      {serverError && (
        <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/15 px-4 py-3 text-sm text-destructive">
          {serverError}
        </div>
      )}

      <div className="space-y-1.5">
        <Label htmlFor="recovery-password">{t('password')}</Label>
        <PasswordInput
          id="recovery-password"
          autoComplete="new-password"
          aria-describedby="recovery-password-requirements"
          aria-invalid={!!errors.password}
          {...register('password')}
        />
        <div id="recovery-password-requirements"><PasswordStrengthIndicator password={passwordValue} /></div>
        {errors.password && <p role="alert" className="text-xs text-destructive">{t(errors.password.message as Parameters<typeof t>[0])}</p>}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="recovery-confirmPassword">{t('confirmPassword')}</Label>
        <PasswordInput
          id="recovery-confirmPassword"
          variant="confirmation"
          autoComplete="new-password"
          aria-describedby={errors.confirmPassword ? 'recovery-confirm-error' : undefined}
          aria-invalid={!!errors.confirmPassword}
          {...register('confirmPassword')}
        />
        {errors.confirmPassword && <p id="recovery-confirm-error" role="alert" className="text-xs text-destructive">{t(errors.confirmPassword.message as Parameters<typeof t>[0])}</p>}
      </div>

      <Button type="submit" className="w-full" disabled={isSubmitting || !allPasswordChecksPassed}>
        {isSubmitting
          ? (
            <span className="inline-flex items-center gap-2">
              <DiceLoader size="sm" />
              <span>{t('recoveryAction')}...</span>
            </span>
          )
          : t('recoveryAction')}
      </Button>
    </form>
  )
}
