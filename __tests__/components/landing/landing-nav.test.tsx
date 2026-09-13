import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { LandingNav } from '@/components/landing/landing-nav'

// #415 — axe-core's `label-content-name-mismatch` rule flagged the
// language-toggle link: it computes "visible text" as the concatenation of
// only the non-`aria-hidden` text nodes ("ES" + "EN", no separator), and
// checks that string is a contiguous substring of the accessible name. The
// old markup put "ES" and "EN" in plain (non-hidden) spans while overriding
// the accessible name with `aria-label="ES · EN — …"` — the literal
// middle dot and surrounding spaces in the aria-label broke the substring
// match, so the rule failed even though the label plainly mentions "ES" and
// "EN". Confirmed against a real axe-core run in the built app (see PR).
//
// The fix removes the `aria-label` override and derives the accessible name
// entirely from content: a visually-hidden (`sr-only`) sentence carries the
// full "current language / switch to" description, and the visible "ES"/"EN"
// indicator is wrapped in `aria-hidden="true"` so it never has to agree with
// anything — there is no second, independent source of accessible-name text
// for it to mismatch against.

vi.mock('next-intl', () => ({
  useTranslations: (namespace: string) => (key: string, values?: Record<string, string>) => {
    if (namespace === 'nav' && key === 'switchLocaleFull') {
      return `Idioma: ${values?.current}. Cambiar a ${values?.other}`
    }
    return `${namespace}.${key}`
  },
}))

vi.mock('next/navigation', () => ({
  usePathname: () => '/es',
  useSearchParams: () => new URLSearchParams(),
}))

describe('LandingNav — LangToggle accessible name (#415)', () => {
  it('has no aria-label override on the language-toggle link', () => {
    render(<LandingNav locale="es" />)

    const toggles = screen.getAllByRole('link', { name: /idioma/i })
    for (const toggle of toggles) {
      expect(toggle).not.toHaveAttribute('aria-label')
    }
  })

  it('states the current and target language in the accessible name', () => {
    render(<LandingNav locale="es" />)

    const toggles = screen.getAllByRole('link', { name: /idioma/i })
    expect(toggles.length).toBeGreaterThan(0)
    for (const toggle of toggles) {
      expect(toggle).toHaveAccessibleName('Idioma: Español. Cambiar a English')
    }
  })

  it('hides the visible ES/EN indicator from the accessibility tree so it cannot mismatch the name', () => {
    render(<LandingNav locale="es" />)

    const toggles = document.querySelectorAll('a.alea-lang-toggle')
    expect(toggles.length).toBeGreaterThan(0)
    for (const toggle of toggles) {
      const visibleIndicator = toggle.querySelector('[aria-hidden="true"]')
      expect(visibleIndicator).not.toBeNull()
      expect(visibleIndicator?.textContent).toBe('ES·EN')
      expect(visibleIndicator).toHaveClass('alea-lang-codes')
      expect(toggle.querySelector('.alea-lang-sep')?.textContent).toBe('·')
    }
  })
})
