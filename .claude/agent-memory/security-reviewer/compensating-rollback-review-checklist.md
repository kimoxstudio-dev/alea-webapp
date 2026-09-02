---
name: compensating-rollback-review-checklist
description: Checklist for reviewing compensating-rollback (non-transactional multi-step write) logic in Neon-migrated services — this class of bug recurred 4 times across one PR (#304, club-events-service).
metadata:
  type: project
---

Neon's HTTP driver only batches queries built up-front — it can't wrap a
multi-step write that branches on a prior query's runtime result in a real
`sql.transaction()`. Every Neon-migrated service (`events-service.ts` #303,
`club-events-service.ts` #304, and likely more to come) therefore uses
hand-rolled "delete → insert-in-a-loop → compensating rollback on failure"
logic instead of a real transaction. PR #304 (issue #304, PR link #354) went
through 4 medium `/code-review` rounds + 1 high round before this class of
bug stopped appearing, all in the same ~150-line function
(`applyClubEventBlocksAndMaterials`/`rollbackClubEventBlocksWrite`). Concrete
bugs found, in order:

1. Materials rollback re-inserted captured pre-delete rows without first
   removing conflicting rows the current call had already inserted → PK
   violation, silently truncating the rest of the rollback (only
   `console.error`-logged).
2. Materials rollback didn't track/undo **brand-new** inserts (equipment ids
   with no prior row, so absent from the "deleted" capture) at all — those
   survived any rollback unconditionally.
3. One failure branch (a batched lookup query) skipped calling the rollback
   helper entirely — copy-paste-style inconsistency versus sibling branches
   in the same function.
4. The rollback helper itself ran all of its compensating steps in one
   shared `try`, so an early step throwing skipped every later restoration
   step.
5. The final post-write read-back `SELECT` (after all writes had already
   committed successfully) had no differentiated handling — its failure was
   treated as a full write failure by the caller, triggering an unnecessary
   revert of correctly-written data. Fixed with a distinct error class
   (`ClubEventReadBackError`) the caller checks for before reverting.

**How to check next time**, for any file using this compensating-rollback
pattern:
- Does every write-loop failure branch actually call the rollback helper —
  not just some of them? (Bug 3 above was a straight omission.)
- Does the rollback helper's re-insert logic account for **both** "restore a
  row this call deleted" and "undo a row this call newly inserted that has
  no corresponding deleted row"? A rollback that only knows about `deletedX`
  captures will silently leave newly-inserted rows in place (bug 2's shape —
  check for this pattern anywhere a delete-then-insert-loop exists).
- Are the rollback helper's own compensating steps independent of each
  other (each own try/catch, log-and-continue) rather than one shared `try`
  that lets an early failure abort every later restoration step (bug 4)?
- Is a failure that happens **after** all writes already committed (e.g. a
  final confirmation read) distinguished from a failure **during** the
  writes themselves? Reverting on the former actively corrupts otherwise-
  correct data (bug 5's shape).
- The generic non-transactional-write **race window** (a block briefly
  unblocked mid-write, so a concurrent reservation could slip through
  uncancelled) is a known, already-accepted, documented architectural
  tradeoff shared across every Neon-migrated service in this style
  (see the file's own doc comment referencing `sql.transaction()`
  limitations) — do NOT re-flag it as a new defect per-PR; it's an
  intentional scope boundary of the whole migration, not a regression.

See also [[apply-neon-schema-review-patterns]] — same underlying class
(non-atomic writes / check-ordering) recurring in a different file
(`scripts/apply-neon-schema.mjs`). This confirms it's a repo-wide pattern to
watch for in any hand-rolled multi-step write, not specific to one file.
