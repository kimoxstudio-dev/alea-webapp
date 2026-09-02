---
name: room-table-map-query-needs-priority-over-broad-tables-handler
description: club-events-service test files' addTablesHandler() registers a handler matching ANY select on 'tables' (no column check) — it must be registered AFTER (not before) a narrower handler for the exact-column `SELECT id, room_id FROM tables WHERE room_id = ANY(...)` batched roomTableMap query, or it silently swallows that query and returns {id}-only rows
metadata:
  type: feedback
---

Both `club-events-service.test.ts` and `oir208-unified-events.test.ts` define an
`addTablesHandler()` whose `match` is just `stmt.table === 'tables'` — no
`hasExactSelectColumns` check — so it matches EVERY select against `tables`,
including the batched `SELECT id, room_id FROM tables WHERE room_id =
ANY(...)` query that builds `roomTableMap`/`tableRoomMap` in
`applyClubEventBlocksAndMaterials`. `oir208-unified-events.test.ts`'s version
was later hardened to register two separate handlers with exact-column
checks (`hasExactSelectColumns(stmt, 'id')` vs `'id, room_id'`) — but
`club-events-service.test.ts`'s `addTablesHandler` was never updated the same
way, so its broad match still wins whenever a test registers a narrower
custom handler for the room->table query.

**Symptom:** calling `addTablesHandler()` BEFORE registering your own
`SELECT id, room_id FROM tables` handler (inline or via
`addCascadeTablesFetchHandler`) makes `addTablesHandler`'s broad handler
match first (first-match-in-registration-order). It then returns `{id}`-only
rows (using its `ids.filter(...).map(id => ({id}))` shape, built from
whatever `stmt.values[0]` is — here the ROOM ids, not table ids), so
`roomTableMap`/`tableRoomMap` get built with `t.room_id === undefined`. Any
block with a non-null `table_id` then fails the table_id/room_id mismatch
guard with `ServiceError('Invalid event data', 400)`, or (if the guard isn't
hit) `roomTableMap.get(roomId)` silently returns `[]`/wrong data, keeping
whatever depends on it (saved-games cancellation, reservation cancellation
table scoping) empty without any error.

**Why:** found in #334 (saved-games event-block cancellation tests) — new
tests passed a `table_id` in the schedule and registered
`addCascadeTablesFetchHandler([...2 tables...])` AFTER `addTablesHandler()`,
which threw "Invalid event data" instead of exercising room-wide
cancellation. Same root cause as [[shared-sql-mock-broad-handlers-need-disambiguation]].

**How to apply:** in `club-events-service.test.ts` specifically, always
register the room->table map handler (`addCascadeTablesFetchHandler(...)` or
an inline `hasExactSelectColumns(stmt, 'id, room_id')` handler) BEFORE
calling `addTablesHandler()` in the same test. Order matters here because
`addTablesHandler`'s match has no column-list narrowing (unlike the
`oir208-unified-events.test.ts` version, which is already safe either way).
Consider hardening `club-events-service.test.ts`'s `addTablesHandler` to
match `oir208-unified-events.test.ts`'s exact-column-split version in a
future round, to remove this ordering trap entirely.
