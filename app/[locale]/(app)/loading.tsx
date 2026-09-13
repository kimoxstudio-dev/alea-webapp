'use client'

import { useTranslations } from 'next-intl'
import { DiceLoader } from '@/components/ui/dice-loader'

export default function Loading() {
  const t = useTranslations('common')
  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <DiceLoader size="lg" label={t('loadingPage')} />
    </div>
  )
}
