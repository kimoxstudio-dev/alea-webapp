// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { isValidOptionalUrl } from '@/lib/validations/url-client'

describe('isValidOptionalUrl (#313)', () => {
  it('accepts an empty or whitespace-only value — the URL is optional', () => {
    expect(isValidOptionalUrl('')).toBe(true)
    expect(isValidOptionalUrl('   ')).toBe(true)
  })

  it('accepts absolute http(s) URLs', () => {
    expect(isValidOptionalUrl('http://example.com')).toBe(true)
    expect(isValidOptionalUrl('https://example.com')).toBe(true)
  })

  it('rejects a javascript: URL', () => {
    expect(isValidOptionalUrl('javascript:alert(1)')).toBe(false)
  })

  it('rejects a relative path', () => {
    expect(isValidOptionalUrl('/relative/path')).toBe(false)
  })

  it('rejects a non-http(s) scheme', () => {
    expect(isValidOptionalUrl('ftp://example.com')).toBe(false)
  })

  it('rejects a string that is not a URL at all', () => {
    expect(isValidOptionalUrl('not a url')).toBe(false)
  })
})
