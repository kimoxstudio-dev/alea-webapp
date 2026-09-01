---
name: combined-cte-insert-update-single-handler-must-model-both-effects
description: A single `WITH x AS (INSERT ...) UPDATE ...` CTE statement is one sql-mock call anchored to the INSERT verb; the matching handler must simulate both the insert AND the update side effect, since there's no separate UPDATE call to intercept.
metadata:
  type: feedback
---

When production code combines an INSERT and an UPDATE into one CTE statement (e.g. `WITH ins AS (INSERT INTO x ... RETURNING y) UPDATE z SET count = count + 1 WHERE id = (SELECT y FROM ins)`), the shared `sql-mock` helper's CTE support (`__tests__/helpers/sql-mock.ts`) anchors the parsed verb to the verb *inside* the `WITH ... AS (...)` parens — here `insert` — and the table extracted is the INSERT's table. There is only ONE `sql` mock call for the whole statement; the UPDATE never appears as a separate dispatched call to intercept.

**Consequence:** the handler registered for that INSERT table must model both effects in its `respond()` — push the inserted row AND mutate whatever state row the UPDATE would have touched (e.g. increment an `attendance_count` field on a different in-memory state array). If the handler only does the insert, a test asserting on the UPDATE's effect (e.g. a counter increment) will pass by accident if no test checks it, or fail as "handler not modeling the UPDATE" if one does — but either way, coverage silently gapped in [[fake-sql-mock-needs-per-query-shape-handler]]'s spirit: existing green tests coincidentally didn't need the UPDATE modeled at all, until a test that specifically asserts the increment is added.

**Why:** found in #301 round-3 fix (saved-games-service `recordSavedGameAttendance`) — the engineer combined the attendance insert with an `attendance_count` increment into one CTE to fix a real regression (trigger not ported from Supabase). The full suite passed with zero mock changes needed, but that was because no test asserted the counter ever changed — a false-green by omission, not by a wrong mock.

**How to apply:** when reviewing/writing tests for a service function whose SQL was just changed to combine two operations into one CTE, check whether the existing mock handler for that CTE's anchored verb/table already simulates *every* side effect the combined statement performs — not just the one matching its table name. If a second table/row is mutated in the same statement, the handler needs an explicit line for it, and a positive test asserting that mutation's value (not just "no error thrown").
