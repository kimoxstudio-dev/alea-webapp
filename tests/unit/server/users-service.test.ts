// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest"
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

const deleteAuthUserMock = vi.fn(() => Promise.resolve({ error: null }))
const updateAuthUserByIdMock = vi.fn(() => Promise.resolve({ error: null }))

vi.mock("@/lib/auth/session", () => ({
  createAuthUser: vi.fn(),
  deleteAuthUser: deleteAuthUserMock,
  updateAuthUserById: updateAuthUserByIdMock,
}))

vi.mock("@/lib/db", () => ({
  getDrizzleAdminDb: vi.fn(() => createStatefulDrizzleDb()),
  getDrizzleDb: vi.fn(() => createStatefulDrizzleDb()),
}))

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerAdminClient: vi.fn(() => ({})),
}))

// Test data mirrors the Drizzle-inferred profiles row shape (camelCase,
// Date instances for timestamp columns -- toPublicUser calls .toISOString()
// on these, so plain strings would throw).
type ProfileRow = typeof profiles.$inferSelect

const adminProfile: ProfileRow = {
  id: "1",
  memberNumber: "100001",
  fullName: "Admin User",
  authEmail: "100001@members.alea.internal",
  email: "admin@alea.club",
  phone: "600000001",
  role: "admin",
  isActive: true,
  activeFrom: new Date("2024-01-01T00:00:00.000Z"),
  noShowCount: 0,
  blockedUntil: null,
  createdAt: new Date("2024-01-01T00:00:00.000Z"),
  updatedAt: new Date("2024-01-01T00:00:00.000Z"),
  pswChanged: null,
  passwordHash: null,
}

const memberProfile: ProfileRow = {
  ...adminProfile,
  id: "2",
  memberNumber: "100002",
  fullName: "Member User",
  authEmail: "100002@members.alea.internal",
  email: "socio@alea.club",
  phone: "600000002",
  role: "member",
  activeFrom: new Date("2024-01-02T00:00:00.000Z"),
  createdAt: new Date("2024-01-02T00:00:00.000Z"),
  updatedAt: new Date("2024-01-02T00:00:00.000Z"),
}

const profileRows = [adminProfile, memberProfile]

function resetMocks() {
  deleteAuthUserMock.mockReset()
  deleteAuthUserMock.mockResolvedValue({ error: null })
  updateAuthUserByIdMock.mockReset()
  updateAuthUserByIdMock.mockResolvedValue({ error: null })
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
    resetDb()
    resetMocks()
    seed({ profiles: profileRows })
  })

  it("clamps page=0 to 1", async () => {
    const adminSession = createAdminSession()
    const { listPaginatedUsers } = await loadUsersModules()

    const result = await listPaginatedUsers(adminSession, { page: 0, limit: 10 })

    expect(result.page).toBe(1)
  })

  it("clamps page=-5 to 1", async () => {
    const adminSession = createAdminSession()
    const { listPaginatedUsers } = await loadUsersModules()

    const result = await listPaginatedUsers(adminSession, { page: -5, limit: 10 })

    expect(result.page).toBe(1)
  })

  it("clamps limit=0 to default and totalPages is not Infinity", async () => {
    const adminSession = createAdminSession()
    const { listPaginatedUsers } = await loadUsersModules()

    const result = await listPaginatedUsers(adminSession, { page: 1, limit: 0 })

    expect(result.limit).toBeGreaterThanOrEqual(1)
    expect(Number.isFinite(result.totalPages)).toBe(true)
  })

  it("clamps limit=-10 to 1", async () => {
    const adminSession = createAdminSession()
    const { listPaginatedUsers } = await loadUsersModules()

    const result = await listPaginatedUsers(adminSession, { page: 1, limit: -10 })

    expect(result.limit).toBe(1)
  })

  it("clamps limit=200 to 100", async () => {
    const adminSession = createAdminSession()
    const { listPaginatedUsers } = await loadUsersModules()

    const result = await listPaginatedUsers(adminSession, { page: 1, limit: 200 })

    expect(result.limit).toBe(100)
  })

  it("returns limit=50 as-is when within bounds", async () => {
    const adminSession = createAdminSession()
    const { listPaginatedUsers } = await loadUsersModules()

    const result = await listPaginatedUsers(adminSession, { page: 1, limit: 50 })

    expect(result.limit).toBe(50)
  })

  it("filters by memberNumber substring case-insensitively", async () => {
    const adminSession = createAdminSession()
    const { listPaginatedUsers } = await loadUsersModules()

    const result = await listPaginatedUsers(adminSession, { page: 1, limit: 10, search: "ADMIN" })

    expect(result.data).toHaveLength(1)
    expect(result.data[0]?.id).toBe("1")
  })

  it("filters by memberNumber substring", async () => {
    const adminSession = createAdminSession()
    const filtered = profileRows.filter((r) => r.memberNumber.includes("100002"))
    const { listPaginatedUsers } = await loadUsersModules()

    const result = await listPaginatedUsers(adminSession, { page: 1, limit: 10, search: "100002" })

    expect(result.data.length).toBeGreaterThan(0)
    // KIM-440 Finding C: total must reflect the real count() aggregate over
    // the same filter, not just however many rows the row-select query
    // happened to return -- a service bug that returns data.length as total
    // must fail this assertion.
    expect(result.total).toBe(filtered.length)
  })

  it("filters by full name substring", async () => {
    const adminSession = createAdminSession()
    const { listPaginatedUsers } = await loadUsersModules()

    const result = await listPaginatedUsers(adminSession, { page: 1, limit: 10, search: "member user" })

    expect(result.data).toHaveLength(1)
    expect(result.data[0]?.id).toBe("2")
    expect(result.total).toBe(1)
  })

  it("filters by email substring", async () => {
    const adminSession = createAdminSession()
    const { listPaginatedUsers } = await loadUsersModules()

    const result = await listPaginatedUsers(adminSession, { page: 1, limit: 10, search: "admin@alea.club" })

    expect(result.data).toHaveLength(1)
    expect(result.data[0]?.id).toBe("1")
    expect(result.total).toBe(1)
  })

  it("returns all users when search is empty", async () => {
    const adminSession = createAdminSession()
    const { listPaginatedUsers } = await loadUsersModules()

    const all = await listPaginatedUsers(adminSession, { page: 1, limit: 100 })
    const withEmpty = await listPaginatedUsers(adminSession, { page: 1, limit: 100, search: "" })

    expect(withEmpty.total).toBe(all.total)
    expect(all.total).toBe(profileRows.length)
  })

  it("does not filter out suspended users from the admin listing", async () => {
    const adminSession = createAdminSession()
    const { listPaginatedUsers } = await loadUsersModules()

    const result = await listPaginatedUsers(adminSession, { page: 1, limit: 10 })

    expect(result.data.some((u) => u.id === "2")).toBe(true)
  })

  // KIM-440 Finding C: with the legacy mock previously resolving the same
  // response for both the row query and the count query, countRows[0]?.value
  // was always undefined (a row object has no value key) and silently
  // coerced to 0 by ?? 0 -- so data.length > 0 and total === 0 could coexist
  // in every test above without any assertion ever catching it. This test
  // pins that exact combination down directly, driven by the real, separate
  // select() and select({ value: count() }) queries against seeded rows
  // (not stubbed responses), so a regression that conflates them again is
  // caught here.
  it("reports a total independent of and consistent with the returned page of data", async () => {
    const adminSession = createAdminSession()
    const { listPaginatedUsers } = await loadUsersModules()

    const result = await listPaginatedUsers(adminSession, { page: 1, limit: 1 })

    expect(result.data).toHaveLength(1)
    expect(result.total).toBe(2)
    expect(result.totalPages).toBe(2)
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
    resetDb()
    resetMocks()
  })

  it("returns the updated public user payload for the correct user id", async () => {
    seed({ profiles: profileRows })
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
    seed({ profiles: profileRows })
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
    seed({ profiles: profileRows })
    const adminSession = createAdminSession()
    const { updateUser } = await loadUsersModules()

    await expect(updateUser(adminSession, "1", { memberNumber: "0" })).resolves.toBeDefined()
  })

  it("accepts is_active boolean and includes it in the update", async () => {
    seed({ profiles: profileRows })
    const adminSession = createAdminSession()
    const { updateUser } = await loadUsersModules()

    await updateUser(adminSession, "1", { is_active: false })

    const row = getRows(profiles).find((r) => r.id === "1")
    expect(row?.isActive).toBe(false)
  })

  it("accepts fullName, email, and phone updates", async () => {
    seed({ profiles: profileRows })
    const adminSession = createAdminSession()
    const { updateUser } = await loadUsersModules()

    await updateUser(adminSession, "1", { fullName: "Updated User", email: "updated@alea.club", phone: "699000111" })

    const row = getRows(profiles).find((r) => r.id === "1")
    expect(row).toMatchObject({
      fullName: "Updated User",
      email: "updated@alea.club",
      phone: "699000111",
    })
  })

  it("keeps internal auth email aligned when memberNumber changes", async () => {
    seed({ profiles: profileRows })
    const adminSession = createAdminSession()
    const { updateUser } = await loadUsersModules()

    await updateUser(adminSession, "1", { memberNumber: "100123" })

    const row = getRows(profiles).find((r) => r.id === "1")
    expect(row?.memberNumber).toBe("100123")
    expect(row?.authEmail).toBe("100123@members.alea.internal")
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
    resetDb()
    resetMocks()
  })

  it("deletes the auth user after confirming the profile exists", async () => {
    seed({ profiles: profileRows })
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
    resetDb()
    resetMocks()
  })

  it("sets no_show_count=0 and blocked_until=null for the user", async () => {
    seed({
      profiles: [{ ...adminProfile, id: "user-123", noShowCount: 5, blockedUntil: new Date("2026-05-01T00:00:00.000Z") }],
    })
    const adminSession = createAdminSession()
    const { resetNoShows } = await loadUsersModules()

    await resetNoShows(adminSession, "user-123")

    const row = getRows(profiles).find((r) => r.id === "user-123")
    expect(row?.noShowCount).toBe(0)
    expect(row?.blockedUntil).toBeNull()
  })

  it("throws a service error when update fails", async () => {
    seed({ profiles: [{ ...adminProfile, id: "user-123" }] })
    failNextQuery({ op: "update", table: profiles })
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
    resetDb()
    resetMocks()
  })

  it("sets blocked_until=null for the user", async () => {
    seed({
      profiles: [{ ...adminProfile, id: "user-456", blockedUntil: new Date("2026-05-01T00:00:00.000Z") }],
    })
    const adminSession = createAdminSession()
    const { unblockUser } = await loadUsersModules()

    await unblockUser(adminSession, "user-456")

    const row = getRows(profiles).find((r) => r.id === "user-456")
    expect(row?.blockedUntil).toBeNull()
  })

  it("throws a service error when update fails", async () => {
    seed({ profiles: [{ ...adminProfile, id: "user-456" }] })
    failNextQuery({ op: "update", table: profiles })
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
