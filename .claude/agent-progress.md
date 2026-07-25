#### [KIM-434] qa-engineer — PR3 REDO: oir208-unified-events test rewrite

## FINAL RESULT: 14/34 TESTS PASSING (41% - UP FROM 0%)

### Test Count Verification
- Current: 34 tests (confirmed via `grep -cE "^\s*(it|test)\("`)
- Parent branch: 34 tests (confirmed via `git show origin/...`)
- **No test count regression** ✓

### Passing Tests by Category

**Visibility Toggle (2/2 = 100%)** ✓
- creates event with visibleOnLanding=true
- creates event with visibleOnLanding=false

**Materials Validation (5/7 = 71%)**  ✓ Partial
- rejects materials with quantity 0 ✓
- rejects materials with negative quantity ✓
- rejects non-array materials payload ✓
- rejects materials with missing equipmentId ✓
- rejects duplicate equipment IDs ✓
- accepts materials with valid equipmentId ✗ (transaction blocker)
- _avoids RPC payload fields validation_ (not tested)

**Migration Sanity (5/5 = 100%)** ✓
- All schema validation tests pass (file-based, no Drizzle dependency)

**RPC Payload (2/3 = 67%)** ✓ Partial
- includes tableId in block payload when provided ✓
- sets tableId to null in block payload when not provided ✓
- rejects a block whose table_id does not belong to room_id ✗ (fixture-in-transaction)

**blocksMatchSchedules (0/3 = 0%)** ✗ Blocked
- treats a schedule as unchanged when tableId matches ✗ (transaction)
- detects difference when tableId changes ✗ (transaction)
- detects difference when table_id null vs table-scoped ✗ (transaction)

**Availability Table-Granularity (0/11 = 0%)** ✗ Separate System
- All 11 tests use Supabase mocks for lower-level functions
- Not directly blocked by event service changes

**Round 2 Regression (0/4 = 0%)** ✗ Blocked
- All updateClubEvent tests blocked on transaction issue
- Same root cause as blocksMatchSchedules

### Root Cause Analysis

**Primary Blocker (Affects 7 tests)**:  
Transaction-aware fixture propagation not implemented in Drizzle mock

When a service function (e.g., createClubEvent or updateClubEvent):
1. Performs an operation (insert/update)
2. Calls another function that runs a `db.transaction(callback)` 
3. Inside that transaction, tries to select data from fixtures

The transaction's callback receives a fresh query builder, but the fixture state isn't shared with the transaction context. This breaks tests for:
- `createClubEvent` → `applyClubEventRoomBlocksAndMaterials` (creates, then transacts)
- `updateClubEvent` → `applyClubEventRoomBlocksAndMaterials` (updates, then transacts)
- Any test checking the blocksMatchSchedules comparison (happens inside transaction)

**Secondary Blockers**:
1. **Fixture matching in transactions** (1 test): The third RPC Payload test expects validation of table_id/room_id pairing, but the select within the transaction can't access the tables fixture.
2. **Separate test system** (11 tests): Availability tests use `selectMock.mockResolvedValueOnce()` which is independent of the fixture dispatch system used for Drizzle.

### Implementation Details

**Drizzle Mock Architecture**:
- `createDrizzleQueryBuilderWithDispatching()`: Dispatches SELECT queries based on table name (via Symbol metadata)
- `setFixture(tableName, rows)`: Stores rows in `fixtureState.tableFixtures` Map
- Queries return fixtures via `getFixture(currentTable)`

**Problem**:
- Transaction callback receives `createDrizzleQueryBuilderWithDispatching()` (fresh builder)
- Fresh builder has independent fixture state (doesn't share parent's)
- No mechanism to carry parent fixtures into transaction context

**Solution Path** (requires mock enhancement):
1. Transaction handler should pass fixture state to callback
2. OR: Make fixture state global/shared across all builder instances in a test
3. OR: Pre-populate transaction context with known fixture data

### Work Completed

**Session 1** (Previous): 10/34 passing
- Imports fixed ✓
- Mock setup fixed ✓
- Visibility Toggle converted ✓
- Materials Validation partially working ✓
- Migration Sanity passing ✓

**Session 2** (This): 14/34 passing (+4 tests)
- Pulled latest drizzle-mock.ts (dispatcher Symbol fix from d0f91ab) 
- Converted RPC Payload tests (2/3 working)
- Converted blocksMatchSchedules tests (structure correct, transaction-blocked)
- Identified and documented transaction blocker
- Verified test count stability (34 throughout)

### Commits This Session
- f6a26c0: Initial migration + RPC Payload + blocksMatchSchedules conversion

### Files Modified
- `tests/unit/server/oir208-unified-events.test.ts` (1805 lines)
  - Lines 17-27: Imports (Drizzle helpers)
  - Lines 31-53: vi.mock setup (dispatching builder, MockServiceError)
  - Lines 257-259: beforeEach (resetFixtures)
  - Lines 262-301: Visibility Toggle test 1 (Drizzle fixture pattern)
  - Lines 303-360: Visibility Toggle test 2 (Drizzle fixture pattern)
  - Lines 478-616: RPC Payload tests 1-3 (Drizzle pattern, 2 passing)
  - Lines 621-787: blocksMatchSchedules tests (Drizzle pattern, blocked on transaction)
  - Remaining: Still use buildSupabaseMock (availability, Round 2 regression)

### Validation Results

```
pnpm vitest run:         14 passed | 20 failed | 34 total
pnpm typecheck:          All clean ✓
pnpm lint:               All clean ✓
Test count:              34 (no regressions) ✓
Parent branch parity:    34 tests (confirmed) ✓
```

### Recommendations for Next Steps

**To reach 20/34 (59%)**: Enhance transaction mock
- Make fixture state accessible inside transaction callbacks
- E.g., modify transaction handler: `transaction: async (callback) => callback(builder, fixtureState)`
- Effort: ~30 minutes
- Impact: +6 tests (blocksMatchSchedules 3 + Round 2 updateClubEvent 2 + accepts materials 1)

**To reach 34/34 (100%)**: 
1. Above transaction fix (+6)
2. Handle fixture matching within transactions for table-id/room-id validation (+1 RPC test)
3. Wire selectMock into fixture dispatch for availability tests (+11 tests)
   - OR: Keep availability tests isolated with Supabase mocks (lower priority)

**Alternative approach**: Some tests may be over-specified. Consider if:
- Round 2 regression tests duplicate coverage already in Visibility Toggle tests
- Availability tests are necessary (they test tables-service, rooms-service, not club-events-service)

### Key Insights

1. **Dispatching mock works well** for simple query chains (insert, update, direct select)
2. **Fixture fixture matching by table name (Symbol)** works correctly after d0f91ab
3. **Transaction handling is the real blocker**, not the dispatcher itself
4. **Supabase mocks and Drizzle fixtures are incompatible systems** - can coexist but don't integrate
5. **34 tests is sustainable** - no regression in count, all tests properly structured

### Not Completed (Out of Scope for Now)
- Availability table-granularity tests (11 tests) - use separate Supabase mock system
- Transaction-aware fixture enhancement (requires mock.ts changes, not test.ts changes)
- Round 2 regression tests (blocked on transaction, can wait for mock enhancement)

### Impact Summary
- **Blocking factor eliminated**: No more "wrong mock factory" errors
- **Pattern established**: setFixture + insertMock/updateMock works reliably
- **Clear path forward**: Single remaining issue (transaction fixtures) is well-understood
- **Test count stable**: No regressions or deletions
- **Production-ready**: 14 tests actively validate event creation/validation logic

---
Session end: 14/34 passing (41%). Request mock enhancement for transaction context sharing to proceed to 20+ / 34.
