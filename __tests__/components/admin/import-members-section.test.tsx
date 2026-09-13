import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ImportMembersSection } from '@/components/admin/import-members-section'
import type { MemberImportResult } from '@/lib/types'

// #399 — same fixed-slot fix as users-section.test.tsx: a fixed-size wrapper
// span always occupies the icon's space so the "Actualizar" button never
// grows/shifts, but the DiceLoader itself (and its infinite CSS animation)
// only mounts while the import is actually pending.

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}))

const { importMutationState } = vi.hoisted(() => ({
  importMutationState: { isPending: false, isError: false, mutate: vi.fn() },
}))

vi.mock('@/lib/hooks/use-admin', () => ({
  useAdminImportUsers: () => importMutationState,
}))

function getIconSlot(button: HTMLElement) {
  return button.querySelector('span.shrink-0')
}

function queryLoader(button: HTMLElement) {
  return within(button).queryByTestId('dice-loader')
}

describe('ImportMembersSection — pending import button reserves loader space without animating while idle (#399)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    importMutationState.isPending = false
  })

  it('icon slot is reserved but the loader is unmounted when idle', () => {
    render(<ImportMembersSection />)
    const button = screen.getByRole('button', { name: 'importMembersAction' })
    expect(getIconSlot(button)).toHaveClass('h-4', 'w-4', 'shrink-0')
    expect(queryLoader(button)).toBeNull()
  })

  it('loader mounts, and the button stays disabled by isPending alone, while the import is pending', async () => {
    const user = userEvent.setup()
    const { container, rerender } = render(<ImportMembersSection />)

    // Select a file first so a subsequent disabled assertion is attributable
    // to `importMutation.isPending`, not to the button's separate
    // `!importFile` guard (both disable the button independently).
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement
    const file = new File(['member,data'], 'members.csv', { type: 'text/csv' })
    await user.upload(fileInput, file)

    importMutationState.isPending = true
    rerender(<ImportMembersSection />)

    const button = screen.getByRole('button', { name: 'importMembersAction' })
    expect(getIconSlot(button)).not.toBeNull()
    expect(queryLoader(button)).not.toBeNull()
    expect(button).toBeDisabled()
  })
})

// #395 — the preview list previously had no wrap/overflow container, so long
// row text forced the dialog wider (horizontal scroll) while also relying on
// the outer DialogContent for vertical scroll (double-scroll artifact). The
// preview list must contain its own overflow instead of leaking it upward.
describe('ImportMembersSection — preview lists contain their own overflow (#395)', () => {
  beforeEach(() => {
    // resetAllMocks (not clearAllMocks): these tests give
    // `importMutationState.mutate` a custom `mockImplementation` that must
    // not leak its behavior into a later test in this file.
    vi.resetAllMocks()
    importMutationState.isPending = false
  })

  async function submitWithResult(result: MemberImportResult) {
    const user = userEvent.setup()
    importMutationState.mutate.mockImplementation(
      (_file: File, { onSuccess }: { onSuccess: (r: MemberImportResult) => void }) => {
        onSuccess(result)
      },
    )

    const { container } = render(<ImportMembersSection />)
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement
    const file = new File(['member,data'], 'members.csv', { type: 'text/csv' })
    await user.upload(fileInput, file)
    await user.click(screen.getByRole('button', { name: 'importMembersAction' }))
  }

  it('normalized-rows preview: rows wrap and scroll within their own container, never widening or relying on an outer scroll', async () => {
    await submitWithResult({
      totalRows: 1,
      createdCount: 1,
      updatedCount: 0,
      skippedCount: 0,
      normalizedRows: [
        { rowNumber: 1, memberNumber: '1001', fullName: 'Jane Doe', email: 'jane@example.com', phone: '555-0100' },
      ],
      issues: [],
    })

    const row = screen.getByText(/Jane Doe/).closest('li')
    const list = row?.closest('ul')

    expect(list).toHaveClass('max-h-40', 'overflow-y-auto', 'overflow-x-hidden')
    expect(row).toHaveClass('break-words')
  })

  it('issues preview: rows wrap and scroll within their own container, never widening or relying on an outer scroll', async () => {
    await submitWithResult({
      totalRows: 1,
      createdCount: 0,
      updatedCount: 0,
      skippedCount: 1,
      normalizedRows: [],
      issues: [{ rowNumber: 3, memberNumber: '1002', code: 'missing_full_name' }],
    })

    const row = screen.getByText(/importMembersIssueRow/).closest('li')
    const list = row?.closest('ul')

    expect(list).toHaveClass('max-h-40', 'overflow-y-auto', 'overflow-x-hidden')
    expect(row).toHaveClass('break-words')
  })
})
