import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { RoomsSection } from '@/components/admin/rooms-section'

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}))

const { createRoomState, updateRoomState, setRoomDefaultEquipmentState, tablesState, regenerateTableQrState } = vi.hoisted(() => ({
  createRoomState: { isPending: false },
  updateRoomState: { isPending: false },
  setRoomDefaultEquipmentState: { isPending: false },
  tablesState: { data: [] as Array<{ id: string; roomId: string; name: string; type: 'small'; qrCode: string }> },
  regenerateTableQrState: { mutateAsync: vi.fn(), isPending: false },
}))

// A row is needed so the edit dialog is reachable.
const roomFixture = [{ id: 'room-1', name: 'Main Hall', tableCount: 2, description: '' }]

// Stable references — RoomRow effects depend on these arrays by identity
// (see the "Initialize selectedEquipmentIds" effect), so returning a fresh
// `[]` on every mock call would re-trigger those effects every render and
// infinite-loop.
const emptyEquipment: never[] = []
const emptyRoomEquipment: never[] = []

vi.mock('@/lib/hooks/use-admin', () => ({
  useAdminRooms: () => ({ data: roomFixture, isLoading: false }),
  useAdminUpdateRoom: () => ({ mutateAsync: vi.fn(), isPending: updateRoomState.isPending }),
  useAdminCreateRoom: () => ({ mutateAsync: vi.fn(), isPending: createRoomState.isPending }),
  useAdminRoomTables: () => ({ data: tablesState.data, isLoading: false }),
  useAdminCreateTable: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useAdminRegenerateTableQr: () => regenerateTableQrState,
  useAdminEquipment: () => ({ data: emptyEquipment, isLoading: false }),
  useAdminRoomDefaultEquipment: () => ({ data: emptyRoomEquipment, isLoading: false }),
  useAdminSetRoomDefaultEquipment: () => ({ mutateAsync: vi.fn(), isPending: setRoomDefaultEquipmentState.isPending }),
}))

// #408 — same fixed-slot fix as #399/#404, applied to this file's two
// `min-w-[80px]` sites. Both are gated on a compound pending condition
// (the room mutation OR the default-equipment mutation), not a single
// mutation flag — covering that compound condition, not just one half of
// it, is the point of the "loader mounts" tests below.
describe('RoomsSection — pending buttons reserve loader space without animating while idle (#408)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    createRoomState.isPending = false
    updateRoomState.isPending = false
    setRoomDefaultEquipmentState.isPending = false
    tablesState.data = []
    regenerateTableQrState.mutateAsync.mockReset()
    regenerateTableQrState.isPending = false
  })

  function getIconSlot(button: HTMLElement) {
    return button.querySelector('span.shrink-0')
  }

  function queryLoader(button: HTMLElement) {
    return within(button).queryByTestId('dice-loader')
  }

  it('create-dialog save button: icon slot reserved with correct sizing but loader unmounted when idle', async () => {
    const user = userEvent.setup()
    render(<RoomsSection />)

    await user.click(screen.getByRole('button', { name: 'createRoom' }))
    const button = screen.getByRole('button', { name: 'save' })

    expect(getIconSlot(button)).toHaveClass('h-4', 'w-4', 'shrink-0')
    expect(getIconSlot(button)).toHaveClass('absolute')
    expect(button).toHaveClass('relative')
    expect(queryLoader(button)).toBeNull()
    expect(button).not.toHaveAttribute('aria-busy', 'true')
  })

  it('create-dialog save button: loader mounts while createRoom is pending', async () => {
    createRoomState.isPending = true
    const user = userEvent.setup()
    render(<RoomsSection />)

    await user.click(screen.getByRole('button', { name: 'createRoom' }))
    const button = screen.getByRole('button', { name: 'save' })

    expect(getIconSlot(button)).not.toBeNull()
    expect(queryLoader(button)).not.toBeNull()
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('aria-busy', 'true')
  })

  it('create-dialog save button: loader mounts while setRoomDefaultEquipment (the other half of the compound condition) is pending', async () => {
    setRoomDefaultEquipmentState.isPending = true
    const user = userEvent.setup()
    render(<RoomsSection />)

    await user.click(screen.getByRole('button', { name: 'createRoom' }))
    const button = screen.getByRole('button', { name: 'save' })

    expect(queryLoader(button)).not.toBeNull()
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('aria-busy', 'true')
  })

  it('edit-dialog save button: icon slot reserved with correct sizing but loader unmounted when idle', async () => {
    const user = userEvent.setup()
    render(<RoomsSection />)

    await user.click(screen.getByRole('button', { name: 'editRoom' }))
    const button = screen.getByRole('button', { name: 'save' })

    expect(getIconSlot(button)).toHaveClass('h-4', 'w-4', 'shrink-0')
    expect(getIconSlot(button)).toHaveClass('absolute')
    expect(button).toHaveClass('relative')
    expect(queryLoader(button)).toBeNull()
  })

  it('edit-dialog save button: loader mounts while updateRoom is pending', async () => {
    updateRoomState.isPending = true
    const user = userEvent.setup()
    render(<RoomsSection />)

    await user.click(screen.getByRole('button', { name: 'editRoom' }))
    const button = screen.getByRole('button', { name: 'save' })

    expect(getIconSlot(button)).not.toBeNull()
    expect(queryLoader(button)).not.toBeNull()
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('aria-busy', 'true')
  })

  it('reloads the regenerated QR image and download without changing its stored URL', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(123)
    tablesState.data = [{ id: 'table-1', roomId: 'room-1', name: 'Table 1', type: 'small', qrCode: '/api/tables/table-1/qr/image' }]
    regenerateTableQrState.mutateAsync.mockResolvedValue({ qr_code: '/api/tables/table-1/qr/image', qr_code_inf: null })
    const user = userEvent.setup()
    render(<RoomsSection />)

    await user.click(screen.getByRole('button', { name: 'Main Hall' }))
    await user.click(screen.getByRole('button', { name: 'qrCode' }))
    const imageBefore = screen.getByAltText('QR Table 1')
    await user.click(screen.getByRole('button', { name: 'regenerateQr' }))

    expect(screen.getByAltText('QR Table 1')).not.toBe(imageBefore)
    expect(screen.getByAltText('QR Table 1')).toHaveAttribute('src', '/api/tables/table-1/qr/image')
    expect(screen.getByRole('link', { name: 'save' })).toHaveAttribute('href', '/api/tables/table-1/qr/image')
  })
})
