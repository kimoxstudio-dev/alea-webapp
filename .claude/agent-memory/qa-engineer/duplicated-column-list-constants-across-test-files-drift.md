---
name: duplicated-column-list-constants-across-test-files-drift
description: a RETURNING/SELECT column-list constant mirrored into a test file (not imported from source) silently drifts when the source list changes, breaking exact-match sql-mock handlers
metadata:
  type: feedback
---

When a test file hardcodes its own copy of a service's SQL column list
(e.g. `const ADMIN_RETURNING_COLUMNS = 'id, title_es, ...'` mirroring
`ADMIN_CLUB_EVENT_RETURNING` in the service file, used for
`hasExactSelectColumns` matching in a `createSqlMock` handler), any later
change to the *source's* column list silently desyncs the mock — the
handler's exact-match stops firing, and the query falls through to
`sql-mock`'s "no handler matched" error, which callers usually catch
generically and turn into an unrelated 500.

**Compounding trap:** a service can have MULTIPLE, independently-evolving
column lists that happen to start out looking similar (e.g.
`ADMIN_CLUB_EVENT_RETURNING` used by create/update RETURNING + a
current-row fetch, vs. a separate literal SELECT in a list-all function
that was never built from that shared constant). A fix that adds a column
to one does NOT necessarily add it to the other — mirroring "the" admin
column list into a single test constant and reusing it for every matching
handler will break the ones tied to the query that *wasn't* touched.

**Why:** discovered 2026-08-31 during #304 follow-up — a software-engineer
fix added a `title` column to `ADMIN_CLUB_EVENT_RETURNING` (fixing a real
`titleEs` fallback bug), which broke 14 `updateClubEvent`/current-row tests
whose mock matched the OLD column list, but also revealed that
`listAdminClubEvents`'s own separate literal SELECT was untouched by the
same fix — reusing one constant for both would have masked that distinction
instead of catching it.

**How to apply:**
- After any service-layer fix that touches a SELECT/RETURNING column list,
  grep the test file(s) for a duplicated constant of that list and check
  whether it needs updating — don't assume "tests still pass" means nothing
  changed; run them.
- If a service has multiple textually-similar-but-independent column lists
  (shared constant vs. one-off literal query), give the test mock a
  *separate* constant per actual query shape rather than reusing one,
  named after which specific query it matches — reduces the chance a future
  source-side change to one gets silently applied to both in the mock.
- When a previously-green suite starts failing right after an unrelated
  service fix lands, check first whether a test-side duplicated
  column/schema constant just went stale — this is often faster to diagnose
  than assuming the fix itself introduced a new regression.
