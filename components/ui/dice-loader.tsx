'use client'

import { useTranslations } from 'next-intl'
import { cn } from '@/lib/utils'

interface DiceLoaderProps {
  size?: 'sm' | 'md' | 'lg'
  label?: string
  className?: string
  hideRole?: boolean
}

const sizeMap = {
  sm: 16,
  md: 24,
  lg: 40,
} as const

function D20Svg({ px, strokeWidth = 1.5 }: { px: number; strokeWidth?: number }) {
  return (
    <span className="inline-flex">
      <svg
        width={px}
        height={px}
        viewBox="0 0 24 24"
        aria-hidden="true"
        stroke="currentColor"
        fill="none"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        className="animate-dice-roll"
      >
        <polygon points="12,2 22,8 22,16 12,22 2,16 2,8" />
        <line x1="12" y1="2" x2="12" y2="10" />
        <line x1="22" y1="8" x2="12" y2="10" />
        <line x1="22" y1="16" x2="12" y2="10" />
        <line x1="12" y1="22" x2="12" y2="10" />
        <line x1="2" y1="16" x2="12" y2="10" />
        <line x1="2" y1="8" x2="12" y2="10" />
      </svg>
    </span>
  )
}

export function DiceLoader({ size = 'md', label, className, hideRole = false }: DiceLoaderProps) {
  const t = useTranslations('common')
  const px = sizeMap[size]

  const roleProps = hideRole
    ? {}
    : { role: 'status' as const, 'aria-live': 'polite' as const, 'aria-label': label ?? t('loading') }

  if (size === 'lg') {
    return (
      <span
        {...roleProps}
        data-testid="dice-loader"
        className={cn('inline-flex items-center justify-center text-primary', className)}
      >
        <span className="relative">
          <span className="absolute inset-0 blur-md opacity-40 text-primary flex items-center justify-center">
            <D20Svg px={px} />
          </span>
          <D20Svg px={px} />
        </span>
      </span>
    )
  }

  return (
    <span
      {...roleProps}
      data-testid="dice-loader"
      className={cn('inline-flex items-center justify-center text-primary', className)}
    >
      <D20Svg px={px} />
    </span>
  )
}
