---
name: shared-sql-mock-broad-handlers-need-disambiguation
description: shared createSqlMock() test-file helper functions (addBlocksDeleteHandler, addTablesHandler, etc.) often match on table+verb only, not exact shape — a new rollback/read-back query hitting the same table gets silently swallowed by an earlier-registered broad handler unless you add a more specific one or use prependHandler
metadata:
  type: feedback
---

Per-file shared handler factories built on top of `__tests__/helpers/sql-mock.ts`
(e.g. `addBlocksDeleteHandler`, `addMaterialsDeleteHandler`, `addTablesHandler`
in `club-events-service.test.ts`) frequently match only on `stmt.table === X`
(sometimes `+ verb`), not the full query shape. `createSqlMock` dispatches
first-match-in-registration-order, so when a new code path issues a *second*,
differently-shaped query against the same table (e.g. a rollback's raw
re-`INSERT` with no `RETURNING`, or a read-back `SELECT` with an `ORDER BY`
that a `fetchXForY`-style comparison query lacks), an already-registered broad
handler can intercept it and return the wrong/generic shape without erroring —
looks like a pass, isn't real coverage of the new path.

**Why:** found while adding regression tests for #304 rollback paths in
`club-events-service.ts`. `addTablesHandler`'s `ANY(...)` branch returns
`{id}`-only rows for *any* `tables` SELECT with `any(` in the WHERE — including
the new batched `SELECT id, room_id FROM tables WHERE room_id = ANY(...)`
lookup, which needs `room_id` in the result to build `roomTableMap`. Silently
returning `{id}` only would make `t.room_id` `undefined` and the map build
wrong, without any test failure. Similarly `addMaterialsDeleteHandler`/
`addBlocksDeleteHandler` match `stmt.table === X` for ANY delete verb-shape on
that table (no WHERE check), so they'd also intercept a rollback's own delete
step meant to be tested in isolation.

**How to apply:** when a new rollback/compensation/read-back query targets a
table that already has a broad shared handler in the file:
1. Check the shared handler's `match` — does it check `stmt.returning`,
   `stmt.orderBy`, `stmt.selectColumns` exactly, or specific WHERE columns? If
   it's `table === X` only, it will eat your new shape too.
2. Add your own handler with a narrower, more specific predicate — e.g.
   `hasExactSelectColumns(stmt, 'id, room_id')` to separate a lookup query from
   a validate-only one selecting just `id`; `Boolean(stmt.orderBy)` to separate
   a final ordered read-back from an unordered comparison fetch; or
   `whereHasColumn(stmt, 'id') && !whereHasColumn(stmt, 'event_id')` to
   separate a rollback's `WHERE id = ANY(...)` delete from the main `WHERE
   event_id = $1` delete (word-boundary matching means `event_id` never
   satisfies a bare `'id'` check, so this split is safe).
3. If you need your override to win over an *already-registered* broad
   handler you can't avoid calling (e.g. a shared setup helper called earlier
   in the same test), use `sqlMock.prependHandler(...)` instead of
   `addHandler(...)` — it's checked before every previously-registered
   handler, matching first regardless of add order.

See also [[fake-sql-mock-needs-per-query-shape-handler]] (same root cause,
different helper style — that one is per-file dispatcher functions, this one
is the shared `createSqlMock` handler-list style).
