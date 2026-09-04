/**
 * qa-no-show-expiry.mjs
 * Validates the lazy no-show expiry mechanism (#312, replaces the deleted
 * CRON_SECRET-gated `POST /api/cron/mark-no-show` route, which no longer
 * exists in this codebase — see lib/server/reservation-no-show.ts):
 *  1. Assert unauthenticated GET /api/reservations → 401 (the lazy-eval
 *     trigger below is only reachable through requireAuth)
 *  2. Insert a pending reservation with a backdated start/end time (already
 *     past the no-show deadline)
 *  3. Trigger the lazy-eval path via an authenticated GET /api/reservations
 *     call — that route calls markExpiredReservationsAsNoShow() on every
 *     request, for any authenticated session, before returning the list
 *  4. Assert DB status transitioned to no_show
 */
import { chromium } from 'playwright';
import { chromiumLaunchOptions, env, requireE2EEnv } from './env.mjs';
import { sql, tryDelete } from './db.mjs';

const required = ['PLAYWRIGHT_QA_USER', 'PLAYWRIGHT_QA_PASSWORD', 'DATABASE_URL'];
requireE2EEnv(required);

const appUrl = process.env.E2E_BASE_URL || 'http://localhost:3001';

const checks = [];
const check = (name, pass, evidence) => {
  checks.push({ name, pass, evidence });
  if (!pass) throw new Error(`FAIL [${name}]: ${JSON.stringify(evidence)}`);
};

const created = { reservationId: null, tableId: null };

let browser;

try {
  // ── Auth guard: lazy-eval trigger requires an authenticated session ───────
  // Runs first, before the timing guard below — this assert depends on
  // neither nowMins nor the slot fixture, so it must not be skippable by them.
  const unauthResp = await fetch(`${appUrl}/api/reservations`);
  check('unauthenticated GET /api/reservations → 401', unauthResp.status === 401, { status: unauthResp.status });

  // ── Fixture: regular table ─────────────────────────────────────────────────
  const [table] = await sql`SELECT id, room_id, type, name FROM tables WHERE type = 'small' LIMIT 1`;
  check('fixture table found', Boolean(table?.id), { table });
  created.tableId = table.id;

  // ── DB time, converted to club timezone (Atlantic/Canary) ─────────────────
  const [{ now: nowValue }] = await sql`SELECT now() AS now`;
  const dbNow = new Date(nowValue);
  const dbParts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Atlantic/Canary',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(dbNow)
      .filter((p) => p.type !== 'literal')
      .map((p) => [p.type, p.value])
  );
  const today = `${dbParts.year}-${dbParts.month}-${dbParts.day}`;
  const nowMins = Number(dbParts.hour) * 60 + Number(dbParts.minute);

  // Guard is load-bearing, not just convention: fmt(m) below can't represent
  // negative minutes and would produce an invalid time-of-day literal
  // (e.g. "-2:-30" for nowMins=0) for nowMins - 90 if nowMins < 90. Do not remove.
  if (nowMins < 90) {
    console.log(JSON.stringify({
      summary: { passed: checks.filter((c) => c.pass).length, total: checks.length },
      skipped: 'Too early in day (< 90 min past midnight) to create an expired slot',
      checks,
    }, null, 2));
    process.exit(0);
  }

  // Slot ended 60 min ago. The no-show deadline is min(start + 59min, end)
  // (getNoShowDeadline, lib/server/reservation-no-show.ts) — with start
  // 90 min ago and end 60 min ago, end is the binding term (now-60 < now-31),
  // so it's `end` that determines the deadline here, not the 59-minute
  // constant. 60 min of margin past that deadline.
  const fmt = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const slotStart = fmt(nowMins - 90); // started 90 min ago
  const slotEnd = fmt(nowMins - 60);   // ended 60 min ago

  // ── Login as admin user ────────────────────────────────────────────────────
  browser = await chromium.launch(chromiumLaunchOptions());
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${appUrl}/es/sign-in`, { waitUntil: 'networkidle' });
  await page.getByLabel('Número de socio').fill(env.PLAYWRIGHT_QA_USER);
  await page.getByLabel('Contraseña', { exact: true }).fill(env.PLAYWRIGHT_QA_PASSWORD);
  await Promise.all([
    page.waitForURL('**/es/rooms', { timeout: 60000 }),
    page.getByRole('button', { name: 'Iniciar sesión' }).click(),
  ]);
  const csrf = (await context.cookies()).find((c) => c.name === 'alea-csrf-token')?.value;
  check('session + CSRF', Boolean(csrf), { url: page.url() });

  const [profile] = await sql`SELECT id FROM profiles WHERE member_number = ${env.PLAYWRIGHT_QA_USER} LIMIT 1`;
  check('admin profile resolved', Boolean(profile?.id), { profile });

  // ── 1. Insert backdated pending reservation ────────────────────────────────
  const [inserted] = await sql`
    INSERT INTO reservations (table_id, user_id, date, start_time, end_time, status)
    VALUES (${table.id}, ${profile.id}, ${today}, ${slotStart}, ${slotEnd}, 'pending')
    RETURNING id
  `;
  created.reservationId = inserted?.id;
  check('backdated pending reservation inserted', Boolean(created.reservationId), { inserted });

  // ── 2. Trigger the lazy-eval path via authenticated GET /api/reservations ─
  const listResp = await page.request.get(`${appUrl}/api/reservations`);
  check('reservations list returns 200', listResp.status() === 200, { status: listResp.status() });

  // ── 3. Assert reservation is now no_show in DB ─────────────────────────────
  const [row] = await sql`SELECT status FROM reservations WHERE id = ${created.reservationId}`;
  check('reservation transitioned to no_show', row?.status === 'no_show', { status: row?.status });

  await context.close();

  const passed = checks.filter((c) => c.pass).length;
  const total = checks.length;
  console.log(JSON.stringify({ summary: { passed, total }, checks }, null, 2));
  if (passed < total) throw new Error(`${total - passed} check(s) failed`);
} finally {
  if (browser) await browser.close();
  if (created.reservationId) {
    await tryDelete`DELETE FROM reservations WHERE id = ${created.reservationId}`;
  }
  console.log(JSON.stringify({ cleanup: 'done' }));
}
