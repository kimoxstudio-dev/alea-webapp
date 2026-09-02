---
name: shared-sql-mock-helper-needs-unsafe-support
description: __tests__/helpers/sql-mock.ts createSqlMock() didn't implement sql.unsafe() until #348 — any source file using sql.unsafe(...) for a shared column list will 500 on every query through it until the helper is extended
metadata:
  type: feedback
---

The shared raw-SQL mock helper (`__tests__/helpers/sql-mock.ts`, used across
reservations/tables/rooms/equipment service tests, see
[[fake-sql-mock-needs-per-query-shape-handler]] for the sibling per-file
dispatcher pattern) mocks `sql` as a plain `vi.fn()` tagged-template
function. Before #348, it had no `.unsafe()` method at all.

When `lib/server/reservations-service.ts` reintroduced a shared
`RESERVATION_COLUMNS` constant referenced via `sql.unsafe(RESERVATION_COLUMNS)`
inside ~10 query call sites, every one of those calls threw
`sql.unsafe is not a function` at runtime. Because every one of those calls
sits inside a `try { ... } catch { serviceError('Internal server error', 500) }`
block in the source, the failure surfaced as a **500 in nearly every test in
the file** (83 of 139 failed) rather than a clear "unsafe is not a function"
error — the try/catch swallowed the real cause. The fix was two-part in
`parseStatement`/`createSqlMock`: (1) add `sql.unsafe = (text) => ({ marker,
text })` returning a tagged raw-fragment object, (2) in the template-string
rebuild loop, inline that fragment's text literally instead of numbering it
as a `$N` bound parameter (mirrors the real Neon driver's semantics) and
exclude it from the returned `values` array so existing bound-value-index
assertions in other test files keep working unchanged.

**Why:** a swallowed `TypeError` masquerading as a generic 500 across
dozens of unrelated-looking test failures is exactly the kind of "test
infra broken, not test wrong" trap this shared helper exists to prevent —
except this one wasn't yet covered because no consumer had used
`sql.unsafe()` before.

**How to apply:** when a source file introduces `sql.unsafe(...)` for the
first time (grep `sql\.unsafe\(` across `lib/server/*.ts` to check), verify
`__tests__/helpers/sql-mock.ts` already exports a working `.unsafe()` off
the mock's `sql` before writing/fixing tests against it — if a mass of
failures all point back to one `catch { serviceError(..., 500) }` site
regardless of which query ran, suspect a missing method on the mock itself,
not per-test mock data.
