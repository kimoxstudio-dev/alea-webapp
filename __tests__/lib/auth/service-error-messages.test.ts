import { describe, expect, it } from 'vitest'
import { getAuthServiceErrorMessageKey } from '@/lib/auth/service-error-messages'
import { ERROR_CODES } from '@/lib/types/error-codes'
import en from '@/messages/en.json'
import es from '@/messages/es.json'

/** Resolves a dot-path key (e.g. "errors.servicePasswordRejected") against
 * the `auth` namespace of a locale file, the same way `useTranslations('auth')`
 * does at runtime. Returns `undefined` if any segment is missing. */
function resolveAuthKey(messages: unknown, key: string): unknown {
  const segments = key.split('.')
  let node: unknown = (messages as { auth?: unknown }).auth
  for (const segment of segments) {
    if (typeof node !== 'object' || node === null) return undefined
    node = (node as Record<string, unknown>)[segment]
  }
  return node
}

describe('getAuthServiceErrorMessageKey', () => {
  it('maps every AUTH_* error code to an errors.* translation key', () => {
    const authCodes = Object.values(ERROR_CODES).filter((code) => code.startsWith('AUTH_'))
    expect(authCodes.length).toBeGreaterThan(0)

    for (const code of authCodes) {
      const key = getAuthServiceErrorMessageKey(code)
      expect(key).not.toBeNull()
      expect(key).toMatch(/^errors\./)
    }
  })

  it('returns null for a code with no mapping', () => {
    expect(getAuthServiceErrorMessageKey('NOT_A_REAL_CODE')).toBeNull()
  })

  it('returns null for a missing code', () => {
    expect(getAuthServiceErrorMessageKey(undefined)).toBeNull()
    expect(getAuthServiceErrorMessageKey(null)).toBeNull()
    expect(getAuthServiceErrorMessageKey('')).toBeNull()
  })

  it('maps every AUTH_* error code to a key that actually resolves in both locale files', () => {
    // The mapped key is cast past next-intl's type safety at every call site
    // (`t(messageKey as Parameters<typeof t>[0])`), and every consumer test
    // mocks `useTranslations` as an identity function — so a typo'd key
    // (e.g. "errors.serviceUserNotFund") would compile and pass every other
    // test here while shipping a broken translation. This is the one check
    // that would catch it: resolve the key against the real messages files.
    const authCodes = Object.values(ERROR_CODES).filter((code) => code.startsWith('AUTH_'))
    expect(authCodes.length).toBeGreaterThan(0)

    for (const code of authCodes) {
      const key = getAuthServiceErrorMessageKey(code)
      expect(key).not.toBeNull()

      const enValue = resolveAuthKey(en, key as string)
      const esValue = resolveAuthKey(es, key as string)
      expect(typeof enValue, `errors.${key} missing/non-string in en.json`).toBe('string')
      expect(typeof esValue, `errors.${key} missing/non-string in es.json`).toBe('string')
    }
  })

  it('never maps a code to the generic fallback key used by callers', () => {
    // Callers fall back to their own translated "generic" message when this
    // returns null — it must never itself resolve to something a caller
    // would mistake for that fallback.
    const key = getAuthServiceErrorMessageKey(ERROR_CODES.AUTH_PASSWORD_REJECTED)
    expect(key).toBe('errors.servicePasswordRejected')
  })
})
