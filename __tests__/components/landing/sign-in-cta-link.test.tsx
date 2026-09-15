import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SignInCtaLink } from '@/components/landing/sign-in-cta-link'

vi.mock('@/lib/preload-clerk', () => ({
  preloadClerkOnIntent: vi.fn(),
}))

vi.mock('next/link', () => ({
  default: ({
    children,
    href,
    ...rest
  }: {
    children: React.ReactNode
    href: string
  } & Record<string, unknown>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}))

import { preloadClerkOnIntent } from '@/lib/preload-clerk'

describe('SignInCtaLink', () => {
  beforeEach(() => {
    vi.mocked(preloadClerkOnIntent).mockClear()
  })

  it('calls preloadClerkOnIntent and the caller-supplied handler on mouseEnter', () => {
    const onMouseEnter = vi.fn()
    render(
      <SignInCtaLink href="/sign-in" onMouseEnter={onMouseEnter}>
        Reservar sala
      </SignInCtaLink>,
    )

    fireEvent.mouseEnter(screen.getByText('Reservar sala'))

    expect(preloadClerkOnIntent).toHaveBeenCalledTimes(1)
    expect(onMouseEnter).toHaveBeenCalledTimes(1)
  })

  it('calls preloadClerkOnIntent and the caller-supplied handler on focus', () => {
    const onFocus = vi.fn()
    render(
      <SignInCtaLink href="/sign-in" onFocus={onFocus}>
        Reservar sala
      </SignInCtaLink>,
    )

    fireEvent.focus(screen.getByText('Reservar sala'))

    expect(preloadClerkOnIntent).toHaveBeenCalledTimes(1)
    expect(onFocus).toHaveBeenCalledTimes(1)
  })

  it('calls preloadClerkOnIntent and the caller-supplied handler on touchStart', () => {
    const onTouchStart = vi.fn()
    render(
      <SignInCtaLink href="/sign-in" onTouchStart={onTouchStart}>
        Reservar sala
      </SignInCtaLink>,
    )

    fireEvent.touchStart(screen.getByText('Reservar sala'))

    expect(preloadClerkOnIntent).toHaveBeenCalledTimes(1)
    expect(onTouchStart).toHaveBeenCalledTimes(1)
  })

  it('does not throw when no caller handlers are supplied', () => {
    render(<SignInCtaLink href="/sign-in">Reservar sala</SignInCtaLink>)
    const link = screen.getByText('Reservar sala')

    expect(() => {
      fireEvent.mouseEnter(link)
      fireEvent.focus(link)
      fireEvent.touchStart(link)
    }).not.toThrow()

    expect(preloadClerkOnIntent).toHaveBeenCalledTimes(3)
  })
})
