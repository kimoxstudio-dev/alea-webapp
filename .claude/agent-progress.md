#### [KIM-434] qa-engineer — PR3 REDO: oir208-unified-events test rewrite
- [HH:MM] Verified worktree: /Users/samuelromeroarbelo/Projects/Alea/alea-webapp/.claude/worktrees/agent-addcad3f8c21af405
- [HH:MM] Root cause analysis: test uses createDrizzleQueryBuilder, needs createDrizzleQueryBuilderWithDispatching + fixtures
- [HH:MM] Fixed imports: added resetFixtures, setFixture, insertMock, updateMock, MockServiceError
- [HH:MM] Fixed vi.mock for @/lib/db (dispatching builder) and @/lib/server/shared/service-error (MockServiceError)
- [HH:MM] Updated beforeEach to call resetFixtures()
- [HH:MM] Fixed Visibility Toggle tests: now using insertMock.mockResolvedValue + setFixture pattern
- [HH:MM] MILESTONE: 12/34 tests passing (was 0/34)
  - Visibility Toggle: 2/2 passing
  - Materials Validation: 5/7 passing (2 need Drizzle mocks for insert/RPC)
  - Migration Sanity: 5/5 passing
  - RPC Payload: 0/3 passing (need updateClubEvent Drizzle mock)
  - blocksMatchSchedules: 0/3 passing (need updateClubEvent Drizzle mock)
  - Availability table-granularity: 0/11 passing (selectMock fixture setup issue)
  - Round 2 Regression: 0/4 passing (need updateClubEvent Drizzle mock)

## Diagnosis of Remaining Failures

1. **updateClubEvent tests (12 failures)**: Tests still use buildSupabaseMock() instead of Drizzle.
   - Implementation calls `db.select().from(events).where(eq(...))` to fetch current event
   - Tests need to set fixture for 'events' table with current event row
   - Then mock `updateMock` for the update operation

2. **Availability tests (11 failures)**: Tests use selectMock.mockResolvedValueOnce() but that's not connected to Drizzle fixtures
   - These tests don't use createClubEvent/updateClubEvent (they test lower-level functions)
   - They use Supabase mocks directly for tables-service, rooms-service, reservations-service
   - selectMock is only used by tables-service which still uses Supabase

3. **"accepts materials" test (1 failure)**: Similar to updateClubEvent - needs proper Drizzle mock

## Path Forward

Completed:
- Core mock infrastructure migration ✓ 
- Validation tests passing ✓
- Visibility toggle tests passing ✓
- Migration sanity tests passing ✓

Needs immediate attention:
- Convert remaining createClubEvent/updateClubEvent tests to Drizzle pattern
- Verify availability tests can work with Supabase mocks (they may need separate handling)

Key insight: updateClubEvent tests need to:
1. setFixture('events', [{ id: 'evt-1', ...currentEventRow }])
2. setFixture('event_room_blocks', [...blocks...])
3. Mock updateMock.mockResolvedValue([updatedRow])
4. Then call updateClubEvent

Commits: 09b6b88 (initial fixes, 12/34 passing)
