// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSqlMock, hasColumn, whereColumnHasOperator, whereHasColumn } from '../helpers/sql-mock'

const TABLE_ID = 'c3d4e5f6-a7b8-9012-cdef-012345678901'
const LARGE_TABLE_ID = 'd4e5f6a7-b8c9-0123-def0-123456789012'
const APP_URL = 'https://test.example.com'
const SUPABASE_URL = 'https://supabase.example.com'

const sqlMock = createSqlMock()
const getDatabaseNowMock = vi.fn(async () => new Date('2026-05-26T12:00:00.000Z'))
const storageUploadMock = vi.fn()
const qrcodeToBufferMock = vi.fn()

vi.mock('@/lib/db/client', () => ({ sql: sqlMock.sql }))
vi.mock('@/lib/server/database-time', () => ({ getDatabaseNow: getDatabaseNowMock }))
vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerAdminClient: vi.fn(() => ({
    storage: { from: vi.fn(() => ({ upload: storageUploadMock })) },
  })),
}))
vi.mock('qrcode', () => ({ default: { toBuffer: qrcodeToBufferMock } }))

async function loadTablesService() {
  vi.resetModules()
  return import('@/lib/server/tables-service')
}

function makeTableRow(overrides?: Partial<{
  id: string
  room_id: string
  name: string
  type: 'small' | 'large' | 'removable_top'
  qr_code: string | null
  qr_code_inf: string | null
  pos_x: number | null
  pos_y: number | null
}>) {
  return {
    id: TABLE_ID,
    room_id: 'room-1',
    name: 'Mesa 3',
    type: 'removable_top' as const,
    qr_code: 'QR-3',
    qr_code_inf: null,
    pos_x: 1,
    pos_y: 1,
    ...overrides,
  }
}

function makeReservationRow(overrides?: Partial<{
  id: string
  table_id: string
  date: string
  start_time: string
  end_time: string
  status: string
  surface: 'top' | 'bottom' | null
  user_id: string | null
  activated_at: string | null
  created_at: string
}>) {
  return {
    id: 'reservation-1',
    table_id: TABLE_ID,
    date: '2026-05-26',
    start_time: '10:00:00',
    end_time: '12:00:00',
    status: 'active',
    surface: 'top' as const,
    user_id: 'user-1',
    activated_at: null,
    created_at: '2026-05-26T08:00:00.000Z',
    ...overrides,
  }
}

function makeEventBlockRow(overrides?: Partial<{
  id: string
  event_id: string
  room_id: string
  table_id: string | null
  date: string
  start_time: string
  end_time: string
  all_day: boolean
}>) {
  return {
    id: 'block-1',
    event_id: 'event-1',
    room_id: 'room-1',
    table_id: null,
    date: '2026-05-26',
    start_time: '14:00:00',
    end_time: '16:00:00',
    all_day: false,
    ...overrides,
  }
}

function registerAvailabilityHandlers(options?: {
  tables?: ReturnType<typeof makeTableRow>[]
  reservations?: ReturnType<typeof makeReservationRow>[]
  eventBlocks?: ReturnType<typeof makeEventBlockRow>[]
  savedGames?: Array<{ id: string }>
  events?: Array<{ id: string; title: string }>
}) {
  const tableRows = options?.tables ?? [makeTableRow()]
  const reservationRows = options?.reservations ?? []
  const eventBlockRows = options?.eventBlocks ?? []
  const savedGameRows = options?.savedGames ?? []
  const eventRows = options?.events ?? []

  sqlMock.addHandler({
    name: 'SELECT table by id',
    verb: 'select',
    match: (stmt) =>
      stmt.table === 'tables' &&
      whereHasColumn(stmt, 'id') &&
      stmt.selectColumns === 'id, room_id, name, type, qr_code, qr_code_inf, pos_x, pos_y',
    respond: (stmt) => stmt.values[0] === TABLE_ID ? tableRows : [],
  })
  sqlMock.addHandler({
    name: 'SELECT active and pending reservations for table/date',
    verb: 'select',
    match: (stmt) =>
      stmt.table === 'reservations' &&
      whereHasColumn(stmt, 'table_id') &&
      whereHasColumn(stmt, 'date') &&
      /status in \('active', 'pending'\)/.test(stmt.whereClause ?? ''),
    respond: () => reservationRows,
  })
  sqlMock.addHandler({
    name: 'SELECT event blocks for room/date',
    verb: 'select',
    match: (stmt) =>
      stmt.table === 'event_room_blocks' &&
      whereHasColumn(stmt, 'room_id') &&
      whereHasColumn(stmt, 'date'),
    respond: () => eventBlockRows,
  })
  sqlMock.addHandler({
    name: 'SELECT active saved game covering date',
    verb: 'select',
    match: (stmt) =>
      stmt.table === 'saved_games' &&
      whereHasColumn(stmt, 'table_id') &&
      whereColumnHasOperator(stmt, 'start_date', '<=') &&
      whereColumnHasOperator(stmt, 'end_date', '>='),
    respond: () => savedGameRows,
  })
  sqlMock.addHandler({
    name: 'SELECT event titles by ids',
    verb: 'select',
    match: (stmt) => stmt.table === 'events' && whereHasColumn(stmt, 'id'),
    respond: () => eventRows,
  })
}

function registerRegenerationHandlers(tableId = LARGE_TABLE_ID) {
  sqlMock.addHandler({
    name: 'SELECT table type by id',
    verb: 'select',
    match: (stmt) =>
      stmt.table === 'tables' &&
      stmt.selectColumns === 'id, type' &&
      whereHasColumn(stmt, 'id'),
    respond: (stmt) => stmt.values[0] === tableId ? [{ id: tableId, type: 'large' }] : [],
  })
  sqlMock.addHandler({
    name: 'UPDATE table QR URLs by id',
    verb: 'update',
    match: (stmt) =>
      stmt.table === 'tables' &&
      hasColumn(stmt, 'qr_code') &&
      hasColumn(stmt, 'qr_code_inf') &&
      whereHasColumn(stmt, 'id'),
    respond: () => [],
  })
}

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  sqlMock.reset()
  getDatabaseNowMock.mockReset()
  getDatabaseNowMock.mockResolvedValue(new Date('2026-05-26T12:00:00.000Z'))
  vi.stubEnv('NEXT_PUBLIC_APP_URL', APP_URL)
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', SUPABASE_URL)
  qrcodeToBufferMock.mockResolvedValue(Buffer.from('fake-png-data'))
  storageUploadMock.mockResolvedValue({ data: { path: `${TABLE_ID}.png` }, error: null })
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('getTableAvailability (Neon raw SQL)', () => {
  it('builds removable-top availability from active reservations', async () => {
    registerAvailabilityHandlers({ reservations: [makeReservationRow()] })
    const { getTableAvailability } = await loadTablesService()

    const availability = await getTableAvailability(TABLE_ID, '2026-05-26')

    expect(availability.top?.some((slot) => slot.startTime === '10:00' && !slot.available)).toBe(true)
    expect(availability.bottom?.every((slot) => slot.available)).toBe(true)
  })

  it('requires table/date/status scoping in the reservations query', async () => {
    registerAvailabilityHandlers()
    const { getTableAvailability } = await loadTablesService()

    await getTableAvailability(TABLE_ID, '2026-05-26')

    expect(sqlMock.sql).toHaveBeenCalledTimes(4)
  })

  it('keeps an unactivated pending reservation before its deadline', async () => {
    getDatabaseNowMock.mockResolvedValue(new Date('2026-05-26T00:00:00.000Z'))
    registerAvailabilityHandlers({
      reservations: [makeReservationRow({ status: 'pending', start_time: '10:00:00', end_time: '12:00:00' })],
    })
    const { getTableAvailability } = await loadTablesService()

    const availability = await getTableAvailability(TABLE_ID, '2026-05-26')

    expect(availability.top?.some((slot) => slot.startTime === '10:00' && !slot.available)).toBe(true)
  })

  it('drops an unactivated pending reservation after its deadline', async () => {
    getDatabaseNowMock.mockResolvedValue(new Date('2026-05-26T12:01:00.000Z'))
    registerAvailabilityHandlers({
      reservations: [makeReservationRow({ status: 'pending', start_time: '10:00:00', end_time: '12:00:00' })],
    })
    const { getTableAvailability } = await loadTablesService()

    const availability = await getTableAvailability(TABLE_ID, '2026-05-26')

    expect(availability.top?.every((slot) => slot.available)).toBe(true)
  })

  it('blocks the lower surface for a saved game covering the date', async () => {
    registerAvailabilityHandlers({ savedGames: [{ id: 'saved-game-1' }] })
    const { getTableAvailability } = await loadTablesService()

    const availability = await getTableAvailability(TABLE_ID, '2026-05-26')

    expect(availability.bottom?.every((slot) => !slot.available)).toBe(true)
    expect(availability.top?.every((slot) => slot.available)).toBe(true)
  })

  it('applies room-wide and matching-table event blocks with event titles', async () => {
    registerAvailabilityHandlers({
      eventBlocks: [
        makeEventBlockRow(),
        makeEventBlockRow({ id: 'block-2', table_id: TABLE_ID, start_time: '18:00:00', end_time: '19:00:00' }),
        makeEventBlockRow({ id: 'block-3', table_id: 'another-table', start_time: '20:00:00', end_time: '21:00:00' }),
      ],
      events: [{ id: 'event-1', title: 'League Night' }],
    })
    const { getTableAvailability } = await loadTablesService()

    const availability = await getTableAvailability(TABLE_ID, '2026-05-26')

    expect(availability.slots.find((slot) => slot.startTime === '14:00')).toMatchObject({
      available: false,
      source: 'event',
      label: 'League Night',
    })
    expect(availability.slots.find((slot) => slot.startTime === '18:00')?.available).toBe(false)
    expect(availability.slots.find((slot) => slot.startTime === '20:00')?.available).toBe(true)
  })

  it('returns 404 when the table does not exist', async () => {
    registerAvailabilityHandlers({ tables: [] })
    const { getTableAvailability } = await loadTablesService()

    await expect(getTableAvailability(TABLE_ID, '2026-05-26')).rejects.toMatchObject({ statusCode: 404 })
  })

  it('maps a table lookup failure to a 500 ServiceError', async () => {
    sqlMock.addHandler({
      name: 'SELECT table failing',
      verb: 'select',
      match: (stmt) => stmt.table === 'tables',
      respond: () => { throw new Error('connection reset') },
    })
    const { getTableAvailability } = await loadTablesService()

    await expect(getTableAvailability(TABLE_ID, '2026-05-26')).rejects.toMatchObject({ statusCode: 500 })
  })

  it('maps a related availability query failure to a 500 ServiceError', async () => {
    registerAvailabilityHandlers()
    sqlMock.prependHandler({
      name: 'SELECT reservations failing',
      verb: 'select',
      match: (stmt) => stmt.table === 'reservations',
      respond: () => { throw new Error('connection reset') },
    })
    const { getTableAvailability } = await loadTablesService()

    await expect(getTableAvailability(TABLE_ID, '2026-05-26')).rejects.toMatchObject({ statusCode: 500 })
  })
})

describe('generateTableQrCode', () => {
  it('returns the Supabase Storage public URL containing the table id', async () => {
    const { generateTableQrCode } = await loadTablesService()

    await expect(generateTableQrCode(TABLE_ID)).resolves.toBe(
      `${SUPABASE_URL}/storage/v1/object/public/table-qr-codes/${TABLE_ID}.png`,
    )
  })

  it('encodes the absolute check-in URL in the QR payload', async () => {
    const { generateTableQrCode } = await loadTablesService()

    await generateTableQrCode(TABLE_ID)

    expect(qrcodeToBufferMock).toHaveBeenCalledWith(
      `${APP_URL}/check-in/${TABLE_ID}`,
      { errorCorrectionLevel: 'M', width: 400, type: 'png' },
    )
  })

  it('removes a trailing slash from NEXT_PUBLIC_APP_URL', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', `${APP_URL}/`)
    const { generateTableQrCode } = await loadTablesService()

    await generateTableQrCode(TABLE_ID)

    expect(qrcodeToBufferMock).toHaveBeenCalledWith(`${APP_URL}/check-in/${TABLE_ID}`, expect.any(Object))
  })

  it('returns 500 when NEXT_PUBLIC_APP_URL is missing', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', '')
    const { generateTableQrCode } = await loadTablesService()
    await expect(generateTableQrCode(TABLE_ID)).rejects.toMatchObject({ statusCode: 500 })
  })

  it('returns 500 when NEXT_PUBLIC_SUPABASE_URL is missing', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', '')
    const { generateTableQrCode } = await loadTablesService()
    await expect(generateTableQrCode(TABLE_ID)).rejects.toMatchObject({ statusCode: 500 })
  })

  it('uploads the PNG buffer with the established path and options', async () => {
    const { generateTableQrCode } = await loadTablesService()
    await generateTableQrCode(TABLE_ID)

    expect(storageUploadMock).toHaveBeenCalledWith(
      `${TABLE_ID}.png`,
      Buffer.from('fake-png-data'),
      { contentType: 'image/png', upsert: true },
    )
  })

  it('returns 500 when the Storage upload fails', async () => {
    storageUploadMock.mockResolvedValueOnce({ data: null, error: { message: 'Bucket not found' } })
    const { generateTableQrCode } = await loadTablesService()
    await expect(generateTableQrCode(TABLE_ID)).rejects.toMatchObject({ statusCode: 500 })
  })

  it('returns 400 when tableId is not a UUID', async () => {
    const { generateTableQrCode } = await loadTablesService()
    await expect(generateTableQrCode('not-a-uuid')).rejects.toMatchObject({ statusCode: 400 })
  })
})

describe('regenerateQrCodes (Neon raw SQL + existing Storage)', () => {
  it('updates a non-removable table with one generated QR URL', async () => {
    registerRegenerationHandlers()
    const { regenerateQrCodes } = await loadTablesService()

    const result = await regenerateQrCodes(LARGE_TABLE_ID)

    expect(result).toEqual({
      qr_code: `${SUPABASE_URL}/storage/v1/object/public/table-qr-codes/${LARGE_TABLE_ID}.png`,
      qr_code_inf: null,
    })
  })

  it('preserves the one-QR behavior for removable-top tables', async () => {
    registerRegenerationHandlers(TABLE_ID)
    const { regenerateQrCodes } = await loadTablesService()

    const result = await regenerateQrCodes(TABLE_ID)

    expect(result.qr_code_inf).toBeNull()
    expect(storageUploadMock).toHaveBeenCalledTimes(1)
  })

  it('writes the generated URL and null inferior URL for the selected id', async () => {
    registerRegenerationHandlers()
    sqlMock.prependHandler({
      name: 'assert UPDATE QR values',
      verb: 'update',
      match: (stmt) => stmt.table === 'tables' && whereHasColumn(stmt, 'id'),
      respond: (stmt) => {
        expect(stmt.values).toEqual([
          `${SUPABASE_URL}/storage/v1/object/public/table-qr-codes/${LARGE_TABLE_ID}.png`,
          LARGE_TABLE_ID,
        ])
        expect(/qr_code_inf = null/.test(stmt.text)).toBe(true)
        return []
      },
    })
    const { regenerateQrCodes } = await loadTablesService()

    await regenerateQrCodes(LARGE_TABLE_ID)
  })

  it('returns 404 when the table does not exist', async () => {
    registerRegenerationHandlers()
    const { regenerateQrCodes } = await loadTablesService()

    await expect(regenerateQrCodes(TABLE_ID)).rejects.toMatchObject({ statusCode: 404 })
    expect(storageUploadMock).not.toHaveBeenCalled()
  })

  it('maps the table lookup failure to a 500 ServiceError', async () => {
    sqlMock.addHandler({
      name: 'SELECT table type failing',
      verb: 'select',
      match: (stmt) => stmt.table === 'tables',
      respond: () => { throw new Error('connection reset') },
    })
    const { regenerateQrCodes } = await loadTablesService()

    await expect(regenerateQrCodes(TABLE_ID)).rejects.toMatchObject({ statusCode: 500 })
  })

  it('maps the QR URL update failure to a 500 ServiceError', async () => {
    registerRegenerationHandlers()
    sqlMock.prependHandler({
      name: 'UPDATE table QR failing',
      verb: 'update',
      match: (stmt) => stmt.table === 'tables',
      respond: () => { throw new Error('connection reset') },
    })
    const { regenerateQrCodes } = await loadTablesService()

    await expect(regenerateQrCodes(LARGE_TABLE_ID)).rejects.toMatchObject({ statusCode: 500 })
  })

  it('returns 500 when NEXT_PUBLIC_APP_URL is missing', async () => {
    registerRegenerationHandlers()
    vi.stubEnv('NEXT_PUBLIC_APP_URL', '')
    const { regenerateQrCodes } = await loadTablesService()
    await expect(regenerateQrCodes(LARGE_TABLE_ID)).rejects.toMatchObject({ statusCode: 500 })
  })

  it('returns 500 when NEXT_PUBLIC_SUPABASE_URL is missing', async () => {
    registerRegenerationHandlers()
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', '')
    const { regenerateQrCodes } = await loadTablesService()
    await expect(regenerateQrCodes(LARGE_TABLE_ID)).rejects.toMatchObject({ statusCode: 500 })
  })

  it('returns 400 when tableId is not a UUID', async () => {
    const { regenerateQrCodes } = await loadTablesService()
    await expect(regenerateQrCodes('not-a-uuid')).rejects.toMatchObject({ statusCode: 400 })
    expect(sqlMock.sql).not.toHaveBeenCalled()
  })
})
