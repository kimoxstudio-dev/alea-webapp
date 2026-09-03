# Alea — Reservation E2E Runners

Standalone Node.js/Playwright scripts that validate the reservation system end-to-end against a running dev server. They are **not** picked up by Vitest (which only scans `__tests__/**`).

---

## Prerequisites

### 1. Install dependencies

The runners need `playwright`, `dotenv`, and `@neondatabase/serverless`. Install them locally in this directory or use the repo devDependencies:

```bash
# From repo root (if these are already devDeps):
pnpm install

# Or install locally inside qa/e2e/:
cd qa/e2e
npm install playwright dotenv @neondatabase/serverless
npx playwright install chromium
```

### 2. Environment variables

Create a dedicated `.env.e2e.local` at the **repo root**. The runners intentionally do not load the app's `.env.local` because they perform privileged fixture writes and deletes.

| Variable | Description |
|---|---|
| `PLAYWRIGHT_QA_USER` | Member number of the admin QA user |
| `PLAYWRIGHT_QA_PASSWORD` | Password for the admin QA user |
| `PLAYWRIGHT_QA_SECONDARY_USER` | Member number of a regular (non-admin) member |
| `PLAYWRIGHT_QA_SECONDARY_PASSWORD` | Password for the secondary user |
| `DATABASE_URL` | Dev Neon connection string |
| `E2E_ALLOW_DESTRUCTIVE` | Must be exactly `1` to acknowledge privileged fixture writes/deletes |

### 3. Override variables (optional)

| Variable | Default | Description |
|---|---|---|
| `E2E_BASE_URL` | `http://localhost:3001` | Base URL of the running app |
| `CHROME_PATH` | Playwright bundled Chromium | Optional path to a custom Chrome executable |

---

## Start the dev server

```bash
# From repo root:
pnpm exec next dev -p 3001
```

Wait until the server is ready (you should see "Ready in Xs" in the terminal), then run the runners.

---

## Running the runners

From the repo root (each runner resolves `.env.e2e.local` relative to its own file location):

```bash
node qa/e2e/qa-reservation-lifecycle.mjs
node qa/e2e/qa-reservation-cancellation.mjs
node qa/e2e/qa-no-show-expiry.mjs
node qa/e2e/qa-reservation-equipment.mjs
```

Each runner prints a JSON summary: `{ summary: { passed, total }, checks: [...] }` and exits 0 on success, non-zero on failure.

---

## What each runner validates

### `qa-reservation-lifecycle.mjs`
Full pending → active reservation lifecycle for a regular (non-removable-top) table:
- Create reservation via API → assert 201 + `status: pending`
- Assert table slot is blocked in the availability endpoint
- Inject a backdated pending reservation (direct DB insert) → activate via `POST /api/tables/:id/activate`
- Assert `status: active` after check-in
- Assert second check-in attempt returns 409 `CHECK_IN_ALREADY_ACTIVE`

### `qa-reservation-cancellation.mjs`
Cancellation cutoff enforcement (must run as a non-admin member):
- Create reservation for tomorrow → cancel within cutoff window → assert 200 + `status: cancelled`
- Assert slot is re-available in the availability endpoint after cancellation
- Inject a reservation starting within 60 minutes (direct DB insert) → attempt member cancel → assert 403 `CANCELLATION_CUTOFF`

### `qa-no-show-expiry.mjs`
Lazy no-show expiry (`markExpiredReservationsAsNoShow`, `lib/server/reservation-no-show.ts`) — no more cron endpoint; this now runs inline on every `GET /api/reservations` call, for any authenticated session:
- Assert unauthenticated `GET /api/reservations` → 401
- Insert a backdated pending reservation (direct DB insert; slot ended 60 min ago — the deadline is `min(start + 59min, end)`, and with the slot's start 90 min ago, `end` is the binding term, giving 60 min of margin past it)
- Call `GET /api/reservations` as an authenticated admin user → assert 200
- Assert reservation transitioned to `no_show` in DB

### `qa-reservation-equipment.mjs`
Equipment conflict and validation:
- Create equipment item via direct DB insert
- Admin books table with that equipment → assert 201 + equipment appears in response
- Assert equipment shows as unavailable in `GET /api/rooms/:id/available-equipment`
- Assert booking with unknown equipment UUID returns 400 `INVALID_ROOM_EQUIPMENT`
- Secondary user books a different table (same room, same slot) with the same equipment → assert 409 `EQUIPMENT_ALREADY_RESERVED`

---

## Notes

- The runners refuse to start unless `E2E_ALLOW_DESTRUCTIVE=1` is present in `.env.e2e.local`.
- All runners clean up only the exact DB fixture IDs they created in the `finally` block.
- Time-sensitive checks (check-in window, cancellation cutoff) are skipped gracefully if the time of day makes the fixture impossible.
- Screenshots or videos generated during a run are gitignored (`qa/e2e/*.png`, `*.webm`, `*.pdf`).
