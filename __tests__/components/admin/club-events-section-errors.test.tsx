import { render, screen, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ClubEventsSection } from '@/components/admin/club-events-section'
import esMessages from '@/messages/es.json'

/**
 * Fix 2: club-event server validation errors must reach this Spanish-capable
 * admin page as a translated message, never as the raw `ERROR_CODES.CLUB_EVENT_*`
 * code the server throws as `error.message` (same defect class as #313's auth
 * errors). This file's `next-intl` mock — unlike
 * `club-events-section.test.tsx`'s (which returns the raw key, irrelevant to
 * those tests) — resolves real strings from `messages/es.json` so a passing
 * test proves an actual translated sentence rendered, not just "some string".
 */
vi.mock('next-intl', () => ({
  useTranslations: (namespace: string) => (key: string, values?: Record<string, unknown>) => {
    const path = `${namespace}.${key}`.split('.')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let node: any = esMessages
    for (const segment of path) node = node?.[segment]
    if (typeof node !== 'string') return path.join('.')
    return values
      ? Object.entries(values).reduce((acc, [k, v]) => acc.replaceAll(`{${k}}`, String(v)), node)
      : node
  },
  useLocale: () => 'es',
}))

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}
// @ts-expect-error -- test-only jsdom polyfill
global.ResizeObserver = ResizeObserverMock

const mockCreateMutateAsync = vi.fn()

vi.mock('@/lib/hooks/use-admin', () => ({
  useAdminClubEvents: () => ({ data: { upcoming: [], past: [] }, isLoading: false }),
  useAdminCreateClubEvent: () => ({ mutateAsync: mockCreateMutateAsync, isPending: false }),
  useAdminUpdateClubEvent: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useAdminDeleteClubEvent: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useAdminRooms: () => ({ data: [], isLoading: false }),
  useAdminRoomTables: () => ({ data: [], isLoading: false }),
  useAdminEquipment: () => ({ data: [], isLoading: false }),
  useAdminUploadImage: () => ({ mutateAsync: vi.fn(), isPending: false }),
}))

async function fillMinimalFormAndSubmit() {
  const user = userEvent.setup()
  render(<ClubEventsSection />)

  await user.click(screen.getByRole('button', { name: esMessages.admin.clubEvents.createEvent }))
  await user.type(screen.getByLabelText(esMessages.admin.clubEvents.titleEs), 'Poker Night')
  fireEvent.change(screen.getByLabelText(esMessages.admin.clubEvents.date), { target: { value: '2026-06-01' } })
  await user.click(screen.getByRole('button', { name: esMessages.common.save }))
}

describe('ClubEventsSection — server validation errors are translated (Fix 2)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('shows the translated Spanish message for a mapped CLUB_EVENT_* error code, not the raw code', async () => {
    // `apiClient` (lib/api/client.ts) throws the parsed JSON error body — a
    // plain object, not an `Error` instance — on a failed response. Rejecting
    // with a real `Error` here would leave `extractErrorCode`'s plain-object
    // branch (the one this actually exercises in production) untested.
    mockCreateMutateAsync.mockRejectedValueOnce({ message: 'CLUB_EVENT_INVALID_DATE_KIND', statusCode: 400 })

    await fillMinimalFormAndSubmit()

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(esMessages.admin.clubEvents.errors.invalidDateKind)
    expect(alert).not.toHaveTextContent('CLUB_EVENT_INVALID_DATE_KIND')
  })

  it('falls back to the generic translated save-error message for an unmapped code, without crashing', async () => {
    mockCreateMutateAsync.mockRejectedValueOnce({ message: 'Internal server error', statusCode: 500 })

    await fillMinimalFormAndSubmit()

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(esMessages.admin.clubEvents.saveError)
  })

  it('falls back to the generic translated save-error message for a network-style error with no code, without crashing', async () => {
    mockCreateMutateAsync.mockRejectedValueOnce(new TypeError('Failed to fetch'))

    await fillMinimalFormAndSubmit()

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(esMessages.admin.clubEvents.saveError)
  })
})
