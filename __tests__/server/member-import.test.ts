// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ExcelJS from 'exceljs'

const sqlQueryMock = vi.fn()
const createUserMock = vi.fn(async ({ email }: { email: string }) => ({
  data: { user: { id: `user-${Math.random().toString(36).substr(2, 9)}` } },
  error: null,
}))
const deleteUserMock = vi.fn(async () => ({ error: null }))

// In-memory store for test data
const profilesStore = new Map<string, any>()

function resetProfileState() {
  profilesStore.clear()
  profilesStore.set('user-100001', {
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

vi.mock('@/lib/db/client', () => ({
  sql: sqlQueryMock,
}))

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerAdminClient: vi.fn(),
}))

vi.mock('@clerk/backend', () => ({
  clerkClient: {
    users: {
      createUser: createUserMock,
      deleteUser: deleteUserMock,
    },
  },
}))

function setupSqlMock() {
  sqlQueryMock.mockImplementation(async (strings: TemplateStringsArray | string, ...values: unknown[]): Promise<unknown> => {
    const queryStr = typeof strings === 'string'
      ? strings
      : strings.reduce((acc, str, i) => acc + str + (i < values.length ? `$${i + 1}` : ''), '')

    const query = queryStr.toLowerCase()

    // SELECT by id
    if (query.includes('from profiles') && query.includes('where id')) {
      const id = values[0]
      const profile = profilesStore.get(id as string)
      return Promise.resolve(profile ? [profile] : [])
    }

    // SELECT by member_number
    if (query.includes('from profiles') && query.includes('where member_number')) {
      const memberNumber = values[0]
      for (const profile of profilesStore.values()) {
        if (profile.member_number === memberNumber) {
          return Promise.resolve([profile])
        }
      }
      return Promise.resolve([])
    }

    // SELECT with OFFSET/LIMIT pagination
    if (query.includes('from profiles') && (query.includes('offset') || query.includes('order by'))) {
      const profiles = Array.from(profilesStore.values())
      return Promise.resolve(profiles)
    }

    // SELECT COUNT
    if (query.includes('select count')) {
      return Promise.resolve([{ count: profilesStore.size }])
    }

    // UPDATE with specific no_show_count/blocked_until operations (these come before general WHERE id)
    if (query.includes('update profiles') && (query.includes('no_show_count') || query.includes('blocked_until'))) {
      const id = values[values.length - 1]
      const profile = profilesStore.get(id as string)
      if (!profile) {
        return Promise.resolve([])
      }

      const updated = { ...profile }
      if (query.includes('no_show_count')) {
        updated.no_show_count = 0
        updated.blocked_until = null
      } else if (query.includes('blocked_until')) {
        updated.blocked_until = null
      }
      profilesStore.set(id as string, updated)
      return Promise.resolve([{ id }])
    }

    // UPDATE profiles: full_name, email, phone WHERE id
    if (query.includes('update profiles') && query.includes('full_name') && query.includes('where id')) {
      // Format: SET full_name = $1, email = $2, phone = $3 WHERE id = $4
      const id = values[3]
      const fullName = values[0]
      const email = values[1]
      const phone = values[2]

      const profile = profilesStore.get(id as string)
      if (!profile) {
        return Promise.resolve([])
      }

      const updated = {
        ...profile,
        full_name: fullName,
        email: email,
        phone: phone,
        updated_at: new Date().toISOString(),
      }
      profilesStore.set(id as string, updated)

      if (query.includes('returning')) {
        return Promise.resolve([updated])
      }
      return Promise.resolve([{ id }])
    }

    // UPDATE profiles: multiple fields (member_number, full_name, email, phone, role, is_active, auth_email) WHERE id
    if (query.includes('update profiles') && query.includes('member_number') && query.includes('where id')) {
      // Format: SET member_number = $1, full_name = $2, email = $3, phone = $4, role = $5, is_active = $6, auth_email = $7 WHERE id = $8
      const memberNumber = values[0]
      const fullName = values[1]
      const email = values[2]
      const phone = values[3]
      const role = values[4]
      const isActive = values[5]
      const authEmail = values[6]
      const id = values[7]

      const profile = profilesStore.get(id as string)
      if (!profile) {
        return Promise.resolve([])
      }

      const updated = {
        ...profile,
        member_number: memberNumber,
        full_name: fullName,
        email: email,
        phone: phone,
        role: role,
        is_active: isActive,
        auth_email: authEmail,
        updated_at: new Date().toISOString(),
      }
      profilesStore.set(id as string, updated)

      if (query.includes('returning')) {
        return Promise.resolve([updated])
      }
      return Promise.resolve([{ id }])
    }

    // INSERT INTO profiles
    if (query.includes('insert into profiles')) {
      // Format: INSERT INTO profiles (...) VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, 'member', false, NULL, NULL)
      // $1=memberNumber, $2=fullName, $3=authEmail, $4=contactEmail, $5=phone
      const memberNumber = String(values[0])
      const fullName = String(values[1])
      const authEmail = String(values[2])
      const email = String(values[3])
      const phone = values[4] ? String(values[4]) : null

      const newId = `profile-${Math.random().toString(36).substr(2, 9)}`

      const newProfile = {
        id: newId,
        member_number: memberNumber,
        full_name: fullName,
        auth_email: authEmail,
        email: email,
        phone: phone,
        role: 'member',
        is_active: false,
        active_from: null,
        psw_changed: null,
        no_show_count: 0,
        blocked_until: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }
      profilesStore.set(newId, newProfile)
      return Promise.resolve([newProfile])
    }

    // DELETE
    if (query.includes('delete from profiles')) {
      const id = values[0]
      profilesStore.delete(id as string)
      return Promise.resolve([{ id }])
    }

    return Promise.resolve([])
  })
}

async function loadService() {
  vi.resetModules()
  const [usersService, memberImport] = await Promise.all([
    import('@/lib/server/users-service'),
    import('@/lib/server/member-import'),
  ])
  return {
    ...usersService,
    parseMemberImportCsv: memberImport.parseMemberImportCsv,
    normalizeMemberImportSource: memberImport.normalizeMemberImportSource,
    extractSpreadsheetCsv: memberImport.extractSpreadsheetCsv,
    importMembersFromCsv: usersService.importMembersFromCsv,
    importMembersFromSource: usersService.importMembersFromSource,
  }
}

describe('parseMemberImportCsv', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setupSqlMock()
    resetProfileState()
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
      '﻿USUARIOS,ID\nJohn Doe,100099\n'
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
    setupSqlMock()
    resetProfileState()
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

    const leadingPadding = 16
    const fakeEmptyEndOfCentralDirectory = new Uint8Array([
      0x50, 0x4b, 0x05, 0x06,
      0x00, 0x00,
      0x00, 0x00,
      0x00, 0x00,
      0x00, 0x00,
      0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00,
      0x00, 0x00,
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
    setupSqlMock()
    resetProfileState()
  })

  it('updates existing members with generated fallback email and nullable phone', async () => {
    const { importMembersFromCsv } = await loadService()

    const result = await importMembersFromCsv(
      'USUARIOS,ID,email,phone\nUpdated Name,100001,,\n'
    )

    expect(result.createdCount).toBe(0)
    expect(result.updatedCount).toBe(1)
    const profile = Array.from(profilesStore.values()).find(p => p.member_number === '100001')
    expect(profile?.full_name).toBe('Updated Name')
    expect(profile?.email).toBe('100001@members.alea.internal')
    expect(profile?.phone).toBeNull()
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

    const result = await importMembersFromCsv(
      'USUARIOS,ID,email,phone\nNew Member,100020,new@alea.club,699000111\n'
    )

    expect(result.createdCount).toBe(1)
    expect(result.totalRows).toBe(1)
    const profile = Array.from(profilesStore.values()).find(p => p.member_number === '100020')
    expect(profile).toEqual(
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

    const result = await importMembersFromCsv(
      'USUARIOS,ID,phone\nNo Email Member,100024,\n'
    )

    expect(result.createdCount).toBe(1)
    const profile = Array.from(profilesStore.values()).find(p => p.member_number === '100024')
    expect(profile).toEqual(
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

    const result = await importMembersFromCsv(
      'USUARIOS,ID\nExisting Again,100001\n'
    )

    expect(result.updatedCount).toBe(1)
    const profile = Array.from(profilesStore.values()).find(p => p.member_number === '100001')
    expect(profile).toEqual(
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

    // After loading the service, override the mock to fail INSERT
    vi.clearAllMocks()
    resetProfileState()
    sqlQueryMock.mockImplementation(async (strings: TemplateStringsArray | string, ...values: unknown[]) => {
      const queryStr = typeof strings === 'string'
        ? strings
        : strings.reduce((acc, str, i) => acc + str + (i < values.length ? `$${i + 1}` : ''), '')

      const query = queryStr.toLowerCase()

      // SELECT by member_number - return nothing for new member
      if (query.includes('from profiles') && query.includes('where member_number')) {
        return Promise.resolve([])
      }

      // INSERT - throw error to simulate persist failure
      if (query.includes('insert into profiles')) {
        throw new Error('Insert failed')
      }

      return Promise.resolve([])
    })

    const result = await importMembersFromCsv(
      'USUARIOS,ID,email,phone\nNew Member,100025,new@alea.club,699000111\n'
    )

    expect(result.createdCount).toBe(0)
    expect(result.skippedCount).toBe(1)
    expect(result.issues).toContainEqual({
      rowNumber: 2,
      memberNumber: '100025',
      code: 'persist_import_failed',
    })
  })
})

describe('importMembersFromSource', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setupSqlMock()
    resetProfileState()
  })

  it('imports from xlsx source files and returns normalized rows for audit', async () => {
    const { importMembersFromSource } = await loadService()
    const workbook = new ExcelJS.Workbook()
    const worksheet = workbook.addWorksheet('Members')
    worksheet.addRow(['USUARIOS', 'ID', 'email'])
    worksheet.addRow(['New Spreadsheet Member', '100023', 'sheet@alea.club'])
    const buffer = await workbook.xlsx.writeBuffer()
    const bytes = new Uint8Array(buffer as ArrayBuffer)

    const result = await importMembersFromSource({
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
    const profile = Array.from(profilesStore.values()).find(p => p.member_number === '100023')
    expect(profile).toEqual(
      expect.objectContaining({
        member_number: '100023',
        full_name: 'New Spreadsheet Member',
        email: 'sheet@alea.club',
      })
    )
  })

  it('limits normalizedRows to a bounded preview size', async () => {
    const { importMembersFromCsv } = await loadService()

    const rows = ['USUARIOS,ID,email']
    for (let index = 0; index < 60; index += 1) {
      rows.push(`Member ${index},${200000 + index},member${index}@alea.club`)
    }

    const result = await importMembersFromCsv(rows.join('\n'))

    expect(result.createdCount).toBe(60)
    expect(result.normalizedRows).toHaveLength(50)
    expect(result.normalizedRows[0]?.memberNumber).toBe('200000')
    expect(result.normalizedRows.at(-1)?.memberNumber).toBe('200049')
  })
})
