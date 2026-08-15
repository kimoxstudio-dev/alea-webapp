'use client'

import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { DiceLoader } from '@/components/ui/dice-loader'
import { getPasswordRequirementChecks, registerSchema, type RegisterFormData } from '@/lib/validations/auth'
import { useAuth } from '@/lib/auth/auth-context'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { PasswordInput } from '@/components/ui/password-input'
import { PasswordStrengthIndicator } from '@/components/auth/password-strength-indicator'

interface RegisterFormProps { locale: string }

export function RegisterForm({ locale }: RegisterFormProps) {
  const t = useTranslations('auth')
  const { register: registerUser } = useAuth()
  const router = useRouter()
  const [serverError, setServerError] = useState<string | null>(null)

  const { register, handleSubmit, watch, formState: { errors, isSubmitting } } = useForm<RegisterFormData>({
    resolver: zodResolver(registerSchema),
  })

  const passwordValue = watch('password', '')
  const allPasswordChecksPassed = getPasswordRequirementChecks(passwordValue).every((c) => c.passed)

  const onSubmit = async (data: RegisterFormData) => {
    setServerError(null)
    try {
      await registerUser(data.memberNumber, data.password)
      router.push(`/${locale}/rooms`)
    } catch (err: unknown) {
      const error = err as { message?: string }
      setServerError(error?.message ?? t('errors.invalidCredentials'))
    }
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} noValidate className="space-y-5">
      {serverError && (
        <div role="alert" className="rounded-md bg-destructive/15 border border-destructive/30 px-4 py-3 text-sm text-destructive">
          {serverError}
        </div>
      )}

      <div className="space-y-1.5">
        <Label htmlFor="memberNumber">{t('memberNumber')}</Label>
        <Input id="memberNumber" type="text" placeholder="123456"
          aria-describedby={errors.memberNumber ? 'memberNumber-error' : undefined}
          aria-invalid={!!errors.memberNumber}
          {...register('memberNumber')}
        />
        {errors.memberNumber && <p id="memberNumber-error" role="alert" className="text-xs text-destructive">{t(errors.memberNumber.message as Parameters<typeof t>[0])}</p>}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="reg-password">{t('password')}</Label>
        <PasswordInput id="reg-password" autoComplete="new-password"
          aria-describedby="password-requirements"
          aria-invalid={!!errors.password}
          {...register('password')}
        />
        <div id="password-requirements"><PasswordStrengthIndicator password={passwordValue} /></div>
        {errors.password && <p role="alert" className="text-xs text-destructive">{t(errors.password.message as Parameters<typeof t>[0])}</p>}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="confirmPassword">{t('confirmPassword')}</Label>
        <PasswordInput id="confirmPassword" variant="confirmation" autoComplete="new-password"
          aria-describedby={errors.confirmPassword ? 'confirm-error' : undefined}
          aria-invalid={!!errors.confirmPassword}
          {...register('confirmPassword')}
        />
        {errors.confirmPassword && <p id="confirm-error" role="alert" className="text-xs text-destructive">{t(errors.confirmPassword.message as Parameters<typeof t>[0])}</p>}
      </div>

      <Button
        type="submit"
        className="w-full h-11 text-base font-semibold bg-primary text-primary-foreground hover:bg-primary/90 shadow-lg shadow-primary/25 transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed disabled:shadow-none"
        disabled={isSubmitting || !allPasswordChecksPassed}
      >
        {isSubmitting
          ? (
            <span className="inline-flex items-center gap-2">
              <DiceLoader size="sm" />
              <span>{t('register')}...</span>
            </span>
          )
          : t('register')}
      </Button>
    </form>
  )
}
