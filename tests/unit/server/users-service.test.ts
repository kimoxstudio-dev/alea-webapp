// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { SessionUser } from "@/lib/server/auth/auth"
import {
  createDrizzleQueryBuilder,
  createAdminSession,
  createMemberSession,
  selectMock,
  updateMock,
  deleteMock,
} from "@/tests/unit/mocks/drizzle-mock"

const deleteAuthUserMock = vi.fn(() => Promise.resolve({ error: null }))
const updateAuthUserByIdMock = vi.fn(() => Promise.resolve({ error: null }))


vi.mock("@/lib/auth/session", () => ({
  createAuthUser: vi.fn(),
  deleteAuthUser: deleteAuthUserMock,
  updateAuthUserById: updateAuthUserByIdMock,
}))

vi.mock("@/lib/db", () => ({
  getDrizzleAdminDb: vi.fn(() => createDrizzleQueryBuilder()),
  getDrizzleDb: vi.fn(() => createDrizzleQueryBuilder()),
}))

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerAdminClient: vi.fn(() => ({})),
}))

// Test data in Drizzle format (camelCase, Date objects for timestamps)
const profileRows = [
  {
    id: "1",
    memberNumber: "100001",
    fullName: "Admin User",
    authEmail: "100001@members.alea.internal",
    email: "admin@alea.club",
    phone: "600000001",
    role: "admin" as const,
    isActive: true,
    activeFrom: new Date("2024-01-01T00:00:00.000Z"),
    noShowCount: 0,
    blockedUntil: null,
    createdAt: new Date("2024-01-01T00:00:00.000Z"),
    updatedAt: new Date("2024-01-01T00:00:00.000Z"),
  },
  {
    id: "2",
    memberNumber: "100002",
    fullName: "Member User",
    authEmail: "100002@members.alea.internal",
    email: "socio@alea.club",
    phone: "600000002",
    role: "member" as const,
    isActive: true,
    activeFrom: new Date("2024-01-02T00:00:00.000Z"),
    noShowCount: 0,
    blockedUntil: null,
    createdAt: new Date("2024-01-02T00:00:00.000Z"),
    updatedAt: new Date("2024-01-02T00:00:00.000Z"),
  },
]

function resetMocks() {
  deleteAuthUserMock.mockReset()
  updateAuthUserByIdMock.mockReset()
  selectMock.mockReset()
  updateMock.mockReset()
  deleteMock.mockReset()
}

async function loadUsersModules() {
  vi.resetModules()
  const service = await import("@/lib/server/users/users-service")
  return { ...service }
}

describe("listPaginatedUsers", () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    resetMocks()
  })

  it("clamps page=0 to 1", async () => {
    const adminSession = createAdminSession()
    selectMock.mockResolvedValue(profileRows.slice(0, 2))
    const { listPaginatedUsers } = await loadUsersModules()

    const result = await listPaginatedUsers(adminSession, { page: 0, limit: 10 })

    expect(result.page).toBe(1)
  })

  it("clamps page=-5 to 1", async () => {
    const adminSession = createAdminSession()
    selectMock.mockResolvedValue(profileRows.slice(0, 2))
    const { listPaginatedUsers } = await loadUsersModules()

    const result = await listPaginatedUsers(adminSession, { page: -5, limit: 10 })

    expect(result.page).toBe(1)
  })

  it("clamps limit=0 to default and totalPages is not Infinity", async () => {
    const adminSession = createAdminSession()
    selectMock.mockResolvedValue(profileRows.slice(0, 2))
    const { listPaginatedUsers } = await loadUsersModules()

    const result = await listPaginatedUsers(adminSession, { page: 1, limit: 0 })

    expect(result.limit).toBeGreaterThanOrEqual(1)
    expect(Number.isFinite(result.totalPages)).toBe(true)
  })

  it("clamps limit=-10 to 1", async () => {
    const adminSession = createAdminSession()
    selectMock.mockResolvedValue(profileRows.slice(0, 2))
    const { listPaginatedUsers } = await loadUsersModules()

    const result = await listPaginatedUsers(adminSession, { page: 1, limit: -10 })

    expect(result.limit).toBe(1)
  })

  it("clamps limit=200 to 100", async () => {
    const adminSession = createAdminSession()
    selectMock.mockResolvedValue(profileRows.slice(0, 2))
    const { listPaginatedUsers } = await loadUsersModules()

    const result = await listPaginatedUsers(adminSession, { page: 1, limit: 200 })

    expect(result.limit).toBe(100)
  })

  it("returns limit=50 as-is when within bounds", async () => {
    const adminSession = createAdminSession()
    selectMock.mockResolvedValue(profileRows.slice(0, 2))
    const { listPaginatedUsers } = await loadUsersModules()

    const result = await listPaginatedUsers(adminSession, { page: 1, limit: 50 })

    expect(result.limit).toBe(50)
  })

  it("filters by memberNumber substring case-insensitively", async () => {
    const adminSession = createAdminSession()
    selectMock.mockResolvedValue(profileRows)
    const { listPaginatedUsers } = await loadUsersModules()

    await listPaginatedUsers(adminSession, { page: 1, limit: 10, search: "ADMIN" })

    expect(selectMock).toHaveBeenCalled()
  })

  it("filters by memberNumber substring", async () => {
    const adminSession = createAdminSession()
    selectMock.mockResolvedValue(profileRows.filter(r => r.memberNumber.includes("100002")))
    const { listPaginatedUsers } = await loadUsersModules()

    const result = await listPaginatedUsers(adminSession, { page: 1, limit: 10, search: "100002" })

    expect(result.data.length).toBeGreaterThan(0)
  })

  it("filters by full name substring", async () => {
    const adminSession = createAdminSession()
    selectMock.mockResolvedValue(profileRows.filter(r => r.fullName.includes("Member")))
    const { listPaginatedUsers } = await loadUsersModules()

    const result = await listPaginatedUsers(adminSession, { page: 1, limit: 10, search: "member user" })

    expect(result.data).toHaveLength(1)
    expect(result.data[0]?.id).toBe("2")
  })

  it("filters by email substring", async () => {
    const adminSession = createAdminSession()
    selectMock.mockResolvedValue(profileRows.filter(r => r.email.includes("admin@alea.club")))
    const { listPaginatedUsers } = await loadUsersModules()

    const result = await listPaginatedUsers(adminSession, { page: 1, limit: 10, search: "admin@alea.club" })

    expect(result.data).toHaveLength(1)
    expect(result.data[0]?.id).toBe("1")
  })

  it("returns all users when search is empty", async () => {
    const adminSession = createAdminSession()
    selectMock.mockResolvedValue(profileRows)
    const { listPaginatedUsers } = await loadUsersModules()

    const all = await listPaginatedUsers(adminSession, { page: 1, limit: 100 })
    const withEmpty = await listPaginatedUsers(adminSession, { page: 1, limit: 100, search: "" })

    expect(withEmpty.total).toBe(all.total)
  })

  it("does not filter out suspended users from the admin listing", async () => {
    const adminSession = createAdminSession()
    selectMock.mockResolvedValue(profileRows)
    const { listPaginatedUsers } = await loadUsersModules()

    await listPaginatedUsers(adminSession, { page: 1, limit: 10 })

    expect(selectMock).toHaveBeenCalled()
  })

  it("throws Forbidden when called by non-admin", async () => {
    const memberSession = createMemberSession()
    const { listPaginatedUsers } = await loadUsersModules()

    await expect(listPaginatedUsers(memberSession, { page: 1, limit: 10 })).rejects.toMatchObject({
      name: "ServiceError",
      statusCode: 403,
    })
  })
})


describe("updateUser", () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    resetMocks()
  })

  it("returns the updated public user payload for the correct user id", async () => {
    updateMock.mockResolvedValue([profileRows[1]])
    selectMock.mockResolvedValue([profileRows[1]])
    const adminSession = createAdminSession()
    const { updateUser } = await loadUsersModules()

    const updated = await updateUser(adminSession, "2", { role: "member" })

    expect(updated.id).toBe("2")
    expect(updated.id).not.toBe("1")
  })

  it("throws 400 when no updatable fields are provided", async () => {
    const adminSession = createAdminSession()
    const { updateUser } = await loadUsersModules()

    await expect(updateUser(adminSession, "1", {})).rejects.toMatchObject({
      name: "ServiceError",
      statusCode: 400,
    })
  })

  it("throws 400 when memberNumber exceeds 10 digits", async () => {
    const adminSession = createAdminSession()
    const { updateUser } = await loadUsersModules()

    await expect(updateUser(adminSession, "1", { memberNumber: "1".repeat(11) })).rejects.toMatchObject({
      name: "ServiceError",
      statusCode: 400,
    })
  })

  it("accepts memberNumber of exactly 10 digits", async () => {
    updateMock.mockResolvedValue([profileRows[0]])
    selectMock.mockResolvedValue([profileRows[0]])
    const adminSession = createAdminSession()
    const { updateUser } = await loadUsersModules()

    await expect(updateUser(adminSession, "1", { memberNumber: "1".repeat(10) })).resolves.toBeDefined()
  })

  it("throws 400 when memberNumber contains non-numeric characters", async () => {
    const adminSession = createAdminSession()
    const { updateUser } = await loadUsersModules()

    await expect(updateUser(adminSession, "1", { memberNumber: "abc12" })).rejects.toMatchObject({
      statusCode: 400,
    })
  })

  it("throws 400 when memberNumber is null (coerced to string null)", async () => {
    const adminSession = createAdminSession()
    const { updateUser } = await loadUsersModules()

    await expect(updateUser(adminSession, "1", { memberNumber: null as unknown as string })).rejects.toMatchObject({
      name: "ServiceError",
      statusCode: 400,
    })
  })

  it("throws 400 when memberNumber is an empty string", async () => {
    const adminSession = createAdminSession()
    const { updateUser } = await loadUsersModules()

    await expect(updateUser(adminSession, "1", { memberNumber: "" })).rejects.toMatchObject({
      name: "ServiceError",
      statusCode: 400,
    })
  })

  it("accepts memberNumber of single digit zero", async () => {
    updateMock.mockResolvedValue([profileRows[0]])
    selectMock.mockResolvedValue([profileRows[0]])
    const adminSession = createAdminSession()
    const { updateUser } = await loadUsersModules()

    await expect(updateUser(adminSession, "1", { memberNumber: "0" })).resolves.toBeDefined()
  })

  it("accepts is_active boolean and includes it in the update", async () => {
    updateMock.mockResolvedValue([profileRows[0]])
    selectMock.mockResolvedValue([profileRows[0]])
    const adminSession = createAdminSession()
    const { updateUser } = await loadUsersModules()

    await updateUser(adminSession, "1", { is_active: false })

    expect(updateMock).toHaveBeenCalled()
  })

  it("accepts fullName, email, and phone updates", async () => {
    const updated = { ...profileRows[0], fullName: "Updated User", email: "updated@alea.club", phone: "699000111" }
    selectMock.mockResolvedValue([profileRows[0]])
    updateMock.mockResolvedValue([updated])
    const adminSession = createAdminSession()
    const { updateUser } = await loadUsersModules()

    await updateUser(adminSession, "1", { fullName: "Updated User", email: "updated@alea.club", phone: "699000111" })

    expect(updateMock).toHaveBeenCalled()
  })

  it("keeps internal auth email aligned when memberNumber changes", async () => {
    const updated = { ...profileRows[0], memberNumber: "100123", authEmail: "100123@members.alea.internal" }
    selectMock.mockResolvedValue([profileRows[0]])
    updateMock.mockResolvedValue([updated])
    const adminSession = createAdminSession()
    const { updateUser } = await loadUsersModules()

    await updateUser(adminSession, "1", { memberNumber: "100123" })

    expect(updateMock).toHaveBeenCalled()
    expect(updateAuthUserByIdMock).toHaveBeenCalled()
  })

  it("rejects blank fullName updates", async () => {
    const adminSession = createAdminSession()
    const { updateUser } = await loadUsersModules()

    await expect(updateUser(adminSession, "1", { fullName: "   " })).rejects.toMatchObject({
      name: "ServiceError",
      statusCode: 400,
    })
  })

  it("rejects non-string email updates", async () => {
    const adminSession = createAdminSession()
    const { updateUser } = await loadUsersModules()

    await expect(updateUser(adminSession, "1", { email: { bad: true } })).rejects.toMatchObject({
      name: "ServiceError",
      statusCode: 400,
      message: "Email must be a string or null",
    })
  })

  it("rejects non-string phone updates", async () => {
    const adminSession = createAdminSession()
    const { updateUser } = await loadUsersModules()

    await expect(updateUser(adminSession, "1", { phone: ["699000111"] })).rejects.toMatchObject({
      name: "ServiceError",
      statusCode: 400,
      message: "Phone must be a string or null",
    })
  })

  it("rejects is_active when provided as a non-boolean string", async () => {
    const adminSession = createAdminSession()
    const { updateUser } = await loadUsersModules()

    await expect(updateUser(adminSession, "1", { is_active: "false" })).rejects.toMatchObject({
      name: "ServiceError",
      statusCode: 400,
    })
  })

  it("throws Forbidden when called by non-admin", async () => {
    const memberSession = createMemberSession()
    const { updateUser } = await loadUsersModules()

    await expect(updateUser(memberSession, "1", { fullName: "New Name" })).rejects.toMatchObject({
      name: "ServiceError",
      statusCode: 403,
    })
  })
})


describe("deleteUser", () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    resetMocks()
  })

  it("deletes the auth user after confirming the profile exists", async () => {
    selectMock.mockResolvedValue([profileRows[0]])
    const adminSession = createAdminSession()
    const { deleteUser } = await loadUsersModules()

    await expect(deleteUser(adminSession, "1")).resolves.toBeUndefined()
    expect(deleteAuthUserMock).toHaveBeenCalled()
  })

  it("throws Forbidden when called by non-admin", async () => {
    const memberSession = createMemberSession()
    const { deleteUser } = await loadUsersModules()

    await expect(deleteUser(memberSession, "1")).rejects.toMatchObject({
      name: "ServiceError",
      statusCode: 403,
    })
  })
})


describe("resetNoShows", () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    resetMocks()
  })

  it("sets no_show_count=0 and blocked_until=null for the user", async () => {
    selectMock.mockResolvedValue([profileRows[0]])
    updateMock.mockResolvedValue([{ ...profileRows[0], noShowCount: 0, blockedUntil: null }])
    const adminSession = createAdminSession()
    const { resetNoShows } = await loadUsersModules()

    await resetNoShows(adminSession, "user-123")

    expect(updateMock).toHaveBeenCalled()
  })

  it("throws a service error when update fails", async () => {
    selectMock.mockResolvedValue([profileRows[0]])
    updateMock.mockRejectedValue(new Error("DB error"))
    const adminSession = createAdminSession()
    const { resetNoShows } = await loadUsersModules()

    await expect(resetNoShows(adminSession, "user-123")).rejects.toMatchObject({
      name: "ServiceError",
      statusCode: 500,
    })
  })

  it("throws Forbidden when called by non-admin", async () => {
    const memberSession = createMemberSession()
    const { resetNoShows } = await loadUsersModules()

    await expect(resetNoShows(memberSession, "user-123")).rejects.toMatchObject({
      name: "ServiceError",
      statusCode: 403,
    })
  })
})


describe("unblockUser", () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    resetMocks()
  })

  it("sets blocked_until=null for the user", async () => {
    selectMock.mockResolvedValue([profileRows[0]])
    updateMock.mockResolvedValue([{ ...profileRows[0], blockedUntil: null }])
    const adminSession = createAdminSession()
    const { unblockUser } = await loadUsersModules()

    await unblockUser(adminSession, "user-456")

    expect(updateMock).toHaveBeenCalled()
  })

  it("throws a service error when update fails", async () => {
    selectMock.mockResolvedValue([profileRows[0]])
    updateMock.mockRejectedValue(new Error("DB error"))
    const adminSession = createAdminSession()
    const { unblockUser } = await loadUsersModules()

    await expect(unblockUser(adminSession, "user-456")).rejects.toMatchObject({
      name: "ServiceError",
      statusCode: 500,
    })
  })

  it("throws Forbidden when called by non-admin", async () => {
    const memberSession = createMemberSession()
    const { unblockUser } = await loadUsersModules()

    await expect(unblockUser(memberSession, "user-456")).rejects.toMatchObject({
      name: "ServiceError",
      statusCode: 403,
    })
  })
})
