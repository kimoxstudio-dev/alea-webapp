// Safe-redirect open-redirect vulnerability regression tests (Codex PR #327 finding 4)
import { describe, expect, it } from 'vitest'
import { isSafeRedirectPath, resolveSafeRedirect } from '@/lib/safe-redirect'

describe('safe-redirect — open-redirect vulnerability mitigation (finding 4)', () => {
  describe('isSafeRedirectPath', () => {
    describe('accepts same-origin relative paths', () => {
      it('accepts simple absolute path', () => {
        expect(isSafeRedirectPath('/rooms')).toBe(true)
      })

      it('accepts path with query parameters', () => {
        expect(isSafeRedirectPath('/rooms?next=foo&bar=baz')).toBe(true)
      })

      it('accepts path with locale prefix', () => {
        expect(isSafeRedirectPath('/en/rooms')).toBe(true)
        expect(isSafeRedirectPath('/es/login')).toBe(true)
      })

      it('accepts path with fragment', () => {
        expect(isSafeRedirectPath('/rooms#section')).toBe(true)
      })

      it('accepts deeply nested path', () => {
        expect(isSafeRedirectPath('/en/admin/users/edit')).toBe(true)
      })

      it('accepts path with encoded characters', () => {
        expect(isSafeRedirectPath('/search?q=%20test')).toBe(true)
      })

      it('accepts path ending with slash', () => {
        expect(isSafeRedirectPath('/rooms/')).toBe(true)
      })

      it('accepts path with hyphen and underscore', () => {
        expect(isSafeRedirectPath('/my-path_name')).toBe(true)
      })

      it('accepts path with numbers', () => {
        expect(isSafeRedirectPath('/room123')).toBe(true)
      })
    })

    describe('rejects protocol-relative URLs', () => {
      it('rejects //attacker.example (protocol-relative)', () => {
        // This is the vulnerability: //attacker.example is parsed as an absolute URL
        // to attacker.example by browsers (protocol-relative URL)
        expect(isSafeRedirectPath('//attacker.example')).toBe(false)
      })

      it('rejects //evil.com/path', () => {
        expect(isSafeRedirectPath('//evil.com/path')).toBe(false)
      })

      it('rejects // alone', () => {
        expect(isSafeRedirectPath('//')).toBe(false)
      })
    })

    describe('rejects backslash variants (WHATWG parser normalization)', () => {
      it('rejects /\\attacker.example', () => {
        // Backslash is normalized to forward slash by WHATWG parser,
        // making this a protocol-relative URL in practice
        expect(isSafeRedirectPath('/\\attacker.example')).toBe(false)
      })

      it('rejects \\\\attacker.example', () => {
        expect(isSafeRedirectPath('\\\\attacker.example')).toBe(false)
      })

      it('rejects / followed by backslash', () => {
        expect(isSafeRedirectPath('/\\')).toBe(false)
      })

      it('rejects /\\/attacker.example', () => {
        expect(isSafeRedirectPath('/\\/attacker.example')).toBe(false)
      })
    })

    describe('rejects absolute URLs with scheme', () => {
      it('rejects http://attacker.example', () => {
        expect(isSafeRedirectPath('http://attacker.example')).toBe(false)
      })

      it('rejects https://attacker.example', () => {
        expect(isSafeRedirectPath('https://attacker.example')).toBe(false)
      })

      it('rejects javascript:..., rejects javascript: scheme if applicable', () => {
        // JavaScript URLs are absolute and will be rejected
        expect(isSafeRedirectPath('javascript:alert(1)')).toBe(false)
      })

      it('rejects data: URLs', () => {
        expect(isSafeRedirectPath('data:text/html,<script>alert(1)</script>')).toBe(false)
      })

      it('rejects file: URLs', () => {
        expect(isSafeRedirectPath('file:///etc/passwd')).toBe(false)
      })
    })

    describe('rejects control characters and problematic input', () => {
      it('rejects input with embedded tab character', () => {
        // Tab (\x09) is a control character that gets stripped by WHATWG parser
        expect(isSafeRedirectPath('/rooms\t@attacker.example')).toBe(false)
      })

      it('rejects input with embedded CR character', () => {
        // CR (\x0d) is stripped by WHATWG parser
        expect(isSafeRedirectPath('/rooms\r@attacker.example')).toBe(false)
      })

      it('rejects input with embedded LF character', () => {
        // LF (\x0a) is stripped by WHATWG parser
        expect(isSafeRedirectPath('/rooms\n@attacker.example')).toBe(false)
      })

      it('rejects input with embedded null byte', () => {
        // Null byte control character
        expect(isSafeRedirectPath('/rooms\x00@attacker.example')).toBe(false)
      })

      it('rejects input with any ASCII control character', () => {
        // All \x00 through \x1f should be rejected
        for (let i = 0; i <= 0x1f; i++) {
          const badPath = `/rooms${String.fromCharCode(i)}test`
          expect(isSafeRedirectPath(badPath)).toBe(false)
        }
      })
    })

    describe('rejects null, undefined, empty', () => {
      it('rejects null', () => {
        expect(isSafeRedirectPath(null)).toBe(false)
      })

      it('rejects undefined', () => {
        expect(isSafeRedirectPath(undefined)).toBe(false)
      })

      it('rejects empty string', () => {
        expect(isSafeRedirectPath('')).toBe(false)
      })

      it('rejects whitespace only', () => {
        expect(isSafeRedirectPath('   ')).toBe(false)
      })
    })

    describe('rejects paths that do not start with slash or start with // or /\\', () => {
      it('rejects relative path without leading slash', () => {
        expect(isSafeRedirectPath('rooms')).toBe(false)
      })

      it('rejects path starting with just slash and slash', () => {
        expect(isSafeRedirectPath('//')).toBe(false)
      })

      it('rejects single slash alone when followed only by slash', () => {
        // This is implicitly covered by the regex /^\/[^/\\]/ requirement
        expect(isSafeRedirectPath('/')).toBe(false) // Just slash is not matched by /^\/[^/\\]/
      })
    })
  })

  describe('resolveSafeRedirect', () => {
    it('returns the value if it is a safe redirect path', () => {
      const result = resolveSafeRedirect('/rooms', '/default')
      expect(result).toBe('/rooms')
    })

    it('returns fallback if value is null', () => {
      const result = resolveSafeRedirect(null, '/default')
      expect(result).toBe('/default')
    })

    it('returns fallback if value is undefined', () => {
      const result = resolveSafeRedirect(undefined, '/default')
      expect(result).toBe('/default')
    })

    it('returns fallback if value is an unsafe protocol-relative URL', () => {
      const result = resolveSafeRedirect('//attacker.example', '/default')
      expect(result).toBe('/default')
    })

    it('returns fallback if value contains backslash variant', () => {
      const result = resolveSafeRedirect('/\\attacker.example', '/default')
      expect(result).toBe('/default')
    })

    it('returns fallback if value is an absolute URL', () => {
      const result = resolveSafeRedirect('https://attacker.example', '/default')
      expect(result).toBe('/default')
    })

    it('returns fallback if value contains control characters', () => {
      const result = resolveSafeRedirect('/rooms\t@attacker.example', '/default')
      expect(result).toBe('/default')
    })

    it('returns value with query params if safe', () => {
      const result = resolveSafeRedirect('/rooms?next=/profile', '/default')
      expect(result).toBe('/rooms?next=/profile')
    })

    it('can use any fallback string', () => {
      const result = resolveSafeRedirect('//evil.com', '/en/login')
      expect(result).toBe('/en/login')
    })
  })

  describe('integration: realistic auth flow scenarios', () => {
    it('safe redirect works for sign-in callback with next parameter', () => {
      // Simulates: /sign-in?next=/en/rooms
      const nextParam = '/en/rooms'
      const fallback = '/en/login'
      const redirectTo = resolveSafeRedirect(nextParam, fallback)

      expect(redirectTo).toBe('/en/rooms')
    })

    it('falls back to login if next parameter is malicious protocol-relative', () => {
      // Simulates attacker trying: /sign-in?next=//attacker.example
      const nextParam = '//attacker.example'
      const fallback = '/en/login'
      const redirectTo = resolveSafeRedirect(nextParam, fallback)

      expect(redirectTo).toBe('/en/login')
    })

    it('falls back if next parameter is absolute URL', () => {
      // Simulates attacker trying: /sign-in?next=https://attacker.example
      const nextParam = 'https://attacker.example/steal'
      const fallback = '/en/dashboard'
      const redirectTo = resolveSafeRedirect(nextParam, fallback)

      expect(redirectTo).toBe('/en/dashboard')
    })

    it('preserves safe locale and path in next parameter', () => {
      // Simulates: /es/login?next=/es/salas/bookings
      const nextParam = '/es/salas/bookings'
      const fallback = '/es/login'
      const redirectTo = resolveSafeRedirect(nextParam, fallback)

      expect(redirectTo).toBe('/es/salas/bookings')
    })

    it('falls back for backslash-attack variant /\\ parsing', () => {
      // Simulates attacker trying: /sign-in?next=/\attacker.example
      const nextParam = '/\\attacker.example'
      const fallback = '/en/login'
      const redirectTo = resolveSafeRedirect(nextParam, fallback)

      expect(redirectTo).toBe('/en/login')
    })
  })
})
