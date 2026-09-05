import { describe, expect, it } from 'vitest'
import { getAuthServiceErrorMessageKey } from '@/lib/auth/service-error-messages'
import { ERROR_CODES } from '@/lib/types/error-codes'

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

  it('never maps a code to the generic fallback key used by callers', () => {
    // Callers fall back to their own translated "generic" message when this
    // returns null — it must never itself resolve to something a caller
    // would mistake for that fallback.
    const key = getAuthServiceErrorMessageKey(ERROR_CODES.AUTH_PASSWORD_REJECTED)
    expect(key).toBe('errors.servicePasswordRejected')
  })
})
