'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { CalendarDays, Clock, Ban, Package } from 'lucide-react'
import { DiceLoader } from '@/components/ui/dice-loader'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog'
import { useAdminReservations, useAdminCancelReservation } from '@/lib/hooks/use-admin'
import { formatDate, formatTime } from '@/lib/utils'
import type { Reservation } from '@/lib/types'

export function ReservationsSection() {
  const t = useTranslations('admin')
  const tc = useTranslations('common')
  const tr = useTranslations('reservations')

  const { data: reservations, isLoading } = useAdminReservations()
  const cancelReservation = useAdminCancelReservation()
  const [cancelingId, setCancelingId] = useState<string | null>(null)

  async function handleCancel() {
    if (!cancelingId) return
    await cancelReservation.mutateAsync(cancelingId)
    setCancelingId(null)
  }

  const statusVariant: Record<Reservation['status'], 'available' | 'reserved' | 'outline'> = {
    active: 'available',
    cancelled: 'reserved',
    completed: 'outline',
    pending: 'outline',
    no_show: 'reserved',
  }

  const sorted = [...(reservations ?? [])].sort((a, b) =>
    a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime)
  )

  return (
    <section aria-labelledby="reservations-heading" className="space-y-5">
      {/* Section header */}
      <div className="flex items-center gap-3">
        <div className="flex items-center justify-center w-8 h-8 rounded-md bg-primary/10 border border-primary/20">
          <CalendarDays className="h-4 w-4 text-primary" aria-hidden="true" />
        </div>
        <h2 id="reservations-heading" className="font-cinzel text-xl font-semibold text-foreground">
          {t('reservationManagement')}
        </h2>
      </div>

      {/* Loading state */}
      {isLoading ? (
        <div className="rounded-lg border border-border overflow-hidden bg-background-secondary/20">
          <div className="bg-background-secondary/80 px-4 py-3 grid grid-cols-6 gap-4">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-4 rounded" />
            ))}
          </div>
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="px-4 py-3.5 grid grid-cols-6 gap-4 border-t border-border/40">
              <Skeleton className="h-4 w-20 rounded" />
              <Skeleton className="h-4 w-20 rounded" />
              <Skeleton className="h-4 w-24 rounded" />
              <Skeleton className="h-4 w-20 rounded" />
              <Skeleton className="h-5 w-16 rounded-full" />
              <Skeleton className="h-7 w-20 rounded ml-auto" />
            </div>
          ))}
        </div>
      ) : sorted.length === 0 ? (
        <div className="rpg-card p-12 text-center flex flex-col items-center gap-4">
          <div className="w-12 h-12 rounded-full bg-muted/40 flex items-center justify-center">
            <CalendarDays className="h-6 w-6 text-muted-foreground" aria-hidden="true" />
          </div>
          <p className="font-cinzel text-sm font-semibold text-muted-foreground">{t('noReservations')}</p>
        </div>
      ) : (
        <div className="rounded-lg border border-border overflow-x-auto bg-background-secondary/20">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-background-secondary/80">
                <th className="px-4 py-3 text-left font-cinzel text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                  {t('user')}
                </th>
                <th className="px-4 py-3 text-left font-cinzel text-xs font-semibold text-muted-foreground uppercase tracking-wider hidden md:table-cell">
                  {t('table')}
                </th>
                <th className="px-4 py-3 text-left font-cinzel text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                  {tc('date')}
                </th>
                <th className="px-4 py-3 text-left font-cinzel text-xs font-semibold text-muted-foreground uppercase tracking-wider hidden sm:table-cell">
                  {tc('time')}
                </th>
                <th className="px-4 py-3 text-left font-cinzel text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                  {tc('status')}
                </th>
                <th className="px-4 py-3 text-right font-cinzel text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                  {tc('actions')}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/40">
              {sorted.map((r, idx) => (
                <tr
                  key={r.id}
                  className={`hover:bg-primary/5 transition-colors group ${idx % 2 === 0 ? '' : 'bg-background-secondary/30'}`}
                >
                  <td className="px-4 py-3.5">
                    <span className="font-mono text-xs text-foreground font-medium">
                      {r.memberNumber ? `#${r.memberNumber}` : `#${r.userId.slice(0, 8)}`}
                    </span>
                  </td>
                  <td className="px-4 py-3.5 hidden md:table-cell">
                    <div className="space-y-1">
                      <span className="block text-xs text-muted-foreground">
                        {r.roomName && r.tableName
                          ? `${r.roomName} · ${r.tableName}`
                          : r.tableId.slice(0, 8) + '\u2026'}
                      </span>
                      {r.equipment && r.equipment.length > 0 && (
                        <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground/80">
                          <Package className="h-3 w-3" aria-hidden="true" />
                          {r.equipment.map((item) => item.name).join(', ')}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3.5">
                    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <CalendarDays className="h-3.5 w-3.5 text-primary/60 flex-shrink-0" aria-hidden="true" />
                      <span className="text-foreground">{formatDate(r.date)}</span>
                    </span>
                  </td>
                  <td className="px-4 py-3.5 hidden sm:table-cell">
                    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Clock className="h-3.5 w-3.5 text-primary/60 flex-shrink-0" aria-hidden="true" />
                      {formatTime(r.startTime)} — {formatTime(r.endTime)}
                    </span>
                  </td>
                  <td className="px-4 py-3.5">
                    <Badge variant={statusVariant[r.status]}>
                      {tr(r.status)}
                    </Badge>
                  </td>
                  <td className="px-4 py-3.5 text-right">
                    {(r.status === 'active' || r.status === 'pending') ? (
                      <Button
                        variant="outline"
                        size="sm"
                        className="border-crimson/30 text-destructive bg-crimson-dark/10 hover:bg-crimson-dark/30 hover:border-crimson/60 transition-colors opacity-70 group-hover:opacity-100"
                        onClick={() => setCancelingId(r.id)}
                      >
                        <Ban className="h-3 w-3 mr-1" aria-hidden="true" />
                        {t('cancelReservation')}
                      </Button>
                    ) : (
                      <span className="text-xs text-muted-foreground/50">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Cancel confirmation dialog */}
      <Dialog open={!!cancelingId} onOpenChange={() => setCancelingId(null)}>
        <DialogContent className="bg-card border-border">
          <DialogHeader>
            <div className="flex items-center gap-3 mb-1">
              <div className="flex items-center justify-center w-10 h-10 rounded-full bg-crimson-dark/20 border border-crimson/30">
                <Ban className="h-5 w-5 text-destructive" aria-hidden="true" />
              </div>
              <DialogTitle className="font-cinzel text-foreground">{t('cancelReservation')}</DialogTitle>
            </div>
            <DialogDescription className="text-muted-foreground leading-relaxed">
              {t('cancelReservationConfirm')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="mt-2">
            <Button variant="outline" onClick={() => setCancelingId(null)} className="border-border">
              {tc('cancel')}
            </Button>
            <Button
              onClick={handleCancel}
              disabled={cancelReservation.isPending}
              aria-busy={cancelReservation.isPending}
              className="relative bg-crimson hover:bg-crimson-light text-white border-0"
            >
              <span className="absolute left-1/2 top-1/2 inline-flex h-4 w-4 shrink-0 -translate-x-1/2 -translate-y-1/2 items-center justify-center">
                {cancelReservation.isPending && <DiceLoader size="sm" hideRole className="text-white" />}
              </span>
              <span className={cancelReservation.isPending ? 'opacity-0' : undefined}>{tc('confirm')}</span>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}
