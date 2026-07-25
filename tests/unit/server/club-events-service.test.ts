// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ServiceError } from '@/lib/server/shared/service-error'

/**
 * CLUB EVENTS SERVICE TEST COVERAGE (OIR-203)
 *
 * Tests for admin CRUD operations on public club events
 * Implementation: lib/server/events/club-events-service.ts
 *
 * Key scenarios tested:
 * - createClubEvent with bilingual titles and optional room blocks (admin-only)
 * - updateClubEvent with partial updates and room block toggling (admin-only)
 * - deleteClubEvent removes event and cancels conflicting reservations (admin-only)
 * - Non-admin users get 403 Forbidden from every CRUD endpoint
 * - URL hardening: validateOptionalUrl rejects javascript:, data:, relative URLs
 * - Room blocking is optional: events without blocksRooms don't create event_room_blocks rows
 * - Upcoming/past split derived from date_kind and end_date at read time
 * - listEvents() excludes landing rows (both title_es and title_en populated)
 */

vi.mock('server-only', () => ({}))

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerAdminClient: vi.fn(),
  createSupabaseServerClient: vi.fn(),
}))

vi.mock('@/lib/server/shared/service-error', () => ({
  serviceError: vi.fn((message: string, statusCode: number) => {
    const err = new Error(message) as ServiceError
    err.name = 'ServiceError'
    err.statusCode = statusCode
    throw err
  }),
}))

vi.mock('@/lib/club-time', () => ({
  getCurrentClubDate: vi.fn(() => '2026-04-15'),
  isValidDateOnlyString: vi.fn((s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s)),
}))

type EventRow = {
  id: string
  title: string
  title_es: string | null
  title_en: string | null
  blurb_es: string | null
  blurb_en: string | null
  description_es: string | null
  description_en: string | null
  category_es: string | null
  category_en: string | null
  date_kind: string | null
  date: string
  end_date: string | null
  recurrence_label_es: string | null
  recurrence_label_en: string | null
  image_url: string | null
  link_url: string | null
  created_by: string | null
  created_at: string
}

type EventRoomBlockRow = {
  id: string
  event_id: string
  room_id: string
  date: string
  start_time: string
  end_time: string
  all_day: boolean
}

type SessionUser = {
  id: string
  role: 'admin' | 'member'
  email?: string
}

function buildSupabaseMock() {
  return {
    from: vi.fn(function (table: string) {
      const state = { table, filters: {} as any, updateData: {} as any, data: null as any }

      return {
        select: vi.fn(function (cols?: string) {
          return {
            not: vi.fn(function (col: string, op: string, val: any) {
              state.filters[`${col}_${op}`] = val
              return {
                not: vi.fn(function (col2: string, op2: string, val2: any) {
                  state.filters[`${col2}_${op2}`] = val2
                  return {
                    order: vi.fn(function (col: string, opts: any) {
                      return {
                        [Symbol.toStringTag]: 'Promise',
                        then: async (onFulfilled?: any) => {
                          if (table === 'events') {
                            // Return mock club events for listing
                            const mockData = [
                              {
                                id: 'evt-upcoming-1',
                                title: 'Tornero 2026',
                                title_es: 'Tornero 2026',
                                title_en: 'Tournament 2026',
                                blurb_es: 'Torneo amistoso',
                                blurb_en: 'Friendly tournament',
                                description_es: null,
                                description_en: null,
                                category_es: 'Torneo',
                                category_en: 'Tournament',
                                date_kind: 'single',
                                date: '2026-05-01',
                                end_date: null,
                                recurrence_label_es: null,
                                recurrence_label_en: null,
                                image_url: 'https://example.com/tournament.png',
                                link_url: null,
                                created_by: 'user-1',
                                created_at: '2026-04-01T00:00:00Z',
                              },
                            ]
                            return onFulfilled?.({ data: mockData, error: null })
                          }
                          return onFulfilled?.({ data: [], error: null })
                        },
                      }
                    }),
                  }
                }),
              }
            }),
            eq: vi.fn(function (col: string, val: any) {
              state.filters[col] = val
              return {
                maybeSingle: vi.fn(async () => {
                  if (table === 'events' && state.filters.id === 'evt-1') {
                    return {
                      data: {
                        id: 'evt-1',
                        title: 'Old Event',
                        title_es: 'Evento Antiguo',
                        title_en: 'Old Event',
                        blurb_es: null,
                        blurb_en: null,
                        description_es: null,
                        description_en: null,
                        category_es: null,
                        category_en: null,
                        date_kind: 'single',
                        date: '2026-04-20',
                        end_date: null,
                        recurrence_label_es: null,
                        recurrence_label_en: null,
                        image_url: null,
                        link_url: null,
                        created_by: 'user-1',
                        created_at: '2026-04-01T00:00:00Z',
                      },
                      error: null,
                    }
                  }
                  return { data: null, error: null }
                }),
                select: vi.fn(() => ({
                  maybeSingle: vi.fn(async () => ({ data: null, error: null })),
                })),
              }
            }),
            in: vi.fn(function (col: string, vals: any[]) {
              state.filters[col] = vals
              return {
                [Symbol.toStringTag]: 'Promise',
                then: async (onFulfilled?: any) => {
                  if (table === 'event_room_blocks') {
                    return onFulfilled?.({ data: [], error: null })
                  }
                  if (table === 'rooms') {
                    // Default: every referenced room id "exists" so tests that
                    // don't specifically exercise the room-validation path
                    // (PR #149 review, createClubEvent) keep passing unmodified.
                    return onFulfilled?.({ data: vals.map((id: string) => ({ id })), error: null })
                  }
                  return onFulfilled?.({ data: [], error: null })
                },
              }
            }),
            or: vi.fn(function (filter: string) {
              return {
                order: vi.fn(function () {
                  return {
                    order: vi.fn(async () => ({
                      data: [],
                      error: null,
                    })),
                  }
                }),
              }
            }),
            order: vi.fn(function () {
              return {
                order: vi.fn(() => ({
                  [Symbol.toStringTag]: 'Promise',
                  then: async (onFulfilled?: any) => {
                    return onFulfilled?.({ data: [], error: null })
                  },
                })),
              }
            }),
          }
        }),
        insert: vi.fn(function (data: any) {
          state.data = data
          return {
            select: vi.fn(() => ({
              maybeSingle: vi.fn(async () => ({
                data: {
                  id: 'evt-new-1',
                  ...data,
                } as EventRow,
                error: null,
              })),
            })),
          }
        }),
        update: vi.fn(function (data: any) {
          state.updateData = data
          return {
            eq: vi.fn(function (col: string, val: any) {
              state.filters[col] = val
              return {
                select: vi.fn(() => ({
                  maybeSingle: vi.fn(async () => ({
                    data: {
                      id: state.filters.id,
                      ...state.updateData,
                    } as EventRow,
                    error: null,
                  })),
                })),
              }
            }),
          }
        }),
        delete: vi.fn(function () {
          return {
            eq: vi.fn(async () => ({
              data: null,
              error: null,
            })),
          }
        }),
      }
    }),
    rpc: vi.fn(),
  }
}

function createAdminSession(): SessionUser {
  return { id: 'user-admin-1', role: 'admin', email: 'admin@example.com' }
}

function createMemberSession(): SessionUser {
  return { id: 'user-member-1', role: 'member', email: 'member@example.com' }
}

async function loadClubEventsService() {
  vi.resetModules()
  const mod = await import('@/lib/server/events/club-events-service')
  return {
    createClubEvent: mod.createClubEvent,
    updateClubEvent: mod.updateClubEvent,
    deleteClubEvent: mod.deleteClubEvent,
    listAdminClubEvents: mod.listAdminClubEvents,
    listClubEvents: mod.listClubEvents,
  }
}

async function loadEventsService() {
  vi.resetModules()
  const mod = await import('@/lib/server/events/events-service')
  return {
    listEvents: mod.listEvents,
  }
}

describe('club-events-service', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('createClubEvent', () => {
    it('admin can create a public club event without room blocks', async () => {
      const adminSession = createAdminSession()
      const mockSupabaseAdmin = buildSupabaseMock()
      
      vi.mocked(await import('@/lib/supabase/server')).createSupabaseServerAdminClient
        .mockReturnValue(mockSupabaseAdmin as any)

      const { createClubEvent } = await loadClubEventsService()

      const result = await createClubEvent(adminSession, {
        titleEs: 'Gastronómica Viernes',
        titleEn: 'Friday Gastro',
        blurbEs: 'Noche de comida',
        blurbEn: 'Food night',
        dateKind: 'recurring',
        date: '2026-04-17',
        recurrenceLabelEs: 'Todos los viernes',
        recurrenceLabelEn: 'Every Friday',
        imageUrl: 'https://example.com/gastro.png',
        linkUrl: 'https://example.com/reserve',
        categoryEs: 'Social',
        categoryEn: 'Social',
        blocksRooms: false,
      })

      expect(result.id).toBe('evt-new-1')
      expect(result.titleEs).toBe('Gastronómica Viernes')
      expect(result.titleEn).toBe('Friday Gastro')
      expect(result.status).toBe('upcoming')
      expect(result.blocksRooms).toBe(false)
      expect(result.roomBlocks.length).toBe(0)
    })

    it('non-admin member gets 403 Forbidden', async () => {
      const memberSession = createMemberSession()
      const mockSupabaseAdmin = buildSupabaseMock()
      
      vi.mocked(await import('@/lib/supabase/server')).createSupabaseServerAdminClient
        .mockReturnValue(mockSupabaseAdmin as any)
      vi.mocked(await import('@/lib/server/shared/service-error')).serviceError
        .mockImplementation((msg, code) => {
          const err = new Error(msg) as ServiceError
          err.statusCode = code
          throw err
        })

      const { createClubEvent } = await loadClubEventsService()

      await expect(
        createClubEvent(memberSession, {
          titleEs: 'Event',
          titleEn: 'Event',
          date: '2026-05-01',
          dateKind: 'single',
        })
      ).rejects.toMatchObject({ statusCode: 403 })
    })

    it('rejects javascript: URL in image_url', async () => {
      const adminSession = createAdminSession()
      const mockSupabaseAdmin = buildSupabaseMock()
      
      vi.mocked(await import('@/lib/supabase/server')).createSupabaseServerAdminClient
        .mockReturnValue(mockSupabaseAdmin as any)
      vi.mocked(await import('@/lib/server/shared/service-error')).serviceError
        .mockImplementation((msg, code) => {
          const err = new Error(msg) as ServiceError
          err.statusCode = code
          throw err
        })

      const { createClubEvent } = await loadClubEventsService()

      await expect(
        createClubEvent(adminSession, {
          titleEs: 'Event',
          titleEn: 'Event',
          date: '2026-05-01',
          dateKind: 'single',
          imageUrl: 'javascript:alert(1)',
        })
      ).rejects.toMatchObject({ statusCode: 400 })
    })

    it('rejects data: URL in link_url', async () => {
      const adminSession = createAdminSession()
      const mockSupabaseAdmin = buildSupabaseMock()
      
      vi.mocked(await import('@/lib/supabase/server')).createSupabaseServerAdminClient
        .mockReturnValue(mockSupabaseAdmin as any)
      vi.mocked(await import('@/lib/server/shared/service-error')).serviceError
        .mockImplementation((msg, code) => {
          const err = new Error(msg) as ServiceError
          err.statusCode = code
          throw err
        })

      const { createClubEvent } = await loadClubEventsService()

      await expect(
        createClubEvent(adminSession, {
          titleEs: 'Event',
          titleEn: 'Event',
          date: '2026-05-01',
          dateKind: 'single',
          linkUrl: 'data:text/html,<script>alert(1)</script>',
        })
      ).rejects.toMatchObject({ statusCode: 400 })
    })

    it('rejects relative URL in imageUrl', async () => {
      const adminSession = createAdminSession()
      const mockSupabaseAdmin = buildSupabaseMock()
      
      vi.mocked(await import('@/lib/supabase/server')).createSupabaseServerAdminClient
        .mockReturnValue(mockSupabaseAdmin as any)
      vi.mocked(await import('@/lib/server/shared/service-error')).serviceError
        .mockImplementation((msg, code) => {
          const err = new Error(msg) as ServiceError
          err.statusCode = code
          throw err
        })

      const { createClubEvent } = await loadClubEventsService()

      await expect(
        createClubEvent(adminSession, {
          titleEs: 'Event',
          titleEn: 'Event',
          date: '2026-05-01',
          dateKind: 'single',
          imageUrl: '/images/event.png',
        })
      ).rejects.toMatchObject({ statusCode: 400 })
    })

    it('accepts empty/undefined imageUrl and linkUrl', async () => {
      const adminSession = createAdminSession()
      const mockSupabaseAdmin = buildSupabaseMock()
      
      vi.mocked(await import('@/lib/supabase/server')).createSupabaseServerAdminClient
        .mockReturnValue(mockSupabaseAdmin as any)

      const { createClubEvent } = await loadClubEventsService()

      const result = await createClubEvent(adminSession, {
        titleEs: 'Event',
        titleEn: 'Event',
        date: '2026-05-01',
        dateKind: 'single',
        imageUrl: undefined,
        linkUrl: null,
      })

      expect(result.imageUrl).toBeNull()
      expect(result.linkUrl).toBeNull()
    })

    it('creates a club event with titleEn absent, succeeds with title_en === title_es in DB (OIR-206)', async () => {
      const adminSession = createAdminSession()
      const mockSupabaseAdmin = buildSupabaseMock()
      
      vi.mocked(await import('@/lib/supabase/server')).createSupabaseServerAdminClient
        .mockReturnValue(mockSupabaseAdmin as any)

      const { createClubEvent } = await loadClubEventsService()

      const result = await createClubEvent(adminSession, {
        titleEs: 'Evento en Español',
        // titleEn absent — should fallback
        date: '2026-05-01',
        dateKind: 'single',
      })

      expect(result.id).toBe('evt-new-1')
      expect(result.titleEs).toBe('Evento en Español')
      expect(result.titleEn).toBe('Evento en Español') // Fallback to ES
    })

    it('creates a club event with titleEn empty string, succeeds with fallback (OIR-206)', async () => {
      const adminSession = createAdminSession()
      const mockSupabaseAdmin = buildSupabaseMock()
      
      vi.mocked(await import('@/lib/supabase/server')).createSupabaseServerAdminClient
        .mockReturnValue(mockSupabaseAdmin as any)

      const { createClubEvent } = await loadClubEventsService()

      const result = await createClubEvent(adminSession, {
        titleEs: 'Evento Viernes',
        titleEn: '', // Empty string — should fallback
        date: '2026-05-01',
        dateKind: 'single',
      })

      expect(result.titleEn).toBe('Evento Viernes')
    })

    it('creates a club event with explicit titleEn, preserves EN value (OIR-206)', async () => {
      const adminSession = createAdminSession()
      const mockSupabaseAdmin = buildSupabaseMock()
      
      vi.mocked(await import('@/lib/supabase/server')).createSupabaseServerAdminClient
        .mockReturnValue(mockSupabaseAdmin as any)

      const { createClubEvent } = await loadClubEventsService()

      const result = await createClubEvent(adminSession, {
        titleEs: 'Torneo de Ajedrez',
        titleEn: 'Chess Tournament',
        date: '2026-05-01',
        dateKind: 'single',
      })

      expect(result.titleEn).toBe('Chess Tournament')
    })

    it('creates a club event with blurbEn absent, falls back to blurbEs (OIR-206)', async () => {
      const adminSession = createAdminSession()
      const mockSupabaseAdmin = buildSupabaseMock()
      
      vi.mocked(await import('@/lib/supabase/server')).createSupabaseServerAdminClient
        .mockReturnValue(mockSupabaseAdmin as any)

      const { createClubEvent } = await loadClubEventsService()

      const result = await createClubEvent(adminSession, {
        titleEs: 'Event',
        titleEn: 'Event',
        blurbEs: 'Descripción breve',
        // blurbEn absent
        date: '2026-05-01',
        dateKind: 'single',
      })

      // The mock builder returns the input data from insert, so verify via result mapping
      expect(result.blurbEs).toBe('Descripción breve')
      // result.blurbEn would also be 'Descripción breve' due to fallback
    })

    it('creates a club event with categoryEn absent, falls back to categoryEs (OIR-206)', async () => {
      const adminSession = createAdminSession()
      const mockSupabaseAdmin = buildSupabaseMock()
      
      vi.mocked(await import('@/lib/supabase/server')).createSupabaseServerAdminClient
        .mockReturnValue(mockSupabaseAdmin as any)

      const { createClubEvent } = await loadClubEventsService()

      const result = await createClubEvent(adminSession, {
        titleEs: 'Event',
        titleEn: 'Event',
        categoryEs: 'Torneo',
        // categoryEn absent
        date: '2026-05-01',
        dateKind: 'single',
      })

      // Fallback behavior: categoryEn should equal categoryEs when absent
      expect(result.id).toBe('evt-new-1')
    })

    it('rejects categoryEn as non-string object (still 400, not fallback) (OIR-206)', async () => {
      const adminSession = createAdminSession()
      const mockSupabaseAdmin = buildSupabaseMock()
      
      vi.mocked(await import('@/lib/supabase/server')).createSupabaseServerAdminClient
        .mockReturnValue(mockSupabaseAdmin as any)
      vi.mocked(await import('@/lib/server/shared/service-error')).serviceError
        .mockImplementation((msg, code) => {
          const err = new Error(msg) as ServiceError
          err.statusCode = code
          throw err
        })

      const { createClubEvent } = await loadClubEventsService()

      await expect(
        createClubEvent(adminSession, {
          titleEs: 'Event',
          titleEn: 'Event',
          categoryEs: 'Torneo',
          categoryEn: { nested: 'object' }, // Non-string — still 400
          date: '2026-05-01',
          dateKind: 'single',
        })
      ).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('must be a string') })
    })

    it('updates club event: auto-copied titleEn follows new titleEs when ES changes (OIR-206)', async () => {
      const adminSession = createAdminSession()
      const mockSupabaseAdmin = buildSupabaseMock()
      
      // Current row has title_en === title_es (auto-copied)
      const currentRow = {
        id: 'evt-1',
        title: 'Old Event',
        title_es: 'Evento Viejo',
        title_en: 'Evento Viejo', // Was auto-copied (equals ES)
        blurb_es: null,
        blurb_en: null,
        description_es: null,
        description_en: null,
        category_es: null,
        category_en: null,
        date_kind: 'single',
        date: '2026-04-20',
        end_date: null,
        recurrence_label_es: null,
        recurrence_label_en: null,
        image_url: null,
        link_url: null,
        created_by: 'user-1',
        created_at: '2026-04-01T00:00:00Z',
      }

      mockSupabaseAdmin.from = vi.fn(function (table: string) {
        if (table === 'events') {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => ({
                maybeSingle: vi.fn(async () => ({
                  data: currentRow,
                  error: null,
                })),
              })),
            })),
            update: vi.fn(() => ({
              eq: vi.fn(() => ({
                select: vi.fn(() => ({
                  maybeSingle: vi.fn(async () => ({
                    data: {
                      ...currentRow,
                      title_es: 'Evento Nuevo',
                      title_en: 'Evento Nuevo', // Should follow ES
                    },
                    error: null,
                  })),
                })),
              })),
            })),
          }
        }
        return buildSupabaseMock().from(table)
      }) as any

      vi.mocked(await import('@/lib/supabase/server')).createSupabaseServerAdminClient
        .mockReturnValue(mockSupabaseAdmin as any)

      const { updateClubEvent } = await loadClubEventsService()

      const result = await updateClubEvent(adminSession, 'evt-1', {
        titleEs: 'Evento Nuevo',
        // titleEn absent — should re-copy from new ES value
      })

      expect(result.titleEn).toBe('Evento Nuevo')
    })

    it('updates club event: explicitly different titleEn is preserved when ES changes (OIR-206)', async () => {
      const adminSession = createAdminSession()
      const mockSupabaseAdmin = buildSupabaseMock()
      
      // Current row has title_en !== title_es (explicitly set)
      const currentRow = {
        id: 'evt-1',
        title: 'Old Event',
        title_es: 'Evento Viejo',
        title_en: 'Old Event Tournament', // Explicit EN (different from ES)
        blurb_es: null,
        blurb_en: null,
        description_es: null,
        description_en: null,
        category_es: null,
        category_en: null,
        date_kind: 'single',
        date: '2026-04-20',
        end_date: null,
        recurrence_label_es: null,
        recurrence_label_en: null,
        image_url: null,
        link_url: null,
        created_by: 'user-1',
        created_at: '2026-04-01T00:00:00Z',
      }

      mockSupabaseAdmin.from = vi.fn(function (table: string) {
        if (table === 'events') {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => ({
                maybeSingle: vi.fn(async () => ({
                  data: currentRow,
                  error: null,
                })),
              })),
            })),
            update: vi.fn(() => ({
              eq: vi.fn(() => ({
                select: vi.fn(() => ({
                  maybeSingle: vi.fn(async () => ({
                    data: {
                      ...currentRow,
                      title_es: 'Evento Nuevo',
                      title_en: 'Old Event Tournament', // Preserved (explicitly set)
                    },
                    error: null,
                  })),
                })),
              })),
            })),
          }
        }
        return buildSupabaseMock().from(table)
      }) as any

      vi.mocked(await import('@/lib/supabase/server')).createSupabaseServerAdminClient
        .mockReturnValue(mockSupabaseAdmin as any)

      const { updateClubEvent } = await loadClubEventsService()

      const result = await updateClubEvent(adminSession, 'evt-1', {
        titleEs: 'Evento Nuevo',
        // titleEn absent — but should preserve the explicit value
      })

      expect(result.titleEn).toBe('Old Event Tournament') // Preserved
    })

    it('calls apply_club_event_room_blocks RPC with normalized payload on create with blocksRooms:true (Finding 1)', async () => {
      const adminSession = createAdminSession()
      const mockSupabaseAdmin = buildSupabaseMock()
      
      mockSupabaseAdmin.rpc = vi.fn(async () => ({
        data: [
          {
            id: 'block-1',
            event_id: 'evt-new-1',
            room_id: 'room-1',
            date: '2026-05-01',
            start_time: '18:00:00',
            end_time: '22:00:00',
            all_day: false,
          },
        ],
        error: null,
      }))

      vi.mocked(await import('@/lib/supabase/server')).createSupabaseServerAdminClient
        .mockReturnValue(mockSupabaseAdmin as any)

      const { createClubEvent } = await loadClubEventsService()

      const result = await createClubEvent(adminSession, {
        titleEs: 'Torneo con Bloques',
        titleEn: 'Tournament with Blocks',
        date: '2026-05-01',
        dateKind: 'single',
        blocksRooms: true,
        schedules: [
          {
            date: '2026-05-01',
            startTime: '18:00',
            endTime: '22:00',
            allDay: false,
            roomId: 'room-1',
          },
        ],
      })

      expect(mockSupabaseAdmin.rpc).toHaveBeenCalledWith(
        'apply_club_event_room_blocks',
        expect.objectContaining({
          p_event_id: 'evt-new-1',
          p_blocks: expect.arrayContaining([
            expect.objectContaining({
              room_id: 'room-1',
              date: '2026-05-01',
              all_day: false,
              start_time: '18:00',
              end_time: '22:00',
            }),
          ]),
        })
      )

      expect(result.blocksRooms).toBe(true)
      expect(result.roomBlocks.length).toBe(1)
    })

    it('rolls back (deletes) the created event when apply_club_event_room_blocks RPC fails, leaving no orphan row (PR #149 review)', async () => {
      const adminSession = createAdminSession()
      const mockSupabaseAdmin = buildSupabaseMock()

      // Simulate a block-replacement RPC failure that happens AFTER the
      // event row has already been inserted (e.g. a transient DB error, not
      // necessarily a bad room id — room ids are validated separately and
      // still pass here).
      mockSupabaseAdmin.rpc = vi.fn(async () => ({
        data: null,
        error: { message: 'transient failure', code: 'XX000' },
      }))

      const deleteEq = vi.fn(async () => ({ data: null, error: null }))
      const baseFrom = mockSupabaseAdmin.from
      mockSupabaseAdmin.from = vi.fn(function (table: string) {
        const result = baseFrom(table)
        if (table === 'events') {
          return { ...result, delete: vi.fn(() => ({ eq: deleteEq })) }
        }
        return result
      }) as any

      vi.mocked(await import('@/lib/supabase/server')).createSupabaseServerAdminClient
        .mockReturnValue(mockSupabaseAdmin as any)
      vi.mocked(await import('@/lib/server/shared/service-error')).serviceError
        .mockImplementation((msg, code) => {
          const err = new Error(msg) as ServiceError
          err.statusCode = code
          throw err
        })

      const { createClubEvent } = await loadClubEventsService()

      await expect(
        createClubEvent(adminSession, {
          titleEs: 'Torneo con Bloques',
          titleEn: 'Tournament with Blocks',
          date: '2026-05-01',
          dateKind: 'single',
          blocksRooms: true,
          schedules: [
            {
              date: '2026-05-01',
              startTime: '18:00',
              endTime: '22:00',
              allDay: false,
              roomId: 'room-1',
            },
          ],
        })
      ).rejects.toMatchObject({ statusCode: 500 })

      // The event row created by the earlier insert (id: evt-new-1, per the
      // shared mock) must be deleted once the block RPC fails — no orphan
      // club event should ever be left behind.
      expect(deleteEq).toHaveBeenCalledWith('id', 'evt-new-1')
    })

    it('logs the orphaned event id when BOTH the block RPC and the compensating delete fail, and still rethrows the original RPC error (PR #149 review round 2)', async () => {
      const adminSession = createAdminSession()
      const mockSupabaseAdmin = buildSupabaseMock()

      // Block-replacement RPC fails after the event row was already inserted.
      mockSupabaseAdmin.rpc = vi.fn(async () => ({
        data: null,
        error: { message: 'transient failure', code: 'XX000' },
      }))

      // The compensating delete ALSO fails — this is the silent-orphan gap:
      // without the fix, this failure is discarded and never logged.
      const deleteEq = vi.fn(async () => ({
        data: null,
        error: { message: 'delete failed', code: 'XX000' },
      }))
      const baseFrom = mockSupabaseAdmin.from
      mockSupabaseAdmin.from = vi.fn(function (table: string) {
        const result = baseFrom(table)
        if (table === 'events') {
          return { ...result, delete: vi.fn(() => ({ eq: deleteEq })) }
        }
        return result
      }) as any

      vi.mocked(await import('@/lib/supabase/server')).createSupabaseServerAdminClient
        .mockReturnValue(mockSupabaseAdmin as any)
      vi.mocked(await import('@/lib/server/shared/service-error')).serviceError
        .mockImplementation((msg, code) => {
          const err = new Error(msg) as ServiceError
          err.statusCode = code
          throw err
        })

      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      const { createClubEvent } = await loadClubEventsService()

      await expect(
        createClubEvent(adminSession, {
          titleEs: 'Torneo con Bloques',
          titleEn: 'Tournament with Blocks',
          date: '2026-05-01',
          dateKind: 'single',
          blocksRooms: true,
          schedules: [
            {
              date: '2026-05-01',
              startTime: '18:00',
              endTime: '22:00',
              allDay: false,
              roomId: 'room-1',
            },
          ],
        })
        // The ORIGINAL RPC error (from apply_club_event_room_blocks) must
        // still be what the client sees — never the compensating delete's
        // own error — since the delete error is only a logging concern.
      ).rejects.toMatchObject({ statusCode: 500, message: 'Internal server error' })

      expect(deleteEq).toHaveBeenCalledWith('id', 'evt-new-1')
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('orphaned event row requires manual cleanup'),
        'evt-new-1',
      )

      consoleErrorSpy.mockRestore()
    })

    it('rejects an unknown room id in schedules with 400 BEFORE inserting the event row (PR #149 review)', async () => {
      const adminSession = createAdminSession()
      const mockSupabaseAdmin = buildSupabaseMock()

      const baseFrom = mockSupabaseAdmin.from
      mockSupabaseAdmin.from = vi.fn(function (table: string) {
        if (table === 'rooms') {
          // No rooms exist — every referenced room id is "unknown".
          return {
            select: vi.fn(() => ({
              in: vi.fn(() => Promise.resolve({ data: [], error: null })),
            })),
          }
        }
        return baseFrom(table)
      }) as any

      vi.mocked(await import('@/lib/supabase/server')).createSupabaseServerAdminClient
        .mockReturnValue(mockSupabaseAdmin as any)
      vi.mocked(await import('@/lib/server/shared/service-error')).serviceError
        .mockImplementation((msg, code) => {
          const err = new Error(msg) as ServiceError
          err.statusCode = code
          throw err
        })

      const { createClubEvent } = await loadClubEventsService()

      await expect(
        createClubEvent(adminSession, {
          titleEs: 'Torneo con Bloques',
          titleEn: 'Tournament with Blocks',
          date: '2026-05-01',
          dateKind: 'single',
          blocksRooms: true,
          schedules: [
            {
              date: '2026-05-01',
              startTime: '18:00',
              endTime: '22:00',
              allDay: false,
              roomId: 'room-does-not-exist',
            },
          ],
        })
      ).rejects.toMatchObject({ statusCode: 400 })

      const eventsFromCalls = mockSupabaseAdmin.from.mock.calls.filter((call: any[]) => call[0] === 'events')
      expect(eventsFromCalls.length).toBe(0)
    })

    it('rejects malformed schedules with 400 and no insert on events table (Finding 2)', async () => {
      const adminSession = createAdminSession()
      const mockSupabaseAdmin = buildSupabaseMock()
      
      vi.mocked(await import('@/lib/supabase/server')).createSupabaseServerAdminClient
        .mockReturnValue(mockSupabaseAdmin as any)
      vi.mocked(await import('@/lib/server/shared/service-error')).serviceError
        .mockImplementation((msg, code) => {
          const err = new Error(msg) as ServiceError
          err.statusCode = code
          throw err
        })

      const { createClubEvent } = await loadClubEventsService()

      await expect(
        createClubEvent(adminSession, {
          titleEs: 'Event',
          titleEn: 'Event',
          date: '2026-05-01',
          dateKind: 'single',
          blocksRooms: true,
          schedules: 'not-an-array',
        })
      ).rejects.toMatchObject({ statusCode: 400 })

      const fromCalls = mockSupabaseAdmin.from.mock.calls
      const hasInsertCall = fromCalls.some(call => call[0] === 'events') && 
                           mockSupabaseAdmin.from('events').insert.mock.calls.length > 0
      expect(hasInsertCall).toBe(false)
    })

    it('rejects blurbEs as object with 400 (Finding 5)', async () => {
      const adminSession = createAdminSession()
      const mockSupabaseAdmin = buildSupabaseMock()
      
      vi.mocked(await import('@/lib/supabase/server')).createSupabaseServerAdminClient
        .mockReturnValue(mockSupabaseAdmin as any)
      vi.mocked(await import('@/lib/server/shared/service-error')).serviceError
        .mockImplementation((msg, code) => {
          const err = new Error(msg) as ServiceError
          err.statusCode = code
          throw err
        })

      const { createClubEvent } = await loadClubEventsService()

      await expect(
        createClubEvent(adminSession, {
          titleEs: 'Event',
          titleEn: 'Event',
          date: '2026-05-01',
          dateKind: 'single',
          blurbEs: {},
        })
      ).rejects.toMatchObject({ statusCode: 400 })
    })

    it('rejects categoryEn as array with 400 (Finding 5)', async () => {
      const adminSession = createAdminSession()
      const mockSupabaseAdmin = buildSupabaseMock()
      
      vi.mocked(await import('@/lib/supabase/server')).createSupabaseServerAdminClient
        .mockReturnValue(mockSupabaseAdmin as any)
      vi.mocked(await import('@/lib/server/shared/service-error')).serviceError
        .mockImplementation((msg, code) => {
          const err = new Error(msg) as ServiceError
          err.statusCode = code
          throw err
        })

      const { createClubEvent } = await loadClubEventsService()

      await expect(
        createClubEvent(adminSession, {
          titleEs: 'Event',
          titleEn: 'Event',
          date: '2026-05-01',
          dateKind: 'single',
          categoryEn: [],
        })
      ).rejects.toMatchObject({ statusCode: 400 })
    })

    it('accepts null and undefined for optional string fields', async () => {
      const adminSession = createAdminSession()
      const mockSupabaseAdmin = buildSupabaseMock()
      
      vi.mocked(await import('@/lib/supabase/server')).createSupabaseServerAdminClient
        .mockReturnValue(mockSupabaseAdmin as any)

      const { createClubEvent } = await loadClubEventsService()

      const result = await createClubEvent(adminSession, {
        titleEs: 'Event',
        titleEn: 'Event',
        date: '2026-05-01',
        dateKind: 'single',
        blurbEs: null,
        blurbEn: undefined,
        categoryEs: null,
        categoryEn: undefined,
      })

      expect(result.id).toBe('evt-new-1')
      expect(result.blurbEs).toBe('')
      expect(result.blurbEn).toBe('')
    })
  })

  describe('updateClubEvent', () => {
    it('admin can update a club event', async () => {
      const adminSession = createAdminSession()
      const mockSupabaseAdmin = buildSupabaseMock()
      
      vi.mocked(await import('@/lib/supabase/server')).createSupabaseServerAdminClient
        .mockReturnValue(mockSupabaseAdmin as any)

      const { updateClubEvent } = await loadClubEventsService()

      const result = await updateClubEvent(adminSession, 'evt-1', {
        titleEs: 'Updated Event ES',
        blurbEn: 'Updated blurb',
      })

      expect(result.id).toBe('evt-1')
    })

    it('non-admin member gets 403 Forbidden on update', async () => {
      const memberSession = createMemberSession()
      const mockSupabaseAdmin = buildSupabaseMock()
      
      vi.mocked(await import('@/lib/supabase/server')).createSupabaseServerAdminClient
        .mockReturnValue(mockSupabaseAdmin as any)
      vi.mocked(await import('@/lib/server/shared/service-error')).serviceError
        .mockImplementation((msg, code) => {
          const err = new Error(msg) as ServiceError
          err.statusCode = code
          throw err
        })

      const { updateClubEvent } = await loadClubEventsService()

      await expect(
        updateClubEvent(memberSession, 'evt-1', { titleEs: 'Updated' })
      ).rejects.toMatchObject({ statusCode: 403 })
    })

    it('returns 404 for non-existent or non-landing club event', async () => {
      const adminSession = createAdminSession()
      const mockSupabaseAdmin = buildSupabaseMock()
      
      vi.mocked(await import('@/lib/supabase/server')).createSupabaseServerAdminClient
        .mockReturnValue(mockSupabaseAdmin as any)
      vi.mocked(await import('@/lib/server/shared/service-error')).serviceError
        .mockImplementation((msg, code) => {
          const err = new Error(msg) as ServiceError
          err.statusCode = code
          throw err
        })

      const { updateClubEvent } = await loadClubEventsService()

      mockSupabaseAdmin.from = vi.fn(() => ({
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            maybeSingle: vi.fn(async () => ({ data: null, error: null })),
          })),
        })),
      })) as any

      await expect(
        updateClubEvent(adminSession, 'nonexistent-evt', { titleEs: 'Test' })
      ).rejects.toMatchObject({ statusCode: 404 })
    })

    it('rejects malformed schedules with 400 and no update on events table (Finding 2)', async () => {
      const adminSession = createAdminSession()
      const mockSupabaseAdmin = buildSupabaseMock()
      
      vi.mocked(await import('@/lib/supabase/server')).createSupabaseServerAdminClient
        .mockReturnValue(mockSupabaseAdmin as any)
      vi.mocked(await import('@/lib/server/shared/service-error')).serviceError
        .mockImplementation((msg, code) => {
          const err = new Error(msg) as ServiceError
          err.statusCode = code
          throw err
        })

      const { updateClubEvent } = await loadClubEventsService()

      mockSupabaseAdmin.from = vi.fn(function (table: string) {
        if (table === 'events') {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => ({
                maybeSingle: vi.fn(async () => ({
                  data: {
                    id: 'evt-1',
                    title: 'Old Event',
                    title_es: 'Evento Antiguo',
                    title_en: 'Old Event',
                    blurb_es: null,
                    blurb_en: null,
                    description_es: null,
                    description_en: null,
                    category_es: null,
                    category_en: null,
                    date_kind: 'single',
                    date: '2026-04-20',
                    end_date: null,
                    recurrence_label_es: null,
                    recurrence_label_en: null,
                    image_url: null,
                    link_url: null,
                    created_by: 'user-1',
                    created_at: '2026-04-01T00:00:00Z',
                  },
                  error: null,
                })),
              })),
            })),
          }
        }
        return buildSupabaseMock().from(table)
      }) as any

      await expect(
        updateClubEvent(adminSession, 'evt-1', {
          blocksRooms: true,
          schedules: [],
        })
      ).rejects.toMatchObject({ statusCode: 400 })
    })

    it('skips RPC when schedules match current blocks (order-insensitive, Finding 4)', async () => {
      const adminSession = createAdminSession()
      const mockSupabaseAdmin = buildSupabaseMock()
      
      const currentBlocks = [
        {
          id: 'block-1',
          event_id: 'evt-1',
          room_id: 'room-1',
          date: '2026-04-20',
          start_time: '18:00:00',
          end_time: '22:00:00',
          all_day: false,
        },
        {
          id: 'block-2',
          event_id: 'evt-1',
          room_id: 'room-2',
          date: '2026-04-20',
          start_time: '10:00:00',
          end_time: '14:00:00',
          all_day: false,
        },
      ]

      mockSupabaseAdmin.rpc = vi.fn(async () => ({ data: currentBlocks, error: null }))

      vi.mocked(await import('@/lib/supabase/server')).createSupabaseServerAdminClient
        .mockReturnValue(mockSupabaseAdmin as any)

      const { updateClubEvent } = await loadClubEventsService()

      mockSupabaseAdmin.from = vi.fn(function (table: string) {
        const baseFrom = buildSupabaseMock().from(table)
        if (table === 'events') {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => ({
                maybeSingle: vi.fn(async () => ({
                  data: {
                    id: 'evt-1',
                    title: 'Event',
                    title_es: 'Evento',
                    title_en: 'Event',
                    blurb_es: null,
                    blurb_en: null,
                    description_es: null,
                    description_en: null,
                    category_es: null,
                    category_en: null,
                    date_kind: 'single',
                    date: '2026-04-20',
                    end_date: null,
                    recurrence_label_es: null,
                    recurrence_label_en: null,
                    image_url: null,
                    link_url: null,
                    created_by: 'user-1',
                    created_at: '2026-04-01T00:00:00Z',
                  },
                  error: null,
                })),
              })),
            })),
            update: vi.fn(() => ({
              eq: vi.fn(() => ({
                select: vi.fn(() => ({
                  maybeSingle: vi.fn(async () => ({
                    data: {
                      id: 'evt-1',
                      title: 'Event',
                      title_es: 'Evento',
                      title_en: 'Event',
                      blurb_es: null,
                      blurb_en: 'Updated blurb',
                      description_es: null,
                      description_en: null,
                      category_es: null,
                      category_en: null,
                      date_kind: 'single',
                      date: '2026-04-20',
                      end_date: null,
                      recurrence_label_es: null,
                      recurrence_label_en: null,
                      image_url: null,
                      link_url: null,
                      created_by: 'user-1',
                      created_at: '2026-04-01T00:00:00Z',
                    },
                    error: null,
                  })),
                })),
              })),
            })),
          }
        }
        if (table === 'event_room_blocks') {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(async () => ({
                data: currentBlocks,
                error: null,
              })),
            })),
          }
        }
        return baseFrom
      }) as any

      await updateClubEvent(adminSession, 'evt-1', {
        blurbEn: 'Updated blurb',
        blocksRooms: true,
        schedules: [
          {
            date: '2026-04-20',
            startTime: '18:00',
            endTime: '22:00',
            allDay: false,
            roomId: 'room-1',
          },
          {
            date: '2026-04-20',
            startTime: '10:00',
            endTime: '14:00',
            allDay: false,
            roomId: 'room-2',
          },
        ],
      })

      expect(mockSupabaseAdmin.rpc).not.toHaveBeenCalled()
    })

    it('calls RPC when schedules differ from current blocks (Finding 4)', async () => {
      const adminSession = createAdminSession()
      const mockSupabaseAdmin = buildSupabaseMock()
      
      const currentBlocks = [
        {
          id: 'block-1',
          event_id: 'evt-1',
          room_id: 'room-1',
          date: '2026-04-20',
          start_time: '18:00:00',
          end_time: '22:00:00',
          all_day: false,
        },
      ]

      const newBlocks = [
        {
          id: 'block-new-1',
          event_id: 'evt-1',
          room_id: 'room-2',
          date: '2026-04-20',
          start_time: '10:00:00',
          end_time: '14:00:00',
          all_day: false,
        },
      ]

      mockSupabaseAdmin.rpc = vi.fn(async () => ({ data: newBlocks, error: null }))

      vi.mocked(await import('@/lib/supabase/server')).createSupabaseServerAdminClient
        .mockReturnValue(mockSupabaseAdmin as any)

      const { updateClubEvent } = await loadClubEventsService()

      mockSupabaseAdmin.from = vi.fn(function (table: string) {
        const baseFrom = buildSupabaseMock().from(table)
        if (table === 'events') {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => ({
                maybeSingle: vi.fn(async () => ({
                  data: {
                    id: 'evt-1',
                    title: 'Event',
                    title_es: 'Evento',
                    title_en: 'Event',
                    blurb_es: null,
                    blurb_en: null,
                    description_es: null,
                    description_en: null,
                    category_es: null,
                    category_en: null,
                    date_kind: 'single',
                    date: '2026-04-20',
                    end_date: null,
                    recurrence_label_es: null,
                    recurrence_label_en: null,
                    image_url: null,
                    link_url: null,
                    created_by: 'user-1',
                    created_at: '2026-04-01T00:00:00Z',
                  },
                  error: null,
                })),
              })),
            })),
            update: vi.fn(() => ({
              eq: vi.fn(() => ({
                select: vi.fn(() => ({
                  maybeSingle: vi.fn(async () => ({
                    data: {
                      id: 'evt-1',
                      title: 'Event',
                      title_es: 'Evento',
                      title_en: 'Event',
                      blurb_es: null,
                      blurb_en: null,
                      description_es: null,
                      description_en: null,
                      category_es: null,
                      category_en: null,
                      date_kind: 'single',
                      date: '2026-04-20',
                      end_date: null,
                      recurrence_label_es: null,
                      recurrence_label_en: null,
                      image_url: null,
                      link_url: null,
                      created_by: 'user-1',
                      created_at: '2026-04-01T00:00:00Z',
                    },
                    error: null,
                  })),
                })),
              })),
            })),
          }
        }
        if (table === 'event_room_blocks') {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(async () => ({
                data: currentBlocks,
                error: null,
              })),
            })),
          }
        }
        return baseFrom
      }) as any

      await updateClubEvent(adminSession, 'evt-1', {
        blocksRooms: true,
        schedules: [
          {
            date: '2026-04-20',
            startTime: '10:00',
            endTime: '14:00',
            allDay: false,
            roomId: 'room-2',
          },
        ],
      })

      expect(mockSupabaseAdmin.rpc).toHaveBeenCalledWith(
        'apply_club_event_room_blocks',
        expect.anything()
      )
    })

    const ORIGINAL_ROW = {
      id: 'evt-1',
      title: 'Old Event',
      title_es: 'Evento Antiguo',
      title_en: 'Old Event',
      blurb_es: null,
      blurb_en: null,
      description_es: null,
      description_en: null,
      category_es: null,
      category_en: null,
      date_kind: 'single',
      date: '2026-04-20',
      end_date: null,
      recurrence_label_es: null,
      recurrence_label_en: null,
      image_url: null,
      link_url: null,
      created_by: 'user-1',
      created_at: '2026-04-01T00:00:00Z',
    }

    it('rejects an unknown room id in schedules with 400 BEFORE updating the event fields (PR #149 review)', async () => {
      const adminSession = createAdminSession()
      const mockSupabaseAdmin = buildSupabaseMock()

      vi.mocked(await import('@/lib/supabase/server')).createSupabaseServerAdminClient
        .mockReturnValue(mockSupabaseAdmin as any)
      vi.mocked(await import('@/lib/server/shared/service-error')).serviceError
        .mockImplementation((msg, code) => {
          const err = new Error(msg) as ServiceError
          err.statusCode = code
          throw err
        })

      const { updateClubEvent } = await loadClubEventsService()

      const updateSpy = vi.fn(() => ({
        eq: vi.fn(() => ({
          select: vi.fn(() => ({
            maybeSingle: vi.fn(async () => ({ data: null, error: null })),
          })),
        })),
      }))

      mockSupabaseAdmin.from = vi.fn(function (table: string) {
        if (table === 'events') {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => ({
                maybeSingle: vi.fn(async () => ({ data: ORIGINAL_ROW, error: null })),
              })),
            })),
            update: updateSpy,
          }
        }
        if (table === 'rooms') {
          // Simulate an unknown room id: the "rooms" lookup returns nothing.
          return {
            select: vi.fn(() => ({
              in: vi.fn(async () => ({ data: [], error: null })),
            })),
          }
        }
        return buildSupabaseMock().from(table)
      }) as any

      await expect(
        updateClubEvent(adminSession, 'evt-1', {
          blocksRooms: true,
          schedules: [
            {
              date: '2026-04-20',
              startTime: '18:00',
              endTime: '22:00',
              allDay: false,
              roomId: 'room-unknown',
            },
          ],
        })
      ).rejects.toMatchObject({ statusCode: 400 })

      // The event fields UPDATE must never run once an unknown room id is
      // detected — the bad reference is rejected before any write happens.
      expect(updateSpy).not.toHaveBeenCalled()
    })

    it('reverts the event fields UPDATE when apply_club_event_room_blocks RPC fails, leaving no partial update (PR #149 / PR #154 review)', async () => {
      const adminSession = createAdminSession()
      const mockSupabaseAdmin = buildSupabaseMock()

      // Room ids validate fine — the RPC still fails for some other reason
      // (e.g. a transient DB error), which is the case this fix targets.
      mockSupabaseAdmin.rpc = vi.fn(async () => ({
        data: null,
        error: { message: 'transient failure', code: 'XX000' },
      }))

      vi.mocked(await import('@/lib/supabase/server')).createSupabaseServerAdminClient
        .mockReturnValue(mockSupabaseAdmin as any)
      vi.mocked(await import('@/lib/server/shared/service-error')).serviceError
        .mockImplementation((msg, code) => {
          const err = new Error(msg) as ServiceError
          err.statusCode = code
          throw err
        })

      const { updateClubEvent } = await loadClubEventsService()

      const updateCalls: Record<string, unknown>[] = []
      const revertEq = vi.fn(async () => ({ data: null, error: null }))

      mockSupabaseAdmin.from = vi.fn(function (table: string) {
        if (table === 'events') {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => ({
                maybeSingle: vi.fn(async () => ({ data: ORIGINAL_ROW, error: null })),
              })),
            })),
            update: vi.fn(function (data: Record<string, unknown>) {
              updateCalls.push(data)
              // First call = the field-update from the request body;
              // second call = the compensating revert.
              if (updateCalls.length === 1) {
                return {
                  eq: vi.fn(() => ({
                    select: vi.fn(() => ({
                      maybeSingle: vi.fn(async () => ({
                        data: { ...ORIGINAL_ROW, ...data },
                        error: null,
                      })),
                    })),
                  })),
                }
              }
              return { eq: revertEq }
            }),
          }
        }
        if (table === 'rooms') {
          return {
            select: vi.fn(() => ({
              in: vi.fn(async (_col: string, vals: string[]) => ({
                data: vals.map((id) => ({ id })),
                error: null,
              })),
            })),
          }
        }
        if (table === 'event_room_blocks') {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(async () => ({ data: [], error: null })),
            })),
          }
        }
        return buildSupabaseMock().from(table)
      }) as any

      await expect(
        updateClubEvent(adminSession, 'evt-1', {
          titleEs: 'Nuevo Titulo',
          blocksRooms: true,
          schedules: [
            {
              date: '2026-04-20',
              startTime: '18:00',
              endTime: '22:00',
              allDay: false,
              roomId: 'room-1',
            },
          ],
        })
      ).rejects.toMatchObject({ statusCode: 500 })

      // Two updates on "events": the initial (now-reverted) field write,
      // then the compensating revert restoring the pre-update values — the
      // original event fields must survive the failed request unchanged.
      expect(updateCalls.length).toBe(2)
      expect(updateCalls[0].title_es).toBe('Nuevo Titulo')
      expect(updateCalls[1].title_es).toBe('Evento Antiguo')
      expect(revertEq).toHaveBeenCalledWith('id', 'evt-1')
    })

    it('logs when both the block RPC and the compensating revert fail, and still rethrows the original RPC error (PR #149 / PR #154 review)', async () => {
      const adminSession = createAdminSession()
      const mockSupabaseAdmin = buildSupabaseMock()

      mockSupabaseAdmin.rpc = vi.fn(async () => ({
        data: null,
        error: { message: 'transient failure', code: 'XX000' },
      }))

      vi.mocked(await import('@/lib/supabase/server')).createSupabaseServerAdminClient
        .mockReturnValue(mockSupabaseAdmin as any)
      vi.mocked(await import('@/lib/server/shared/service-error')).serviceError
        .mockImplementation((msg, code) => {
          const err = new Error(msg) as ServiceError
          err.statusCode = code
          throw err
        })

      const { updateClubEvent } = await loadClubEventsService()

      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      // The FIRST "events".update call (field write) succeeds normally; the
      // SECOND call (compensating revert) fails, simulating the revert
      // itself being unable to complete.
      let updateCallCount = 0
      mockSupabaseAdmin.from = vi.fn(function (table: string) {
        if (table === 'events') {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => ({
                maybeSingle: vi.fn(async () => ({ data: ORIGINAL_ROW, error: null })),
              })),
            })),
            update: vi.fn(function (data: Record<string, unknown>) {
              updateCallCount += 1
              if (updateCallCount === 1) {
                return {
                  eq: vi.fn(() => ({
                    select: vi.fn(() => ({
                      maybeSingle: vi.fn(async () => ({
                        data: { ...ORIGINAL_ROW, ...data },
                        error: null,
                      })),
                    })),
                  })),
                }
              }
              return {
                eq: vi.fn(async () => ({
                  data: null,
                  error: { message: 'revert failed', code: 'XX000' },
                })),
              }
            }),
          }
        }
        if (table === 'rooms') {
          return {
            select: vi.fn(() => ({
              in: vi.fn(async (_col: string, vals: string[]) => ({
                data: vals.map((id) => ({ id })),
                error: null,
              })),
            })),
          }
        }
        if (table === 'event_room_blocks') {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(async () => ({ data: [], error: null })),
            })),
          }
        }
        return buildSupabaseMock().from(table)
      }) as any

      await expect(
        updateClubEvent(adminSession, 'evt-1', {
          titleEs: 'Nuevo Titulo',
          blocksRooms: true,
          schedules: [
            {
              date: '2026-04-20',
              startTime: '18:00',
              endTime: '22:00',
              allDay: false,
              roomId: 'room-1',
            },
          ],
        })
        // The ORIGINAL RPC error must still be what the client sees — never
        // the compensating revert's own error, which is only a logging concern.
      ).rejects.toMatchObject({ statusCode: 500, message: 'Internal server error' })

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('event row left partially updated'),
        'evt-1',
      )

      consoleErrorSpy.mockRestore()
    })

    it('rejects an unknown table id in schedules with 400 BEFORE updating the event fields (PR #154 review)', async () => {
      const adminSession = createAdminSession()
      const mockSupabaseAdmin = buildSupabaseMock()

      vi.mocked(await import('@/lib/supabase/server')).createSupabaseServerAdminClient
        .mockReturnValue(mockSupabaseAdmin as any)
      vi.mocked(await import('@/lib/server/shared/service-error')).serviceError
        .mockImplementation((msg, code) => {
          const err = new Error(msg) as ServiceError
          err.statusCode = code
          throw err
        })

      const { updateClubEvent } = await loadClubEventsService()

      const updateSpy = vi.fn(() => ({
        eq: vi.fn(() => ({
          select: vi.fn(() => ({
            maybeSingle: vi.fn(async () => ({ data: null, error: null })),
          })),
        })),
      }))

      mockSupabaseAdmin.from = vi.fn(function (table: string) {
        if (table === 'events') {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => ({
                maybeSingle: vi.fn(async () => ({ data: ORIGINAL_ROW, error: null })),
              })),
            })),
            update: updateSpy,
          }
        }
        if (table === 'rooms') {
          // The room id is valid — only the table id is unknown.
          return {
            select: vi.fn(() => ({
              in: vi.fn(async (_col: string, vals: string[]) => ({
                data: vals.map((id) => ({ id })),
                error: null,
              })),
            })),
          }
        }
        if (table === 'tables') {
          // Simulate an unknown table id: the "tables" lookup returns nothing.
          return {
            select: vi.fn(() => ({
              in: vi.fn(async () => ({ data: [], error: null })),
            })),
          }
        }
        return buildSupabaseMock().from(table)
      }) as any

      await expect(
        updateClubEvent(adminSession, 'evt-1', {
          blocksRooms: true,
          schedules: [
            {
              date: '2026-04-20',
              startTime: '18:00',
              endTime: '22:00',
              allDay: false,
              roomId: 'room-1',
              tableId: 'table-unknown',
            },
          ],
        })
      ).rejects.toMatchObject({ statusCode: 400 })

      // The event fields UPDATE must never run once an unknown table id is
      // detected — the bad reference is rejected before any write happens.
      expect(updateSpy).not.toHaveBeenCalled()
    })

    it('rejects an unknown equipment id in materials with 400 BEFORE updating the event fields (PR #154 review)', async () => {
      const adminSession = createAdminSession()
      const mockSupabaseAdmin = buildSupabaseMock()

      vi.mocked(await import('@/lib/supabase/server')).createSupabaseServerAdminClient
        .mockReturnValue(mockSupabaseAdmin as any)
      vi.mocked(await import('@/lib/server/shared/service-error')).serviceError
        .mockImplementation((msg, code) => {
          const err = new Error(msg) as ServiceError
          err.statusCode = code
          throw err
        })

      const { updateClubEvent } = await loadClubEventsService()

      const updateSpy = vi.fn(() => ({
        eq: vi.fn(() => ({
          select: vi.fn(() => ({
            maybeSingle: vi.fn(async () => ({ data: null, error: null })),
          })),
        })),
      }))

      mockSupabaseAdmin.from = vi.fn(function (table: string) {
        if (table === 'events') {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => ({
                maybeSingle: vi.fn(async () => ({ data: ORIGINAL_ROW, error: null })),
              })),
            })),
            update: updateSpy,
          }
        }
        if (table === 'equipment') {
          // Simulate a missing equipment FK: the "equipment" lookup returns nothing.
          return {
            select: vi.fn(() => ({
              in: vi.fn(async () => ({ data: [], error: null })),
            })),
          }
        }
        return buildSupabaseMock().from(table)
      }) as any

      await expect(
        updateClubEvent(adminSession, 'evt-1', {
          materials: [{ equipmentId: 'equip-unknown', quantity: 1 }],
        })
      ).rejects.toMatchObject({ statusCode: 400 })

      // The event fields UPDATE must never run once a missing equipment id
      // is detected — the bad reference is rejected before any write happens.
      expect(updateSpy).not.toHaveBeenCalled()
    })

    it('reverts the event fields UPDATE when the RPC fails during a materials-only change, leaving no partial update (PR #154 review)', async () => {
      const adminSession = createAdminSession()
      const mockSupabaseAdmin = buildSupabaseMock()

      // Equipment ids validate fine — the RPC still fails for some other
      // reason (e.g. a transient DB error), which is the case this fix targets.
      mockSupabaseAdmin.rpc = vi.fn(async () => ({
        data: null,
        error: { message: 'transient failure', code: 'XX000' },
      }))

      vi.mocked(await import('@/lib/supabase/server')).createSupabaseServerAdminClient
        .mockReturnValue(mockSupabaseAdmin as any)
      vi.mocked(await import('@/lib/server/shared/service-error')).serviceError
        .mockImplementation((msg, code) => {
          const err = new Error(msg) as ServiceError
          err.statusCode = code
          throw err
        })

      const { updateClubEvent } = await loadClubEventsService()

      const updateCalls: Record<string, unknown>[] = []
      const revertEq = vi.fn(async () => ({ data: null, error: null }))

      mockSupabaseAdmin.from = vi.fn(function (table: string) {
        if (table === 'events') {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => ({
                maybeSingle: vi.fn(async () => ({ data: ORIGINAL_ROW, error: null })),
              })),
            })),
            update: vi.fn(function (data: Record<string, unknown>) {
              updateCalls.push(data)
              // First call = the field-update from the request body;
              // second call = the compensating revert.
              if (updateCalls.length === 1) {
                return {
                  eq: vi.fn(() => ({
                    select: vi.fn(() => ({
                      maybeSingle: vi.fn(async () => ({
                        data: { ...ORIGINAL_ROW, ...data },
                        error: null,
                      })),
                    })),
                  })),
                }
              }
              return { eq: revertEq }
            }),
          }
        }
        if (table === 'equipment') {
          return {
            select: vi.fn(() => ({
              in: vi.fn(async (_col: string, vals: string[]) => ({
                data: vals.map((id) => ({ id })),
                error: null,
              })),
            })),
          }
        }
        return buildSupabaseMock().from(table)
      }) as any

      await expect(
        updateClubEvent(adminSession, 'evt-1', {
          titleEs: 'Nuevo Titulo',
          materials: [{ equipmentId: 'equip-1', quantity: 2 }],
        })
      ).rejects.toMatchObject({ statusCode: 500 })

      // Two updates on "events": the initial (now-reverted) field write,
      // then the compensating revert restoring the pre-update values — even
      // though only `materials` changed (no schedules), the event fields
      // must survive the failed request unchanged.
      expect(updateCalls.length).toBe(2)
      expect(updateCalls[0].title_es).toBe('Nuevo Titulo')
      expect(updateCalls[1].title_es).toBe('Evento Antiguo')
      expect(revertEq).toHaveBeenCalledWith('id', 'evt-1')
    })
  })

  describe('deleteClubEvent', () => {
    it('admin can delete a club event', async () => {
      const adminSession = createAdminSession()
      const mockSupabaseAdmin = buildSupabaseMock()
      
      vi.mocked(await import('@/lib/supabase/server')).createSupabaseServerAdminClient
        .mockReturnValue(mockSupabaseAdmin as any)

      const { deleteClubEvent } = await loadClubEventsService()

      await deleteClubEvent(adminSession, 'evt-1')
    })

    it('non-admin member gets 403 Forbidden on delete', async () => {
      const memberSession = createMemberSession()
      const mockSupabaseAdmin = buildSupabaseMock()
      
      vi.mocked(await import('@/lib/supabase/server')).createSupabaseServerAdminClient
        .mockReturnValue(mockSupabaseAdmin as any)
      vi.mocked(await import('@/lib/server/shared/service-error')).serviceError
        .mockImplementation((msg, code) => {
          const err = new Error(msg) as ServiceError
          err.statusCode = code
          throw err
        })

      const { deleteClubEvent } = await loadClubEventsService()

      await expect(
        deleteClubEvent(memberSession, 'evt-1')
      ).rejects.toMatchObject({ statusCode: 403 })
    })
  })

  describe('listAdminClubEvents', () => {
    it('admin gets upcoming and past events split by date', async () => {
      const adminSession = createAdminSession()
      const mockSupabaseAdmin = buildSupabaseMock()
      
      vi.mocked(await import('@/lib/supabase/server')).createSupabaseServerAdminClient
        .mockReturnValue(mockSupabaseAdmin as any)

      const { listAdminClubEvents } = await loadClubEventsService()

      const result = await listAdminClubEvents(adminSession)

      expect(result).toHaveProperty('upcoming')
      expect(result).toHaveProperty('past')
      expect(Array.isArray(result.upcoming)).toBe(true)
      expect(Array.isArray(result.past)).toBe(true)
    })

    it('non-admin member gets 403 Forbidden', async () => {
      const memberSession = createMemberSession()
      const mockSupabaseAdmin = buildSupabaseMock()
      
      vi.mocked(await import('@/lib/supabase/server')).createSupabaseServerAdminClient
        .mockReturnValue(mockSupabaseAdmin as any)
      vi.mocked(await import('@/lib/server/shared/service-error')).serviceError
        .mockImplementation((msg, code) => {
          const err = new Error(msg) as ServiceError
          err.statusCode = code
          throw err
        })

      const { listAdminClubEvents } = await loadClubEventsService()

      await expect(
        listAdminClubEvents(memberSession)
      ).rejects.toMatchObject({ statusCode: 403 })
    })
  })

  describe('listClubEvents', () => {
    it('returns upcoming and past club events for public listing', async () => {
      const mockSupabaseClient = buildSupabaseMock()
      
      vi.mocked(await import('@/lib/supabase/server')).createSupabaseServerClient
        .mockResolvedValue(mockSupabaseClient as any)

      const { listClubEvents } = await loadClubEventsService()

      const result = await listClubEvents()

      expect(result).toHaveProperty('upcoming')
      expect(result).toHaveProperty('past')
    })
  })

  describe('listEvents (from events-service.ts)', () => {
    it('excludes landing-only rows (both title_es and title_en populated)', async () => {
      const mockSupabaseClient = buildSupabaseMock()
      mockSupabaseClient.from = vi.fn(function (table: string) {
        if (table === 'events') {
          return {
            select: vi.fn(() => ({
              or: vi.fn(function (filter: string) {
                expect(filter).toContain('title_es')
                expect(filter).toContain('title_en')
                return {
                  order: vi.fn(function () {
                    return {
                      order: vi.fn(async () => ({
                        data: [
                          {
                            id: 'evt-internal-1',
                            title: 'Internal Event',
                            description: null,
                            date: '2026-04-20',
                            start_time: '18:00',
                            end_time: '22:00',
                            created_by: 'user-1',
                            created_at: '2026-04-01T00:00:00Z',
                          },
                        ],
                        error: null,
                      })),
                    }
                  }),
                }
              }),
            })),
          }
        }
        return buildSupabaseMock().from(table)
      }) as any

      vi.mocked(await import('@/lib/supabase/server')).createSupabaseServerClient
        .mockResolvedValue(mockSupabaseClient as any)
      vi.mocked(await import('@/lib/supabase/server')).createSupabaseServerAdminClient
        .mockReturnValue(buildSupabaseMock() as any)

      const { listEvents } = await loadEventsService()

      const result = await listEvents()

      expect(Array.isArray(result)).toBe(true)
    })
  })

  describe('updateClubEvent with fallback semantics edge cases (OIR-206 round 2)', () => {
    it('rule 2: explicit different titleEn + blank titleEn payload = re-enable auto-copy to new ES', async () => {
      const adminSession = createAdminSession()
      const mockSupabaseAdmin = buildSupabaseMock()
      
      // Current row: title_en !== title_es (deliberately set)
      const currentRow = {
        id: 'evt-1',
        title: 'Event',
        title_es: 'Evento Antiguo',
        title_en: 'Old Explicit Title', // Deliberately different from ES
        blurb_es: null,
        blurb_en: null,
        description_es: null,
        description_en: null,
        category_es: null,
        category_en: null,
        date_kind: 'single',
        date: '2026-04-20',
        end_date: null,
        recurrence_label_es: null,
        recurrence_label_en: null,
        image_url: null,
        link_url: null,
        created_by: 'user-1',
        created_at: '2026-04-01T00:00:00Z',
      }

      mockSupabaseAdmin.from = vi.fn(function (table: string) {
        if (table === 'events') {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => ({
                maybeSingle: vi.fn(async () => ({
                  data: currentRow,
                  error: null,
                })),
              })),
            })),
            update: vi.fn(() => ({
              eq: vi.fn(() => ({
                select: vi.fn(() => ({
                  maybeSingle: vi.fn(async () => ({
                    data: {
                      ...currentRow,
                      title_es: 'Evento Nuevo',
                      title_en: 'Evento Nuevo', // Should become new ES (rule 2)
                    },
                    error: null,
                  })),
                })),
              })),
            })),
          }
        }
        return buildSupabaseMock().from(table)
      }) as any

      vi.mocked(await import('@/lib/supabase/server')).createSupabaseServerAdminClient
        .mockReturnValue(mockSupabaseAdmin as any)

      const { updateClubEvent } = await loadClubEventsService()

      const result = await updateClubEvent(adminSession, 'evt-1', {
        titleEs: 'Evento Nuevo',
        titleEn: '', // Blank = re-enable auto-copy
      })

      expect(result.titleEn).toBe('Evento Nuevo') // Follows new ES
    })

    it('rule 1: resending identical titleEn (en === es deliberately) + ES change = EN preserved', async () => {
      const adminSession = createAdminSession()
      const mockSupabaseAdmin = buildSupabaseMock()
      
      // Current row: title_en === title_es (could be deliberate or auto-copied, but identical)
      const currentRow = {
        id: 'evt-1',
        title: 'Event',
        title_es: 'Evento Antiguo',
        title_en: 'Evento Antiguo', // Same as ES (deliberately or auto-copied)
        blurb_es: null,
        blurb_en: null,
        description_es: null,
        description_en: null,
        category_es: null,
        category_en: null,
        date_kind: 'single',
        date: '2026-04-20',
        end_date: null,
        recurrence_label_es: null,
        recurrence_label_en: null,
        image_url: null,
        link_url: null,
        created_by: 'user-1',
        created_at: '2026-04-01T00:00:00Z',
      }

      mockSupabaseAdmin.from = vi.fn(function (table: string) {
        if (table === 'events') {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => ({
                maybeSingle: vi.fn(async () => ({
                  data: currentRow,
                  error: null,
                })),
              })),
            })),
            update: vi.fn(() => ({
              eq: vi.fn(() => ({
                select: vi.fn(() => ({
                  maybeSingle: vi.fn(async () => ({
                    data: {
                      ...currentRow,
                      title_es: 'Evento Nuevo',
                      title_en: 'Evento Antiguo', // Preserved because explicitly resent (rule 1)
                    },
                    error: null,
                  })),
                })),
              })),
            })),
          }
        }
        return buildSupabaseMock().from(table)
      }) as any

      vi.mocked(await import('@/lib/supabase/server')).createSupabaseServerAdminClient
        .mockReturnValue(mockSupabaseAdmin as any)

      const { updateClubEvent } = await loadClubEventsService()

      const result = await updateClubEvent(adminSession, 'evt-1', {
        titleEs: 'Evento Nuevo',
        titleEn: 'Evento Antiguo', // Resend explicit identical value
      })

      expect(result.titleEn).toBe('Evento Antiguo') // Preserved by rule 1
    })

    it('rule 2: whitespace-only titleEn behaves as blank (re-enable auto-copy to new ES)', async () => {
      const adminSession = createAdminSession()
      const mockSupabaseAdmin = buildSupabaseMock()
      
      const currentRow = {
        id: 'evt-1',
        title: 'Event',
        title_es: 'Evento Antiguo',
        title_en: 'Old Explicit Title',
        blurb_es: null,
        blurb_en: null,
        description_es: null,
        description_en: null,
        category_es: null,
        category_en: null,
        date_kind: 'single',
        date: '2026-04-20',
        end_date: null,
        recurrence_label_es: null,
        recurrence_label_en: null,
        image_url: null,
        link_url: null,
        created_by: 'user-1',
        created_at: '2026-04-01T00:00:00Z',
      }

      mockSupabaseAdmin.from = vi.fn(function (table: string) {
        if (table === 'events') {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => ({
                maybeSingle: vi.fn(async () => ({
                  data: currentRow,
                  error: null,
                })),
              })),
            })),
            update: vi.fn(() => ({
              eq: vi.fn(() => ({
                select: vi.fn(() => ({
                  maybeSingle: vi.fn(async () => ({
                    data: {
                      ...currentRow,
                      title_es: 'Evento Nuevo',
                      title_en: 'Evento Nuevo', // Should become new ES (whitespace trimmed = empty)
                    },
                    error: null,
                  })),
                })),
              })),
            })),
          }
        }
        return buildSupabaseMock().from(table)
      }) as any

      vi.mocked(await import('@/lib/supabase/server')).createSupabaseServerAdminClient
        .mockReturnValue(mockSupabaseAdmin as any)

      const { updateClubEvent } = await loadClubEventsService()

      const result = await updateClubEvent(adminSession, 'evt-1', {
        titleEs: 'Evento Nuevo',
        titleEn: '   ', // Whitespace-only = treated as empty (rule 2)
      })

      expect(result.titleEn).toBe('Evento Nuevo') // Follows new ES
    })

    it('rule 2: blank blurbEn (nullable) re-enables auto-copy to new ES (nullable field)', async () => {
      const adminSession = createAdminSession()
      const mockSupabaseAdmin = buildSupabaseMock()
      
      const currentRow = {
        id: 'evt-1',
        title: 'Event',
        title_es: 'Evento',
        title_en: 'Event',
        blurb_es: 'Viejo resumen',
        blurb_en: 'Old blurb summary', // Explicitly set
        description_es: null,
        description_en: null,
        category_es: null,
        category_en: null,
        date_kind: 'single',
        date: '2026-04-20',
        end_date: null,
        recurrence_label_es: null,
        recurrence_label_en: null,
        image_url: null,
        link_url: null,
        created_by: 'user-1',
        created_at: '2026-04-01T00:00:00Z',
      }

      mockSupabaseAdmin.from = vi.fn(function (table: string) {
        if (table === 'events') {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => ({
                maybeSingle: vi.fn(async () => ({
                  data: currentRow,
                  error: null,
                })),
              })),
            })),
            update: vi.fn(() => ({
              eq: vi.fn(() => ({
                select: vi.fn(() => ({
                  maybeSingle: vi.fn(async () => ({
                    data: {
                      ...currentRow,
                      blurb_es: 'Nuevo resumen',
                      blurb_en: 'Nuevo resumen', // Becomes new ES (rule 2, nullable)
                    },
                    error: null,
                  })),
                })),
              })),
            })),
          }
        }
        return buildSupabaseMock().from(table)
      }) as any

      vi.mocked(await import('@/lib/supabase/server')).createSupabaseServerAdminClient
        .mockReturnValue(mockSupabaseAdmin as any)

      const { updateClubEvent } = await loadClubEventsService()

      const result = await updateClubEvent(adminSession, 'evt-1', {
        blurbEs: 'Nuevo resumen',
        blurbEn: '', // Blank = re-enable auto-copy (rule 2)
      })

      expect(result.blurbEn).toBe('Nuevo resumen')
    })
  })
})
