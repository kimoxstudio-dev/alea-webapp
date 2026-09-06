'use client'

import { useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { CalendarHeart, Plus, Pencil, Trash2, PlusCircle, MinusCircle } from 'lucide-react'
import { DiceLoader } from '@/components/ui/dice-loader'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import { Skeleton } from '@/components/ui/skeleton'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import {
  useAdminClubEvents,
  useAdminCreateClubEvent,
  useAdminUpdateClubEvent,
  useAdminDeleteClubEvent,
  useAdminRooms,
  useAdminRoomTables,
  useAdminEquipment,
  type ClubEventPayload,
} from '@/lib/hooks/use-admin'
import { formatClubEventDate } from '@/lib/club-events-format'
import { useRequiredFieldFocus } from '@/lib/hooks/use-required-field-focus'
import type { AdminClubEvent, AdminEventMaterial, AdminEventRoomBlock } from '@/lib/types'
import { OptionalEnglishFields } from './optional-english-fields'
import { ImageUpload } from './image-upload'

const NONE_ROOM = '__none__'
const WHOLE_ROOM = '__whole_room__'

type DateKind = 'single' | 'range' | 'recurring'

// ---------------------------------------------------------------------------
// Room-block schedule entry — mirrors the internal admin event flow's
// schedule editor so "blocks rooms" behaves like a normal room-booking event.
// OIR-208: each entry may also scope its block to a single table of the
// selected room ("Sala entera" / WHOLE_ROOM = block the whole room, unchanged
// default behavior).
// ---------------------------------------------------------------------------
interface ScheduleEntry {
  id: string
  date: string
  startTime: string
  endTime: string
  roomId: string
  tableId: string
  allDay: boolean
}

function emptySchedule(): ScheduleEntry {
  return {
    id: crypto.randomUUID(),
    date: '',
    startTime: '',
    endTime: '',
    roomId: NONE_ROOM,
    tableId: WHOLE_ROOM,
    allDay: false,
  }
}

function scheduleFromBlock(b: AdminEventRoomBlock): ScheduleEntry {
  return {
    id: b.id ?? crypto.randomUUID(),
    date: b.date,
    startTime: b.startTime,
    endTime: b.endTime,
    roomId: b.roomId ?? NONE_ROOM,
    tableId: b.tableId ?? WHOLE_ROOM,
    allDay: b.allDay,
  }
}

// ---------------------------------------------------------------------------
// Material (equipment) entry — OIR-208.
// ---------------------------------------------------------------------------
interface MaterialEntry {
  id: string
  equipmentId: string
  quantity: number
}

function emptyMaterial(): MaterialEntry {
  return { id: crypto.randomUUID(), equipmentId: '', quantity: 1 }
}

function materialFromAdmin(m: AdminEventMaterial): MaterialEntry {
  return { id: crypto.randomUUID(), equipmentId: m.equipmentId, quantity: m.quantity }
}

// ---------------------------------------------------------------------------
// Form state
// ---------------------------------------------------------------------------
interface ClubEventFormState {
  titleEs: string
  titleEn: string
  blurbEs: string
  blurbEn: string
  descriptionEs: string
  descriptionEn: string
  categoryEs: string
  categoryEn: string
  dateKind: DateKind
  date: string
  endDate: string
  recurrenceLabelEs: string
  recurrenceLabelEn: string
  imageUrl: string
  linkUrl: string
  /** OIR-208: ON publishes the event on the public landing; OFF is internal-only. */
  visibleOnLanding: boolean
  blocksRooms: boolean
  schedules: ScheduleEntry[]
  materials: MaterialEntry[]
}

function emptyForm(): ClubEventFormState {
  return {
    titleEs: '',
    titleEn: '',
    blurbEs: '',
    blurbEn: '',
    descriptionEs: '',
    descriptionEn: '',
    categoryEs: '',
    categoryEn: '',
    dateKind: 'single',
    date: '',
    endDate: '',
    recurrenceLabelEs: '',
    recurrenceLabelEn: '',
    imageUrl: '',
    linkUrl: '',
    visibleOnLanding: true,
    blocksRooms: false,
    schedules: [emptySchedule()],
    materials: [],
  }
}

function formFromEvent(event: AdminClubEvent): ClubEventFormState {
  return {
    titleEs: event.titleEs,
    titleEn: event.titleEn,
    blurbEs: event.blurbEs,
    blurbEn: event.blurbEn,
    descriptionEs: event.descriptionEs ?? '',
    descriptionEn: event.descriptionEn ?? '',
    categoryEs: event.categoryEs ?? '',
    categoryEn: event.categoryEn ?? '',
    dateKind: event.dateKind,
    date: event.startDate,
    endDate: event.endDate ?? '',
    recurrenceLabelEs: event.recurrenceLabelEs ?? '',
    recurrenceLabelEn: event.recurrenceLabelEn ?? '',
    imageUrl: event.imageUrl ?? '',
    linkUrl: event.linkUrl ?? '',
    visibleOnLanding: event.visibleOnLanding,
    blocksRooms: event.blocksRooms,
    schedules: event.roomBlocks.length > 0 ? event.roomBlocks.map(scheduleFromBlock) : [emptySchedule()],
    materials: event.materials.map(materialFromAdmin),
  }
}

function buildPayload(form: ClubEventFormState): ClubEventPayload {
  return {
    titleEs: form.titleEs.trim(),
    titleEn: form.titleEn.trim(),
    blurbEs: form.blurbEs.trim() || null,
    blurbEn: form.blurbEn.trim() || null,
    descriptionEs: form.descriptionEs.trim() || null,
    descriptionEn: form.descriptionEn.trim() || null,
    categoryEs: form.categoryEs.trim() || null,
    categoryEn: form.categoryEn.trim() || null,
    dateKind: form.dateKind,
    date: form.date,
    endDate: form.dateKind === 'range' ? (form.endDate || null) : null,
    recurrenceLabelEs: form.dateKind === 'recurring' ? (form.recurrenceLabelEs.trim() || null) : null,
    recurrenceLabelEn: form.dateKind === 'recurring' ? (form.recurrenceLabelEn.trim() || null) : null,
    imageUrl: form.imageUrl.trim() || null,
    linkUrl: form.linkUrl.trim() || null,
    visibleOnLanding: form.visibleOnLanding,
    blocksRooms: form.blocksRooms,
    schedules: form.blocksRooms
      ? form.schedules.map((s) => ({
        date: s.date,
        startTime: s.allDay ? undefined : s.startTime,
        endTime: s.allDay ? undefined : s.endTime,
        roomId: s.roomId === NONE_ROOM ? null : s.roomId,
        tableId: s.roomId === NONE_ROOM || s.tableId === WHOLE_ROOM ? null : s.tableId,
        allDay: s.allDay,
      }))
      : undefined,
    materials: form.materials
      .filter((m) => m.equipmentId)
      .map((m) => ({ equipmentId: m.equipmentId, quantity: m.quantity })),
  }
}

/** Which required field is blank, anchoring a field-level error message to
 * the actual input instead of one generic message at the bottom of the form.
 * A schedule row error also carries its index, since `blocksRooms` allows
 * multiple room-block rows. */
type ClubEventFieldError =
  | { kind: 'titleEs' | 'date' | 'endDate' }
  | { kind: 'schedule'; index: number; field: 'date' | 'startTime' | 'endTime' }

/** Every field the form marks `required` — checked client-side on submit
 * (#313: a blank one used to fall through to the browser's native,
 * English-only validation bubble instead of this app's Spanish-capable error
 * display). The form itself sets `noValidate`, so this is the only gate left
 * against submitting a blank required field. Returns the first blank field
 * found, or `null` when the form is valid. */
function getBlankRequiredField(form: ClubEventFormState): ClubEventFieldError | null {
  if (!form.titleEs.trim()) return { kind: 'titleEs' }
  if (!form.date.trim()) return { kind: 'date' }
  if (form.dateKind === 'range' && !form.endDate.trim()) return { kind: 'endDate' }
  if (form.blocksRooms) {
    for (let i = 0; i < form.schedules.length; i += 1) {
      const s = form.schedules[i]
      if (!s.date.trim()) return { kind: 'schedule', index: i, field: 'date' }
      if (!s.allDay) {
        if (!s.startTime.trim()) return { kind: 'schedule', index: i, field: 'startTime' }
        if (!s.endTime.trim()) return { kind: 'schedule', index: i, field: 'endTime' }
      }
    }
  }
  return null
}

/** Field keys for the shared `useRequiredFieldFocus` hook (#313 code-review
 * finding 5). Schedule rows are dynamic, so their key encodes the row index
 * and sub-field instead of being a fixed property name. */
type ClubEventFieldKey = 'titleEs' | 'date' | 'endDate' | `schedule:${number}:${'date' | 'startTime' | 'endTime'}`

function scheduleFieldKey(index: number, field: 'date' | 'startTime' | 'endTime'): ClubEventFieldKey {
  return `schedule:${index}:${field}`
}

function clubEventFieldKey(error: ClubEventFieldError): ClubEventFieldKey {
  return error.kind === 'schedule' ? scheduleFieldKey(error.index, error.field) : error.kind
}

// ---------------------------------------------------------------------------
// ScheduleRow — one room-block entry in the "blocks rooms" sub-flow
// ---------------------------------------------------------------------------
function ScheduleRow({
  index,
  entry,
  canRemove,
  onChange,
  onRemove,
  dialogId,
  errorField,
  getFieldRef,
}: {
  index: number
  entry: ScheduleEntry
  canRemove: boolean
  onChange: (updated: ScheduleEntry) => void
  onRemove: () => void
  dialogId: string
  errorField: 'date' | 'startTime' | 'endTime' | null
  getFieldRef: ReturnType<typeof useRequiredFieldFocus<ClubEventFieldKey>>['getRef']
}) {
  const t = useTranslations('admin')
  const tc = useTranslations('common')
  const { data: rooms } = useAdminRooms()
  const { data: tables } = useAdminRoomTables(entry.roomId !== NONE_ROOM ? entry.roomId : null)
  const id = (suffix: string) => `${dialogId}-sched-${index}-${suffix}`

  function field(key: keyof ScheduleEntry) {
    return (e: React.ChangeEvent<HTMLInputElement>) =>
      onChange({ ...entry, [key]: e.target.value })
  }

  return (
    <div className="rounded-lg border border-border bg-background-secondary/40 p-3 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">
          {t('clubEvents.scheduleDay', { n: index + 1 })}
        </span>
        {canRemove && (
          <button
            type="button"
            aria-label={t('clubEvents.removeSchedule')}
            onClick={onRemove}
            className="text-muted-foreground hover:text-destructive transition-colors"
          >
            <MinusCircle className="h-4 w-4" aria-hidden="true" />
          </button>
        )}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <div className="space-y-1.5">
          <Label htmlFor={id('room')} className="text-xs text-muted-foreground font-medium">
            {t('clubEvents.room')}
          </Label>
          <Select
            value={entry.roomId}
            onValueChange={(v) => onChange({ ...entry, roomId: v, tableId: WHOLE_ROOM })}
          >
            <SelectTrigger id={id('room')} className="bg-background-secondary border-border h-8 text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE_ROOM}>—</SelectItem>
              {(rooms ?? []).map((room) => (
                <SelectItem key={room.id} value={room.id}>{room.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {entry.roomId !== NONE_ROOM && (
          <div className="space-y-1.5">
            <Label htmlFor={id('table')} className="text-xs text-muted-foreground font-medium">
              {t('clubEvents.table')}
            </Label>
            <Select
              value={entry.tableId}
              onValueChange={(v) => onChange({ ...entry, tableId: v })}
            >
              <SelectTrigger id={id('table')} className="bg-background-secondary border-border h-8 text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={WHOLE_ROOM}>{t('clubEvents.wholeRoom')}</SelectItem>
                {(tables ?? []).map((table) => (
                  <SelectItem key={table.id} value={table.id}>{table.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
      </div>

      <div className="flex items-start gap-2">
        <Checkbox
          id={id('all-day')}
          checked={entry.allDay}
          onCheckedChange={(checked) => onChange({
            ...entry,
            allDay: checked === true,
            startTime: checked === true ? '' : entry.startTime,
            endTime: checked === true ? '' : entry.endTime,
          })}
          className="mt-0.5"
        />
        <Label htmlFor={id('all-day')} className="text-xs text-foreground font-medium leading-tight">
          {t('clubEvents.allDay')}
        </Label>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <div className="space-y-1">
          <Label htmlFor={id('date')} className="text-xs text-muted-foreground font-medium">
            {tc('date')}
          </Label>
          <Input
            id={id('date')}
            ref={getFieldRef(scheduleFieldKey(index, 'date'))}
            type="date"
            value={entry.date}
            onChange={field('date')}
            required
            aria-invalid={errorField === 'date'}
            aria-describedby={errorField === 'date' ? id('date-error') : undefined}
            className="bg-background-secondary border-border focus:border-primary/50 h-8 text-sm"
          />
          {errorField === 'date' && (
            <p id={id('date-error')} role="alert" className="text-xs text-destructive">{tc('requiredField')}</p>
          )}
        </div>
        {!entry.allDay && (
          <>
            <div className="space-y-1">
              <Label htmlFor={id('start')} className="text-xs text-muted-foreground font-medium">
                {t('clubEvents.startTime')}
              </Label>
              <Input
                id={id('start')}
                ref={getFieldRef(scheduleFieldKey(index, 'startTime'))}
                type="time"
                step={3600}
                value={entry.startTime}
                onChange={field('startTime')}
                required={!entry.allDay}
                aria-invalid={errorField === 'startTime'}
                aria-describedby={errorField === 'startTime' ? id('start-error') : undefined}
                className="bg-background-secondary border-border focus:border-primary/50 h-8 text-sm"
              />
              {errorField === 'startTime' && (
                <p id={id('start-error')} role="alert" className="text-xs text-destructive">{tc('requiredField')}</p>
              )}
            </div>
            <div className="space-y-1">
              <Label htmlFor={id('end')} className="text-xs text-muted-foreground font-medium">
                {t('clubEvents.endTime')}
              </Label>
              <Input
                id={id('end')}
                ref={getFieldRef(scheduleFieldKey(index, 'endTime'))}
                type="time"
                step={3600}
                value={entry.endTime}
                onChange={field('endTime')}
                required={!entry.allDay}
                aria-invalid={errorField === 'endTime'}
                aria-describedby={errorField === 'endTime' ? id('end-error') : undefined}
                className="bg-background-secondary border-border focus:border-primary/50 h-8 text-sm"
              />
              {errorField === 'endTime' && (
                <p id={id('end-error')} role="alert" className="text-xs text-destructive">{tc('requiredField')}</p>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// MaterialsEditor — materials (equipment) needed for the event, with
// quantities (OIR-208). Shown regardless of visibleOnLanding — internal
// logistics never appear on the landing.
// ---------------------------------------------------------------------------
function MaterialsEditor({
  materials,
  onChange,
  dialogId,
}: {
  materials: MaterialEntry[]
  onChange: (materials: MaterialEntry[]) => void
  dialogId: string
}) {
  const t = useTranslations('admin')
  const { data: equipment } = useAdminEquipment()

  function updateMaterial(index: number, updated: MaterialEntry) {
    onChange(materials.map((m, i) => (i === index ? updated : m)))
  }

  function addMaterial() {
    onChange([...materials, emptyMaterial()])
  }

  function removeMaterial(index: number) {
    onChange(materials.filter((_, i) => i !== index))
  }

  return (
    <div className="space-y-3 rounded-lg border border-border bg-background-secondary/30 p-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <span className="text-sm text-foreground font-medium leading-tight">{t('clubEvents.materials')}</span>
          <p className="text-xs text-muted-foreground">{t('clubEvents.materialsHelp')}</p>
        </div>
        <button
          type="button"
          onClick={addMaterial}
          className="flex items-center gap-1 text-xs text-primary hover:text-primary/80 transition-colors flex-shrink-0"
          aria-label={t('clubEvents.addMaterial')}
        >
          <PlusCircle className="h-3.5 w-3.5" aria-hidden="true" />
          {t('clubEvents.addMaterial')}
        </button>
      </div>

      {materials.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t('clubEvents.noMaterials')}</p>
      ) : (
        <div className="space-y-2">
          {materials.map((entry, i) => (
            <div key={entry.id} className="flex flex-wrap items-center gap-2">
              <div className="min-w-0 flex-1 basis-40">
                <Select
                  value={entry.equipmentId}
                  onValueChange={(v) => updateMaterial(i, { ...entry, equipmentId: v })}
                >
                  <SelectTrigger
                    id={`${dialogId}-material-${i}-equipment`}
                    className="bg-background-secondary border-border h-8 text-sm w-full"
                  >
                    <SelectValue placeholder={t('clubEvents.selectMaterial')} />
                  </SelectTrigger>
                  <SelectContent>
                    {(equipment ?? []).map((item) => (
                      <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Input
                type="number"
                min={1}
                value={entry.quantity}
                onChange={(e) => updateMaterial(i, { ...entry, quantity: Math.max(1, Number(e.target.value) || 1) })}
                aria-label={t('clubEvents.materialQuantity')}
                className="bg-background-secondary border-border focus:border-primary/50 h-8 text-sm w-20 flex-shrink-0"
              />
              <button
                type="button"
                aria-label={t('clubEvents.removeMaterial')}
                onClick={() => removeMaterial(i)}
                className="text-muted-foreground hover:text-destructive transition-colors flex-shrink-0"
              >
                <MinusCircle className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// ClubEventFormDialog — create / edit
// ---------------------------------------------------------------------------
function ClubEventFormDialog({
  open,
  onOpenChange,
  dialogId,
  title,
  form,
  setForm,
  onSubmit,
  isPending,
  error,
  fieldError,
  onClearFieldError,
  getFieldRef,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  dialogId: string
  title: string
  form: ClubEventFormState
  setForm: (f: ClubEventFormState) => void
  onSubmit: (e: React.FormEvent) => void
  isPending: boolean
  error?: string | null
  fieldError: ClubEventFieldError | null
  onClearFieldError: () => void
  getFieldRef: ReturnType<typeof useRequiredFieldFocus<ClubEventFieldKey>>['getRef']
}) {
  const t = useTranslations('admin')
  const tc = useTranslations('common')

  function updateSchedule(index: number, updated: ScheduleEntry) {
    const schedules = form.schedules.map((s, i) => (i === index ? updated : s))
    setForm({ ...form, schedules })
  }

  function addSchedule() {
    setForm({ ...form, schedules: [...form.schedules, emptySchedule()] })
  }

  function removeSchedule(index: number) {
    const schedules = form.schedules.filter((_, i) => i !== index)
    setForm({ ...form, schedules })
    // A field error anchored to a schedule row's index (e.g. `{kind:
    // 'schedule', index: 1, field: 'date'}`) becomes stale once a row above
    // it is removed and every later row shifts up — the error (and its
    // aria-invalid) would otherwise land on a different, now-valid input
    // (#313 code-review round 2, finding 5).
    onClearFieldError()
  }

  const textareaClass = 'flex w-full rounded-md border border-input bg-background-surface px-3 py-2 text-sm '
    + 'ring-offset-background placeholder:text-muted-foreground '
    + 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 '
    + 'disabled:cursor-not-allowed disabled:opacity-50 transition-colors min-h-[72px] resize-y'

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-card border-border sm:max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <div className="flex items-center gap-3 mb-1">
            <div className="flex items-center justify-center w-10 h-10 rounded-full bg-primary/10 border border-primary/20">
              <CalendarHeart className="h-5 w-5 text-primary" aria-hidden="true" />
            </div>
            <DialogTitle className="font-cinzel text-gradient-gold">{title}</DialogTitle>
          </div>
        </DialogHeader>
        <form onSubmit={onSubmit} noValidate className="space-y-4 py-2">
          {/* Title */}
          <div className="space-y-2">
            <Label htmlFor={`${dialogId}-title-es`} className="text-sm text-muted-foreground font-medium">
              {t('clubEvents.titleEs')}
            </Label>
            <Input
              id={`${dialogId}-title-es`}
              ref={getFieldRef('titleEs')}
              value={form.titleEs}
              onChange={(e) => setForm({ ...form, titleEs: e.target.value })}
              required
              aria-invalid={fieldError?.kind === 'titleEs'}
              aria-describedby={fieldError?.kind === 'titleEs' ? `${dialogId}-title-es-error` : undefined}
              className="bg-background-secondary border-border focus:border-primary/50"
            />
            {fieldError?.kind === 'titleEs' && (
              <p id={`${dialogId}-title-es-error`} role="alert" className="text-xs text-destructive">
                {tc('requiredField')}
              </p>
            )}
          </div>

          {/* Visible on landing toggle (OIR-208) */}
          <div className="flex items-start gap-2 rounded-lg border border-border bg-background-secondary/30 p-3">
            <Checkbox
              id={`${dialogId}-visible-on-landing`}
              checked={form.visibleOnLanding}
              onCheckedChange={(checked) => setForm({ ...form, visibleOnLanding: checked === true })}
              className="mt-0.5"
            />
            <div className="space-y-0.5">
              <Label htmlFor={`${dialogId}-visible-on-landing`} className="text-sm text-foreground font-medium leading-tight">
                {t('clubEvents.visibleOnLanding')}
              </Label>
              <p className="text-xs text-muted-foreground">{t('clubEvents.visibleOnLandingHelp')}</p>
            </div>
          </div>

          {form.visibleOnLanding && (
            <>
              {/* Blurb */}
              <div className="space-y-2">
                <Label htmlFor={`${dialogId}-blurb-es`} className="text-sm text-muted-foreground font-medium">
                  {t('clubEvents.blurbEs')}
                </Label>
                <Input
                  id={`${dialogId}-blurb-es`}
                  value={form.blurbEs}
                  onChange={(e) => setForm({ ...form, blurbEs: e.target.value })}
                  className="bg-background-secondary border-border focus:border-primary/50"
                />
              </div>

              {/* Description */}
              <div className="space-y-2">
                <Label htmlFor={`${dialogId}-description-es`} className="text-sm text-muted-foreground font-medium">
                  {t('clubEvents.descriptionEs')}
                </Label>
                <textarea
                  id={`${dialogId}-description-es`}
                  value={form.descriptionEs}
                  onChange={(e) => setForm({ ...form, descriptionEs: e.target.value })}
                  className={textareaClass}
                />
              </div>

              {/* Category */}
              <div className="space-y-2">
                <Label htmlFor={`${dialogId}-category-es`} className="text-sm text-muted-foreground font-medium">
                  {t('clubEvents.categoryEs')}
                </Label>
                <Input
                  id={`${dialogId}-category-es`}
                  value={form.categoryEs}
                  onChange={(e) => setForm({ ...form, categoryEs: e.target.value })}
                  className="bg-background-secondary border-border focus:border-primary/50"
                />
              </div>
            </>
          )}

          {/* Date kind + date(s) */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="space-y-2">
              <Label htmlFor={`${dialogId}-date-kind`} className="text-sm text-muted-foreground font-medium">
                {t('clubEvents.dateKind')}
              </Label>
              <Select
                value={form.dateKind}
                onValueChange={(v) => setForm({ ...form, dateKind: v as DateKind })}
              >
                <SelectTrigger id={`${dialogId}-date-kind`} className="bg-background-secondary border-border">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="single">{t('clubEvents.dateKindSingle')}</SelectItem>
                  <SelectItem value="range">{t('clubEvents.dateKindRange')}</SelectItem>
                  <SelectItem value="recurring">{t('clubEvents.dateKindRecurring')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor={`${dialogId}-date`} className="text-sm text-muted-foreground font-medium">
                {form.dateKind === 'range' ? t('clubEvents.startDate') : t('clubEvents.date')}
              </Label>
              <Input
                id={`${dialogId}-date`}
                ref={getFieldRef('date')}
                type="date"
                value={form.date}
                onChange={(e) => setForm({ ...form, date: e.target.value })}
                required
                aria-invalid={fieldError?.kind === 'date'}
                aria-describedby={fieldError?.kind === 'date' ? `${dialogId}-date-error` : undefined}
                className="bg-background-secondary border-border focus:border-primary/50"
              />
              {fieldError?.kind === 'date' && (
                <p id={`${dialogId}-date-error`} role="alert" className="text-xs text-destructive">
                  {tc('requiredField')}
                </p>
              )}
            </div>
            {form.dateKind === 'range' && (
              <div className="space-y-2">
                <Label htmlFor={`${dialogId}-end-date`} className="text-sm text-muted-foreground font-medium">
                  {t('clubEvents.endDate')}
                </Label>
                <Input
                  id={`${dialogId}-end-date`}
                  ref={getFieldRef('endDate')}
                  type="date"
                  value={form.endDate}
                  onChange={(e) => setForm({ ...form, endDate: e.target.value })}
                  required
                  aria-invalid={fieldError?.kind === 'endDate'}
                  aria-describedby={fieldError?.kind === 'endDate' ? `${dialogId}-end-date-error` : undefined}
                  className="bg-background-secondary border-border focus:border-primary/50"
                />
                {fieldError?.kind === 'endDate' && (
                  <p id={`${dialogId}-end-date-error`} role="alert" className="text-xs text-destructive">
                    {tc('requiredField')}
                  </p>
                )}
              </div>
            )}
          </div>

          {form.dateKind === 'recurring' && (
            <div className="space-y-2">
              <Label htmlFor={`${dialogId}-recurrence-es`} className="text-sm text-muted-foreground font-medium">
                {t('clubEvents.recurrenceLabelEs')}
              </Label>
              <Input
                id={`${dialogId}-recurrence-es`}
                value={form.recurrenceLabelEs}
                onChange={(e) => setForm({ ...form, recurrenceLabelEs: e.target.value })}
                className="bg-background-secondary border-border focus:border-primary/50"
              />
            </div>
          )}

          {/* English copy is optional (OIR-206) — collapsed by default; the
              service falls back to the Spanish text above when left blank.
              Only relevant when the event is visible on the (bilingual)
              landing page. */}
          {form.visibleOnLanding && (
            <OptionalEnglishFields idPrefix={dialogId}>
              <div className="space-y-2">
                <Label htmlFor={`${dialogId}-title-en`} className="text-sm text-muted-foreground font-medium">
                  {t('clubEvents.titleEn')}
                </Label>
                <Input
                  id={`${dialogId}-title-en`}
                  value={form.titleEn}
                  onChange={(e) => setForm({ ...form, titleEn: e.target.value })}
                  placeholder={t('englishOptional.hint')}
                  className="bg-background-secondary border-border focus:border-primary/50"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor={`${dialogId}-blurb-en`} className="text-sm text-muted-foreground font-medium">
                  {t('clubEvents.blurbEn')}
                </Label>
                <Input
                  id={`${dialogId}-blurb-en`}
                  value={form.blurbEn}
                  onChange={(e) => setForm({ ...form, blurbEn: e.target.value })}
                  placeholder={t('englishOptional.hint')}
                  className="bg-background-secondary border-border focus:border-primary/50"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor={`${dialogId}-description-en`} className="text-sm text-muted-foreground font-medium">
                  {t('clubEvents.descriptionEn')}
                </Label>
                <textarea
                  id={`${dialogId}-description-en`}
                  value={form.descriptionEn}
                  onChange={(e) => setForm({ ...form, descriptionEn: e.target.value })}
                  placeholder={t('englishOptional.hint')}
                  className={textareaClass}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor={`${dialogId}-category-en`} className="text-sm text-muted-foreground font-medium">
                  {t('clubEvents.categoryEn')}
                </Label>
                <Input
                  id={`${dialogId}-category-en`}
                  value={form.categoryEn}
                  onChange={(e) => setForm({ ...form, categoryEn: e.target.value })}
                  placeholder={t('englishOptional.hint')}
                  className="bg-background-secondary border-border focus:border-primary/50"
                />
              </div>
              {form.dateKind === 'recurring' && (
                <div className="space-y-2">
                  <Label htmlFor={`${dialogId}-recurrence-en`} className="text-sm text-muted-foreground font-medium">
                    {t('clubEvents.recurrenceLabelEn')}
                  </Label>
                  <Input
                    id={`${dialogId}-recurrence-en`}
                    value={form.recurrenceLabelEn}
                    onChange={(e) => setForm({ ...form, recurrenceLabelEn: e.target.value })}
                    placeholder={t('englishOptional.hint')}
                    className="bg-background-secondary border-border focus:border-primary/50"
                  />
                </div>
              )}
            </OptionalEnglishFields>
          )}

          {/* Image / link URLs — landing-only */}
          {form.visibleOnLanding && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-2">
                <ImageUpload
                  idPrefix={dialogId}
                  folder="events"
                  value={form.imageUrl}
                  onChange={(url) => setForm({ ...form, imageUrl: url })}
                />
                <Label htmlFor={`${dialogId}-image-url`} className="text-sm text-muted-foreground font-medium">
                  {t('clubEvents.imageUrl')}
                </Label>
                <Input
                  id={`${dialogId}-image-url`}
                  type="url"
                  value={form.imageUrl}
                  onChange={(e) => setForm({ ...form, imageUrl: e.target.value })}
                  placeholder="https://…"
                  className="bg-background-secondary border-border focus:border-primary/50"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor={`${dialogId}-link-url`} className="text-sm text-muted-foreground font-medium">
                  {t('clubEvents.linkUrl')}
                </Label>
                <Input
                  id={`${dialogId}-link-url`}
                  type="url"
                  value={form.linkUrl}
                  onChange={(e) => setForm({ ...form, linkUrl: e.target.value })}
                  placeholder="https://…"
                  className="bg-background-secondary border-border focus:border-primary/50"
                />
              </div>
            </div>
          )}

          {/* Blocks rooms toggle + sub-flow */}
          <div className="space-y-3 rounded-lg border border-border bg-background-secondary/30 p-3">
            <div className="flex items-start gap-2">
              <Checkbox
                id={`${dialogId}-blocks-rooms`}
                checked={form.blocksRooms}
                onCheckedChange={(checked) => setForm({ ...form, blocksRooms: checked === true })}
                className="mt-0.5"
              />
              <div className="space-y-0.5">
                <Label htmlFor={`${dialogId}-blocks-rooms`} className="text-sm text-foreground font-medium leading-tight">
                  {t('clubEvents.blocksRooms')}
                </Label>
                <p className="text-xs text-muted-foreground">{t('clubEvents.blocksRoomsHelp')}</p>
              </div>
            </div>

            {form.blocksRooms && (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground font-medium">
                    {t('clubEvents.roomBlocks')}
                  </span>
                  <button
                    type="button"
                    onClick={addSchedule}
                    className="flex items-center gap-1 text-xs text-primary hover:text-primary/80 transition-colors"
                    aria-label={t('clubEvents.addSchedule')}
                  >
                    <PlusCircle className="h-3.5 w-3.5" aria-hidden="true" />
                    {t('clubEvents.addSchedule')}
                  </button>
                </div>
                <div className="space-y-3">
                  {form.schedules.map((entry, i) => (
                    <ScheduleRow
                      key={entry.id}
                      index={i}
                      entry={entry}
                      canRemove={form.schedules.length > 1}
                      onChange={(updated) => updateSchedule(i, updated)}
                      onRemove={() => removeSchedule(i)}
                      dialogId={dialogId}
                      errorField={
                        fieldError?.kind === 'schedule' && fieldError.index === i ? fieldError.field : null
                      }
                      getFieldRef={getFieldRef}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Materials (equipment) — OIR-208 */}
          <MaterialsEditor
            materials={form.materials}
            onChange={(materials) => setForm({ ...form, materials })}
            dialogId={dialogId}
          />

          {error && (
            <div role="alert" className="rounded-md bg-destructive/15 border border-destructive/30 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} className="border-border">
              {tc('cancel')}
            </Button>
            <Button type="submit" disabled={isPending} className="min-w-[80px]">
              {isPending ? (
                <span className="inline-flex items-center gap-2">
                  <DiceLoader size="sm" hideRole />
                  <span>{t('saving')}</span>
                </span>
              ) : tc('save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// DeleteClubEventDialog
// ---------------------------------------------------------------------------
function DeleteClubEventDialog({
  open,
  onOpenChange,
  event,
  onConfirm,
  isPending,
  deleteError,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  event: AdminClubEvent | null
  onConfirm: () => void
  isPending: boolean
  deleteError: string | null
}) {
  const t = useTranslations('admin')
  const tc = useTranslations('common')

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-card border-border">
        <DialogHeader>
          <DialogTitle className="font-cinzel text-destructive">{t('clubEvents.deleteEvent')}</DialogTitle>
        </DialogHeader>
        <div className="py-2 space-y-3">
          <p className="text-sm text-muted-foreground">
            {t('clubEvents.deleteEventConfirm', { title: event?.titleEs ?? '' })}
          </p>
          <p className="text-sm text-muted-foreground">
            {t('clubEvents.deleteWarning')}
          </p>
          {deleteError && (
            <div role="alert" className="rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3">
              <p className="text-sm text-destructive font-medium">{t('clubEvents.deleteError')}</p>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} className="border-border">
            {tc('cancel')}
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={onConfirm}
            disabled={isPending}
            className="min-w-[80px]"
          >
            {isPending ? (
              <span className="inline-flex items-center gap-2">
                <DiceLoader size="sm" hideRole />
                <span>{tc('loading')}</span>
              </span>
            ) : tc('delete')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// ClubEventRow — list item
// ---------------------------------------------------------------------------
function ClubEventRow({
  event,
  onEdit,
  onDelete,
}: {
  event: AdminClubEvent
  onEdit: (event: AdminClubEvent) => void
  onDelete: (event: AdminClubEvent) => void
}) {
  const t = useTranslations('admin')
  const tc = useTranslations('common')
  const locale = useLocale()
  const dateLabel = formatClubEventDate(event, locale)
  const category = locale === 'en' ? event.categoryEn : event.categoryEs

  return (
    <div className="rpg-card px-4 py-3.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-0.5">
          <p className="font-cinzel font-semibold text-foreground truncate">
            {locale === 'en' ? event.titleEn : event.titleEs}
          </p>
          {(event.blurbEs || event.blurbEn) && (
            <p className="text-xs text-muted-foreground truncate">
              {locale === 'en' ? event.blurbEn : event.blurbEs}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2 mt-1.5">
            <Badge variant="outline" className="text-xs font-mono">{dateLabel}</Badge>
            {event.visibleOnLanding && (
              <Badge variant="default" className="text-xs">
                {t('clubEvents.landingBadge')}
              </Badge>
            )}
            {category && (
              <Badge variant="partial" className="text-xs">{category}</Badge>
            )}
            {event.blocksRooms && (
              <Badge variant="outline" className="text-xs">
                {t('clubEvents.blocksRooms')}
              </Badge>
            )}
            {event.materials.length > 0 && (
              <Badge variant="outline" className="text-xs">
                {t('clubEvents.materials')}: {event.materials.length}
              </Badge>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <Button
            variant="ghost"
            size="icon"
            aria-label={tc('edit')}
            onClick={() => onEdit(event)}
            className="h-8 w-8 text-muted-foreground hover:text-primary hover:bg-primary/10 transition-colors"
          >
            <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label={tc('delete')}
            onClick={() => onDelete(event)}
            className="h-8 w-8 text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
          </Button>
        </div>
      </div>
    </div>
  )
}

function ClubEventList({
  events,
  emptyLabel,
  onEdit,
  onDelete,
}: {
  events: AdminClubEvent[]
  emptyLabel: string
  onEdit: (event: AdminClubEvent) => void
  onDelete: (event: AdminClubEvent) => void
}) {
  if (events.length === 0) {
    return (
      <div className="rpg-card p-8 text-center">
        <p className="font-cinzel text-sm font-semibold text-muted-foreground">{emptyLabel}</p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {events.map((event) => (
        <ClubEventRow key={event.id} event={event} onEdit={onEdit} onDelete={onDelete} />
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// ClubEventsSection — main export
//
// OIR-208: this is the ONE unified "Eventos" section — there is no more
// Club/Internos split. Every event (landing-published or internal-only)
// lives in the same list; the "Landing" badge marks published rows and the
// "Visible en landing" toggle in the form controls it.
// ---------------------------------------------------------------------------
export function ClubEventsSection() {
  const t = useTranslations('admin')

  const { data, isLoading } = useAdminClubEvents()
  const createClubEvent = useAdminCreateClubEvent()
  const updateClubEvent = useAdminUpdateClubEvent()
  const deleteClubEvent = useAdminDeleteClubEvent()

  const [showCreate, setShowCreate] = useState(false)
  const [createForm, setCreateForm] = useState<ClubEventFormState>(emptyForm())

  const [editingEvent, setEditingEvent] = useState<AdminClubEvent | null>(null)
  const [editForm, setEditForm] = useState<ClubEventFormState>(emptyForm())

  const [deletingEvent, setDeletingEvent] = useState<AdminClubEvent | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [createError, setCreateError] = useState<string | null>(null)
  const [updateError, setUpdateError] = useState<string | null>(null)
  const [createFieldError, setCreateFieldError] = useState<ClubEventFieldError | null>(null)
  const [updateFieldError, setUpdateFieldError] = useState<ClubEventFieldError | null>(null)
  const { getRef: getCreateFieldRef, focus: focusCreateField } = useRequiredFieldFocus<ClubEventFieldKey>()
  const { getRef: getUpdateFieldRef, focus: focusUpdateField } = useRequiredFieldFocus<ClubEventFieldKey>()

  function openEdit(event: AdminClubEvent) {
    setEditingEvent(event)
    setEditForm(formFromEvent(event))
    setUpdateFieldError(null)
  }

  function openDelete(event: AdminClubEvent) {
    setDeletingEvent(event)
    setDeleteError(null)
  }

  function extractErrorMessage(err: unknown): string {
    return err instanceof Error
      ? err.message
      : (err as { message?: string })?.message ?? String(err)
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    const blankField = getBlankRequiredField(createForm)
    if (blankField) {
      setCreateFieldError(blankField)
      focusCreateField(clubEventFieldKey(blankField))
      return
    }
    setCreateFieldError(null)
    setCreateError(null)
    try {
      await createClubEvent.mutateAsync(buildPayload(createForm))
      setCreateForm(emptyForm())
      setShowCreate(false)
    } catch (err: unknown) {
      setCreateError(extractErrorMessage(err))
    }
  }

  async function handleUpdate(e: React.FormEvent) {
    e.preventDefault()
    if (!editingEvent) return
    const blankField = getBlankRequiredField(editForm)
    if (blankField) {
      setUpdateFieldError(blankField)
      focusUpdateField(clubEventFieldKey(blankField))
      return
    }
    setUpdateFieldError(null)
    setUpdateError(null)
    try {
      await updateClubEvent.mutateAsync({ id: editingEvent.id, data: buildPayload(editForm) })
      setEditingEvent(null)
    } catch (err: unknown) {
      setUpdateError(extractErrorMessage(err))
    }
  }

  async function handleDelete() {
    if (!deletingEvent) return
    try {
      await deleteClubEvent.mutateAsync(deletingEvent.id)
      setDeletingEvent(null)
      setDeleteError(null)
    } catch (err: unknown) {
      setDeleteError(extractErrorMessage(err))
    }
  }

  const upcoming = data?.upcoming ?? []
  const past = data?.past ?? []

  return (
    <section aria-labelledby="club-events-heading" className="space-y-5">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-8 h-8 rounded-md bg-primary/10 border border-primary/20">
            <CalendarHeart className="h-4 w-4 text-primary" aria-hidden="true" />
          </div>
          <div>
            <h2 id="club-events-heading" className="font-cinzel text-xl font-semibold text-foreground">
              {t('clubEvents.title')}
            </h2>
            <p className="text-xs text-muted-foreground">{t('clubEvents.sectionDescription')}</p>
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => { setCreateForm(emptyForm()); setCreateFieldError(null); setShowCreate(true) }}
          className="gap-1.5 border-primary/30 text-primary/80 hover:bg-primary/10 hover:border-primary/50 hover:text-primary transition-colors"
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
          {t('clubEvents.createEvent')}
        </Button>
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="rpg-card px-4 py-3.5 flex items-center justify-between gap-4">
              <div className="space-y-1.5 flex-1">
                <Skeleton className="h-4 w-40 rounded" />
                <Skeleton className="h-3 w-60 rounded" />
              </div>
              <Skeleton className="h-8 w-16 rounded flex-shrink-0" />
            </div>
          ))}
        </div>
      ) : (
        <Tabs defaultValue="upcoming">
          <TabsList className="mb-4">
            <TabsTrigger value="upcoming">{t('clubEvents.upcoming')}</TabsTrigger>
            <TabsTrigger value="past">{t('clubEvents.past')}</TabsTrigger>
          </TabsList>
          <TabsContent value="upcoming">
            <ClubEventList
              events={upcoming}
              emptyLabel={t('clubEvents.noUpcoming')}
              onEdit={openEdit}
              onDelete={openDelete}
            />
          </TabsContent>
          <TabsContent value="past">
            <ClubEventList
              events={past}
              emptyLabel={t('clubEvents.noPast')}
              onEdit={openEdit}
              onDelete={openDelete}
            />
          </TabsContent>
        </Tabs>
      )}

      <ClubEventFormDialog
        open={showCreate}
        onOpenChange={(open) => {
          setShowCreate(open)
          if (!open) {
            setCreateError(null)
            setCreateFieldError(null)
          }
        }}
        dialogId="create-club-event"
        title={t('clubEvents.createEvent')}
        form={createForm}
        setForm={setCreateForm}
        onSubmit={handleCreate}
        isPending={createClubEvent.isPending}
        error={createError}
        fieldError={createFieldError}
        onClearFieldError={() => setCreateFieldError(null)}
        getFieldRef={getCreateFieldRef}
      />

      <ClubEventFormDialog
        open={!!editingEvent}
        onOpenChange={(open) => {
          if (!open) {
            setEditingEvent(null)
            setUpdateError(null)
            setUpdateFieldError(null)
          }
        }}
        dialogId="edit-club-event"
        title={t('clubEvents.editEvent')}
        form={editForm}
        setForm={setEditForm}
        onSubmit={handleUpdate}
        isPending={updateClubEvent.isPending}
        error={updateError}
        fieldError={updateFieldError}
        onClearFieldError={() => setUpdateFieldError(null)}
        getFieldRef={getUpdateFieldRef}
      />

      <DeleteClubEventDialog
        open={!!deletingEvent}
        onOpenChange={(open) => { if (!open) { setDeletingEvent(null); setDeleteError(null) } }}
        event={deletingEvent}
        onConfirm={handleDelete}
        isPending={deleteClubEvent.isPending}
        deleteError={deleteError}
      />
    </section>
  )
}
