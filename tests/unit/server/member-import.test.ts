// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionUser } from '@/lib/server/auth/auth'
import ExcelJS from 'exceljs'
import {
  createDrizzleQueryBuilder,
  selectMock,
  updateMock,
} from '@/tests/unit/mocks/drizzle-mock'


function createAdminSession(): SessionUser {
  return { id: 'admin-1', role: 'admin', email: 'admin@example.com' }
}

function createMemberSession(): SessionUser {
  return { id: 'member-1', role: 'member', email: 'member@example.com' }
}


const createUserMock = vi.fn(async (opts?: any) => ({
  data: { user: { id: 'new-user-' + Math.random().toString(36).substr(2, 9) } },
  error: null,
}))
const deleteUserMock = vi.fn(async () => ({ error: null }))

// Mock createAuthUser to use createUserMock
vi.mock('@/lib/auth/session', () => ({
  createAuthUser: vi.fn(async (admin, opts) => createUserMock(opts)),
  deleteAuthUser: vi.fn(async (admin, id) => deleteUserMock(id)),
  updateAuthUserById: vi.fn(async (id, opts) => ({ error: null })),
}))

const profileState = new Map<string, {
  id: string
  member_number: string
  full_name: string | null
  auth_email: string
  email: string | null
  phone: string | null
  role: 'member' | 'admin'
  is_active: boolean
  active_from: string | null
  psw_changed: string | null
  no_show_count: number
  blocked_until: string | null
  created_at: string
  updated_at: string
}>()

function resetProfileState() {
  profileState.clear()
  profileState.set('100001', {
    id: 'user-100001',
    member_number: '100001',
    full_name: 'Existing Member',
    auth_email: '100001@members.alea.internal',
    email: 'existing@alea.club',
    phone: '600111222',
    role: 'member',
    is_active: true,
    active_from: '2026-04-01T00:00:00.000Z',
    psw_changed: null,
    no_show_count: 0,
    blocked_until: null,
    created_at: '2026-04-01T00:00:00.000Z',
    updated_at: '2026-04-01T00:00:00.000Z',
  })
}

type ProfileStateRow = ReturnType<typeof profileState.get> extends infer T ? NonNullable<T> : never

/**
 * Converts a snake_case `profileState` fixture row into the camelCase shape
 * `db.select(PROFILE_COLUMNS)` returns from the real Drizzle-backed service
 * (see `PublicProfileRow` in lib/server/users/profile-mappers.ts). Used to
 * seed `selectMock` for the "existing member" scenarios below.
 */
function toSelectRow(row: ProfileStateRow) {
  return {
    id: row.id,
    memberNumber: row.member_number,
    fullName: row.full_name,
    authEmail: row.auth_email,
    email: row.email,
    phone: row.phone,
    role: row.role,
    isActive: row.is_active,
    activeFrom: row.active_from,
    noShowCount: row.no_show_count,
    blockedUntil: row.blocked_until,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * Gives `updateMock` real persistence behavior against `profileState` for
 * the `importMembersFromCsv` / `importMembersFromSource` describes below.
 * The real service (`users-service.ts`) always sets camelCase fields via
 * `db.update(profiles).set(updates)`:
 *  - "create new member" payloads always include `memberNumber` (see
 *    `importMembersFromNormalizedRows`'s create-path `.set({ memberNumber, ... })`)
 *    -> build a fresh row keyed by that member number.
 *  - "update existing member" payloads never include `memberNumber` (only
 *    `fullName`/`email`/`phone`) -> merge into the single pre-seeded fixture.
 * No test in these describes mixes both scenarios in one call, so keying
 * off `updates.memberNumber` presence is sufficient without needing to
 * thread the real row id through the mock's `.where()` clause.
 */
function configureImportUpdateMock() {
  updateMock.mockImplementation(async (updates: Record<string, unknown>) => {
    const now = '2026-04-14T00:00:00.000Z'

    if (typeof updates.memberNumber === 'string') {
      const memberNumber = updates.memberNumber
      const row = {
        id: `user-${memberNumber}`,
        member_number: memberNumber,
        full_name: (updates.fullName as string | null | undefined) ?? null,
        auth_email: updates.authEmail as string,
        email: (updates.email as string | null | undefined) ?? null,
        phone: (updates.phone as string | null | undefined) ?? null,
        role: (updates.role as 'member' | 'admin' | undefined) ?? 'member',
        is_active: (updates.isActive as boolean | undefined) ?? false,
        active_from: (updates.activeFrom as string | null | undefined) ?? null,
        psw_changed: (updates.pswChanged as string | null | undefined) ?? null,
        no_show_count: 0,
        blocked_until: null,
        created_at: now,
        updated_at: now,
      }
      profileState.set(memberNumber, row)
      return [{ id: row.id }]
    }

    const [existingKey] = profileState.keys()
    if (!existingKey) return []
    const target = profileState.get(existingKey)!
    const next = {
      ...target,
      ...(updates.fullName !== undefined ? { full_name: updates.fullName as string | null } : {}),
      ...(updates.email !== undefined ? { email: updates.email as string | null } : {}),
      ...(updates.phone !== undefined ? { phone: updates.phone as string | null } : {}),
      updated_at: now,
    }
    profileState.set(existingKey, next)
    return [next]
  })
}

vi.mock('@/lib/db', () => ({
  getDrizzleAdminDb: vi.fn(() => createDrizzleQueryBuilder()),
  getDrizzleDb: vi.fn(() => createDrizzleQueryBuilder()),
}))

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerAdminClient: vi.fn(() => ({
    auth: {
      admin: {
        createUser: createUserMock,
        deleteUser: deleteUserMock,
      },
    },
  })),
}))

async function loadService() {
  vi.resetModules()
  const [usersService, memberImport] = await Promise.all([
    import('@/lib/server/users/users-service'),
    import('@/lib/server/users/member-import'),
  ])
  return {
    ...usersService,
    // Ensure parsing functions come from member-import module
    parseMemberImportCsv: memberImport.parseMemberImportCsv,
    normalizeMemberImportSource: memberImport.normalizeMemberImportSource,
    extractSpreadsheetCsv: memberImport.extractSpreadsheetCsv,
    // Keep orchestration functions from users-service
    importMembersFromCsv: usersService.importMembersFromCsv,
    importMembersFromSource: usersService.importMembersFromSource,
  }
}

describe('parseMemberImportCsv', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetProfileState()
    setupMocks()
  })

  it('parses the expected USUARIOS / ID CSV shape', async () => {
    const { parseMemberImportCsv } = await loadService()

    const result = parseMemberImportCsv(
      'USUARIOS,ID,email,phone\nJohn Doe,100010,john@alea.club,600123123\n'
    )

    expect(result.issues).toEqual([])
    expect(result.normalizedRows).toEqual([
      {
        rowNumber: 2,
        memberNumber: '100010',
        fullName: 'John Doe',
        email: 'john@alea.club',
        phone: '600123123',
      },
    ])
  })

  it('supports semicolon-delimited CSV files', async () => {
    const { parseMemberImportCsv } = await loadService()

    const result = parseMemberImportCsv(
      'USUARIOS;ID;email\nJane Doe;100011;jane@alea.club\n'
    )

    expect(result.normalizedRows[0]?.memberNumber).toBe('100011')
    expect(result.issues).toEqual([])
  })

  it('accepts normalized member_number headers with underscores', async () => {
    const { parseMemberImportCsv } = await loadService()

    const result = parseMemberImportCsv(
      'member_number,full_name,email\n100013,Jane Doe,jane@alea.club\n'
    )

    expect(result.issues).toEqual([])
    expect(result.normalizedRows).toEqual([
      {
        rowNumber: 2,
        memberNumber: '100013',
        fullName: 'Jane Doe',
        email: 'jane@alea.club',
        phone: null,
      },
    ])
  })

  it('reports duplicate member numbers in the same file', async () => {
    const { parseMemberImportCsv } = await loadService()

    const result = parseMemberImportCsv(
      'USUARIOS,ID\nOne,100012\nTwo,100012\n'
    )

    expect(result.normalizedRows).toHaveLength(1)
    expect(result.issues).toEqual([
      { rowNumber: 3, memberNumber: '100012', code: 'duplicate_member_number' },
    ])
  })

  it('accepts CSV files with UTF-8 BOM headers', async () => {
    const { parseMemberImportCsv } = await loadService()

    const result = parseMemberImportCsv(
      '\uFEFFUSUARIOS,ID\nJohn Doe,100099\n'
    )

    expect(result.normalizedRows).toEqual([
      expect.objectContaining({
        memberNumber: '100099',
        fullName: 'John Doe',
      }),
    ])
    expect(result.totalRows).toBe(1)
  })

  it('throws when required headers are missing', async () => {
    const { parseMemberImportCsv } = await loadService()

    expect(() => parseMemberImportCsv('name,email\nJohn,john@alea.club\n')).toThrowError()
  })
})

describe('normalizeMemberImportSource', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetProfileState()
    setupMocks()
  })

  it('normalizes xlsx spreadsheets into the canonical dataset', async () => {
    const { normalizeMemberImportSource } = await loadService()
    const workbook = new ExcelJS.Workbook()
    const worksheet = workbook.addWorksheet('Members')
    worksheet.addRow(['USUARIOS', 'ID', 'email', 'phone'])
    worksheet.addRow(['Jane Doe', '100021', 'jane@alea.club', '699123123'])
    const buffer = await workbook.xlsx.writeBuffer()
    const bytes = new Uint8Array(buffer as ArrayBuffer)

    const result = await normalizeMemberImportSource({
      fileName: 'members.xlsx',
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      bytes: new Uint8Array(bytes),
    })

    expect(result.normalizedCsv).toBe('USUARIOS,ID,email,phone\nJane Doe,100021,jane@alea.club,699123123')
    expect(result.normalizedRows).toEqual([
      {
        rowNumber: 2,
        memberNumber: '100021',
        fullName: 'Jane Doe',
        email: 'jane@alea.club',
        phone: '699123123',
      },
    ])
  })

  it('uses the first xlsx sheet that matches import headers', async () => {
    const { normalizeMemberImportSource } = await loadService()
    const workbook = new ExcelJS.Workbook()
    const coverSheet = workbook.addWorksheet('Cover')
    coverSheet.addRow(['Report generated', '2026-04-15'])
    coverSheet.addRow(['Notes', 'Skip this sheet'])
    const memberSheet = workbook.addWorksheet('Members')
    memberSheet.addRow(['USUARIOS', 'ID', 'email'])
    memberSheet.addRow(['Second Sheet Member', '100031', 'sheet2@alea.club'])
    const buffer = await workbook.xlsx.writeBuffer()
    const bytes = new Uint8Array(buffer as ArrayBuffer)

    const result = await normalizeMemberImportSource({
      fileName: 'members.xlsx',
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      bytes: new Uint8Array(bytes),
    })

    expect(result.normalizedRows).toEqual([
      {
        rowNumber: 2,
        memberNumber: '100031',
        fullName: 'Second Sheet Member',
        email: 'sheet2@alea.club',
        phone: null,
      },
    ])
  })

  it('normalizes odt table files into the canonical dataset', async () => {
    const { normalizeMemberImportSource } = await loadService()
    const bytes = Uint8Array.from(Buffer.from(
      'UEsDBBQAAAAIABxQj1xmoUcuKQEAABwFAAALAAAAY29udGVudC54bWy1VNFqgzAUfe9XhLzbWoUxgtoNyqCDMVjnB8R4uzpiIiZ27d8vJrad7kXW+aLJuefck5vLTbQ6lhwdoFaFFDFezn2MQDCZF+Ijxun7k3ePV8kskrtdwYDkkjUlCO0xKbT5I6MWirhojJtaEElVoYigJSiiGZEViLOK/GQT6+UQTTM+Wm7JPTUc9Wix4VptMkPoXFUm81O7vyItzSEGc4b2i9y6dYjxC5SZuTib6jfVq+XXNTKIMeAcdV4Hyhvw9KkyKZWuzcXjJLLnrJJ0mz6+bV630aIDzGKQ5maPzXrK7FDSgk9pUO2lgFEG/VivPf/euGe5F2gtxx3sjx5L3/eDYEqHT1PFA+VA54w32ZROd20pQRiGt3WyF+hGejGY6Qvgxv6yHb5tyTdQSwMEFAAAAAgAHFCPXF7GMgwnAAAAJwAAAAgAAABtaW1ldHlwZQVAwQkAIAjcyGaS9CGUJ3hF44dWrZjKQI6bJtCOFpSnYZ7tSaE/flBLAQIUABQAAAAIABxQj1xmoUcuKQEAABwFAAALAAAAAAAAAAAAAAAAAAAAAABjb250ZW50LnhtbFBLAQIUABQAAAAIABxQj1xexjIMJwAAACcAAAAIAAAAAAAAAAAAAAAAAFIBAABtaW1ldHlwZVBLBQYAAAAAAgACAG8AAACfAQAAAAA=',
      'base64'
    ))

    const result = await normalizeMemberImportSource({
      fileName: 'members.odt',
      contentType: 'application/vnd.oasis.opendocument.text',
      bytes,
    })

    expect(result.normalizedCsv).toBe('USUARIOS,ID,email,phone\nJohn Doe,100022,john@alea.club,600222333')
    expect(result.normalizedRows[0]).toEqual({
      rowNumber: 2,
      memberNumber: '100022',
      fullName: 'John Doe',
      email: 'john@alea.club',
      phone: '600222333',
    })
  })

  it('parses a valid xlsx when bytes is a Uint8Array view with a non-zero byteOffset', async () => {
    const { extractSpreadsheetCsv } = await loadService()
    const workbook = new ExcelJS.Workbook()
    const worksheet = workbook.addWorksheet('Members')
    worksheet.addRow(['USUARIOS', 'ID', 'email', 'phone'])
    worksheet.addRow(['Offset Member', '100041', 'offset@alea.club', '699444555'])
    const buffer = await workbook.xlsx.writeBuffer()
    const xlsxBytes = new Uint8Array(buffer as ArrayBuffer)

    // Simulate a sliced view into a larger backing ArrayBuffer, as produced
    // when reading a multipart/form-data body: the Uint8Array has a non-zero
    // byteOffset and does not span the whole underlying buffer.
    //
    // The trailing bytes are a crafted, zero-record "end of central
    // directory" record (zip signature PK\x05\x06). If `bytes.buffer` (the
    // full backing buffer) were passed to ExcelJS instead of the exact byte
    // range, the zip reader would latch onto this bogus trailing record
    // (it scans backward from the end of the buffer) and see zero entries,
    // rejecting a genuinely valid workbook. Slicing to the byte range
    // excludes this trailing data entirely.
    const leadingPadding = 16
    const fakeEmptyEndOfCentralDirectory = new Uint8Array([
      0x50, 0x4b, 0x05, 0x06, // signature PK\x05\x06
      0x00, 0x00, // disk number
      0x00, 0x00, // disk where central directory starts
      0x00, 0x00, // number of central directory records on this disk
      0x00, 0x00, // total number of central directory records
      0x00, 0x00, 0x00, 0x00, // size of central directory
      0x00, 0x00, 0x00, 0x00, // offset of start of central directory
      0x00, 0x00, // comment length
    ])
    const padded = new Uint8Array(leadingPadding + xlsxBytes.byteLength + fakeEmptyEndOfCentralDirectory.byteLength)
    padded.set(xlsxBytes, leadingPadding)
    padded.set(fakeEmptyEndOfCentralDirectory, leadingPadding + xlsxBytes.byteLength)
    const offsetView = new Uint8Array(padded.buffer, leadingPadding, xlsxBytes.byteLength)

    expect(offsetView.byteOffset).toBe(leadingPadding)
    expect(offsetView.buffer.byteLength).toBeGreaterThan(offsetView.byteLength)

    const csv = await extractSpreadsheetCsv(offsetView)

    expect(csv).toBe('USUARIOS,ID,email,phone\nOffset Member,100041,offset@alea.club,699444555')
  })
})

describe('importMembersFromCsv', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetProfileState()
    // Real identity derivation from the row being processed (opts.email),
    // instead of a single hardcoded placeholder — profileState population
    // belongs in updateMock (see configureImportUpdateMock), not here.
    createUserMock.mockImplementation(async ({ email }: { email: string }) => ({
      data: { user: { id: `user-${email.split('@')[0]}` } },
      error: null,
    }))
    deleteUserMock.mockResolvedValue({ error: null })
    configureImportUpdateMock()
  })

  it('updates existing members with generated fallback email and nullable phone', async () => {
    const { importMembersFromCsv } = await loadService()

    selectMock.mockResolvedValue([toSelectRow(profileState.get('100001')!)])

    const adminSession = createAdminSession()
    const result = await importMembersFromCsv(adminSession, 'USUARIOS,ID,email,phone\nUpdated Name,100001,,\n'
    )

    expect(result.createdCount).toBe(0)
    expect(result.updatedCount).toBe(1)
    expect(profileState.get('100001')?.full_name).toBe('Updated Name')
    expect(profileState.get('100001')?.email).toBe('100001@members.alea.internal')
    expect(profileState.get('100001')?.phone).toBeNull()
    expect(result.normalizedRows).toEqual([
      {
        rowNumber: 2,
        memberNumber: '100001',
        fullName: 'Updated Name',
        email: '100001@members.alea.internal',
        phone: null,
      },
    ])
  })

  it('rejects renamed odt archives uploaded as xlsx', async () => {
    const { normalizeMemberImportSource } = await loadService()
    const odtBytes = Uint8Array.from(Buffer.from(
      'UEsDBBQAAAAIABxQj1xmoUcuKQEAABwFAAALAAAAY29udGVudC54bWy1VNFqgzAUfe9XhLzbWoUxgtoNyqCDMVjnB8R4uzpiIiZ27d8vJrad7kXW+aLJuefck5vLTbQ6lhwdoFaFFDFezn2MQDCZF+Ijxun7k3ePV8kskrtdwYDkkjUlCO0xKbT5I6MWirhojJtaEElVoYigJSiiGZEViLOK/GQT6+UQTTM+Wm7JPTUc9Wix4VptMkPoXFUm81O7vyItzSEGc4b2i9y6dYjxC5SZuTib6jfVq+XXNTKIMeAcdV4Hyhvw9KkyKZWuzcXjJLLnrJJ0mz6+bV630aIDzGKQ5maPzXrK7FDSgk9pUO2lgFEG/VivPf/euGe5F2gtxx3sjx5L3/eDYEqHT1PFA+VA54w32ZROd20pQRiGt3WyF+hGejGY6Qvgxv6yHb5tyTdQSwMEFAAAAAgAHFCPXF7GMgwnAAAAJwAAAAgAAABtaW1ldHlwZQVAwQkAIAjcyGaS9CGUJ3hF44dWrZjKQI6bJtCOFpSnYZ7tSaE/flBLAQIUABQAAAAIABxQj1xmoUcuKQEAABwFAAALAAAAAAAAAAAAAAAAAAAAAABjb250ZW50LnhtbFBLAQIUABQAAAAIABxQj1xexjIMJwAAACcAAAAIAAAAAAAAAAAAAAAAAFIBAABtaW1ldHlwZVBLBQYAAAAAAgACAG8AAACfAQAAAAA=',
      'base64'
    ))

    await expect(normalizeMemberImportSource({
      fileName: 'members.xlsx',
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      bytes: odtBytes,
    })).rejects.toThrow()
  })

  it('creates new imported members as inactive profiles with internal auth email', async () => {
    const { importMembersFromCsv } = await loadService()

    selectMock.mockResolvedValue([])

    const adminSession = createAdminSession()
    const result = await importMembersFromCsv(adminSession, 'USUARIOS,ID,email,phone\nNew Member,100020,new@alea.club,699000111\n'
    )

    expect(result.createdCount).toBe(1)
    expect(result.totalRows).toBe(1)
    expect(createUserMock).toHaveBeenCalledWith(
      expect.objectContaining({
        email: '100020@members.alea.internal',
        email_confirm: true,
      })
    )
    expect(profileState.get('100020')).toEqual(
      expect.objectContaining({
        member_number: '100020',
        full_name: 'New Member',
        auth_email: '100020@members.alea.internal',
        email: 'new@alea.club',
        phone: '699000111',
        is_active: false,
        active_from: null,
        psw_changed: null,
      })
    )
    expect(result.normalizedRows).toEqual([
      {
        rowNumber: 2,
        memberNumber: '100020',
        fullName: 'New Member',
        email: 'new@alea.club',
        phone: '699000111',
      },
    ])
  })

  it('fills missing source email with internal generated email and keeps phone null', async () => {
    const { importMembersFromCsv } = await loadService()

    selectMock.mockResolvedValue([])

    const adminSession = createAdminSession()
    const result = await importMembersFromCsv(adminSession, 'USUARIOS,ID,phone\nNo Email Member,100024,\n'
    )

    expect(result.createdCount).toBe(1)
    expect(profileState.get('100024')).toEqual(
      expect.objectContaining({
        auth_email: '100024@members.alea.internal',
        email: '100024@members.alea.internal',
        phone: null,
      })
    )
    expect(result.normalizedRows).toEqual([
      {
        rowNumber: 2,
        memberNumber: '100024',
        fullName: 'No Email Member',
        email: '100024@members.alea.internal',
        phone: null,
      },
    ])
  })

  it('preserves existing optional contact data when optional headers are omitted', async () => {
    const { importMembersFromCsv } = await loadService()

    selectMock.mockResolvedValue([toSelectRow(profileState.get('100001')!)])

    const adminSession = createAdminSession()
    const result = await importMembersFromCsv(adminSession, 'USUARIOS,ID\nExisting Again,100001\n'
    )

    expect(result.updatedCount).toBe(1)
    expect(profileState.get('100001')).toEqual(
      expect.objectContaining({
        full_name: 'Existing Again',
        email: 'existing@alea.club',
        phone: '600111222',
      })
    )
    expect(result.normalizedRows).toEqual([
      {
        rowNumber: 2,
        memberNumber: '100001',
        fullName: 'Existing Again',
        email: 'existing@alea.club',
        phone: '600111222',
      },
    ])
  })

  it('rejects mismatched file extension and MIME type during source normalization', async () => {
    const { normalizeMemberImportSource } = await loadService()

    await expect(normalizeMemberImportSource({
      fileName: 'members.csv',
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      bytes: new Uint8Array([1, 2, 3]),
    })).rejects.toThrow()
  })

  it('rejects malformed odt uploads with a validation error', async () => {
    const { normalizeMemberImportSource } = await loadService()

    await expect(normalizeMemberImportSource({
      fileName: 'members.odt',
      contentType: 'application/vnd.oasis.opendocument.text',
      bytes: new Uint8Array([1, 2, 3]),
    })).rejects.toThrow()
  })

  it('honors repeated odt rows for row counts and duplicate detection', async () => {
    const { normalizeMemberImportSource } = await loadService()
    const repeatedBytes = Uint8Array.from(Buffer.from(
      'UEsDBBQAAAAIAKVRj1yr9ggzGAEAAK8DAAALAAAAY29udGVudC54bWy1U8tqwzAQvOcrhO5unPRShO1QKIUcSiGpP0CWN8UgS0aS0+Tvq4edxOrFNOSix+zOjnZYZZtTy9ERlG6kyPHqKcUIBJN1I75zXH69Jy94UywyeTg0DEgtWd+CMAmTwtgdWbbQJERz3CtBJNWNJoK2oIlhRHYgRha5zSZeKyCGVnw23SdP2HAys8k213OLBUJjV5Wsz+5+RVxaQCwWBP2Kwtkp5PgD2soa50v9TU2U/LlGohgDztGgdaS8h8ScO1tSG2WNx0Xm39kV5b583W0/99lyAOwhKnO3xvZtVvVpbNJc3PboUu/8cYBOFHRADdQ5Xt/49c8X73wxFPx/pDWrNE2f1/fZMwkMU7aMxuwChEm8XOPvVvwCUEsDBBQAAAAIAKVRj1xexjIMJwAAACcAAAAIAAAAbWltZXR5cGUFQMEJACAI3MhmkvQhlCd4ReOHVq2YykCOmybQjhaUp2Ge7UmhP35QSwECFAAUAAAACAClUY9cq/YIMxgBAACvAwAACwAAAAAAAAAAAAAAAAAAAAAAY29udGVudC54bWxQSwECFAAUAAAACAClUY9cXsYyDCcAAAAnAAAACAAAAAAAAAAAAAAAAABBAQAAbWltZXR5cGVQSwUGAAAAAAIAAgBvAAAAjgEAAAAA',
      'base64'
    ))

    const result = await normalizeMemberImportSource({
      fileName: 'members.odt',
      contentType: 'application/vnd.oasis.opendocument.text',
      bytes: repeatedBytes,
    })

    expect(result.totalRows).toBe(2)
    expect(result.normalizedRows).toHaveLength(1)
    expect(result.issues).toContainEqual({
      rowNumber: 3,
      memberNumber: '100032',
      code: 'duplicate_member_number',
    })
  })

  it('keeps odt sparse cells aligned when empty email cell is self-closing', async () => {
    const { normalizeMemberImportSource } = await loadService()
    const sparseBytes = Uint8Array.from(Buffer.from(
      'UEsDBBQAAAAIAKVRj1xwaRyJHgEAANUEAAALAAAAY29udGVudC54bWy1VNFugyAUfe9XEN6dNpplIWqzZFnSh2XJnB+AeLuZIBjBrv37Idh2uhcz54vCuefcA1wu8e5Uc3SEVlVSJHh7F2AEgsmyEh8Jzt+fvQe8SzexPBwqBqSUrKtBaI9Joc0fGbVQxEUT3LWCSKoqRQStQRHNiGxAXFTkJ5tYL4doWvDZckseqeGkZ4sN12rTDUKXXRWyPPfzG9LTHGIwZ2i/yI17hwS/QF2Yg7OpflO9Vn7dIpMYA87R4HWkvANPnxuTUunWHDxOY7vOJs2z/PFt/5rF/gCYwSTNYo/905rZoaYVX9Og+ZQCZhmMY6Py/Hvhsoa2CpC7ImtufxsEQRj+1cFf7H/f24dRFC0rwSgw9KI/acYr4Pr1Op0+Suk3UEsDBBQAAAAIAKVRj1xexjIMJwAAACcAAAAIAAAAbWltZXR5cGUFQMEJACAI3MhmkvQhlCd4ReOHVq2YykCOmybQjhaUp2Ge7UmhP35QSwECFAAUAAAACAClUY9ccGkciR4BAADVBAAACwAAAAAAAAAAAAAAAAAAAAAAY29udGVudC54bWxQSwECFAAUAAAACAClUY9cXsYyDCcAAAAnAAAACAAAAAAAAAAAAAAAAABHAQAAbWltZXR5cGVQSwUGAAAAAAIAAgBvAAAAlAEAAAAA',
      'base64'
    ))

    const result = await normalizeMemberImportSource({
      fileName: 'members.odt',
      contentType: 'application/vnd.oasis.opendocument.text',
      bytes: sparseBytes,
    })

    expect(result.normalizedRows).toEqual([
      {
        rowNumber: 2,
        memberNumber: '100033',
        fullName: 'Sparse Member',
        email: null,
        phone: '600333444',
      },
    ])
  })

  it('deletes the auth user when profile persistence returns null data', async () => {
    const { importMembersFromCsv } = await loadService()

    // New-member path (no pre-existing 100020 row) whose persistence write
    // is forced to fail: the real service's `db.update(profiles).set({...})
    // .where(eq(profiles.id, authData.user.id)).returning({ id: profiles.id })`
    // call resolves with no row, which is exactly what an empty array from
    // `updateMock` simulates via the mocked `.returning()` chain.
    selectMock.mockResolvedValue([])
    updateMock.mockResolvedValueOnce([])

    const adminSession = createAdminSession()
    const result = await importMembersFromCsv(adminSession, 'USUARIOS,ID,email,phone\nNew Member,100020,new@alea.club,699000111\n'
    )

    expect(result.createdCount).toBe(0)
    expect(result.skippedCount).toBe(1)
    expect(result.issues).toContainEqual({
      rowNumber: 2,
      memberNumber: '100020',
      code: 'persist_import_failed',
    })
    expect(deleteUserMock).toHaveBeenCalledWith('user-100020')
  })
})

describe('importMembersFromSource', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetProfileState()
    createUserMock.mockImplementation(async ({ email }: { email: string }) => ({
      data: { user: { id: `user-${email.split('@')[0]}` } },
      error: null,
    }))
    deleteUserMock.mockResolvedValue({ error: null })
    configureImportUpdateMock()
  })

  it('imports from xlsx source files and returns normalized rows for audit', async () => {
    const { importMembersFromSource } = await loadService()
    const workbook = new ExcelJS.Workbook()
    const worksheet = workbook.addWorksheet('Members')
    worksheet.addRow(['USUARIOS', 'ID', 'email'])
    worksheet.addRow(['New Spreadsheet Member', '100023', 'sheet@alea.club'])
    const buffer = await workbook.xlsx.writeBuffer()
    const bytes = new Uint8Array(buffer as ArrayBuffer)

    selectMock.mockResolvedValue([])

    const adminSession = createAdminSession()
    const result = await importMembersFromSource(adminSession, {
      fileName: 'members.xlsx',
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      bytes: new Uint8Array(bytes),
    })

    expect(result.createdCount).toBe(1)
    expect(result.normalizedRows).toEqual([
      {
        rowNumber: 2,
        memberNumber: '100023',
        fullName: 'New Spreadsheet Member',
        email: 'sheet@alea.club',
        phone: null,
      },
    ])
    expect(profileState.get('100023')).toEqual(
      expect.objectContaining({
        member_number: '100023',
        full_name: 'New Spreadsheet Member',
        email: 'sheet@alea.club',
      })
    )
  })

  it('limits normalizedRows to a bounded preview size', async () => {
    const { importMembersFromCsv } = await loadService()
    const adminSession = createAdminSession()

    selectMock.mockResolvedValue([])

    const rows = ['USUARIOS,ID,email']
    for (let index = 0; index < 60; index += 1) {
      rows.push(`Member ${index},${200000 + index},member${index}@alea.club`)
    }

    const result = await importMembersFromCsv(adminSession, rows.join('\n'))

    expect(result.createdCount).toBe(60)
    expect(result.normalizedRows).toHaveLength(50)
    expect(result.normalizedRows[0]?.memberNumber).toBe('200000')
    expect(result.normalizedRows.at(-1)?.memberNumber).toBe('200049')
  })
})

describe('Member-role session denial for requireAdminSession', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetProfileState()
    setupMocks()
  })

  it('importMembersFromCsv throws 403 when session role is member', async () => {
    const { importMembersFromCsv } = await loadService()
    const memberSession = createMemberSession()

    await expect(importMembersFromCsv(memberSession, 'USUARIOS,ID,email\nNew Member,100020,new@alea.club\n')).rejects.toMatchObject({
      name: 'ServiceError',
      statusCode: 403,
    })
  })

  it('importMembersFromSource throws 403 when session role is member', async () => {
    const { importMembersFromSource } = await loadService()
    const memberSession = createMemberSession()

    await expect(importMembersFromSource(memberSession, {
      fileName: 'members.csv',
      contentType: 'text/csv',
      bytes: new Uint8Array([1, 2, 3]),
    })).rejects.toMatchObject({
      name: 'ServiceError',
      statusCode: 403,
    })
  })
})
function setupMocks() {
  // Configure selectMock to return all profiles from profileState
  selectMock.mockImplementation(async () => {
    return Array.from(profileState.values())
  })

  // Configure updateMock to update profileState and return the updated row
  updateMock.mockImplementation(async (updates: Record<string, unknown>) => {
    const entry = Object.entries(updates).find(([k]) => k === 'id' || k === 'member_number')
    if (!entry) return []
    
    const [key, value] = entry
    let target = null
    
    if (key === 'member_number') {
      target = profileState.get(value)
    } else if (key === 'id') {
      target = Array.from(profileState.values()).find((row) => row.id === value)
    }
    
    if (!target) return []
    
    const next = {
      ...target,
      ...updates,
      updated_at: '2026-04-14T00:00:00.000Z',
    }
    
    profileState.delete(target.member_number)
    profileState.set(next.member_number, next)
    
    return [next]
  })
}

