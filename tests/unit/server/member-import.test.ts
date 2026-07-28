// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { SessionUser } from "@/lib/server/auth/auth"
import ExcelJS from "exceljs"
import {
  createStatefulDrizzleDb,
  createAdminSession,
  createMemberSession,
  resetDb,
  seed,
  getRows,
  failNextQuery,
} from "@/tests/unit/mocks/drizzle-mock"
import { profiles } from "@/lib/db/schema"

type ProfileRow = typeof profiles.$inferSelect

const createUserMock = vi.fn(async (opts?: any) => ({
  data: { user: { id: "new-user-" + Math.random().toString(36).substr(2, 9) } },
  error: null,
}))
const deleteUserMock = vi.fn(async () => ({ error: null }))

// Mock createAuthUser to use createUserMock.
vi.mock("@/lib/auth/session", () => ({
  createAuthUser: vi.fn(async (admin, opts) => createUserMock(opts)),
  deleteAuthUser: vi.fn(async (admin, id) => deleteUserMock(id)),
  updateAuthUserById: vi.fn(async (id, opts) => ({ error: null })),
}))

vi.mock("@/lib/db", () => ({
  getDrizzleAdminDb: vi.fn(() => createStatefulDrizzleDb()),
  getDrizzleDb: vi.fn(() => createStatefulDrizzleDb()),
}))

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerAdminClient: vi.fn(() => ({
    auth: {
      admin: {
        createUser: createUserMock,
        deleteUser: deleteUserMock,
      },
    },
  })),
}))

const EXISTING_MEMBER_ID = "user-100001"

/**
 * The single pre-existing profiles row every "update existing member"
 * scenario below targets. Seeded fresh in each importMembersFromCsv /
 * importMembersFromSource beforeEach via seed({ profiles: [...] }) -- this is
 * a real row in the in-memory store, matched by genuine
 * eq(profiles.memberNumber, ...) / eq(profiles.id, ...) evaluation, not a
 * stubbed response, so a regression in the service where clause is
 * catchable here (KIM-440 Finding B).
 */
function existingMemberRow(): ProfileRow {
  return {
    id: EXISTING_MEMBER_ID,
    memberNumber: "100001",
    fullName: "Existing Member",
    authEmail: "100001@members.alea.internal",
    email: "existing@alea.club",
    phone: "600111222",
    role: "member",
    isActive: true,
    activeFrom: new Date("2026-04-01T00:00:00.000Z"),
    noShowCount: 0,
    blockedUntil: null,
    createdAt: new Date("2026-04-01T00:00:00.000Z"),
    updatedAt: new Date("2026-04-01T00:00:00.000Z"),
    pswChanged: null,
    passwordHash: null,
  }
}

async function loadService() {
  vi.resetModules()
  const [usersService, memberImport] = await Promise.all([
    import("@/lib/server/users/users-service"),
    import("@/lib/server/users/member-import"),
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

describe("parseMemberImportCsv", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetDb()
  })

  it("parses the expected USUARIOS / ID CSV shape", async () => {
    const { parseMemberImportCsv } = await loadService()

    const result = parseMemberImportCsv(
      "USUARIOS,ID,email,phone\nJohn Doe,100010,john@alea.club,600123123\n"
    )

    expect(result.issues).toEqual([])
    expect(result.normalizedRows).toEqual([
      {
        rowNumber: 2,
        memberNumber: "100010",
        fullName: "John Doe",
        email: "john@alea.club",
        phone: "600123123",
      },
    ])
  })

  it("supports semicolon-delimited CSV files", async () => {
    const { parseMemberImportCsv } = await loadService()

    const result = parseMemberImportCsv(
      "USUARIOS;ID;email\nJane Doe;100011;jane@alea.club\n"
    )

    expect(result.normalizedRows[0]?.memberNumber).toBe("100011")
    expect(result.issues).toEqual([])
  })

  it("accepts normalized member_number headers with underscores", async () => {
    const { parseMemberImportCsv } = await loadService()

    const result = parseMemberImportCsv(
      "member_number,full_name,email\n100013,Jane Doe,jane@alea.club\n"
    )

    expect(result.issues).toEqual([])
    expect(result.normalizedRows).toEqual([
      {
        rowNumber: 2,
        memberNumber: "100013",
        fullName: "Jane Doe",
        email: "jane@alea.club",
        phone: null,
      },
    ])
  })

  it("reports duplicate member numbers in the same file", async () => {
    const { parseMemberImportCsv } = await loadService()

    const result = parseMemberImportCsv(
      "USUARIOS,ID\nOne,100012\nTwo,100012\n"
    )

    expect(result.normalizedRows).toHaveLength(1)
    expect(result.issues).toEqual([
      { rowNumber: 3, memberNumber: "100012", code: "duplicate_member_number" },
    ])
  })


  it("accepts CSV files with UTF-8 BOM headers", async () => {
    const { parseMemberImportCsv } = await loadService()

    const result = parseMemberImportCsv(
      String.fromCharCode(0xfeff) + "USUARIOS,ID\nJohn Doe,100099\n"
    )

    expect(result.normalizedRows).toEqual([
      expect.objectContaining({
        memberNumber: "100099",
        fullName: "John Doe",
      }),
    ])
    expect(result.totalRows).toBe(1)
  })

  it("throws when required headers are missing", async () => {
    const { parseMemberImportCsv } = await loadService()

    expect(() => parseMemberImportCsv("name,email\nJohn,john@alea.club\n")).toThrowError()
  })
})

describe("normalizeMemberImportSource", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetDb()
  })

  it("normalizes xlsx spreadsheets into the canonical dataset", async () => {
    const { normalizeMemberImportSource } = await loadService()
    const workbook = new ExcelJS.Workbook()
    const worksheet = workbook.addWorksheet("Members")
    worksheet.addRow(["USUARIOS", "ID", "email", "phone"])
    worksheet.addRow(["Jane Doe", "100021", "jane@alea.club", "699123123"])
    const buffer = await workbook.xlsx.writeBuffer()
    const bytes = new Uint8Array(buffer as ArrayBuffer)

    const result = await normalizeMemberImportSource({
      fileName: "members.xlsx",
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      bytes: new Uint8Array(bytes),
    })

    expect(result.normalizedCsv).toBe("USUARIOS,ID,email,phone\nJane Doe,100021,jane@alea.club,699123123")
    expect(result.normalizedRows).toEqual([
      {
        rowNumber: 2,
        memberNumber: "100021",
        fullName: "Jane Doe",
        email: "jane@alea.club",
        phone: "699123123",
      },
    ])
  })

  it("uses the first xlsx sheet that matches import headers", async () => {
    const { normalizeMemberImportSource } = await loadService()
    const workbook = new ExcelJS.Workbook()
    const coverSheet = workbook.addWorksheet("Cover")
    coverSheet.addRow(["Report generated", "2026-04-15"])
    coverSheet.addRow(["Notes", "Skip this sheet"])
    const memberSheet = workbook.addWorksheet("Members")
    memberSheet.addRow(["USUARIOS", "ID", "email"])
    memberSheet.addRow(["Second Sheet Member", "100031", "sheet2@alea.club"])
    const buffer = await workbook.xlsx.writeBuffer()
    const bytes = new Uint8Array(buffer as ArrayBuffer)

    const result = await normalizeMemberImportSource({
      fileName: "members.xlsx",
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      bytes: new Uint8Array(bytes),
    })

    expect(result.normalizedRows).toEqual([
      {
        rowNumber: 2,
        memberNumber: "100031",
        fullName: "Second Sheet Member",
        email: "sheet2@alea.club",
        phone: null,
      },
    ])
  })

  it("normalizes odt table files into the canonical dataset", async () => {
    const { normalizeMemberImportSource } = await loadService()
    const bytes = Uint8Array.from(Buffer.from(
      "UEsDBBQAAAAIABxQj1xmoUcuKQEAABwFAAALAAAAY29udGVudC54bWy1VNFqgzAUfe9XhLzbWoUxgtoNyqCDMVjnB8R4uzpiIiZ27d8vJrad7kXW+aLJuefck5vLTbQ6lhwdoFaFFDFezn2MQDCZF+Ijxun7k3ePV8kskrtdwYDkkjUlCO0xKbT5I6MWirhojJtaEElVoYigJSiiGZEViLOK/GQT6+UQTTM+Wm7JPTUc9Wix4VptMkPoXFUm81O7vyItzSEGc4b2i9y6dYjxC5SZuTib6jfVq+XXNTKIMeAcdV4Hyhvw9KkyKZWuzcXjJLLnrJJ0mz6+bV630aIDzGKQ5maPzXrK7FDSgk9pUO2lgFEG/VivPf/euGe5F2gtxx3sjx5L3/eDYEqHT1PFA+VA54w32ZROd20pQRiGt3WyF+hGejGY6Qvgxv6yHb5tyTdQSwMEFAAAAAgAHFCPXF7GMgwnAAAAJwAAAAgAAABtaW1ldHlwZQVAwQkAIAjcyGaS9CGUJ3hF44dWrZjKQI6bJtCOFpSnYZ7tSaE/flBLAQIUABQAAAAIABxQj1xmoUcuKQEAABwFAAALAAAAAAAAAAAAAAAAAAAAAABjb250ZW50LnhtbFBLAQIUABQAAAAIABxQj1xexjIMJwAAACcAAAAIAAAAAAAAAAAAAAAAAFIBAABtaW1ldHlwZVBLBQYAAAAAAgACAG8AAACfAQAAAAA=",
      "base64"
    ))

    const result = await normalizeMemberImportSource({
      fileName: "members.odt",
      contentType: "application/vnd.oasis.opendocument.text",
      bytes,
    })

    expect(result.normalizedCsv).toBe("USUARIOS,ID,email,phone\nJohn Doe,100022,john@alea.club,600222333")
    expect(result.normalizedRows[0]).toEqual({
      rowNumber: 2,
      memberNumber: "100022",
      fullName: "John Doe",
      email: "john@alea.club",
      phone: "600222333",
    })
  })

  it("parses a valid xlsx when bytes is a Uint8Array view with a non-zero byteOffset", async () => {
    const { extractSpreadsheetCsv } = await loadService()
    const workbook = new ExcelJS.Workbook()
    const worksheet = workbook.addWorksheet("Members")
    worksheet.addRow(["USUARIOS", "ID", "email", "phone"])
    worksheet.addRow(["Offset Member", "100041", "offset@alea.club", "699444555"])
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

    expect(csv).toBe("USUARIOS,ID,email,phone\nOffset Member,100041,offset@alea.club,699444555")
  })
})

describe("importMembersFromCsv", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetDb()
    seed({ profiles: [existingMemberRow()] })
    createUserMock.mockImplementation(async ({ email }: { email: string }) => ({
      data: { user: { id: `user-${email.split("@")[0]}` } },
      error: null,
    }))
    deleteUserMock.mockResolvedValue({ error: null })
  })

  it("updates existing members with generated fallback email and nullable phone", async () => {
    const { importMembersFromCsv } = await loadService()

    const adminSession = createAdminSession()
    const result = await importMembersFromCsv(adminSession, "USUARIOS,ID,email,phone\nUpdated Name,100001,,\n")

    expect(result.createdCount).toBe(0)
    expect(result.updatedCount).toBe(1)
    const updated = getRows(profiles).find((row) => row.memberNumber === "100001")
    expect(updated?.fullName).toBe("Updated Name")
    expect(updated?.email).toBe("100001@members.alea.internal")
    expect(updated?.phone).toBeNull()
    expect(result.normalizedRows).toEqual([
      {
        rowNumber: 2,
        memberNumber: "100001",
        fullName: "Updated Name",
        email: "100001@members.alea.internal",
        phone: null,
      },
    ])
  })

  it("rejects renamed odt archives uploaded as xlsx", async () => {
    const { normalizeMemberImportSource } = await loadService()
    const odtBytes = Uint8Array.from(Buffer.from(
      "UEsDBBQAAAAIABxQj1xmoUcuKQEAABwFAAALAAAAY29udGVudC54bWy1VNFqgzAUfe9XhLzbWoUxgtoNyqCDMVjnB8R4uzpiIiZ27d8vJrad7kXW+aLJuefck5vLTbQ6lhwdoFaFFDFezn2MQDCZF+Ijxun7k3ePV8kskrtdwYDkkjUlCO0xKbT5I6MWirhojJtaEElVoYigJSiiGZEViLOK/GQT6+UQTTM+Wm7JPTUc9Wix4VptMkPoXFUm81O7vyItzSEGc4b2i9y6dYjxC5SZuTib6jfVq+XXNTKIMeAcdV4Hyhvw9KkyKZWuzcXjJLLnrJJ0mz6+bV630aIDzGKQ5maPzXrK7FDSgk9pUO2lgFEG/VivPf/euGe5F2gtxx3sjx5L3/eDYEqHT1PFA+VA54w32ZROd20pQRiGt3WyF+hGejGY6Qvgxv6yHb5tyTdQSwMEFAAAAAgAHFCPXF7GMgwnAAAAJwAAAAgAAABtaW1ldHlwZQVAwQkAIAjcyGaS9CGUJ3hF44dWrZjKQI6bJtCOFpSnYZ7tSaE/flBLAQIUABQAAAAIABxQj1xmoUcuKQEAABwFAAALAAAAAAAAAAAAAAAAAAAAAABjb250ZW50LnhtbFBLAQIUABQAAAAIABxQj1xexjIMJwAAACcAAAAIAAAAAAAAAAAAAAAAAFIBAABtaW1ldHlwZVBLBQYAAAAAAgACAG8AAACfAQAAAAA=",
      "base64"
    ))

    await expect(normalizeMemberImportSource({
      fileName: "members.xlsx",
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      bytes: odtBytes,
    })).rejects.toThrow()
  })

  it("creates new imported members as inactive profiles with internal auth email", async () => {
    const { importMembersFromCsv } = await loadService()

    const adminSession = createAdminSession()
    const result = await importMembersFromCsv(adminSession, "USUARIOS,ID,email,phone\nNew Member,100020,new@alea.club,699000111\n")

    expect(result.createdCount).toBe(1)
    expect(result.totalRows).toBe(1)
    expect(createUserMock).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "100020@members.alea.internal",
        email_confirm: true,
      })
    )
    const inserted = getRows(profiles).find((row) => row.memberNumber === "100020")
    expect(inserted).toMatchObject({
      id: "user-100020",
      memberNumber: "100020",
      fullName: "New Member",
      authEmail: "100020@members.alea.internal",
      email: "new@alea.club",
      phone: "699000111",
      isActive: false,
      activeFrom: null,
      pswChanged: null,
    })
    expect(result.normalizedRows).toEqual([
      {
        rowNumber: 2,
        memberNumber: "100020",
        fullName: "New Member",
        email: "new@alea.club",
        phone: "699000111",
      },
    ])
  })

  // KIM-440 Finding A regression guard: isolates why new-member creation
  // now succeeds, independently of the assertions above. createAuthUser
  // succeeds (a real Supabase Auth user is provisioned), and the follow-up
  // db.insert(profiles).values({ id: authData.user.id, ... }).returning(...)
  // (which replaced the old db.update(profiles).set({...}).where(eq(profiles.id,
  // authData.user.id)) that could never match a brand-new id on Neon/Postgres,
  // where no DB trigger pre-populates profiles the way the legacy Supabase
  // trigger did) persists the new row, so the service must not take its
  // persist_import_failed branch and must not roll back the just-created
  // auth user. getRows(profiles) reads the real in-memory store the insert
  // wrote to -- not a stubbed response -- so this proves the row (and its
  // columns) genuinely exist, not merely that the service returned a
  // plausible-looking result. If this ever fails with a different issue
  // code, or with deleteUserMock being called, that points to a regression
  // in either the production fix or the insert wiring, not a passing test
  // masking a bug.
  it("persists a new member via explicit INSERT (KIM-440 Finding A regression guard)", async () => {
    const { importMembersFromCsv } = await loadService()

    const adminSession = createAdminSession()
    const result = await importMembersFromCsv(adminSession, "USUARIOS,ID,email,phone\nNew Member,100020,new@alea.club,699000111\n")

    expect(createUserMock).toHaveBeenCalled()
    expect(result.issues).not.toContainEqual(
      expect.objectContaining({ code: "persist_import_failed" })
    )
    expect(deleteUserMock).not.toHaveBeenCalled()
    const persisted = getRows(profiles).find((row) => row.memberNumber === "100020")
    expect(persisted).toMatchObject({
      id: "user-100020",
      memberNumber: "100020",
      authEmail: "100020@members.alea.internal",
      fullName: "New Member",
      email: "new@alea.club",
      phone: "699000111",
      isActive: false,
      activeFrom: null,
      pswChanged: null,
    })
    expect(result.createdCount).toBe(1)
  })

  it("fills missing source email with internal generated email and keeps phone null", async () => {
    const { importMembersFromCsv } = await loadService()

    const adminSession = createAdminSession()
    const result = await importMembersFromCsv(adminSession, "USUARIOS,ID,phone\nNo Email Member,100024,\n")

    expect(result.createdCount).toBe(1)
    const inserted = getRows(profiles).find((row) => row.memberNumber === "100024")
    expect(inserted).toMatchObject({
      authEmail: "100024@members.alea.internal",
      email: "100024@members.alea.internal",
      phone: null,
    })
    expect(result.normalizedRows).toEqual([
      {
        rowNumber: 2,
        memberNumber: "100024",
        fullName: "No Email Member",
        email: "100024@members.alea.internal",
        phone: null,
      },
    ])
  })

  it("preserves existing optional contact data when optional headers are omitted", async () => {
    const { importMembersFromCsv } = await loadService()

    const adminSession = createAdminSession()
    const result = await importMembersFromCsv(adminSession, "USUARIOS,ID\nExisting Again,100001\n")

    expect(result.updatedCount).toBe(1)
    const updated = getRows(profiles).find((row) => row.memberNumber === "100001")
    expect(updated).toMatchObject({
      fullName: "Existing Again",
      email: "existing@alea.club",
      phone: "600111222",
    })
    expect(result.normalizedRows).toEqual([
      {
        rowNumber: 2,
        memberNumber: "100001",
        fullName: "Existing Again",
        email: "existing@alea.club",
        phone: "600111222",
      },
    ])
  })

  it("rejects mismatched file extension and MIME type during source normalization", async () => {
    const { normalizeMemberImportSource } = await loadService()

    await expect(normalizeMemberImportSource({
      fileName: "members.csv",
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      bytes: new Uint8Array([1, 2, 3]),
    })).rejects.toThrow()
  })

  it("rejects malformed odt uploads with a validation error", async () => {
    const { normalizeMemberImportSource } = await loadService()

    await expect(normalizeMemberImportSource({
      fileName: "members.odt",
      contentType: "application/vnd.oasis.opendocument.text",
      bytes: new Uint8Array([1, 2, 3]),
    })).rejects.toThrow()
  })

  it("honors repeated odt rows for row counts and duplicate detection", async () => {
    const { normalizeMemberImportSource } = await loadService()
    const repeatedBytes = Uint8Array.from(Buffer.from(
      "UEsDBBQAAAAIAKVRj1yr9ggzGAEAAK8DAAALAAAAY29udGVudC54bWy1U8tqwzAQvOcrhO5unPRShO1QKIUcSiGpP0CWN8UgS0aS0+Tvq4edxOrFNOSix+zOjnZYZZtTy9ERlG6kyPHqKcUIBJN1I75zXH69Jy94UywyeTg0DEgtWd+CMAmTwtgdWbbQJERz3CtBJNWNJoK2oIlhRHYgRha5zSZeKyCGVnw23SdP2HAys8k213OLBUJjV5Wsz+5+RVxaQCwWBP2Kwtkp5PgD2soa50v9TU2U/LlGohgDztGgdaS8h8ScO1tSG2WNx0Xm39kV5b583W0/99lyAOwhKnO3xvZtVvVpbNJc3PboUu/8cYBOFHRADdQ5Xt/49c8X73wxFPx/pDWrNE2f1/fZMwkMU7aMxuwChEm8XOPvVvwCUEsDBBQAAAAIAKVRj1xexjIMJwAAACcAAAAIAAAAbWltZXR5cGUFQMEJACAI3MhmkvQhlCd4ReOHVq2YykCOmybQjhaUp2Ge7UmhP35QSwECFAAUAAAACAClUY9cq/YIMxgBAACvAwAACwAAAAAAAAAAAAAAAAAAAAAAY29udGVudC54bWxQSwECFAAUAAAACAClUY9cXsYyDCcAAAAnAAAACAAAAAAAAAAAAAAAAABBAQAAbWltZXR5cGVQSwUGAAAAAAIAAgBvAAAAjgEAAAAA",
      "base64"
    ))

    const result = await normalizeMemberImportSource({
      fileName: "members.odt",
      contentType: "application/vnd.oasis.opendocument.text",
      bytes: repeatedBytes,
    })

    expect(result.totalRows).toBe(2)
    expect(result.normalizedRows).toHaveLength(1)
    expect(result.issues).toContainEqual({
      rowNumber: 3,
      memberNumber: "100032",
      code: "duplicate_member_number",
    })
  })

  it("keeps odt sparse cells aligned when empty email cell is self-closing", async () => {
    const { normalizeMemberImportSource } = await loadService()
    const sparseBytes = Uint8Array.from(Buffer.from(
      "UEsDBBQAAAAIAKVRj1xwaRyJHgEAANUEAAALAAAAY29udGVudC54bWy1VNFugyAUfe9XEN6dNpplIWqzZFnSh2XJnB+AeLuZIBjBrv37Idh2uhcz54vCuefcA1wu8e5Uc3SEVlVSJHh7F2AEgsmyEh8Jzt+fvQe8SzexPBwqBqSUrKtBaI9Joc0fGbVQxEUT3LWCSKoqRQStQRHNiGxAXFTkJ5tYL4doWvDZckseqeGkZ4sN12rTDUKXXRWyPPfzG9LTHGIwZ2i/yI17hwS/QF2Yg7OpflO9Vn7dIpMYA87R4HWkvANPnxuTUunWHDxOY7vOJs2z/PFt/5rF/gCYwSTNYo/905rZoaYVX9Og+ZQCZhmMY6Py/Hvhsoa2CpC7ImtufxsEQRj+1cFf7H/f24dRFC0rwSgw9KI/acYr4Pr1Op0+Suk3UEsDBBQAAAAIAKVRj1xexjIMJwAAACcAAAAIAAAAbWltZXR5cGUFQMEJACAI3MhmkvQhlCd4ReOHVq2YykCOmybQjhaUp2Ge7UmhP35QSwECFAAUAAAACAClUY9ccGkciR4BAADVBAAACwAAAAAAAAAAAAAAAAAAAAAAY29udGVudC54bWxQSwECFAAUAAAACAClUY9cXsYyDCcAAAAnAAAACAAAAAAAAAAAAAAAAABHAQAAbWltZXR5cGVQSwUGAAAAAAIAAgBvAAAAlAEAAAAA",
      "base64"
    ))

    const result = await normalizeMemberImportSource({
      fileName: "members.odt",
      contentType: "application/vnd.oasis.opendocument.text",
      bytes: sparseBytes,
    })

    expect(result.normalizedRows).toEqual([
      {
        rowNumber: 2,
        memberNumber: "100033",
        fullName: "Sparse Member",
        email: null,
        phone: "600333444",
      },
    ])
  })

  it("deletes the auth user when profile persistence returns null data", async () => {
    const { importMembersFromCsv } = await loadService()

    // New-member path (no pre-existing 100020 row) whose persistence write
    // is forced to fail: the real service insert call throws, which the
    // service catch block treats identically to "resolved with no row" --
    // both leave persistedProfile undefined and take the
    // persist_import_failed branch.
    failNextQuery({ op: "insert", table: profiles })

    const adminSession = createAdminSession()
    const result = await importMembersFromCsv(adminSession, "USUARIOS,ID,email,phone\nNew Member,100020,new@alea.club,699000111\n")

    expect(result.createdCount).toBe(0)
    expect(result.skippedCount).toBe(1)
    expect(result.issues).toContainEqual({
      rowNumber: 2,
      memberNumber: "100020",
      code: "persist_import_failed",
    })
    expect(deleteUserMock).toHaveBeenCalledWith("user-100020")
  })
})

describe("importMembersFromSource", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetDb()
    seed({ profiles: [existingMemberRow()] })
    createUserMock.mockImplementation(async ({ email }: { email: string }) => ({
      data: { user: { id: `user-${email.split("@")[0]}` } },
      error: null,
    }))
    deleteUserMock.mockResolvedValue({ error: null })
  })

  it("imports from xlsx source files and returns normalized rows for audit", async () => {
    const { importMembersFromSource } = await loadService()
    const workbook = new ExcelJS.Workbook()
    const worksheet = workbook.addWorksheet("Members")
    worksheet.addRow(["USUARIOS", "ID", "email"])
    worksheet.addRow(["New Spreadsheet Member", "100023", "sheet@alea.club"])
    const buffer = await workbook.xlsx.writeBuffer()
    const bytes = new Uint8Array(buffer as ArrayBuffer)

    const adminSession = createAdminSession()
    const result = await importMembersFromSource(adminSession, {
      fileName: "members.xlsx",
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      bytes: new Uint8Array(bytes),
    })

    expect(result.createdCount).toBe(1)
    expect(result.normalizedRows).toEqual([
      {
        rowNumber: 2,
        memberNumber: "100023",
        fullName: "New Spreadsheet Member",
        email: "sheet@alea.club",
        phone: null,
      },
    ])
    const inserted = getRows(profiles).find((row) => row.memberNumber === "100023")
    expect(inserted).toMatchObject({
      memberNumber: "100023",
      fullName: "New Spreadsheet Member",
      email: "sheet@alea.club",
    })
  })

  it("limits normalizedRows to a bounded preview size", async () => {
    const { importMembersFromCsv } = await loadService()
    const adminSession = createAdminSession()

    const rows = ["USUARIOS,ID,email"]
    for (let index = 0; index < 60; index += 1) {
      rows.push(`Member ${index},${200000 + index},member${index}@alea.club`)
    }

    const result = await importMembersFromCsv(adminSession, rows.join("\n"))

    expect(result.createdCount).toBe(60)
    expect(result.normalizedRows).toHaveLength(50)
    expect(result.normalizedRows[0]?.memberNumber).toBe("200000")
    expect(result.normalizedRows.at(-1)?.memberNumber).toBe("200049")
  })
})

describe("Member-role session denial for requireAdminSession", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetDb()
  })

  it("importMembersFromCsv throws 403 when session role is member", async () => {
    const { importMembersFromCsv } = await loadService()
    const memberSession = createMemberSession()

    await expect(importMembersFromCsv(memberSession, "USUARIOS,ID,email\nNew Member,100020,new@alea.club\n")).rejects.toMatchObject({
      name: "ServiceError",
      statusCode: 403,
    })
  })

  it("importMembersFromSource throws 403 when session role is member", async () => {
    const { importMembersFromSource } = await loadService()
    const memberSession = createMemberSession()

    await expect(importMembersFromSource(memberSession, {
      fileName: "members.csv",
      contentType: "text/csv",
      bytes: new Uint8Array([1, 2, 3]),
    })).rejects.toMatchObject({
      name: "ServiceError",
      statusCode: 403,
    })
  })
})
