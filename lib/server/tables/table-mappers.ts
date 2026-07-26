import 'server-only'
import type { GameTable } from '@/lib/types'
import type { tables } from '@/lib/db/schema'

/**
 * KIM-434 (F3c) PR2: `tables` is now Drizzle/Neon-backed (see
 * `lib/server/tables/tables-service.ts`), so this mapper takes the Drizzle
 * inferred row shape (camelCase) instead of the legacy Supabase
 * `Tables<'tables'>` (snake_case) row shape.
 */
type TableRow = typeof tables.$inferSelect

export function toGameTable(row: TableRow): GameTable {
  return {
    id: row.id,
    roomId: row.roomId,
    name: row.name,
    type: row.type,
    qrCode: row.qrCode ?? '',
    qrCodeInf: row.qrCodeInf ?? null,
    position: row.posX == null || row.posY == null ? undefined : { x: row.posX, y: row.posY },
  }
}
