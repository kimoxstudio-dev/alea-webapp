import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import enMessages from '@/messages/en.json'
import esMessages from '@/messages/es.json'

const getTranslationsMock = vi.fn()

function translateFaqKey(key: string) {
  const value = key.split('.').reduce<unknown>((current, part) => {
    if (!current || typeof current !== 'object') return undefined
    return (current as Record<string, unknown>)[part]
  }, enMessages.faq)

  if (typeof value !== 'string') throw new Error(`Missing FAQ translation: ${key}`)
  return value
}

function flattenKeys(value: unknown, prefix = ''): string[] {
  if (!value || typeof value !== 'object') return [prefix]
  return Object.entries(value).flatMap(([key, child]) =>
    flattenKeys(child, prefix ? `${prefix}.${key}` : key),
  )
}

function flattenValues(value: unknown): unknown[] {
  if (!value || typeof value !== 'object') return [value]
  return Object.values(value).flatMap(flattenValues)
}

vi.mock('next-intl/server', () => ({
  getTranslations: getTranslationsMock,
}))

describe('FAQ page', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getTranslationsMock.mockResolvedValue(translateFaqKey)
  })

  it('renders public FAQ sections with semantic headings', async () => {
    const { default: FaqPage } = await import('@/app/[locale]/(app)/faq/page')
    const page = await FaqPage({ params: Promise.resolve({ locale: 'en' }) })

    render(page)

    expect(screen.getByRole('heading', { level: 1, name: 'Frequently asked questions' })).toBeInTheDocument()
    expect(screen.getAllByRole('heading', { level: 2 })).toHaveLength(5)
    expect(screen.getByRole('heading', { level: 2, name: 'Reservations' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'How do I activate my account?' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Can I extend a Saved Game reservation?' })).toBeInTheDocument()
    expect(getTranslationsMock).toHaveBeenCalledWith({ locale: 'en', namespace: 'faq' })
  })

  it('opens an accordion answer', async () => {
    const user = userEvent.setup()
    const { default: FaqPage } = await import('@/app/[locale]/(app)/faq/page')
    const page = await FaqPage({ params: Promise.resolve({ locale: 'en' }) })

    render(page)
    const trigger = screen.getByRole('button', { name: 'How do I activate my account?' })

    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    await user.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText(/Ask an administrator for an activation link/)).toBeVisible()
  })

  it('generates localized metadata', async () => {
    const { generateMetadata } = await import('@/app/[locale]/(app)/faq/page')

    await expect(
      generateMetadata({ params: Promise.resolve({ locale: 'en' }) }),
    ).resolves.toEqual({ title: 'Frequently asked questions — Alea' })
    expect(getTranslationsMock).toHaveBeenCalledWith({ locale: 'en', namespace: 'faq' })
  })

  it('keeps FAQ translations complete across locales and page config', async () => {
    const { FAQ_SECTIONS } = await import('@/app/[locale]/(app)/faq/config')
    const configuredKeys = [
      'eyebrow',
      'title',
      'subtitle',
      'currentRules',
      ...FAQ_SECTIONS.flatMap((section) => [
        `sections.${section.key}.title`,
        ...('hasBadge' in section && section.hasBadge
          ? [`sections.${section.key}.badge`]
          : []),
        ...section.items.flatMap((item) => [
          `sections.${section.key}.items.${item}.question`,
          `sections.${section.key}.items.${item}.answer`,
        ]),
      ]),
    ]

    expect(flattenKeys(esMessages.faq).sort()).toEqual(flattenKeys(enMessages.faq).sort())
    expect(flattenKeys(enMessages.faq).sort()).toEqual(configuredKeys.sort())
    expect(flattenValues(enMessages.faq).every((value) => typeof value === 'string' && value.trim().length > 0)).toBe(true)
    expect(flattenValues(esMessages.faq).every((value) => typeof value === 'string' && value.trim().length > 0)).toBe(true)
    expect(esMessages.nav.faq).toBeTruthy()
    expect(enMessages.nav.faq).toBeTruthy()
    expect(esMessages.footer.faq).toBeTruthy()
    expect(enMessages.footer.faq).toBeTruthy()
  })
})
