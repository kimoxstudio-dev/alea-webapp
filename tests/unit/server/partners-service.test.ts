// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import type { ServiceError } from '@/lib/server/shared/service-error'
import {
  selectMock,
  insertMock,
  updateMock,
  deleteMock,
  createAdminSession,
  createMemberSession,
} from '@/tests/unit/mocks/drizzle-mock'

/**
 * PARTNERS SERVICE TEST COVERAGE (OIR-204)
 *
 * Tests for admin CRUD operations on partners (colaboradores) and public read access.
 * Implementation: lib/server/partners/partners-service.ts
 *
 * Key scenarios tested:
 * - listPartners returns active partners ordered by sort_order (public, via RLS)
 * - listAdminPartners returns all partners (active + inactive) for admin dashboard
 * - createPartner/updatePartner/deletePartner admin-only operations
 * - Non-admin users get 403 Forbidden from every admin endpoint
 * - URL hardening: validateOptionalUrl rejects javascript:, data:, relative URLs
 * - img_url is required; link_url is optional
 * - Validate-before-write: invalid input prevents DB calls
 * - Type guards: name as object/array rejected with 400
 * - Migration enables RLS, creates SELECT-only policy, seeds 20 partners
 * - Chained .order() calls: secondary order('name') tie-break for consistent results
 */

/**
 * Enhanced Drizzle query builder mock that supports .where().orderBy() chaining.
 * Returns thenable objects that can also be chained with .orderBy().
 */
function createDrizzleQueryBuilder() {
  // Create a chainable object that's also thenable (awaitable)
  const createChainableSelectQuery = () => {
    return {
      orderBy: vi.fn(() => selectMock()),
      where: vi.fn(() => {
        // Return something thenable that also has .orderBy()
        const thenableWithOrderBy = selectMock() as any
        thenableWithOrderBy.orderBy = vi.fn(() => selectMock())
        return thenableWithOrderBy
      }),
    }
  }

  return {
    select: vi.fn(() => ({
      from: vi.fn(() => createChainableSelectQuery()),
    })),
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        returning: vi.fn(() => insertMock()),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn(() => updateMock()),
        })),
      })),
    })),
    delete: vi.fn(() => ({
      where: vi.fn(() => ({
        returning: vi.fn(() => deleteMock()),
      })),
    })),
  }
}

vi.mock('@/lib/db', () => ({
  getDrizzleDb: vi.fn(() => createDrizzleQueryBuilder()),
  getDrizzleAdminDb: vi.fn(() => createDrizzleQueryBuilder()),
}))

vi.mock('server-only', () => ({}))

vi.mock('@/lib/server/shared/service-error', () => ({
  serviceError: vi.fn((message: string, statusCode: number) => {
    const err = new Error(message) as ServiceError
    err.name = 'ServiceError'
    err.statusCode = statusCode
    throw err
  }),
}))

// Test data fixtures
const mockPartner1 = {
  id: 'partner-1',
  name: 'Amantis Informática',
  imgUrl: 'https://alealaspalmas.es/wp-content/uploads/2025/10/amantisinformatica.png',
  linkUrl: 'https://maps.app.goo.gl/KPiF4nxabjBYu8YA6',
  descEs: 'Tienda de informática',
  descEn: 'Computer store',
  sortOrder: 0,
  active: true,
  createdAt: '2026-04-01T00:00:00Z',
  updatedAt: '2026-04-01T00:00:00Z',
}

const mockPartner2 = {
  id: 'partner-2',
  name: 'El Desván del Leprechaun',
  imgUrl: 'https://alealaspalmas.es/wp-content/uploads/2025/10/eldesvandelleprechaun.png',
  linkUrl: 'https://maps.app.goo.gl/CM96Gnighr4YGMbC7',
  descEs: 'Videojuegos y más',
  descEn: 'Video games and more',
  sortOrder: 1,
  active: true,
  createdAt: '2026-04-01T00:00:00Z',
  updatedAt: '2026-04-01T00:00:00Z',
}

async function loadPartnersService() {
  vi.resetModules()
  const mod = await import('@/lib/server/partners/partners-service')
  return {
    listPartners: mod.listPartners,
    listAdminPartners: mod.listAdminPartners,
    createPartner: mod.createPartner,
    updatePartner: mod.updatePartner,
    deletePartner: mod.deletePartner,
  }
}

describe('partners-service', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
  })

  describe('listPartners', () => {
    it('returns active partners ordered by sort_order', async () => {
      selectMock.mockResolvedValue([mockPartner1, mockPartner2])

      const { listPartners } = await loadPartnersService()
      const result = await listPartners()

      expect(Array.isArray(result)).toBe(true)
      expect(result.length).toBe(2)
      expect(result[0].name).toBe('Amantis Informática')
      expect(result[0].sortOrder).toBe(0)
      expect(result[1].name).toBe('El Desván del Leprechaun')
      expect(result[1].sortOrder).toBe(1)
    })

    it('chains multiple order() calls without error (sort_order primary, name secondary)', async () => {
      selectMock.mockResolvedValue([mockPartner1, mockPartner2])

      const { listPartners } = await loadPartnersService()
      const result = await listPartners()

      expect(Array.isArray(result)).toBe(true)
    })

    it('uses user-scoped client (RLS-respecting) for public listing', async () => {
      selectMock.mockResolvedValue([mockPartner1, mockPartner2])

      const { listPartners } = await loadPartnersService()
      await listPartners()

      expect(vi.mocked(await import('@/lib/db')).getDrizzleDb).toHaveBeenCalled()
    })

    it('maps database columns to public Partner type', async () => {
      selectMock.mockResolvedValue([mockPartner1])

      const { listPartners } = await loadPartnersService()
      const result = await listPartners()

      expect(result[0]).toMatchObject({
        id: 'partner-1',
        name: 'Amantis Informática',
        imageUrl: 'https://alealaspalmas.es/wp-content/uploads/2025/10/amantisinformatica.png',
        linkUrl: 'https://maps.app.goo.gl/KPiF4nxabjBYu8YA6',
        descriptionEs: 'Tienda de informática',
        descriptionEn: 'Computer store',
        sortOrder: 0,
      })
      expect(result[0]).not.toHaveProperty('active')
    })
  })

  describe('listAdminPartners', () => {
    it('admin can list all partners including inactive', async () => {
      const adminSession = createAdminSession()
      selectMock.mockResolvedValue([mockPartner1, mockPartner2])

      const { listAdminPartners } = await loadPartnersService()
      const result = await listAdminPartners(adminSession)

      expect(Array.isArray(result)).toBe(true)
      expect(result[0]).toHaveProperty('active')
    })

    it('chains multiple order() calls without error (sort_order primary, name secondary)', async () => {
      const adminSession = createAdminSession()
      selectMock.mockResolvedValue([mockPartner1, mockPartner2])

      const { listAdminPartners } = await loadPartnersService()
      const result = await listAdminPartners(adminSession)

      expect(Array.isArray(result)).toBe(true)
    })

    it('non-admin member gets 403 Forbidden', async () => {
      const memberSession = createMemberSession()

      const { listAdminPartners } = await loadPartnersService()

      await expect(listAdminPartners(memberSession)).rejects.toMatchObject({ statusCode: 403 })
    })
  })

  describe('createPartner', () => {
    it('admin can create a partner with required fields', async () => {
      const adminSession = createAdminSession()
      const newPartner = {
        id: 'partner-new-1',
        name: 'New Partner',
        imgUrl: 'https://example.com/partner.png',
        linkUrl: null,
        descEs: null,
        descEn: null,
        sortOrder: 0,
        active: true,
        createdAt: '2026-04-01T00:00:00Z',
        updatedAt: '2026-04-01T00:00:00Z',
      }
      insertMock.mockResolvedValue([newPartner])

      const { createPartner } = await loadPartnersService()
      const result = await createPartner(adminSession, {
        name: 'New Partner',
        imageUrl: 'https://example.com/partner.png',
      })

      expect(result.id).toBe('partner-new-1')
      expect(result.name).toBe('New Partner')
      expect(result.imageUrl).toBe('https://example.com/partner.png')
    })

    it('admin can create a partner with all fields', async () => {
      const adminSession = createAdminSession()
      const newPartner = {
        id: 'partner-new-1',
        name: 'Complete Partner',
        imgUrl: 'https://example.com/partner.png',
        linkUrl: 'https://example.com',
        descEs: 'Descripción en español',
        descEn: 'Description in English',
        sortOrder: 5,
        active: true,
        createdAt: '2026-04-01T00:00:00Z',
        updatedAt: '2026-04-01T00:00:00Z',
      }
      insertMock.mockResolvedValue([newPartner])

      const { createPartner } = await loadPartnersService()
      const result = await createPartner(adminSession, {
        name: 'Complete Partner',
        imageUrl: 'https://example.com/partner.png',
        linkUrl: 'https://example.com',
        descriptionEs: 'Descripción en español',
        descriptionEn: 'Description in English',
        sortOrder: 5,
        active: true,
      })

      expect(result.name).toBe('Complete Partner')
      expect(result.active).toBe(true)
    })

    it('non-admin member gets 403 Forbidden', async () => {
      const memberSession = createMemberSession()

      const { createPartner } = await loadPartnersService()

      await expect(
        createPartner(memberSession, {
          name: 'Partner',
          imageUrl: 'https://example.com/partner.png',
        })
      ).rejects.toMatchObject({ statusCode: 403 })
    })

    it('rejects javascript: URL in img_url', async () => {
      const adminSession = createAdminSession()

      const { createPartner } = await loadPartnersService()

      await expect(
        createPartner(adminSession, {
          name: 'Partner',
          imageUrl: 'javascript:alert(1)',
        })
      ).rejects.toMatchObject({ statusCode: 400 })
    })

    it('rejects data: URL in link_url', async () => {
      const adminSession = createAdminSession()

      const { createPartner } = await loadPartnersService()

      await expect(
        createPartner(adminSession, {
          name: 'Partner',
          imageUrl: 'https://example.com/partner.png',
          linkUrl: 'data:text/html,<script>alert(1)</script>',
        })
      ).rejects.toMatchObject({ statusCode: 400 })
    })

    it('rejects relative URL in imageUrl', async () => {
      const adminSession = createAdminSession()

      const { createPartner } = await loadPartnersService()

      await expect(
        createPartner(adminSession, {
          name: 'Partner',
          imageUrl: '/images/partner.png',
        })
      ).rejects.toMatchObject({ statusCode: 400 })
    })

    it('accepts empty/null link_url (optional)', async () => {
      const adminSession = createAdminSession()
      const newPartner = {
        id: 'partner-new-1',
        name: 'Partner 1',
        imgUrl: 'https://example.com/partner.png',
        linkUrl: null,
        descEs: null,
        descEn: null,
        sortOrder: 0,
        active: true,
        createdAt: '2026-04-01T00:00:00Z',
        updatedAt: '2026-04-01T00:00:00Z',
      }
      insertMock.mockResolvedValue([newPartner])

      const { createPartner } = await loadPartnersService()

      const result1 = await createPartner(adminSession, {
        name: 'Partner 1',
        imageUrl: 'https://example.com/partner.png',
        linkUrl: null,
      })

      const result2 = await createPartner(adminSession, {
        name: 'Partner 2',
        imageUrl: 'https://example.com/partner.png',
        linkUrl: undefined,
      })

      expect(result1.id).toBe('partner-new-1')
      expect(result2.id).toBe('partner-new-1')
    })

    it('rejects missing/empty name', async () => {
      const adminSession = createAdminSession()

      const { createPartner } = await loadPartnersService()

      await expect(
        createPartner(adminSession, {
          name: '',
          imageUrl: 'https://example.com/partner.png',
        })
      ).rejects.toMatchObject({ statusCode: 400 })
    })

    it('rejects missing imageUrl', async () => {
      const adminSession = createAdminSession()

      const { createPartner } = await loadPartnersService()

      await expect(
        createPartner(adminSession, {
          name: 'Partner',
          imageUrl: null,
        })
      ).rejects.toMatchObject({ statusCode: 400 })
    })

    it('rejects name as object with 400', async () => {
      const adminSession = createAdminSession()

      const { createPartner } = await loadPartnersService()

      await expect(
        createPartner(adminSession, {
          name: { invalid: 'object' },
          imageUrl: 'https://example.com/partner.png',
        })
      ).rejects.toMatchObject({ statusCode: 400 })
    })

    it('rejects name as array with 400', async () => {
      const adminSession = createAdminSession()

      const { createPartner } = await loadPartnersService()

      await expect(
        createPartner(adminSession, {
          name: ['array', 'name'],
          imageUrl: 'https://example.com/partner.png',
        })
      ).rejects.toMatchObject({ statusCode: 400 })
    })

    it('rejects descriptionEs as array with 400', async () => {
      const adminSession = createAdminSession()

      const { createPartner } = await loadPartnersService()

      await expect(
        createPartner(adminSession, {
          name: 'Partner',
          imageUrl: 'https://example.com/partner.png',
          descriptionEs: [],
        })
      ).rejects.toMatchObject({ statusCode: 400 })
    })

    it('validates before any DB insert', async () => {
      const adminSession = createAdminSession()

      const { createPartner } = await loadPartnersService()

      await expect(
        createPartner(adminSession, {
          name: 'Partner',
          imageUrl: 'javascript:alert(1)',
        })
      ).rejects.toMatchObject({ statusCode: 400 })

      expect(insertMock).not.toHaveBeenCalled()
    })

    it('accepts valid http:// URL', async () => {
      const adminSession = createAdminSession()
      const newPartner = {
        id: 'partner-new-1',
        name: 'Partner',
        imgUrl: 'http://example.com/partner.png',
        linkUrl: null,
        descEs: null,
        descEn: null,
        sortOrder: 0,
        active: true,
        createdAt: '2026-04-01T00:00:00Z',
        updatedAt: '2026-04-01T00:00:00Z',
      }
      insertMock.mockResolvedValue([newPartner])

      const { createPartner } = await loadPartnersService()
      const result = await createPartner(adminSession, {
        name: 'Partner',
        imageUrl: 'http://example.com/partner.png',
      })

      expect(result.id).toBe('partner-new-1')
    })

    it('accepts valid https:// URL', async () => {
      const adminSession = createAdminSession()
      const newPartner = {
        id: 'partner-new-1',
        name: 'Partner',
        imgUrl: 'https://example.com/partner.png',
        linkUrl: null,
        descEs: null,
        descEn: null,
        sortOrder: 0,
        active: true,
        createdAt: '2026-04-01T00:00:00Z',
        updatedAt: '2026-04-01T00:00:00Z',
      }
      insertMock.mockResolvedValue([newPartner])

      const { createPartner } = await loadPartnersService()
      const result = await createPartner(adminSession, {
        name: 'Partner',
        imageUrl: 'https://example.com/partner.png',
      })

      expect(result.id).toBe('partner-new-1')
    })
  })

  describe('updatePartner', () => {
    it('admin can update a partner', async () => {
      const adminSession = createAdminSession()
      const updated = { ...mockPartner1, name: 'Updated Partner' }
      selectMock.mockResolvedValueOnce([mockPartner1])
      updateMock.mockResolvedValue([updated])

      const { updatePartner } = await loadPartnersService()
      const result = await updatePartner(adminSession, 'partner-1', {
        name: 'Updated Partner',
      })

      expect(result.id).toBe('partner-1')
      expect(result.name).toBe('Updated Partner')
    })

    it('non-admin member gets 403 Forbidden on update', async () => {
      const memberSession = createMemberSession()

      const { updatePartner } = await loadPartnersService()

      await expect(
        updatePartner(memberSession, 'partner-1', { name: 'Updated' })
      ).rejects.toMatchObject({ statusCode: 403 })
    })

    it('returns 404 for non-existent partner', async () => {
      const adminSession = createAdminSession()
      selectMock.mockResolvedValue([])

      const { updatePartner } = await loadPartnersService()

      await expect(
        updatePartner(adminSession, 'nonexistent-partner', { name: 'Updated' })
      ).rejects.toMatchObject({ statusCode: 404 })
    })

    it('rejects javascript: URL in img_url on update', async () => {
      const adminSession = createAdminSession()
      selectMock.mockResolvedValue([mockPartner1])

      const { updatePartner } = await loadPartnersService()

      await expect(
        updatePartner(adminSession, 'partner-1', {
          imageUrl: 'javascript:alert(1)',
        })
      ).rejects.toMatchObject({ statusCode: 400 })
    })

    it('rejects data: URL in link_url on update', async () => {
      const adminSession = createAdminSession()
      selectMock.mockResolvedValue([mockPartner1])

      const { updatePartner } = await loadPartnersService()

      await expect(
        updatePartner(adminSession, 'partner-1', {
          linkUrl: 'data:text/html,<script>alert(1)</script>',
        })
      ).rejects.toMatchObject({ statusCode: 400 })
    })

    it('validates before any DB update', async () => {
      const adminSession = createAdminSession()
      selectMock.mockResolvedValue([mockPartner1])

      const { updatePartner } = await loadPartnersService()

      await expect(
        updatePartner(adminSession, 'partner-1', {
          imageUrl: 'javascript:alert(1)',
        })
      ).rejects.toMatchObject({ statusCode: 400 })

      expect(updateMock).not.toHaveBeenCalled()
    })

    it('preserves current values for omitted fields', async () => {
      const adminSession = createAdminSession()
      const updated = { ...mockPartner1, name: 'Updated Name' }
      selectMock.mockResolvedValueOnce([mockPartner1])
      updateMock.mockResolvedValue([updated])

      const { updatePartner } = await loadPartnersService()
      const result = await updatePartner(adminSession, 'partner-1', {
        name: 'Updated Name',
      })

      expect(result.id).toBe('partner-1')
    })
  })

  describe('deletePartner', () => {
    it('admin can delete a partner', async () => {
      const adminSession = createAdminSession()
      deleteMock.mockResolvedValue([{ id: 'partner-1' }])

      const { deletePartner } = await loadPartnersService()

      await expect(deletePartner(adminSession, 'partner-1')).resolves.toBeUndefined()
    })

    it('non-admin member gets 403 Forbidden on delete', async () => {
      const memberSession = createMemberSession()

      const { deletePartner } = await loadPartnersService()

      await expect(deletePartner(memberSession, 'partner-1')).rejects.toMatchObject({ statusCode: 403 })
    })

    it('returns 404 for non-existent partner', async () => {
      const adminSession = createAdminSession()
      deleteMock.mockResolvedValue([])

      const { deletePartner } = await loadPartnersService()

      await expect(deletePartner(adminSession, 'nonexistent-partner')).rejects.toMatchObject({
        statusCode: 404,
      })
    })
  })

  describe('migration sanity checks', () => {
    const migrationPath = join(
      '/Users/samuelromeroarbelo/Projects/Alea/alea-webapp/supabase/migrations',
      '20260704000002_oir204_partners_table.sql'
    )
    const migrationContent = readFileSync(migrationPath, 'utf8')

    it('migration file enables RLS on partners table', () => {
      expect(migrationContent).toContain('ALTER TABLE "public"."partners" ENABLE ROW LEVEL SECURITY')
    })

    it('migration creates SELECT-only policy for anon and authenticated', () => {
      expect(migrationContent).toContain('CREATE POLICY "partners_select_active"')
      expect(migrationContent).toContain('FOR SELECT TO "anon", "authenticated"')
      expect(migrationContent).toContain('USING ("active" = true)')
    })

    it('migration grants SELECT only (no INSERT/UPDATE/DELETE)', () => {
      expect(migrationContent).toContain('GRANT SELECT ON TABLE "public"."partners" TO "anon", "authenticated"')
      expect(migrationContent).not.toContain('GRANT INSERT')
      expect(migrationContent).not.toContain('GRANT UPDATE')
      expect(migrationContent).not.toContain('GRANT DELETE')
    })

    it('migration seeds 20 partners with sort_order preservation', () => {
      const insertMatch = migrationContent.match(/INSERT INTO "public"."partners"[\s\S]*?VALUES([\s\S]*?);/)
      expect(insertMatch).not.toBeNull()
      if (insertMatch) {
        const valuesSection = insertMatch[1]
        const rowCount = (valuesSection.match(/^\s*\(/gm) || []).length
        expect(rowCount).toBe(20)
      }
    })

    it('migration creates required columns with correct types', () => {
      expect(migrationContent).toContain('"id" uuid PRIMARY KEY DEFAULT gen_random_uuid()')
      expect(migrationContent).toContain('"name" text NOT NULL')
      expect(migrationContent).toContain('"img_url" text NOT NULL')
      expect(migrationContent).toContain('"link_url" text')
      expect(migrationContent).toContain('"sort_order" integer NOT NULL DEFAULT 0')
      expect(migrationContent).toContain('"active" boolean NOT NULL DEFAULT true')
      expect(migrationContent).toContain('"created_at" timestamptz NOT NULL DEFAULT now()')
      expect(migrationContent).toContain('"updated_at" timestamptz NOT NULL DEFAULT now()')
    })
  })

  describe('createPartner with optional English (OIR-206)', () => {
    it('admin can create a partner with descriptionEn absent, falls back to descriptionEs', async () => {
      const adminSession = createAdminSession()
      const newPartner = {
        id: 'partner-new-1',
        name: 'Librería Local',
        imgUrl: 'https://example.com/library.png',
        linkUrl: null,
        descEs: 'Tu tienda de libros favorita',
        descEn: 'Tu tienda de libros favorita',
        sortOrder: 0,
        active: true,
        createdAt: '2026-04-01T00:00:00Z',
        updatedAt: '2026-04-01T00:00:00Z',
      }
      insertMock.mockResolvedValue([newPartner])

      const { createPartner } = await loadPartnersService()
      const result = await createPartner(adminSession, {
        name: 'Librería Local',
        imageUrl: 'https://example.com/library.png',
        descriptionEs: 'Tu tienda de libros favorita',
      })

      expect(result.name).toBe('Librería Local')
      expect(result.descriptionEs).toBe('Tu tienda de libros favorita')
      expect(result.descriptionEn).toBe('Tu tienda de libros favorita')
    })

    it('admin can create a partner with descriptionEn empty string, falls back to descriptionEs', async () => {
      const adminSession = createAdminSession()
      const newPartner = {
        id: 'partner-new-1',
        name: 'Tienda de Juegos',
        imgUrl: 'https://example.com/games.png',
        linkUrl: null,
        descEs: 'Juegos de mesa y más',
        descEn: 'Juegos de mesa y más',
        sortOrder: 0,
        active: true,
        createdAt: '2026-04-01T00:00:00Z',
        updatedAt: '2026-04-01T00:00:00Z',
      }
      insertMock.mockResolvedValue([newPartner])

      const { createPartner } = await loadPartnersService()
      const result = await createPartner(adminSession, {
        name: 'Tienda de Juegos',
        imageUrl: 'https://example.com/games.png',
        descriptionEs: 'Juegos de mesa y más',
        descriptionEn: '',
      })

      expect(result.descriptionEn).toBe('Juegos de mesa y más')
    })

    it('admin can create a partner with explicit descriptionEn, preserves EN value', async () => {
      const adminSession = createAdminSession()
      const newPartner = {
        id: 'partner-new-1',
        name: 'Café Artesanal',
        imgUrl: 'https://example.com/cafe.png',
        linkUrl: null,
        descEs: 'Café y pasteles locales',
        descEn: 'Artisanal coffee and pastries',
        sortOrder: 0,
        active: true,
        createdAt: '2026-04-01T00:00:00Z',
        updatedAt: '2026-04-01T00:00:00Z',
      }
      insertMock.mockResolvedValue([newPartner])

      const { createPartner } = await loadPartnersService()
      const result = await createPartner(adminSession, {
        name: 'Café Artesanal',
        imageUrl: 'https://example.com/cafe.png',
        descriptionEs: 'Café y pasteles locales',
        descriptionEn: 'Artisanal coffee and pastries',
      })

      expect(result.descriptionEn).toBe('Artisanal coffee and pastries')
    })
  })

  describe('updatePartner with fallback semantics edge cases (OIR-206 round 2)', () => {
    it('rule 2: explicit different descriptionEn + blank descriptionEn payload = re-enable auto-copy to new ES', async () => {
      const adminSession = createAdminSession()
      const currentRow = {
        id: 'partner-1',
        name: 'Partner Name',
        imgUrl: 'https://example.com/partner.png',
        linkUrl: null,
        descEs: 'Descripción antigua',
        descEn: 'Old Explicit Description',
        sortOrder: 0,
        active: true,
        createdAt: '2026-04-01T00:00:00Z',
        updatedAt: '2026-04-01T00:00:00Z',
      }
      const updated = {
        id: 'partner-1',
        name: 'Partner Name',
        imgUrl: 'https://example.com/partner.png',
        linkUrl: null,
        descEs: 'Nueva descripción',
        descEn: 'Nueva descripción',
        sortOrder: 0,
        active: true,
        createdAt: '2026-04-01T00:00:00Z',
        updatedAt: '2026-04-01T00:00:00Z',
      }
      selectMock.mockResolvedValueOnce([currentRow])
      updateMock.mockResolvedValue([updated])

      const { updatePartner } = await loadPartnersService()
      const result = await updatePartner(adminSession, 'partner-1', {
        descriptionEs: 'Nueva descripción',
        descriptionEn: '',
      })

      expect(result.descriptionEn).toBe('Nueva descripción')
    })

    it('rule 1: resending identical descriptionEn (en === es deliberately) + ES change = EN preserved', async () => {
      const adminSession = createAdminSession()
      const currentRow = {
        id: 'partner-1',
        name: 'Partner Name',
        imgUrl: 'https://example.com/partner.png',
        linkUrl: null,
        descEs: 'Descripción antigua',
        descEn: 'Descripción antigua',
        sortOrder: 0,
        active: true,
        createdAt: '2026-04-01T00:00:00Z',
        updatedAt: '2026-04-01T00:00:00Z',
      }
      const updated = {
        id: 'partner-1',
        name: 'Partner Name',
        imgUrl: 'https://example.com/partner.png',
        linkUrl: null,
        descEs: 'Nueva descripción',
        descEn: 'Descripción antigua',
        sortOrder: 0,
        active: true,
        createdAt: '2026-04-01T00:00:00Z',
        updatedAt: '2026-04-01T00:00:00Z',
      }
      selectMock.mockResolvedValueOnce([currentRow])
      updateMock.mockResolvedValue([updated])

      const { updatePartner } = await loadPartnersService()
      const result = await updatePartner(adminSession, 'partner-1', {
        descriptionEs: 'Nueva descripción',
        descriptionEn: 'Descripción antigua',
      })

      expect(result.descriptionEn).toBe('Descripción antigua')
    })

    it('rule 2: whitespace-only descriptionEn behaves as blank (re-enable auto-copy to new ES)', async () => {
      const adminSession = createAdminSession()
      const currentRow = {
        id: 'partner-1',
        name: 'Partner Name',
        imgUrl: 'https://example.com/partner.png',
        linkUrl: null,
        descEs: 'Descripción antigua',
        descEn: 'Old Explicit Description',
        sortOrder: 0,
        active: true,
        createdAt: '2026-04-01T00:00:00Z',
        updatedAt: '2026-04-01T00:00:00Z',
      }
      const updated = {
        id: 'partner-1',
        name: 'Partner Name',
        imgUrl: 'https://example.com/partner.png',
        linkUrl: null,
        descEs: 'Nueva descripción',
        descEn: 'Nueva descripción',
        sortOrder: 0,
        active: true,
        createdAt: '2026-04-01T00:00:00Z',
        updatedAt: '2026-04-01T00:00:00Z',
      }
      selectMock.mockResolvedValueOnce([currentRow])
      updateMock.mockResolvedValue([updated])

      const { updatePartner } = await loadPartnersService()
      const result = await updatePartner(adminSession, 'partner-1', {
        descriptionEs: 'Nueva descripción',
        descriptionEn: '   ',
      })

      expect(result.descriptionEn).toBe('Nueva descripción')
    })
  })
})
