/**
 * qa-reservation-equipment.mjs
 * Tests equipment reservation lifecycle:
 *  1. Create an equipment item via a direct DB insert
 *  2. Admin creates reservation with that equipmentId → assert equipment in response
 *  3. Secondary user books a DIFFERENT table in same room same slot with same equipment
 *     → should get 409 EQUIPMENT_ALREADY_RESERVED
 *  4. Use unknown equipment ID → assert 400 INVALID_ROOM_EQUIPMENT
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

const created = { equipmentId: null, reservation1Id: null, reservation2Id: null, extraTableId: null, roomDefaultSeeded: false };

const browser = await chromium.launch(chromiumLaunchOptions());

try {
  // ── 1. Create a fresh equipment item via a direct DB insert ───────────────
  const [eq] = await sql`
    INSERT INTO equipment (name, description)
    VALUES (${`QA Equipment ${Date.now()}`}, 'E2E test fixture')
    RETURNING id
  `;
  created.equipmentId = eq?.id;
  check('equipment item created', Boolean(created.equipmentId), { eq });

  // ── 2. Pick a regular table (primary booking table) ──────────────────────
  const [table] = await sql`SELECT id, room_id, type, name FROM tables WHERE type = 'small' LIMIT 1`;
  check('fixture table 1', Boolean(table?.id), { table });

  // ── 3. Pick a second regular table in the SAME room ─────────────────────
  // (needed so secondary user's booking doesn't hit SLOT_TAKEN on the same table)
  const [table2Found] = await sql`
    SELECT id, room_id FROM tables
    WHERE type = 'small' AND room_id = ${table.room_id} AND id != ${table.id}
    LIMIT 1
  `;
  let table2 = table2Found;

  // If there's no second table in the same room, create a temporary one
  if (!table2?.id) {
    const [t2] = await sql`
      INSERT INTO tables (room_id, name, type)
      VALUES (${table.room_id}, ${`QA Extra ${Date.now()}`}, 'small')
      RETURNING id
    `;
    created.extraTableId = t2?.id;
    check('created extra table for conflict test', Boolean(t2?.id), { t2 });
    table2 = { id: t2.id, room_id: table.room_id };
  } else {
    check('fixture table 2 (same room)', Boolean(table2.id), { table2 });
  }

  const [roomDefault] = await sql`
    INSERT INTO room_default_equipment (room_id, equipment_id)
    VALUES (${table.room_id}, ${created.equipmentId})
    RETURNING room_id
  `;
  created.roomDefaultSeeded = Boolean(roomDefault);
  check('equipment assigned to fixture room', created.roomDefaultSeeded, { roomDefault });

  // ── 4. Compute date: tomorrow ─────────────────────────────────────────────
  const [{ now: nowValue }] = await sql`SELECT now() AS now`;
  const dbNow = new Date(nowValue);
  const tomorrow = new Date(Date.UTC(dbNow.getUTCFullYear(), dbNow.getUTCMonth(), dbNow.getUTCDate() + 1));
  const date = tomorrow.toISOString().slice(0, 10);
  const startTime = '15:00';
  const endTime = '16:00';

  // ── 5. Login as admin user ────────────────────────────────────────────────
  const ctx1 = await browser.newContext();
  const page1 = await ctx1.newPage();
  await page1.goto(`${appUrl}/es/sign-in`, { waitUntil: 'networkidle' });
  await page1.getByLabel('Número de socio').fill(env.PLAYWRIGHT_QA_USER);
  await page1.getByLabel('Contraseña', { exact: true }).fill(env.PLAYWRIGHT_QA_PASSWORD);
  await Promise.all([
    page1.waitForURL('**/es/rooms', { timeout: 60000 }),
    page1.getByRole('button', { name: 'Iniciar sesión' }).click(),
  ]);
  const csrf1 = (await ctx1.cookies()).find((c) => c.name === 'alea-csrf-token')?.value;
  check('admin session + CSRF', Boolean(csrf1), { url: page1.url() });

  const mh1 = { Origin: appUrl, 'x-csrf-token': csrf1, 'Content-Type': 'application/json' };
  const post1 = (path, data) => page1.request.post(`${appUrl}/api${path}`, { headers: mh1, data });

  // ── 6. Admin creates reservation on table1 with equipment ─────────────────
  const createResp = await post1('/reservations', {
    tableId: table.id,
    date,
    startTime,
    endTime,
    equipmentIds: [created.equipmentId],
  });
  const created1 = await json(createResp);
  created.reservation1Id = created1?.id;
  check('reservation with equipment created (201)', createResp.status() === 201 && Boolean(created.reservation1Id), {
    status: createResp.status(), body: created1,
  });
  check('equipment appears in reservation response', Array.isArray(created1?.equipment) && created1.equipment.some((e) => e.id === created.equipmentId), {
    equipment: created1?.equipment,
  });

  // ── 7. Check available-equipment endpoint shows equipment as unavailable ──
  const eqAvailResp = await page1.request.get(
    `${appUrl}/api/rooms/${table.room_id}/available-equipment?date=${date}&startTime=${startTime}&endTime=${endTime}`
  );
  const eqAvailBody = await json(eqAvailResp);
  check('equipment availability endpoint returns 200', eqAvailResp.status() === 200 && Array.isArray(eqAvailBody), {
    status: eqAvailResp.status(), body: eqAvailBody,
  });
  const eqEntry = eqAvailBody.find((e) => e.id === created.equipmentId);
  check('equipment appears in room pool', Boolean(eqEntry), { equipmentId: created.equipmentId, body: eqAvailBody });
  check('equipment shows as unavailable after booking', eqEntry.available === false, { eqEntry });

  // ── 8. Unknown equipment ID → 400 INVALID_ROOM_EQUIPMENT ─────────────────
  const unknownResp = await post1('/reservations', {
    tableId: table.id,
    date,
    startTime: '16:00',
    endTime: '17:00',
    equipmentIds: ['00000000-0000-0000-0000-000000000000'],
  });
  const unknownBody = await json(unknownResp);
  check('unknown equipment ID rejected (400)', unknownResp.status() === 400, {
    status: unknownResp.status(), message: unknownBody?.message,
  });
  check('unknown equipment message is INVALID_ROOM_EQUIPMENT', unknownBody?.message === 'INVALID_ROOM_EQUIPMENT', {
    message: unknownBody?.message,
  });

  await ctx1.close();

  // ── 9. Secondary user books table2 (same room, same slot) with same equipment ─
  const ctx2 = await browser.newContext();
  const page2 = await ctx2.newPage();
  await page2.goto(`${appUrl}/es/sign-in`, { waitUntil: 'networkidle' });
  await page2.getByLabel('Número de socio').fill(env.PLAYWRIGHT_QA_SECONDARY_USER);
  await page2.getByLabel('Contraseña', { exact: true }).fill(env.PLAYWRIGHT_QA_SECONDARY_PASSWORD);
  await Promise.all([
    page2.waitForURL('**/es/rooms', { timeout: 60000 }),
    page2.getByRole('button', { name: 'Iniciar sesión' }).click(),
  ]);
  const csrf2 = (await ctx2.cookies()).find((c) => c.name === 'alea-csrf-token')?.value;
  check('secondary session + CSRF', Boolean(csrf2), { url: page2.url() });

  const mh2 = { Origin: appUrl, 'x-csrf-token': csrf2, 'Content-Type': 'application/json' };
  const post2 = (path, data) => page2.request.post(`${appUrl}/api${path}`, { headers: mh2, data });

  // Secondary user books table2 in the same room, same slot, same equipment
  // table2 has no slot conflict, so the equipment conflict is what triggers
  const conflictResp = await post2('/reservations', {
    tableId: table2.id,
    date,
    startTime,
    endTime,
    equipmentIds: [created.equipmentId],
  });
  const conflictBody = await json(conflictResp);
  created.reservation2Id = conflictBody?.id; // null if correctly rejected
  check('conflicting equipment booking rejected (409)', conflictResp.status() === 409, {
    status: conflictResp.status(), message: conflictBody?.message,
  });
  check('conflict message is EQUIPMENT_ALREADY_RESERVED', conflictBody?.message === 'EQUIPMENT_ALREADY_RESERVED', {
    message: conflictBody?.message,
  });

  await ctx2.close();

  const passed = checks.filter((c) => c.pass).length;
  const total = checks.length;
  console.log(JSON.stringify({ summary: { passed, total }, checks }, null, 2));
  if (passed < total) throw new Error(`${total - passed} check(s) failed`);
} finally {
  await browser.close();
  if (created.reservation1Id) {
    await tryDelete`DELETE FROM reservation_equipment WHERE reservation_id = ${created.reservation1Id}`;
    await tryDelete`DELETE FROM reservations WHERE id = ${created.reservation1Id}`;
  }
  if (created.reservation2Id) {
    await tryDelete`DELETE FROM reservation_equipment WHERE reservation_id = ${created.reservation2Id}`;
    await tryDelete`DELETE FROM reservations WHERE id = ${created.reservation2Id}`;
  }
  if (created.roomDefaultSeeded && created.equipmentId) {
    await tryDelete`DELETE FROM room_default_equipment WHERE equipment_id = ${created.equipmentId}`;
  }
  if (created.equipmentId) {
    await tryDelete`DELETE FROM equipment WHERE id = ${created.equipmentId}`;
  }
  if (created.extraTableId) {
    await tryDelete`DELETE FROM tables WHERE id = ${created.extraTableId}`;
  }
  console.log(JSON.stringify({ cleanup: 'done' }));
}
