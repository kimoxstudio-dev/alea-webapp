---
name: fake-sql-mock-needs-per-query-shape-handler
description: createFakeSql-style dispatchers (apply-neon-schema.test.ts and similar) throw on unmatched query text by design — but only if every new query shape a source change introduces gets its own explicit handler branch added first
metadata:
  type: feedback
---

When a source script (e.g. `scripts/apply-neon-schema.mjs`) adds a new SQL
statement shape (a new `DELETE`/`UPDATE`/etc query text), the file's own
`createFakeSql`-style dispatcher (in `__tests__/scripts/apply-neon-schema.test.ts`)
does NOT automatically handle it — it throws `no handler matched query` unless a
matching `text.includes(...)` branch is added. This is by design (mirrors
[[sql-mock-substring-dispatch-trap]]'s "no silent empty-array fallback" rule) and
is the correct trap-avoidance behavior, not a bug — but it means writing new
tests for a new query shape is a two-step job: (1) add the dispatcher branch
matching the new query text/params shape, (2) write the test. Skipping step 1
makes the new test fail loudly (good, not a false green) but the failure looks
like "test infra broken" rather than "test wrong" if you don't expect it.

**Why:** found while adding regression tests for PR #338 Findings 1/2 —
`assertExpectedTablesArePresent`'s reused `pg_tables` query was already
handled (shared helper `fetchPublicTableNames`), but the new
`DELETE FROM "schema_migrations" WHERE "filename" = $1` query (from the
`--allow-removed` bypass path) had no handler yet. Since this dispatcher is
defined inside the test file itself (not an external shared helper under
`__tests__/helpers/`), qa-engineer owns and edits it directly — it is not a
production file boundary violation.

**How to apply:** before writing assertions for a new code path in
`apply-neon-schema.mjs` (or any script using this same query-dispatcher test
pattern), read the source to find every new `sql.query(...)`/`txn.query(...)`
call it introduces, and check `createFakeSql`'s `respond()` function already
has a matching branch. If not, add one that returns a realistic, correctly
keyed result — never a blind `[]` "to make it pass" without checking the
caller doesn't depend on the return shape.
