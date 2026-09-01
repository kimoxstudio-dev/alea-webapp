'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Bookmark, Calendar, Clock, Layers, Package } from 'lucide-react'
import { DiceLoader } from '@/components/ui/dice-loader'
import type { GameTable, TableSurface, TableAvailability } from '@/lib/types'
import { getCurrentClubDate } from '@/lib/club-time'
import { useAvailableRoomEquipment, useTableAvailability, useCreateReservation, useCreateSavedGame } from '@/lib/hooks/use-reservations'
import { useAuth } from '@/lib/auth/auth-context'
import { generateTimeSlots, formatDate } from '@/lib/utils'
import { cn } from '@/lib/utils'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'

const ALL_TIME_SLOTS = generateTimeSlots('00:00', '24:00', 30)

function addDaysToDateOnly(date: string, days: number) {
  const [year, month, day] = date.split('-').map(Number)
  const next = new Date(Date.UTC(year, month - 1, day + days))
  return next.toISOString().slice(0, 10)
}

function addMonthsClamped(date: string, months: number) {
  const [year, month, day] = date.split('-').map(Number)
  const targetMonth = month - 1 + months
  const targetYear = year + Math.floor(targetMonth / 12)
  const normalizedMonth = ((targetMonth % 12) + 12) % 12
  const lastDay = new Date(Date.UTC(targetYear, normalizedMonth + 1, 0)).getUTCDate()
  return new Date(Date.UTC(targetYear, normalizedMonth, Math.min(day, lastDay))).toISOString().slice(0, 10)
}

interface ReservationDialogProps {
  table: GameTable | null
  open: boolean
  onClose: () => void
}

export function ReservationDialog({ table, open, onClose }: ReservationDialogProps) {
  const t = useTranslations('reservations')
  const tTables = useTranslations('tables')
  const tCommon = useTranslations('common')
  const { user } = useAuth()

  const now = new Date()
  const today = getCurrentClubDate(now)
  const [selectedDate, setSelectedDate] = useState(today)
  const [reservationMode, setReservationMode] = useState<'standard' | 'saved_game'>('standard')
  const [savedGameEndDate, setSavedGameEndDate] = useState(addDaysToDateOnly(addMonthsClamped(today, 3), -1))
  const [selectedStartTime, setSelectedStartTime] = useState<string | null>(null)
  const [selectedEndTime, setSelectedEndTime] = useState<string | null>(null)
  const [selectedSurface, setSelectedSurface] = useState<TableSurface | null>(null)
  const [selectedEquipmentIds, setSelectedEquipmentIds] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

  const { data: availability, isLoading: availabilityLoading } = useTableAvailability(
    table?.id ?? null,
    selectedDate
  )
  const { data: equipmentOptions, isLoading: equipmentLoading } = useAvailableRoomEquipment(
    table?.roomId ?? null,
    selectedDate,
    selectedStartTime,
    selectedEndTime,
  )
  const createReservation = useCreateReservation()
  const createSavedGame = useCreateSavedGame()

  const nowMinutes = now.getHours() * 60 + now.getMinutes()
  const maxDate = addDaysToDateOnly(today, 7)
  const timeSlots = selectedDate === today
    ? ALL_TIME_SLOTS.filter((slot) => {
        const [h, m] = slot.split(':').map(Number)
        return h * 60 + m > nowMinutes
      })
    : ALL_TIME_SLOTS

  useEffect(() => {
    if (!equipmentOptions) return
    setSelectedEquipmentIds((current) => {
      const next = current.filter((id) => equipmentOptions.some((item) => item.id === id && item.available))
      if (next.length === current.length && next.every((id, index) => id === current[index])) {
        return current
      }
      return next
    })
  }, [equipmentOptions])

  function isSlotAvailable(time: string, surface?: TableSurface): boolean {
    if (!availability) return true
    if (table?.type === 'removable_top' && surface) {
      const surfaceSlots = surface === 'top' ? availability.top : availability.bottom
      if (!surfaceSlots) return true
      const slot = surfaceSlots.find(s => s.startTime === time)
      return slot?.available ?? true
    }
    const slot = availability.slots.find(s => s.startTime === time)
    return slot?.available ?? true
  }

  function getSlotDetails(time: string, surface?: TableSurface) {
    if (!availability) return undefined
    if (table?.type === 'removable_top' && surface) {
      const surfaceSlots = surface === 'top' ? availability.top : availability.bottom
      return surfaceSlots?.find((slot) => slot.startTime === time)
    }
    return availability.slots.find((slot) => slot.startTime === time)
  }

  function handleSurfaceSelect(surface: TableSurface) {
    setSelectedSurface(surface)
    setSelectedStartTime(null)
    setSelectedEndTime(null)
    setSelectedEquipmentIds([])
  }

  function toggleEquipment(equipmentId: string, checked: boolean) {
    setSelectedEquipmentIds((current) => {
      if (checked) {
        return [...current, equipmentId]
      }
      return current.filter((id) => id !== equipmentId)
    })
  }

  async function handleSubmit() {
    if (!table || !user) return
    if (reservationMode === 'saved_game') {
      setError(null)
      try {
        await createSavedGame.mutateAsync({ tableId: table.id, startDate: selectedDate, endDate: savedGameEndDate })
        setSuccess(true)
        setTimeout(handleClose, 1500)
      } catch (err) {
        const code = (err as { message?: string })?.message
        const key = code === 'SAVED_GAME_MAX_DURATION'
          ? 'savedGame.errors.maxDuration'
          : code === 'SAVED_GAME_EVENT_CONFLICT'
            ? 'savedGame.errors.eventConflict'
            : code === 'SAVED_GAME_BOTTOM_RESERVATION_CONFLICT'
              ? 'savedGame.errors.bottomReservationConflict'
              : code === 'SAVED_GAME_CONFLICT'
                ? 'savedGame.errors.conflict'
                : 'errors.generic'
        setError(t(key))
      }
      return
    }
    if (!selectedStartTime || !selectedEndTime) return
    if (table.type === 'removable_top' && !selectedSurface) {
      setError(tTables('surfaceConflict'))
      return
    }

    setError(null)
    try {
      await createReservation.mutateAsync({
        tableId: table.id,
        date: selectedDate,
        startTime: selectedStartTime,
        endTime: selectedEndTime,
        surface: table.type === 'removable_top' ? selectedSurface ?? undefined : undefined,
        equipmentIds: selectedEquipmentIds,
      })
      setSuccess(true)
      setTimeout(() => {
        setSuccess(false)
        onClose()
        setSelectedStartTime(null)
        setSelectedEndTime(null)
        setSelectedSurface(null)
        setSelectedEquipmentIds([])
      }, 1500)
    } catch (err) {
      const mutationError = err as { message?: string; statusCode?: number }
      const errorCode = mutationError?.message
      if (errorCode === 'USER_ALREADY_HAS_RESERVATION_IN_SLOT') {
        setError(t('errors.userSlotConflict'))
      } else if (errorCode === 'Cannot make a reservation in the past') {
        setError(t('errors.pastDate'))
      } else if (errorCode === 'BOOKING_WINDOW_EXCEEDED') {
        setError(t('errors.bookingWindow'))
      } else if (errorCode === 'ROOM_BLOCKED_BY_EVENT') {
        setError(t('errors.eventBlocked'))
      } else if (errorCode === 'EQUIPMENT_ALREADY_RESERVED') {
        setError(t('errors.equipmentConflict'))
      } else if (mutationError?.statusCode === 409) {
        setError(t('errors.conflictTime'))
      } else {
        setError(t('errors.generic'))
      }
    }
  }

  function handleClose() {
    setSelectedStartTime(null)
    setSelectedEndTime(null)
    setSelectedSurface(null)
    setSelectedEquipmentIds([])
    setError(null)
    setSuccess(false)
    setReservationMode('standard')
    onClose()
  }

  if (!table) return null

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) handleClose()
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="font-cinzel text-lg flex items-center gap-2">
            <Calendar className="h-5 w-5 text-primary" aria-hidden="true" />
            {t('makeReservation')} — {table.name}
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">
            {tTables(table.type)}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 py-2">
          {table.type === 'removable_top' && (
            <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label={t('reservationType')}>
              {(['standard', 'saved_game'] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  role="radio"
                  aria-checked={reservationMode === mode}
                  onClick={() => {
                    setReservationMode(mode)
                    if (mode === 'saved_game') {
                      setSavedGameEndDate(addDaysToDateOnly(addMonthsClamped(selectedDate, 3), -1))
                    }
                    setSelectedSurface(mode === 'saved_game' ? 'bottom' : null)
                    setSelectedStartTime(null)
                    setSelectedEndTime(null)
                    setSelectedEquipmentIds([])
                  }}
                  className={cn(
                    'min-h-11 rounded-lg border px-3 py-2 text-sm font-medium transition-colors',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    reservationMode === mode ? 'border-primary bg-primary/10 text-primary' : 'border-border hover:border-primary/40',
                  )}
                >
                  {mode === 'standard' ? t('standardReservation') : t('savedGame.name')}
                </button>
              ))}
            </div>
          )}

          {/* Date selector */}
          <div className="space-y-2">
            <Label htmlFor="reservation-date" className="flex items-center gap-1.5">
              <Calendar className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
              {t('selectDate')}
            </Label>
            <input
              id="reservation-date"
              type="date"
              value={selectedDate}
              min={today}
              max={reservationMode === 'standard' ? maxDate : undefined}
              onChange={(e) => {
                setSelectedDate(e.target.value)
                setSelectedStartTime(null)
                setSelectedEndTime(null)
                setSelectedEquipmentIds([])
                if (reservationMode === 'saved_game') {
                  setSavedGameEndDate(addDaysToDateOnly(addMonthsClamped(e.target.value, 3), -1))
                }
              }}
              className="flex h-10 w-full rounded-md border border-input bg-background-surface px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={t('selectDate')}
            />
            <p className="text-xs text-muted-foreground">{formatDate(selectedDate)}</p>
          </div>

          {reservationMode === 'saved_game' && (
            <div className="space-y-3 rounded-lg border border-primary/25 bg-primary/5 p-4">
              <div className="flex items-start gap-2">
                <Bookmark className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
                <div>
                  <p className="text-sm font-medium">{t('savedGame.name')}</p>
                  <p className="text-xs text-muted-foreground">{t('savedGame.description')}</p>
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="saved-game-end-date">{t('savedGame.endDate')}</Label>
                <input
                  id="saved-game-end-date"
                  type="date"
                  value={savedGameEndDate}
                  min={selectedDate}
                  max={addDaysToDateOnly(addMonthsClamped(selectedDate, 3), -1)}
                  onChange={(event) => setSavedGameEndDate(event.target.value)}
                  className="flex h-11 w-full rounded-md border border-input bg-background-surface px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
              </div>
              <p className="text-xs text-muted-foreground">{t('savedGame.upperReservationRule')}</p>
            </div>
          )}

          {/* Surface selector for removable_top */}
          {table.type === 'removable_top' && reservationMode === 'standard' && (
            <div className="space-y-2">
              <Label className="flex items-center gap-1.5">
                <Layers className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                {tTables('selectSurface')}
              </Label>
              <div role="radiogroup" aria-label={tTables('selectSurface')} className="grid grid-cols-2 gap-2">
                {(['top', 'bottom'] as TableSurface[]).map((surface) => {
                  const surfaceSlots = surface === 'top' ? availability?.top : availability?.bottom
                  const hasUnavailable = surfaceSlots?.some(s => !s.available)

                  return (
                    <button
                      key={surface}
                      role="radio"
                      aria-checked={selectedSurface === surface}
                      onClick={() => handleSurfaceSelect(surface)}
                      className={cn(
                        'flex flex-col items-center gap-1 p-3 rounded-lg border text-sm transition-all',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                        selectedSurface === surface
                          ? 'border-primary bg-primary/10 text-primary'
                          : 'border-border hover:border-primary/40',
                        hasUnavailable && 'opacity-60'
                      )}
                    >
                      <Layers className="h-4 w-4" aria-hidden="true" />
                      <span className="font-medium">{tTables(surface === 'top' ? 'surfaceTop' : 'surfaceBottom')}</span>
                      {hasUnavailable && (
                        <span className="text-[10px] text-muted-foreground">{t('partiallyOccupied')}</span>
                      )}
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          {/* Time slots */}
          {reservationMode === 'standard' && (table.type !== 'removable_top' || selectedSurface) && (
            <div className="space-y-2">
              <Label className="flex items-center gap-1.5">
                <Clock className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                {t('selectTime')}
              </Label>

              {availabilityLoading ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <DiceLoader size="sm" />
                  <span>{tCommon('loading')}</span>
                </div>
              ) : (
                <div
                  className="grid grid-cols-5 gap-1.5"
                  role="group"
                  aria-label={t('availableTimesLabel')}
                >
                  {timeSlots.map((time) => {
                    const available = isSlotAvailable(time, selectedSurface ?? undefined)
                    const slotDetails = getSlotDetails(time, selectedSurface ?? undefined)
                    const isStart = selectedStartTime === time
                    const isEnd = selectedEndTime === time
                    const isInRange =
                      selectedStartTime && selectedEndTime && time > selectedStartTime && time < selectedEndTime

                    return (
                      <button
                        key={time}
                        disabled={!available}
                        onClick={() => {
                          if (!selectedStartTime || (selectedStartTime && selectedEndTime)) {
                            setSelectedStartTime(time)
                            setSelectedEndTime(null)
                          } else if (time > selectedStartTime) {
                            setSelectedEndTime(time)
                          } else {
                            setSelectedStartTime(time)
                            setSelectedEndTime(null)
                          }
                        }}
                        className={cn(
                          'py-1 px-1.5 text-xs rounded transition-all font-medium',
                          'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                          available
                            ? cn(
                                'border hover:border-primary/60',
                                (isStart || isEnd) && 'bg-primary text-primary-foreground border-primary',
                                isInRange && 'bg-primary/20 border-primary/40',
                                !isStart && !isEnd && !isInRange && 'border-emerald/40 bg-emerald-dark/20 text-emerald-light'
                              )
                            : 'border border-crimson/40 bg-crimson-dark/30 text-destructive/70 cursor-not-allowed line-through'
                        )}
                        title={!available && slotDetails?.source === 'event'
                          ? `${t('eventBlocked')}: ${slotDetails.label ?? t('eventBlockLabel')}`
                          : undefined}
                        aria-label={!available && slotDetails?.source === 'event'
                          ? `${time} — ${t('eventBlocked')}: ${slotDetails.label ?? t('eventBlockLabel')}`
                          : `${time} — ${available ? t('available') : t('occupied')}`}
                        aria-pressed={isStart || isEnd || !!isInRange}
                        aria-disabled={!available}
                      >
                        {!available && slotDetails?.source === 'event' ? `E ${time}` : time}
                      </button>
                    )
                  })}
                  {(() => {
                    const midnightSlot = getSlotDetails('23:30', selectedSurface ?? undefined)
                    const canSelectMidnightBoundary = Boolean(
                      selectedStartTime &&
                      !selectedEndTime &&
                      selectedStartTime < '24:00'
                    )
                    const midnightAvailable = midnightSlot?.available ?? false
                    const isMidnightEnd = selectedEndTime === '24:00'

                    return (
                      <button
                        key="24:00"
                        disabled={!canSelectMidnightBoundary || !midnightAvailable}
                        onClick={() => {
                          if (canSelectMidnightBoundary && midnightAvailable) {
                            setSelectedEndTime('24:00')
                          }
                        }}
                        className={cn(
                          'py-1 px-1.5 text-xs rounded transition-all font-medium',
                          'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                          canSelectMidnightBoundary && midnightAvailable
                            ? cn(
                                'border hover:border-primary/60',
                                isMidnightEnd && 'bg-primary text-primary-foreground border-primary',
                                !isMidnightEnd && 'border-emerald/40 bg-emerald-dark/20 text-emerald-light'
                              )
                            : 'border border-dashed border-border/60 text-muted-foreground cursor-not-allowed opacity-60'
                        )}
                        aria-label={`24:00 — ${canSelectMidnightBoundary && midnightAvailable ? t('available') : t('occupied')}`}
                        aria-pressed={isMidnightEnd}
                        aria-disabled={!canSelectMidnightBoundary || !midnightAvailable}
                        title="24:00"
                      >
                        24:00
                      </button>
                    )
                  })()}
                </div>
              )}

              {availability?.slots.some((slot) => !slot.available && slot.source === 'event') && (
                <p className="text-xs text-muted-foreground">
                  {t('eventBlocked')}
                  {': '}
                  {[
                    ...new Set(
                      availability.slots
                        .filter((slot) => !slot.available && slot.source === 'event')
                        .map((slot) => slot.label ?? t('eventBlockLabel')),
                    ),
                  ].join(', ')}
                </p>
              )}

              {selectedStartTime && !selectedEndTime && (
                <p className="text-xs text-muted-foreground">
                  {t('selectEndTimePrompt', { startTime: selectedStartTime })}
                </p>
              )}
              {selectedStartTime && selectedEndTime && (
                <p className="text-xs text-primary font-medium">
                  {selectedStartTime} &rarr; {selectedEndTime}
                </p>
              )}
            </div>
          )}

          {reservationMode === 'standard' && (table.type !== 'removable_top' || selectedSurface) && (
            <div className="space-y-2">
              <Label className="flex items-center gap-1.5">
                <Package className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                {t('equipmentOptional')}
              </Label>

              {!selectedStartTime || !selectedEndTime ? (
                <p className="text-xs text-muted-foreground">{t('selectTimeForEquipment')}</p>
              ) : equipmentLoading ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <DiceLoader size="sm" />
                  <span>{tCommon('loading')}</span>
                </div>
              ) : !equipmentOptions || equipmentOptions.length === 0 ? (
                <p className="text-xs text-muted-foreground">{t('equipmentNoneConfigured')}</p>
              ) : (
                <div className="space-y-3">
                  <div className="space-y-2">
                    {equipmentOptions.filter((item) => item.available).length === 0 ? (
                      <p className="text-xs text-muted-foreground">{t('equipmentNoneAvailable')}</p>
                    ) : (
                      equipmentOptions
                        .filter((item) => item.available)
                        .map((item) => {
                          const checkboxId = `equipment-${item.id}`
                          const descriptionId = `equipment-${item.id}-description`
                          return (
                            <div
                              key={item.id}
                              className="flex items-start gap-3 rounded-lg border border-border px-3 py-2 text-sm transition-colors hover:border-primary/40"
                            >
                              <Checkbox
                                id={checkboxId}
                                checked={selectedEquipmentIds.includes(item.id)}
                                onCheckedChange={(checked) => toggleEquipment(item.id, checked === true)}
                                aria-describedby={item.description ? descriptionId : undefined}
                              />
                              <span className="space-y-0.5">
                                <Label htmlFor={checkboxId} className="block font-medium text-foreground">
                                  {item.name}
                                </Label>
                                {item.description && (
                                  <span id={descriptionId} className="block text-xs text-muted-foreground">{item.description}</span>
                                )}
                              </span>
                            </div>
                          )
                        })
                    )}
                  </div>

                  {equipmentOptions.some((item) => !item.available) && (
                    <div className="space-y-2">
                      <p className="text-xs font-medium text-muted-foreground">{t('equipmentUnavailable')}</p>
                      {equipmentOptions
                        .filter((item) => !item.available)
                        .map((item) => (
                          <div
                            key={item.id}
                            className="rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2 text-xs text-muted-foreground"
                          >
                            <span className="block font-medium text-foreground">{item.name}</span>
                            <span>{t('equipmentUnavailableReason')}</span>
                          </div>
                        ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {error && (
            <div role="alert" className="rounded-md bg-destructive/15 border border-destructive/30 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          )}

          {success && (
            <div role="status" className="rounded-md bg-emerald-dark/30 border border-emerald/40 px-3 py-2 text-sm text-emerald-light font-medium text-center">
              {t('success')}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleClose}>{t('cancel')}</Button>
          <Button
            onClick={handleSubmit}
            disabled={
              reservationMode === 'saved_game'
                ? !savedGameEndDate || createSavedGame.isPending
                : !selectedStartTime ||
                  !selectedEndTime ||
                  (table.type === 'removable_top' && !selectedSurface) ||
                  createReservation.isPending
            }
          >
            {createReservation.isPending || createSavedGame.isPending
              ? (
                <span className="inline-flex items-center gap-2">
                  <DiceLoader size="sm" hideRole />
                  <span>{t('submitting')}</span>
                </span>
              )
              : reservationMode === 'saved_game' ? t('savedGame.create') : t('makeReservation')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
