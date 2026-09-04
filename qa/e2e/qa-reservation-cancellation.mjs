/**
 * qa-reservation-cancellation.mjs
 * Tests:
 *  1. Member creates reservation → cancels within cutoff → assert cancelled + slot re-available
 *  2. Member attempts cancel on a reservation starting within 60 min → assert 403 CANCELLATION_CUTOFF
 *
 * NOTE: The cutoff guard is `session.role !== 'admin'` — must use member (secondary) user.
 */
import { chromium } from 'playwright';
import { chromiumLaunchOptions, env, requireE2EEnv } from './env.mjs';
import { sql, tryDelete } from './db.mjs';

const required = [
  'PLAYWRIGHT_QA_USER', 'PLAYWRIGHT_QA_PASSWORD',
  'PLAYWRIGHT_QA_SECONDARY_USER', 'PLAYWRIGHT_QA_SECONDARY_PASSWORD',
  'DATABASE_URL',
];
requireE2EEnv(required);

const appUrl = process.env.E2E_BASE_URL || 'http://localhost:3001';
const json = (r) => r.json().catch(() => null);

const checks = [];
const check = (name, pass, evidence) => {
  checks.push({ name, pass, evidence });
  if (!pass) throw new Error(`FAIL [${name}]: ${JSON.stringify(evidence)}`);
};

const created = { earlyReservationId: null, lateReservationId: null, tableId: null };

const browser = await chromium.launch(chromiumLaunchOptions());

try {
  // ── Fixture: regular table ─────────────────────────────────────────────────
  const [table] = await sql`SELECT id, room_id, type, name FROM tables WHERE type = 'small' LIMIT 1`;
  check('fixture table', Boolean(table?.id), { table });
  created.tableId = table.id;

  // ── DB time ───────────────────────────────────────────────────────────────
  const [{ now: nowValue }] = await sql`SELECT now() AS now`;
  const dbNow = new Date(nowValue);
  const tomorrow = new Date(Date.UTC(dbNow.getUTCFullYear(), dbNow.getUTCMonth(), dbNow.getUTCDate() + 1));
  const tomorrowStr = tomorrow.toISOString().slice(0, 10);

  // ── Login as MEMBER (secondary user) ─────────────────────────────────────
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`${appUrl}/es/sign-in`, { waitUntil: 'networkidle' });
  await page.getByLabel('Número de socio').fill(env.PLAYWRIGHT_QA_SECONDARY_USER);
  await page.getByLabel('Contraseña', { exact: true }).fill(env.PLAYWRIGHT_QA_SECONDARY_PASSWORD);
  await Promise.all([
    page.waitForURL('**/es/rooms', { timeout: 60000 }),
    page.getByRole('button', { name: 'Iniciar sesión' }).click(),
  ]);
  const csrf = (await ctx.cookies()).find((c) => c.name === 'alea-csrf-token')?.value;
  check('member session + CSRF', Boolean(csrf), { url: page.url() });

  const mh = { Origin: appUrl, 'x-csrf-token': csrf, 'Content-Type': 'application/json' };
  const post = (path, data) => page.request.post(`${appUrl}/api${path}`, { headers: mh, data });
  const put  = (path, data) => page.request.put(`${appUrl}/api${path}`, { headers: mh, data });

  // ── Test 1: Cancel within cutoff (>60 min away) ──────────────────────────
  const createResp = await post('/reservations', {
    tableId: table.id,
    date: tomorrowStr,
    startTime: '14:00',
    endTime: '15:00',
    equipmentIds: [],
  });
  const created1 = await json(createResp);
  created.earlyReservationId = created1?.id;
  check('member reservation created (201)', createResp.status() === 201 && Boolean(created.earlyReservationId), {
    status: createResp.status(), body: created1,
  });

  // Verify slot blocked
  const availBefore = await page.request.get(
    `${appUrl}/api/tables/${table.id}/availability?date=${tomorrowStr}`
  );
  const ab = await json(availBefore);
  const slotsArr = Array.isArray(ab) ? ab : (ab?.slots ?? []);
  check('slot blocked after creation', slotsArr.some((s) => s.startTime === '14:00' && s.available === false), {
    sample: slotsArr.slice(0, 4),
  });

  // Cancel within cutoff
  const cancelResp = await put(`/reservations/${created.earlyReservationId}`, { status: 'cancelled' });
  const cancelBody = await json(cancelResp);
  check('cancel within cutoff succeeds (200)', cancelResp.status() === 200, {
    status: cancelResp.status(), body: cancelBody,
  });
  check('status is cancelled', cancelBody?.status === 'cancelled', { status: cancelBody?.status });

  // Verify slot released
  const availAfter = await page.request.get(
    `${appUrl}/api/tables/${table.id}/availability?date=${tomorrowStr}`
  );
  const aa = await json(availAfter);
  const slotsAfter = Array.isArray(aa) ? aa : (aa?.slots ?? []);
  check('slot released after cancellation', slotsAfter.some((s) => s.startTime === '14:00' && s.available === true), {
    sample: slotsAfter.slice(0, 4),
  });

  // ── Test 2: Cancel AFTER cutoff — inject via direct DB insert ────────────
  // Resolve secondary profile id
  const [profile] = await sql`SELECT id FROM profiles WHERE member_number = ${env.PLAYWRIGHT_QA_SECONDARY_USER} LIMIT 1`;

  // Get club-local time
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
  const fmt = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

  // Slot starts in 30 min → within the 60-min cutoff
  if (nowMins + 60 <= 1440) {
    const nearStart = fmt(nowMins + 30);
    const nearEnd   = fmt(nowMins + 60);

    const [lateRes] = await sql`
      INSERT INTO reservations (table_id, user_id, date, start_time, end_time, status)
      VALUES (${table.id}, ${profile.id}, ${today}, ${nearStart}, ${nearEnd}, 'pending')
      RETURNING id
    `;
    created.lateReservationId = lateRes?.id;
    check('late-fixture inserted', Boolean(created.lateReservationId), { lateRes });

    // Member tries to cancel — must be rejected (< 60 min to start)
    const lateCancelResp = await put(`/reservations/${created.lateReservationId}`, { status: 'cancelled' });
    const lateCancelBody = await json(lateCancelResp);
    check('cancel after cutoff rejected (403)', lateCancelResp.status() === 403, {
      status: lateCancelResp.status(), message: lateCancelBody?.message,
    });
    check('cancel after cutoff message is CANCELLATION_CUTOFF', lateCancelBody?.message === 'CANCELLATION_CUTOFF', {
      message: lateCancelBody?.message,
    });
  } else {
    checks.push({ name: 'late cancel fixture', pass: true, evidence: { note: 'too late in day to fit +30/+60 min slot; skipped' } });
  }

  await ctx.close();

  const passed = checks.filter((c) => c.pass).length;
  const total = checks.length;
  console.log(JSON.stringify({ summary: { passed, total }, checks }, null, 2));
  if (passed < total) throw new Error(`${total - passed} check(s) failed`);
} finally {
  await browser.close();
  if (created.earlyReservationId) await tryDelete`DELETE FROM reservations WHERE id = ${created.earlyReservationId}`;
  if (created.lateReservationId)  await tryDelete`DELETE FROM reservations WHERE id = ${created.lateReservationId}`;
  console.log(JSON.stringify({ cleanup: 'done' }));
}
