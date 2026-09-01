// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createSqlMock,
  hasExactOrderBy,
  hasExactSelectColumns,
  neonDbError,
  whereColumnHasOperator,
  whereConditionCount,
} from '../helpers/sql-mock'

/**
 * PARTNERS SERVICE TEST COVERAGE (Neon raw SQL — #307)
 *
 * Rewritten off the old Supabase-client mocks to the raw-SQL Neon
 * implementation in lib/server/partners-service.ts (#307), following the
 * shared sql-mock pattern established by #332 and used by
 * library-games-service.test.ts (#306) and saved-games-service.test.ts (#301).
 *
 * Key scenarios tested:
 * - listPartners: public read, active-only, ordered by sort_order/name
 * - listAdminPartners: admin-only, returns active + inactive rows
 * - createPartner/updatePartner/deletePartner: admin-only CRUD
 * - Non-admin session gets 403 Forbidden before any DB call on every admin op
 * - Validate-before-write: invalid input (missing name/imageUrl, bad URL
 *   scheme, non-integer sortOrder) never reaches the DB
 * - URL hardening via validateOptionalUrl (javascript:/data:/relative rejected)
 * - descriptionEn bilingual-fallback resolution (auto-copy vs deliberate edit)
 * - mapWriteError: 23514/22P02/23502 -> 400, everything else -> 500
 * - updatePartner: 404 when the initial SELECT finds no row
 * - deletePartner: DELETE...RETURNING id, 404 when no row returned
 */

const sqlMock = createSqlMock()

vi.mock('@/lib/db/client', () => ({ sql: sqlMock.sql }))

async function loadService() {
  vi.resetModules()
  return import('@/lib/server/partners-service')
}

const adminSession = { id: 'admin-1', role: 'admin' as const }
const memberSession = { id: 'member-1', role: 'member' as const }

const partnerRow = {
  id: 'partner-1',
  name: 'Amantis Informática',
  img_url: 'https://example.com/partner.png',
  link_url: 'https://example.com',
  desc_es: 'Tienda de informática',
  desc_en: 'Computer store',
  sort_order: 0,
}

const adminPartnerRow = { ...partnerRow, active: true }

const mappedPartner = {
  id: 'partner-1',
  name: 'Amantis Informática',
  imageUrl: 'https://example.com/partner.png',
  linkUrl: 'https://example.com',
  descriptionEs: 'Tienda de informática',
  descriptionEn: 'Computer store',
  sortOrder: 0,
}

// ---------------------------------------------------------------------------
// Shared handler factories
// ---------------------------------------------------------------------------

function addPublicListHandler(respond: () => unknown) {
  sqlMock.addHandler({
    name: 'SELECT active partners',
    verb: 'select',
    match: (stmt) =>
      stmt.table === 'partners' &&
      hasExactSelectColumns(stmt, 'id, name, img_url, link_url, desc_es, desc_en, sort_order') &&
      whereColumnHasOperator(stmt, 'active', '=') &&
      whereConditionCount(stmt) === 1 &&
      hasExactOrderBy(stmt, 'sort_order asc, name asc'),
    respond,
  })
}

function addAdminListHandler(respond: () => unknown) {
  sqlMock.addHandler({
    name: 'SELECT all partners (admin)',
    verb: 'select',
    match: (stmt) =>
      stmt.table === 'partners' &&
      stmt.whereClause === null &&
      hasExactSelectColumns(stmt, 'id, name, img_url, link_url, desc_es, desc_en, sort_order, active') &&
      hasExactOrderBy(stmt, 'sort_order asc, name asc'),
    respond,
  })
}

function addInsertHandler(respond: (values: unknown[]) => unknown) {
  sqlMock.addHandler({
    name: 'INSERT partners returning row',
    verb: 'insert',
    match: (stmt) => stmt.table === 'partners' && stmt.returning,
    respond: (stmt) => respond(stmt.values),
  })
}

function addCurrentRowHandler(respond: () => unknown) {
  sqlMock.addHandler({
    name: 'SELECT current partners row by id (updatePartner)',
    verb: 'select',
    match: (stmt) =>
      stmt.table === 'partners' &&
      whereColumnHasOperator(stmt, 'id', '=') &&
      whereConditionCount(stmt) === 1 &&
      hasExactSelectColumns(stmt, 'id, name, img_url, link_url, desc_es, desc_en, sort_order, active'),
    respond,
  })
}

function addUpdateHandler(respond: (values: unknown[]) => unknown) {
  sqlMock.addHandler({
    name: 'UPDATE partners by id returning row',
    verb: 'update',
    match: (stmt) =>
      stmt.table === 'partners' &&
      stmt.returning &&
      whereColumnHasOperator(stmt, 'id', '=') &&
      whereConditionCount(stmt) === 1,
    respond: (stmt) => respond(stmt.values),
  })
}

function addDeleteHandler(respond: () => unknown) {
  sqlMock.addHandler({
    name: 'DELETE partners by id returning id',
    verb: 'delete',
    match: (stmt) =>
      stmt.table === 'partners' &&
      stmt.returning &&
      whereColumnHasOperator(stmt, 'id', '=') &&
      whereConditionCount(stmt) === 1,
    respond,
  })
}

const validCreateBody = {
  name: 'Amantis Informática',
  imageUrl: 'https://example.com/partner.png',
  linkUrl: 'https://example.com',
  descriptionEs: 'Tienda de informática',
  descriptionEn: 'Computer store',
  sortOrder: 0,
  active: true,
}

describe('partners-service (Neon raw SQL)', () => {
  beforeEach(() => {
    vi.resetModules()
    sqlMock.reset()
  })

  describe('listPartners', () => {
    it('maps active rows ordered by sort_order then name', async () => {
      addPublicListHandler(() => [
        partnerRow,
        { ...partnerRow, id: 'partner-2', name: 'El Desván del Leprechaun', sort_order: 1 },
      ])

      const { listPartners } = await loadService()
      await expect(listPartners()).resolves.toEqual([
        mappedPartner,
        { ...mappedPartner, id: 'partner-2', name: 'El Desván del Leprechaun', sortOrder: 1 },
      ])
    })

    it('does not include the active field on the public shape', async () => {
      addPublicListHandler(() => [partnerRow])

      const { listPartners } = await loadService()
      const [partner] = await listPartners()
      expect(partner).not.toHaveProperty('active')
    })

    it('maps a database failure to 500', async () => {
      addPublicListHandler(() => { throw new Error('connection reset') })

      const { listPartners } = await loadService()
      await expect(listPartners()).rejects.toMatchObject({ name: 'ServiceError', statusCode: 500 })
    })
  })

  describe('listAdminPartners', () => {
    it('rejects a non-admin session with 403 before any DB call', async () => {
      const { listAdminPartners } = await loadService()
      await expect(listAdminPartners(memberSession)).rejects.toMatchObject({ statusCode: 403 })
      expect(sqlMock.sql).not.toHaveBeenCalled()
    })

    it('returns active and inactive rows for an admin session', async () => {
      addAdminListHandler(() => [adminPartnerRow, { ...adminPartnerRow, id: 'partner-2', active: false }])

      const { listAdminPartners } = await loadService()
      await expect(listAdminPartners(adminSession)).resolves.toEqual([
        { ...mappedPartner, active: true },
        { ...mappedPartner, id: 'partner-2', active: false },
      ])
    })

    it('maps a database failure to 500', async () => {
      addAdminListHandler(() => { throw new Error('connection reset') })

      const { listAdminPartners } = await loadService()
      await expect(listAdminPartners(adminSession)).rejects.toMatchObject({ statusCode: 500 })
    })
  })

  describe('createPartner', () => {
    it('rejects a non-admin session with 403 before any DB call', async () => {
      const { createPartner } = await loadService()
      await expect(createPartner(memberSession, validCreateBody)).rejects.toMatchObject({ statusCode: 403 })
      expect(sqlMock.sql).not.toHaveBeenCalled()
    })

    it.each([
      ['blank', { ...validCreateBody, name: '  ' }],
      ['empty', { ...validCreateBody, name: '' }],
      ['missing', (() => { const { name: _n, ...rest } = validCreateBody; return rest })()],
    ])('rejects a %s name before any DB call', async (_label, body) => {
      const { createPartner } = await loadService()
      await expect(createPartner(adminSession, body)).rejects.toMatchObject({ statusCode: 400 })
      expect(sqlMock.sql).not.toHaveBeenCalled()
    })

    it('rejects a non-string name (type guard: object)', async () => {
      const { createPartner } = await loadService()
      await expect(createPartner(adminSession, { ...validCreateBody, name: { invalid: 'object' } })).rejects.toMatchObject({ statusCode: 400 })
      expect(sqlMock.sql).not.toHaveBeenCalled()
    })

    it('rejects a non-string name (type guard: array)', async () => {
      const { createPartner } = await loadService()
      await expect(createPartner(adminSession, { ...validCreateBody, name: ['array', 'name'] })).rejects.toMatchObject({ statusCode: 400 })
      expect(sqlMock.sql).not.toHaveBeenCalled()
    })

    it.each([
      ['missing', (() => { const { imageUrl: _i, ...rest } = validCreateBody; return rest })()],
      ['null', { ...validCreateBody, imageUrl: null }],
      ['empty string', { ...validCreateBody, imageUrl: '' }],
    ])('rejects a %s imageUrl before any DB call', async (_label, body) => {
      const { createPartner } = await loadService()
      await expect(createPartner(adminSession, body)).rejects.toMatchObject({ statusCode: 400 })
      expect(sqlMock.sql).not.toHaveBeenCalled()
    })

    it('rejects a javascript: imageUrl before any DB call', async () => {
      const { createPartner } = await loadService()
      await expect(createPartner(adminSession, { ...validCreateBody, imageUrl: 'javascript:alert(1)' })).rejects.toMatchObject({ statusCode: 400 })
      expect(sqlMock.sql).not.toHaveBeenCalled()
    })

    it('rejects a data: linkUrl before any DB call', async () => {
      const { createPartner } = await loadService()
      await expect(createPartner(adminSession, { ...validCreateBody, linkUrl: 'data:text/html,<script>alert(1)</script>' })).rejects.toMatchObject({ statusCode: 400 })
      expect(sqlMock.sql).not.toHaveBeenCalled()
    })

    it('rejects a relative imageUrl before any DB call', async () => {
      const { createPartner } = await loadService()
      await expect(createPartner(adminSession, { ...validCreateBody, imageUrl: '/images/partner.png' })).rejects.toMatchObject({ statusCode: 400 })
      expect(sqlMock.sql).not.toHaveBeenCalled()
    })

    it.each(['http://example.com/partner.png', 'https://example.com/partner.png'])(
      'accepts a valid %s imageUrl',
      async (imageUrl) => {
        addInsertHandler(() => [{ ...adminPartnerRow, img_url: imageUrl }])
        const { createPartner } = await loadService()
        await expect(createPartner(adminSession, { ...validCreateBody, imageUrl })).resolves.toMatchObject({ imageUrl })
      },
    )

    it('accepts a null linkUrl (optional)', async () => {
      addInsertHandler((values) => [{ ...adminPartnerRow, link_url: values[2] }])
      const { createPartner } = await loadService()
      await expect(createPartner(adminSession, { ...validCreateBody, linkUrl: null })).resolves.toMatchObject({ linkUrl: null })
    })

    it('accepts an omitted linkUrl (optional)', async () => {
      const { linkUrl: _l, ...bodyWithoutLink } = validCreateBody
      addInsertHandler((values) => [{ ...adminPartnerRow, link_url: values[2] }])
      const { createPartner } = await loadService()
      await expect(createPartner(adminSession, bodyWithoutLink)).resolves.toMatchObject({ linkUrl: null })
    })

    it('rejects descriptionEs as a non-string (type guard: array)', async () => {
      const { createPartner } = await loadService()
      await expect(createPartner(adminSession, { ...validCreateBody, descriptionEs: [] })).rejects.toMatchObject({ statusCode: 400 })
      expect(sqlMock.sql).not.toHaveBeenCalled()
    })

    describe('sortOrder coercion', () => {
      it('defaults to 0 when omitted', async () => {
        const { sortOrder: _s, ...bodyWithoutSortOrder } = validCreateBody
        addInsertHandler((values) => [{ ...adminPartnerRow, sort_order: values[5] }])
        const { createPartner } = await loadService()
        await expect(createPartner(adminSession, bodyWithoutSortOrder)).resolves.toMatchObject({ sortOrder: 0 })
      })

      it('accepts a numeric string', async () => {
        addInsertHandler((values) => [{ ...adminPartnerRow, sort_order: values[5] }])
        const { createPartner } = await loadService()
        await expect(createPartner(adminSession, { ...validCreateBody, sortOrder: '3' })).resolves.toMatchObject({ sortOrder: 3 })
      })

      it.each([3.5, 'abc', NaN])('rejects a non-integer sortOrder (%s) before any DB call', async (sortOrder) => {
        const { createPartner } = await loadService()
        await expect(createPartner(adminSession, { ...validCreateBody, sortOrder })).rejects.toMatchObject({ statusCode: 400 })
        expect(sqlMock.sql).not.toHaveBeenCalled()
      })
    })

    describe('active coercion', () => {
      it('defaults to true when omitted', async () => {
        const { active: _a, ...bodyWithoutActive } = validCreateBody
        addInsertHandler((values) => [{ ...adminPartnerRow, active: values[6] }])
        const { createPartner } = await loadService()
        await expect(createPartner(adminSession, bodyWithoutActive)).resolves.toMatchObject({ active: true })
      })

      it('coerces the string "true" to boolean true', async () => {
        addInsertHandler((values) => [{ ...adminPartnerRow, active: values[6] }])
        const { createPartner } = await loadService()
        await expect(createPartner(adminSession, { ...validCreateBody, active: 'true' })).resolves.toMatchObject({ active: true })
      })

      it('coerces any other value to boolean false', async () => {
        addInsertHandler((values) => [{ ...adminPartnerRow, active: values[6] }])
        const { createPartner } = await loadService()
        await expect(createPartner(adminSession, { ...validCreateBody, active: 'false' })).resolves.toMatchObject({ active: false })
      })
    })

    describe('descriptionEn bilingual fallback', () => {
      it('uses the provided descriptionEn verbatim when non-empty', async () => {
        addInsertHandler((values) => [{ ...adminPartnerRow, desc_en: values[4] }])
        const { createPartner } = await loadService()
        await expect(createPartner(adminSession, { ...validCreateBody, descriptionEn: 'Explicit English' })).resolves.toMatchObject({
          descriptionEn: 'Explicit English',
        })
      })

      it('auto-copies descriptionEs when descriptionEn is provided but blank', async () => {
        addInsertHandler((values) => [{ ...adminPartnerRow, desc_en: values[4] }])
        const { createPartner } = await loadService()
        await expect(createPartner(adminSession, { ...validCreateBody, descriptionEn: '  ' })).resolves.toMatchObject({
          descriptionEn: 'Tienda de informática',
        })
      })

      it('auto-copies descriptionEs when descriptionEn is omitted entirely (create has no current row)', async () => {
        const { descriptionEn: _omit, ...bodyWithoutEn } = validCreateBody
        addInsertHandler((values) => [{ ...adminPartnerRow, desc_en: values[4] }])
        const { createPartner } = await loadService()
        await expect(createPartner(adminSession, bodyWithoutEn)).resolves.toMatchObject({
          descriptionEn: 'Tienda de informática',
        })
      })

      it('rejects a non-string, non-null descriptionEn', async () => {
        const { createPartner } = await loadService()
        await expect(createPartner(adminSession, { ...validCreateBody, descriptionEn: 42 })).rejects.toMatchObject({ statusCode: 400 })
        expect(sqlMock.sql).not.toHaveBeenCalled()
      })
    })

    it('inserts normalized values and maps the returned row', async () => {
      addInsertHandler(() => [adminPartnerRow])
      const { createPartner } = await loadService()
      await expect(createPartner(adminSession, validCreateBody)).resolves.toEqual({ ...mappedPartner, active: true })
    })

    it('maps a 23502/22P02/23514 write failure to 400', async () => {
      addInsertHandler(() => { throw neonDbError('23502', 'null value in column "name" violates not-null constraint') })
      const { createPartner } = await loadService()
      await expect(createPartner(adminSession, validCreateBody)).rejects.toMatchObject({ statusCode: 400 })
    })

    it('maps a generic database failure to 500', async () => {
      addInsertHandler(() => { throw new Error('connection reset') })
      const { createPartner } = await loadService()
      await expect(createPartner(adminSession, validCreateBody)).rejects.toMatchObject({ statusCode: 500 })
    })

    it('maps a missing RETURNING row to 500', async () => {
      addInsertHandler(() => [])
      const { createPartner } = await loadService()
      await expect(createPartner(adminSession, validCreateBody)).rejects.toMatchObject({ statusCode: 500 })
    })
  })

  describe('updatePartner', () => {
    it('rejects a non-admin session with 403 before any DB call', async () => {
      const { updatePartner } = await loadService()
      await expect(updatePartner(memberSession, 'partner-1', { name: 'New' })).rejects.toMatchObject({ statusCode: 403 })
      expect(sqlMock.sql).not.toHaveBeenCalled()
    })

    it('maps a current-row lookup failure to 500', async () => {
      addCurrentRowHandler(() => { throw new Error('connection reset') })
      const { updatePartner } = await loadService()
      await expect(updatePartner(adminSession, 'partner-1', { name: 'New' })).rejects.toMatchObject({ statusCode: 500 })
    })

    it('maps a missing current row to 404 before validating the body', async () => {
      addCurrentRowHandler(() => [])
      const { updatePartner } = await loadService()
      await expect(updatePartner(adminSession, 'missing', { name: '' })).rejects.toMatchObject({ statusCode: 404 })
    })

    it('rejects a blank name (explicit empty overwrite)', async () => {
      addCurrentRowHandler(() => [adminPartnerRow])
      const { updatePartner } = await loadService()
      await expect(updatePartner(adminSession, 'partner-1', { name: '  ' })).rejects.toMatchObject({ statusCode: 400 })
    })

    it('rejects a javascript: imageUrl on update', async () => {
      addCurrentRowHandler(() => [adminPartnerRow])
      const { updatePartner } = await loadService()
      await expect(updatePartner(adminSession, 'partner-1', { imageUrl: 'javascript:alert(1)' })).rejects.toMatchObject({ statusCode: 400 })
    })

    it('rejects a data: linkUrl on update', async () => {
      addCurrentRowHandler(() => [adminPartnerRow])
      const { updatePartner } = await loadService()
      await expect(updatePartner(adminSession, 'partner-1', { linkUrl: 'data:text/html,<script>alert(1)</script>' })).rejects.toMatchObject({ statusCode: 400 })
    })

    it('falls back to the current row for every omitted field', async () => {
      addCurrentRowHandler(() => [adminPartnerRow])
      addUpdateHandler(() => [adminPartnerRow])

      const { updatePartner } = await loadService()
      await expect(updatePartner(adminSession, 'partner-1', {})).resolves.toEqual({ ...mappedPartner, active: true })
    })

    it('falls back to the current imageUrl when omitted', async () => {
      addCurrentRowHandler(() => [adminPartnerRow])
      addUpdateHandler((values) => [{ ...adminPartnerRow, img_url: values[1] }])

      const { updatePartner } = await loadService()
      await expect(updatePartner(adminSession, 'partner-1', { name: 'Renamed' })).resolves.toMatchObject({ imageUrl: adminPartnerRow.img_url })
    })

    it('rejects an out-of-range sortOrder override', async () => {
      addCurrentRowHandler(() => [adminPartnerRow])
      const { updatePartner } = await loadService()
      await expect(updatePartner(adminSession, 'partner-1', { sortOrder: 'abc' })).rejects.toMatchObject({ statusCode: 400 })
    })

    describe('descriptionEn resolution', () => {
      it('rule 1: preserves an explicitly-resent identical value even after descriptionEs changes', async () => {
        addCurrentRowHandler(() => [{ ...adminPartnerRow, desc_es: 'Descripción antigua', desc_en: 'Descripción antigua' }])
        addUpdateHandler((values) => [{ ...adminPartnerRow, desc_es: values[3], desc_en: values[4] }])

        const { updatePartner } = await loadService()
        await expect(updatePartner(adminSession, 'partner-1', {
          descriptionEs: 'Nueva descripción',
          descriptionEn: 'Descripción antigua',
        })).resolves.toMatchObject({
          descriptionEs: 'Nueva descripción',
          descriptionEn: 'Descripción antigua',
        })
      })

      it('rule 2: a blank descriptionEn re-enables auto-copy to the new descriptionEs', async () => {
        addCurrentRowHandler(() => [{ ...adminPartnerRow, desc_es: 'Descripción antigua', desc_en: 'Old Explicit Description' }])
        addUpdateHandler((values) => [{ ...adminPartnerRow, desc_es: values[3], desc_en: values[4] }])

        const { updatePartner } = await loadService()
        await expect(updatePartner(adminSession, 'partner-1', {
          descriptionEs: 'Nueva descripción',
          descriptionEn: '',
        })).resolves.toMatchObject({
          descriptionEs: 'Nueva descripción',
          descriptionEn: 'Nueva descripción',
        })
      })

      it('rule 2: a whitespace-only descriptionEn is treated the same as blank', async () => {
        addCurrentRowHandler(() => [{ ...adminPartnerRow, desc_es: 'Descripción antigua', desc_en: 'Old Explicit Description' }])
        addUpdateHandler((values) => [{ ...adminPartnerRow, desc_es: values[3], desc_en: values[4] }])

        const { updatePartner } = await loadService()
        await expect(updatePartner(adminSession, 'partner-1', {
          descriptionEs: 'Nueva descripción',
          descriptionEn: '   ',
        })).resolves.toMatchObject({ descriptionEn: 'Nueva descripción' })
      })

      it('rule 3: preserves a deliberately-edited current.en that differs from the OLD descriptionEs when omitted', async () => {
        addCurrentRowHandler(() => [{ ...adminPartnerRow, desc_es: 'Descripción antigua', desc_en: 'Custom English' }])
        addUpdateHandler((values) => [{ ...adminPartnerRow, desc_es: values[3], desc_en: values[4] }])

        const { updatePartner } = await loadService()
        await expect(updatePartner(adminSession, 'partner-1', { descriptionEs: 'Nueva descripción' })).resolves.toMatchObject({
          descriptionEs: 'Nueva descripción',
          descriptionEn: 'Custom English',
        })
      })

      it('rule 3: auto-copies the NEW descriptionEs when current.en equals the OLD descriptionEs and descriptionEn is omitted', async () => {
        addCurrentRowHandler(() => [{ ...adminPartnerRow, desc_es: 'Descripción antigua', desc_en: 'Descripción antigua' }])
        addUpdateHandler((values) => [{ ...adminPartnerRow, desc_es: values[3], desc_en: values[4] }])

        const { updatePartner } = await loadService()
        await expect(updatePartner(adminSession, 'partner-1', { descriptionEs: 'Nueva descripción' })).resolves.toMatchObject({
          descriptionEs: 'Nueva descripción',
          descriptionEn: 'Nueva descripción',
        })
      })

      it('rejects a non-string, non-null descriptionEn on update', async () => {
        addCurrentRowHandler(() => [adminPartnerRow])
        const { updatePartner } = await loadService()
        await expect(updatePartner(adminSession, 'partner-1', { descriptionEn: 42 })).rejects.toMatchObject({ statusCode: 400 })
      })
    })

    it('updates and maps the returned row', async () => {
      addCurrentRowHandler(() => [adminPartnerRow])
      addUpdateHandler(() => [{ ...adminPartnerRow, name: 'Renamed' }])

      const { updatePartner } = await loadService()
      await expect(updatePartner(adminSession, 'partner-1', { name: 'Renamed' })).resolves.toMatchObject({ name: 'Renamed' })
    })

    it('maps a 23502/22P02/23514 write failure to 400', async () => {
      addCurrentRowHandler(() => [adminPartnerRow])
      addUpdateHandler(() => { throw neonDbError('22P02', 'invalid input syntax') })

      const { updatePartner } = await loadService()
      await expect(updatePartner(adminSession, 'partner-1', { name: 'Renamed' })).rejects.toMatchObject({ statusCode: 400 })
    })

    it('maps a generic update failure to 500', async () => {
      addCurrentRowHandler(() => [adminPartnerRow])
      addUpdateHandler(() => { throw new Error('connection reset') })

      const { updatePartner } = await loadService()
      await expect(updatePartner(adminSession, 'partner-1', { name: 'Renamed' })).rejects.toMatchObject({ statusCode: 500 })
    })

    it('maps a missing RETURNING row on update to 404', async () => {
      addCurrentRowHandler(() => [adminPartnerRow])
      addUpdateHandler(() => [])

      const { updatePartner } = await loadService()
      await expect(updatePartner(adminSession, 'partner-1', { name: 'Renamed' })).rejects.toMatchObject({ statusCode: 404 })
    })
  })

  describe('deletePartner', () => {
    it('rejects a non-admin session with 403 before any DB call', async () => {
      const { deletePartner } = await loadService()
      await expect(deletePartner(memberSession, 'partner-1')).rejects.toMatchObject({ statusCode: 403 })
      expect(sqlMock.sql).not.toHaveBeenCalled()
    })

    it('deletes a matching row', async () => {
      addDeleteHandler(() => [{ id: 'partner-1' }])
      const { deletePartner } = await loadService()
      await expect(deletePartner(adminSession, 'partner-1')).resolves.toBeUndefined()
    })

    it('maps a database failure to 500', async () => {
      addDeleteHandler(() => { throw new Error('connection reset') })
      const { deletePartner } = await loadService()
      await expect(deletePartner(adminSession, 'partner-1')).rejects.toMatchObject({ statusCode: 500 })
    })

    it('maps a missing row to 404', async () => {
      addDeleteHandler(() => [])
      const { deletePartner } = await loadService()
      await expect(deletePartner(adminSession, 'missing')).rejects.toMatchObject({ statusCode: 404 })
    })
  })
})
