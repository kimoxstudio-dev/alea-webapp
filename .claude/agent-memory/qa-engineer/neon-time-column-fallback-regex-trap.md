---
name: neon-time-column-fallback-regex-trap
description: When a migrated service falls back to a raw DB row's own time/date column value instead of a fresh user input, check the column's real wire format (HH:MM:SS for Postgres `time`) against any strict regex validator applied to it
metadata:
  type: project
---

Found in #303 (events-service.ts Neon migration): `updateEvent`'s legacy
single-block path falls back to `currentRow.start_time`/`currentRow.end_time`
(raw Postgres `time without time zone` values, which come back from Neon's
driver as `'HH:MM:SS'` strings) when the caller's body omits `startTime`/
`endTime`. That value is then re-validated through `validateDateTimeFields`'s
`TIME_RE` regex, which requires strict `HH:MM` (no seconds) — so it 400s on
every partial update that doesn't resupply both times explicitly (title-only
update, roomId-only update, etc).

**Why this happened:** the pre-migration code was a Postgres RPC
(`update_event_atomic`) that used `COALESCE(p_start_time, existing.start_time)`
entirely inside SQL — the existing column value was never round-tripped back
through JS input-validation regexes. Inlining that RPC into sequential JS
`sql` statements (the established pattern for this migration, see
[[fix-findings-dont-file-issues]]-adjacent sibling services) introduced a
re-validation step that didn't exist before, and nobody sliced the fetched
value to `HH:MM` before feeding it back into the same validator used for
fresh user input.

**How to apply:** whenever reviewing/testing a migrated service function that
reads a "current row" and falls back to one of its own time/date columns as
a default for an omitted user-supplied field elsewhere in the same function,
use realistic Postgres wire-format values in the mock (`'18:00:00'` for
`time`, not `'18:00'`) — not the JS-input-shaped format. A test built with
already-sliced `HH:MM` mock data will pass and hide exactly this class of
regression. Only real Postgres formats expose it.

See also [[fake-sql-mock-needs-per-query-shape-handler]] and
[[sql-mock-substring-dispatch-trap]] for the general "mock shape must match
real DB output shape" discipline this is one instance of.
