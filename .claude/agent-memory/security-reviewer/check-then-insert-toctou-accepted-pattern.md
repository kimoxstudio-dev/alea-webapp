---
name: check-then-insert-toctou-accepted-pattern
description: Cross-table check-then-insert TOCTOU races in Neon-migrated services are an accepted repo-wide tradeoff, not a per-PR blocking finding — confirmed during PR #301 (saved-games-service) review.
metadata:
  type: project
---

Every Neon-migrated service in this repo (`lib/server/*-service.ts` via
`lib/db/client.ts`'s `sql`) runs application-layer "SELECT to check a
cross-table/cross-row invariant, then INSERT" instead of a real transaction,
because the Neon HTTP driver can't atomically combine a read that branches
logic with a following write. This creates an inherent TOCTOU race window:
two concurrent requests can each pass the check before either write commits.

**Confirmed instances already merged and accepted:**
- `assertTableAndEventAvailability` (saved-games-service.ts) — checks
  `event_room_blocks` before insert, no DB-level backstop.
- `hasSavedGameBottomConflict` (reservations-service.ts, PR #300) — checks
  `saved_games` before inserting a bottom reservation, no DB-level backstop.
- `assertNoBottomReservationConflict` (saved-games-service.ts, PR #301 fix
  round 2) — the reverse-direction check added to close the one-way gap a
  `/code-review` high pass found; same TOCTOU shape as the two above.

**Decision (PR #301, 2026-08-31):** a `/code-review` medium pass flagged
this race on `assertNoBottomReservationConflict` specifically. Treated as
NOT blocking — same architectural tradeoff already accepted for its two
siblings above, not a new class of risk introduced by that PR. Closing it
fully would require either a DB trigger (explicitly out of scope for the
Neon migration per `lib/db/schema/014_saved_games.sql`'s doc comment) or a
genuine cross-table Postgres `EXCLUDE` constraint (not feasible — `EXCLUDE`
is single-table only).

**How to apply next time:** when `/code-review` flags a TOCTOU race in a
check-then-insert pattern in a Neon-migrated service, first check whether an
equivalent unenforced race already exists elsewhere in the same file or in a
sibling already-merged service performing the mirror-direction check. If so,
it's the same accepted tradeoff — don't re-block on it, just note it for
visibility. Only escalate to blocking if: (a) the write is protected by a
real DB constraint elsewhere in the codebase and this instance uniquely
lacks it (an actual regression, not a shared limitation), or (b) the race
window has materially higher blast radius than the accepted instances (e.g.
financial/irreversible side effects, not a 409 conflict a user can retry).

This is a narrower, complementary case to [[compensating-rollback-review-checklist]]
(which covers delete/insert-loop compensating-rollback bugs, a different
non-atomicity shape) — both stem from the same root cause (no real
`sql.transaction()` across branching multi-step writes) but need different
review checklists.
