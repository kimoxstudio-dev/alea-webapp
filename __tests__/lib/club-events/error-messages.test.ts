import { describe, expect, it } from 'vitest'
import { getClubEventErrorMessageKey } from '@/lib/club-events/error-messages'
import { ERROR_CODES } from '@/lib/types/error-codes'
import en from '@/messages/en.json'
import es from '@/messages/es.json'

/** Resolves a dot-path key (e.g. "clubEvents.errors.invalidDateKind") against
 * the `admin` namespace of a locale file, the same way `useTranslations('admin')`
 * does at runtime. Returns `undefined` if any segment is missing. */
function resolveAdminKey(messages: unknown, key: string): unknown {
  const segments = key.split('.')
  let node: unknown = (messages as { admin?: unknown }).admin
  for (const segment of segments) {
    if (typeof node !== 'object' || node === null) return undefined
    node = (node as Record<string, unknown>)[segment]
  }
  return node
}

describe('getClubEventErrorMessageKey', () => {
  it('maps every CLUB_EVENT_* error code to a clubEvents.errors.* translation key', () => {
    const clubEventCodes = Object.values(ERROR_CODES).filter((code) => code.startsWith('CLUB_EVENT_'))
    expect(clubEventCodes.length).toBeGreaterThan(0)

    for (const code of clubEventCodes) {
      const key = getClubEventErrorMessageKey(code)
      expect(key).not.toBeNull()
      expect(key).toMatch(/^clubEvents\.errors\./)
    }
  })

  it('returns null for a code with no mapping', () => {
    expect(getClubEventErrorMessageKey('NOT_A_REAL_CODE')).toBeNull()
  })

  it('returns null for a missing code', () => {
    expect(getClubEventErrorMessageKey(undefined)).toBeNull()
    expect(getClubEventErrorMessageKey(null)).toBeNull()
    expect(getClubEventErrorMessageKey('')).toBeNull()
  })

  it('maps every CLUB_EVENT_* error code to a key that actually resolves in both locale files', () => {
    // The mapped key is cast past next-intl's type safety at the call site
    // (`t(messageKey as Parameters<typeof t>[0])`), and the component's test
    // mocks `useTranslations` as an identity function — so a typo'd key
    // (e.g. "clubEvents.errors.invalidRomm") would compile and pass every
    // other test here while shipping a broken translation. This is the one
    // check that would catch it: resolve the key against the real messages
    // files (mirrors __tests__/lib/auth/service-error-messages.test.ts).
    const clubEventCodes = Object.values(ERROR_CODES).filter((code) => code.startsWith('CLUB_EVENT_'))
    expect(clubEventCodes.length).toBeGreaterThan(0)

    for (const code of clubEventCodes) {
      const key = getClubEventErrorMessageKey(code)
      expect(key).not.toBeNull()

      const enValue = resolveAdminKey(en, key as string)
      const esValue = resolveAdminKey(es, key as string)
      expect(typeof enValue, `admin.${key} missing/non-string in en.json`).toBe('string')
      expect(typeof esValue, `admin.${key} missing/non-string in es.json`).toBe('string')
    }
  })

  it('never maps a code to the generic fallback key used by callers', () => {
    // Callers fall back to their own translated "saveError" message when
    // this returns null — it must never itself resolve to something a
    // caller would mistake for that fallback.
    const key = getClubEventErrorMessageKey(ERROR_CODES.CLUB_EVENT_INVALID_DATE_KIND)
    expect(key).toBe('clubEvents.errors.invalidDateKind')
  })
})
