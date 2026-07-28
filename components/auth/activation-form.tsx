'use client'

import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Check, X } from 'lucide-react'
import { DiceLoader } from '@/components/ui/dice-loader'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { PasswordInput } from '@/components/ui/password-input'
import { activationSchema, getPasswordRequirementChecks, type ActivationFormData } from '@/lib/validations/auth'
import { apiClient } from '@/lib/api/client'
import { endpoints } from '@/lib/api/endpoints'

function PasswordStrengthIndicator({ password }: { password: string }) {
  const t = useTranslations('auth.passwordRequirements')
  const checks = getPasswordRequirementChecks(password)

  return (
    <ul className="mt-2 space-y-1" aria-label={t('title')}>
      {checks.map((check) => (
        <li key={check.key} className="flex items-center gap-2 text-xs">
          {check.passed
            ? <Check className="h-3 w-3 text-emerald-500 flex-shrink-0" aria-hidden="true" />
            : <X className="h-3 w-3 text-muted-foreground flex-shrink-0" aria-hidden="true" />}
          <span className={check.passed ? 'text-emerald-400' : 'text-muted-foreground'}>
            {t(check.key)}
          </span>
          <span className="sr-only">{check.passed ? t('met') : t('pending')}</span>
        </li>
      ))}
    </ul>
  )
}

interface ActivationFormProps {
  locale: string
  token: string
}

export function ActivationForm({ locale, token }: ActivationFormProps) {
  const t = useTranslations('auth')
  const router = useRouter()
  const [serverError, setServerError] = useState<string | null>(null)

  const { register, handleSubmit, watch, formState: { errors, isSubmitting } } = useForm<ActivationFormData>({
    resolver: zodResolver(activationSchema),
    defaultValues: {
      password: '',
      confirmPassword: '',
    },
  })

  const passwordValue = watch('password', '')
  const allPasswordChecksPassed = getPasswordRequirementChecks(passwordValue).every((check) => check.passed)

  const onSubmit = async (data: ActivationFormData) => {
    setServerError(null)

    try {
      await apiClient.post(endpoints.auth.activate, {
        token,
        password: data.password,
      })
      router.push(`/${locale}/login`)
    } catch (error) {
      const message = error instanceof Error
        ? error.message
        : typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string'
          ? error.message
          : null
      setServerError(message ?? t('activationInvalidBody'))
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
        <Label htmlFor="activation-password">{t('password')}</Label>
        <PasswordInput
          id="activation-password"
          autoComplete="new-password"
          aria-describedby="activation-password-requirements"
          aria-invalid={!!errors.password}
          {...register('password')}
        />
        <div id="activation-password-requirements">
          <PasswordStrengthIndicator password={passwordValue} />
        </div>
        {errors.password && (
          <p role="alert" className="text-xs text-destructive">
            {t(errors.password.message as Parameters<typeof t>[0])}
          </p>
        )}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="activation-confirm-password">{t('confirmPassword')}</Label>
        <PasswordInput
          id="activation-confirm-password"
          variant="confirmation"
          autoComplete="new-password"
          aria-describedby={errors.confirmPassword ? 'activation-confirm-password-error' : undefined}
          aria-invalid={!!errors.confirmPassword}
          {...register('confirmPassword')}
        />
        {errors.confirmPassword && (
          <p id="activation-confirm-password-error" role="alert" className="text-xs text-destructive">
            {t(errors.confirmPassword.message as Parameters<typeof t>[0])}
          </p>
        )}
      </div>

      <Button type="submit" className="w-full" disabled={isSubmitting || !allPasswordChecksPassed}>
        {isSubmitting
          ? (
            <span className="inline-flex items-center gap-2">
              <DiceLoader size="sm" />
              <span>{t('activationAction')}...</span>
            </span>
          )
          : t('activationAction')}
      </Button>
    </form>
  )
}
