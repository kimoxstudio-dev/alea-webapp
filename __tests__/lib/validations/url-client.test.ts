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

  it('accepts generated same-origin landing-media paths only for image fields', () => {
    const path = '/api/media/events/123e4567-e89b-12d3-a456-426614174000.png'
    expect(isValidOptionalUrl(path, true)).toBe(true)
    expect(isValidOptionalUrl(path)).toBe(false)
    expect(isValidOptionalUrl('/api/media/events/private-report.pdf', true)).toBe(false)
  })

  it('rejects a non-http(s) scheme', () => {
    expect(isValidOptionalUrl('ftp://example.com')).toBe(false)
  })

  it('rejects a string that is not a URL at all', () => {
    expect(isValidOptionalUrl('not a url')).toBe(false)
  })
})
