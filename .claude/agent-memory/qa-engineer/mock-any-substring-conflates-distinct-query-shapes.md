---
name: mock-any-substring-conflates-distinct-query-shapes
description: a sql-mock handler dispatching on a shared `any(` substring silently conflates two distinct queries against the same table once production code adds a second `= ANY(...)` shape
metadata:
  type: feedback
---

When a table has more than one `SELECT ... WHERE col = ANY(...)` query shape (e.g. `SELECT id FROM tables WHERE id = ANY(...)` vs `SELECT id, room_id FROM tables WHERE room_id = ANY(...)`), a mock handler that dispatches on `stmt.whereClause?.includes('any(')` treats them as the same case and returns the wrong row shape (e.g. bare `{ id }` when the caller needs `{ id, room_id }`). This is the same class of trap as [[sql-mock-substring-dispatch-trap]] and [[fake-sql-mock-needs-per-query-shape-handler]] but specifically bites when a new query is added that reuses `= ANY(...)` syntax — the existing handler doesn't error, it just returns rows shaped for the *other* query, causing whatever Map/lookup the production code builds from those rows to silently drop the field it needed (e.g. `room_id` missing → mismatch-guard logic breaks).

**Why:** hit in PR #354 (issue #304, club-events-service Neon migration) — production code folded a per-block table/room mismatch guard into an existing batched `roomTableMap` query, adding a *second* `tables` query (`SELECT id, room_id FROM tables WHERE room_id = ANY(...)`) alongside the pre-existing `validateTablesExist` query (`SELECT id FROM tables WHERE id = ANY(...)`). The test file's `addTablesHandler()` mock had one handler keyed on `any(` substring returning `{ id }` only, silently starving the new `tableRoomMap` of `room_id` and failing 3 tests with false 400s.

**How to apply:** when a mock handler's `match` predicate is a loose substring check like `.includes('any(')`, and production code gains a new query against the same table using `= ANY(...)`, split the handler using `hasExactSelectColumns(stmt, '<exact column list>')` (from `__tests__/helpers/sql-mock.ts`) to disambiguate by the SELECT projection instead of the WHERE-clause substring. Grep the production file directly for `FROM <table>` to enumerate every remaining query shape before touching the mock — don't assume the old handler's shapes are still exhaustive after a refactor that folds/removes queries.
