'use client'

import { useTranslations } from 'next-intl'
import { Check, X } from 'lucide-react'
import { getPasswordRequirementChecks } from '@/lib/validations/auth'

/**
 * Shared password requirement checklist, used by every form that collects a
 * new password (register, activate, recover). Extracted from
 * `register-form.tsx` (#299 pass 3) so activation/recovery forms don't
 * duplicate it now that they collect a password again.
 */
export function PasswordStrengthIndicator({ password }: { password: string }) {
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
