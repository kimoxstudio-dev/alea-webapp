'use client'

import { useState, useEffect, useRef } from 'react'
import Image from 'next/image'
import { useTranslations } from 'next-intl'
import { Pencil, Plus, ChevronDown, ChevronRight, DoorOpen, Table2, QrCode, Download, RefreshCw } from 'lucide-react'
import { DiceLoader } from '@/components/ui/dice-loader'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Badge } from '@/components/ui/badge'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import {
  useAdminRooms,
  useAdminUpdateRoom,
  useAdminCreateRoom,
  useAdminRoomTables,
  useAdminCreateTable,
  useAdminRegenerateTableQr,
  useAdminEquipment,
  useAdminRoomDefaultEquipment,
  useAdminSetRoomDefaultEquipment,
} from '@/lib/hooks/use-admin'
import type { Room, GameTable } from '@/lib/types'

// Table type badge styling
const tableTypeBadge: Record<string, 'outline' | 'partial' | 'available'> = {
  small: 'outline',
  large: 'partial',
  removable_top: 'available',
}

// Sub-component: QR code display and management for a single table
function TableQrPanel({ table, roomId }: { table: GameTable; roomId: string }) {
  const t = useTranslations('admin')
  const tt = useTranslations('tables')
  const tc = useTranslations('common')
  const regenerateQr = useAdminRegenerateTableQr()
  const [qrCode, setQrCode] = useState<string>(table.qrCode)

  async function handleRegenerate() {
    const result = await regenerateQr.mutateAsync({ tableId: table.id, roomId })
    setQrCode(result.qr_code)
  }

  return (
    <div className="mt-2 ml-6 pl-4 border-l-2 border-primary/10 space-y-3 py-2">
      <div className="flex flex-wrap gap-4">
        {/* Main QR code */}
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-muted-foreground">
            {tt('qrCode')}
          </p>
          {qrCode ? (
            <div className="flex flex-col gap-2">
              <Image
                src={qrCode}
                alt={`QR ${table.name}`}
                width={128}
                height={128}
                className="w-32 h-32 rounded-md border border-border/50 bg-white object-cover"
                unoptimized
              />
              <a
                href={qrCode}
                download={`QR-${table.name}.png`}
                className="inline-flex items-center gap-1.5 text-xs text-primary hover:text-primary/80 transition-colors"
              >
                <Download className="h-3 w-3" aria-hidden="true" />
                {tc('save')}
              </a>
            </div>
          ) : (
            <div className="w-32 h-32 rounded-md border border-border/50 bg-background-secondary/40 flex items-center justify-center">
              <QrCode className="h-8 w-8 text-muted-foreground/40" aria-hidden="true" />
            </div>
          )}
        </div>

      </div>

      <Button
        variant="outline"
        size="sm"
        onClick={handleRegenerate}
        disabled={regenerateQr.isPending}
        className="gap-1.5 h-8 border-border text-muted-foreground hover:text-foreground hover:border-primary/50 transition-colors"
      >
        {regenerateQr.isPending ? (
          <span className="inline-flex items-center gap-2"><DiceLoader size="sm" hideRole /><span>{tc('loading')}</span></span>
        ) : (
          <>
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
            {t('regenerateQr')}
          </>
        )}
      </Button>
    </div>
  )
}

// Sub-component: single table row with QR toggle
function TableRow({ table, roomId }: { table: GameTable; roomId: string }) {
  const tt = useTranslations('tables')
  const [showQr, setShowQr] = useState(false)

  return (
    <div className="rounded-md bg-background-secondary/40 border border-border/30">
      <div className="flex items-center justify-between gap-2 py-2 px-3 hover:bg-background-secondary/70 transition-colors">
        <div className="flex items-center gap-2">
          <Table2 className="h-3.5 w-3.5 text-muted-foreground/60 flex-shrink-0" aria-hidden="true" />
          <span className="text-sm font-medium text-foreground">{table.name}</span>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={tableTypeBadge[table.type] ?? 'outline'} className="text-xs">
            {tt(table.type)}
          </Badge>
          <button
            type="button"
            onClick={() => setShowQr((v) => !v)}
            aria-expanded={showQr}
            aria-label={tt('qrCode')}
            className="flex items-center justify-center w-6 h-6 rounded text-muted-foreground hover:text-primary transition-colors"
          >
            <QrCode className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
      </div>
      {showQr && <TableQrPanel table={table} roomId={roomId} />}
    </div>
  )
}

// Sub-component: expanded room tables list + create table form
function RoomTablesPanel({ room }: { room: Room }) {
  const t = useTranslations('admin')
  const tc = useTranslations('common')
  const tt = useTranslations('tables')

  const { data: tables, isLoading } = useAdminRoomTables(room.id)
  const createTable = useAdminCreateTable()

  const [showCreateTable, setShowCreateTable] = useState(false)
  const [tableName, setTableName] = useState('')
  const [tableType, setTableType] = useState<'small' | 'large' | 'removable_top'>('small')
  const [formError, setFormError] = useState<string | null>(null)
  const tableNameRef = useRef<HTMLInputElement>(null)

  async function handleCreateTable(e: React.FormEvent) {
    e.preventDefault()
    if (!tableName.trim()) {
      setFormError(tc('requiredField'))
      tableNameRef.current?.focus()
      return
    }
    setFormError(null)
    await createTable.mutateAsync({ roomId: room.id, data: { name: tableName.trim(), type: tableType } })
    setTableName('')
    setTableType('small')
    setShowCreateTable(false)
  }

  return (
    <div className="mt-4 ml-6 pl-4 border-l-2 border-primary/20 space-y-4">
      {/* Table list */}
      {isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-8 w-full rounded-md" />
          <Skeleton className="h-8 w-3/4 rounded-md" />
        </div>
      ) : (tables ?? []).length === 0 ? (
        <div className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
          <Table2 className="h-4 w-4 text-muted-foreground/50" aria-hidden="true" />
          {t('noTables')}
        </div>
      ) : (
        <div className="space-y-1">
          {(tables as GameTable[]).map((table) => (
            <TableRow key={table.id} table={table} roomId={room.id} />
          ))}
        </div>
      )}

      {/* Create table form */}
      {showCreateTable ? (
        <form onSubmit={handleCreateTable} noValidate className="space-y-3 rounded-md border border-primary/20 bg-primary/5 p-4">
          <p className="text-xs font-cinzel font-semibold text-primary/80 uppercase tracking-wider mb-2">
            {t('createTable')}
          </p>
          <div className="space-y-1.5">
            <Label htmlFor={`table-name-${room.id}`} className="text-xs text-muted-foreground">
              {t('tableName')}
            </Label>
            <Input
              id={`table-name-${room.id}`}
              ref={tableNameRef}
              value={tableName}
              onChange={(e) => setTableName(e.target.value)}
              placeholder={t('tableName')}
              required
              aria-invalid={!!formError}
              aria-describedby={formError ? `table-name-error-${room.id}` : undefined}
              className="h-8 text-sm bg-background-secondary border-border focus:border-primary/50"
            />
            {formError && (
              <p id={`table-name-error-${room.id}`} role="alert" className="text-xs text-destructive">
                {formError}
              </p>
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`table-type-${room.id}`} className="text-xs text-muted-foreground">
              {t('tableType')}
            </Label>
            <Select value={tableType} onValueChange={(v) => setTableType(v as typeof tableType)}>
              <SelectTrigger id={`table-type-${room.id}`} className="h-8 text-sm bg-background-secondary border-border">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="small">{tt('small')}</SelectItem>
                <SelectItem value="large">{tt('large')}</SelectItem>
                <SelectItem value="removable_top">{tt('removable_top')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex gap-2 pt-1">
            <Button type="submit" size="sm" disabled={createTable.isPending} className="h-8">
              {createTable.isPending ? (
                <span className="inline-flex items-center gap-2"><DiceLoader size="sm" hideRole /><span>{t('creating')}</span></span>
              ) : tc('save')}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => { setShowCreateTable(false); setFormError(null) }}
              className="h-8 border-border"
            >
              {tc('cancel')}
            </Button>
          </div>
        </form>
      ) : (
        <Button
          variant="outline"
          size="sm"
          onClick={() => setShowCreateTable(true)}
          className="gap-1.5 border-primary/30 text-primary/80 hover:bg-primary/10 hover:border-primary/50 hover:text-primary transition-colors"
        >
          <Plus className="h-3.5 w-3.5" aria-hidden="true" />
          {t('createTable')}
        </Button>
      )}
    </div>
  )
}

// Sub-component: single room row
function RoomRow({ room }: { room: Room }) {
  const t = useTranslations('admin')
  const tc = useTranslations('common')

  const [expanded, setExpanded] = useState(false)
  const [editing, setEditing] = useState(false)
  const [editName, setEditName] = useState(room.name)
  const [editDesc, setEditDesc] = useState(room.description ?? '')
  const [editTableCount, setEditTableCount] = useState(String(room.tableCount))
  const [selectedEquipmentIds, setSelectedEquipmentIds] = useState<string[]>([])
  const [editError, setEditError] = useState<string | null>(null)
  const editNameRef = useRef<HTMLInputElement>(null)

  const updateRoom = useAdminUpdateRoom()
  const setRoomDefaultEquipment = useAdminSetRoomDefaultEquipment()
  const { data: allEquipment } = useAdminEquipment()
  const { data: roomEquipment } = useAdminRoomDefaultEquipment(editing ? room.id : null)

  // Sync room equipment when dialog opens
  function handleOpenEdit() {
    setEditName(room.name)
    setEditDesc(room.description ?? '')
    setEditTableCount(String(room.tableCount))
    setEditError(null)
    setEditing(true)
  }

  function toggleEquipment(id: string) {
    setSelectedEquipmentIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    )
  }

  // Initialize selectedEquipmentIds from loaded room equipment
  useEffect(() => {
    if (editing && roomEquipment !== undefined) {
      setSelectedEquipmentIds(roomEquipment.map((e) => e.id))
    }
    if (!editing) {
      setSelectedEquipmentIds([])
    }
  }, [editing, roomEquipment])

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    if (!editName.trim()) {
      setEditError(tc('requiredField'))
      editNameRef.current?.focus()
      return
    }
    setEditError(null)
    const tableCount = Math.max(0, parseInt(editTableCount, 10) || 0)
    await Promise.all([
      updateRoom.mutateAsync({
        id: room.id,
        data: { name: editName.trim() || room.name, description: editDesc.trim() || undefined, tableCount },
      }),
      setRoomDefaultEquipment.mutateAsync({ roomId: room.id, equipmentIds: selectedEquipmentIds }),
    ])
    setEditing(false)
  }

  return (
    <div className="rpg-card overflow-hidden">
      {/* Room header row */}
      <div className="flex items-center justify-between gap-2 px-4 py-3.5">
        <button
          type="button"
          className="flex items-center gap-2.5 text-left hover:text-primary transition-colors group/toggle min-w-0"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          aria-controls={`room-tables-${room.id}`}
        >
          <span className="flex-shrink-0 flex items-center justify-center w-6 h-6 rounded text-muted-foreground group-hover/toggle:text-primary transition-colors">
            {expanded
              ? <ChevronDown className="h-4 w-4" aria-hidden="true" />
              : <ChevronRight className="h-4 w-4" aria-hidden="true" />}
          </span>
          <div className="min-w-0">
            <span className="font-cinzel font-semibold text-foreground group-hover/toggle:text-primary transition-colors block truncate">
              {room.name}
            </span>
            {room.description && (
              <span className="text-xs text-muted-foreground block truncate mt-0.5">
                {room.description}
              </span>
            )}
          </div>
        </button>

        <div className="flex items-center gap-3 flex-shrink-0">
          <div className="hidden sm:flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-background-secondary/60 border border-border/50">
            <Table2 className="h-3 w-3 text-muted-foreground" aria-hidden="true" />
            <span className="text-xs font-medium text-muted-foreground">
              {room.tableCount} {t('tables')}
            </span>
          </div>
          <Button
            variant="ghost"
            size="icon"
            aria-label={t('editRoom')}
            onClick={handleOpenEdit}
            className="h-8 w-8 text-muted-foreground hover:text-primary hover:bg-primary/10 transition-colors"
          >
            <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
          </Button>
        </div>
      </div>

      {/* Expandable tables panel */}
      {expanded && (
        <div
          id={`room-tables-${room.id}`}
          className="border-t border-border/50 px-4 pb-4 bg-background-secondary/20"
        >
          <RoomTablesPanel room={room} />
        </div>
      )}

      {/* Edit dialog */}
      <Dialog open={editing} onOpenChange={(open) => { setEditing(open); if (!open) setEditError(null) }}>
        <DialogContent className="bg-card border-border max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="font-cinzel text-gradient-gold">{t('editRoom')}</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleSave} noValidate className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor={`room-name-edit-${room.id}`} className="text-sm text-muted-foreground font-medium">
                {t('roomName')}
              </Label>
              <Input
                id={`room-name-edit-${room.id}`}
                ref={editNameRef}
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                required
                aria-invalid={!!editError}
                aria-describedby={editError ? `room-name-edit-error-${room.id}` : undefined}
                className="bg-background-secondary border-border focus:border-primary/50"
              />
              {editError && (
                <p id={`room-name-edit-error-${room.id}`} role="alert" className="text-xs text-destructive">
                  {editError}
                </p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor={`room-desc-edit-${room.id}`} className="text-sm text-muted-foreground font-medium">
                {t('roomDescription')}
              </Label>
              <Input
                id={`room-desc-edit-${room.id}`}
                value={editDesc}
                onChange={(e) => setEditDesc(e.target.value)}
                className="bg-background-secondary border-border focus:border-primary/50"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor={`room-count-edit-${room.id}`} className="text-sm text-muted-foreground font-medium">
                {t('tableCount')}
              </Label>
              <Input
                id={`room-count-edit-${room.id}`}
                type="number"
                min="0"
                value={editTableCount}
                onChange={(e) => setEditTableCount(e.target.value)}
                className="bg-background-secondary border-border focus:border-primary/50"
              />
            </div>
            {(allEquipment ?? []).length > 0 && (
              <div className="space-y-2">
                <Label className="text-sm text-muted-foreground font-medium">
                  {t('equipment.defaultEquipment')}
                </Label>
                <div className="rounded-md border border-border/50 bg-background-secondary/40 p-3 space-y-2 max-h-40 overflow-y-auto">
                  {(allEquipment ?? []).map((equip) => (
                    <label key={equip.id} className="flex items-center gap-2 cursor-pointer group">
                      <input
                        type="checkbox"
                        checked={selectedEquipmentIds.includes(equip.id)}
                        onChange={() => toggleEquipment(equip.id)}
                        className="w-4 h-4 rounded border-border accent-primary"
                      />
                      <span className="text-sm text-foreground group-hover:text-primary transition-colors">
                        {equip.name}
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setEditing(false)} className="border-border">
                {tc('cancel')}
              </Button>
              <Button type="submit" disabled={updateRoom.isPending || setRoomDefaultEquipment.isPending} className="min-w-[80px]">
                {(updateRoom.isPending || setRoomDefaultEquipment.isPending) ? (
                  <span className="inline-flex items-center gap-2"><DiceLoader size="sm" hideRole /><span>{t('saving')}</span></span>
                ) : tc('save')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}

export function RoomsSection() {
  const t = useTranslations('admin')
  const tc = useTranslations('common')

  const { data: rooms, isLoading } = useAdminRooms()
  const { data: allEquipment } = useAdminEquipment()
  const createRoom = useAdminCreateRoom()
  const setRoomDefaultEquipment = useAdminSetRoomDefaultEquipment()

  const [showCreate, setShowCreate] = useState(false)
  const [newName, setNewName] = useState('')
  const [newDesc, setNewDesc] = useState('')
  const [newTableCount, setNewTableCount] = useState('0')
  const [newEquipmentIds, setNewEquipmentIds] = useState<string[]>([])
  const [createError, setCreateError] = useState<string | null>(null)
  const newNameRef = useRef<HTMLInputElement>(null)

  function toggleNewEquipment(id: string) {
    setNewEquipmentIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    )
  }

  async function handleCreateRoom(e: React.FormEvent) {
    e.preventDefault()
    if (!newName.trim()) {
      setCreateError(tc('requiredField'))
      newNameRef.current?.focus()
      return
    }
    setCreateError(null)
    const parsed = Number(newTableCount)
    const tableCount = Number.isInteger(parsed) && parsed >= 0 ? parsed : 0
    const created = await createRoom.mutateAsync({ name: newName.trim(), description: newDesc.trim() || undefined, tableCount })
    if (newEquipmentIds.length > 0) {
      await setRoomDefaultEquipment.mutateAsync({ roomId: created.id, equipmentIds: newEquipmentIds })
    }
    setNewName('')
    setNewDesc('')
    setNewTableCount('0')
    setNewEquipmentIds([])
    setShowCreate(false)
  }

  return (
    <section aria-labelledby="rooms-heading" className="space-y-5">
      {/* Section header */}
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-8 h-8 rounded-md bg-primary/10 border border-primary/20">
            <DoorOpen className="h-4 w-4 text-primary" aria-hidden="true" />
          </div>
          <h2 id="rooms-heading" className="font-cinzel text-xl font-semibold text-foreground">
            {t('roomManagement')}
          </h2>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setShowCreate(true)}
          className="gap-1.5 border-primary/30 text-primary/80 hover:bg-primary/10 hover:border-primary/50 hover:text-primary transition-colors"
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
          {t('createRoom')}
        </Button>
      </div>

      {/* Loading state */}
      {isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="rpg-card px-4 py-3.5 flex items-center justify-between gap-4">
              <div className="flex items-center gap-3 flex-1">
                <Skeleton className="h-4 w-4 rounded flex-shrink-0" />
                <div className="space-y-1.5 flex-1">
                  <Skeleton className="h-4 w-32 rounded" />
                  <Skeleton className="h-3 w-48 rounded" />
                </div>
              </div>
              <Skeleton className="h-6 w-16 rounded-full flex-shrink-0" />
            </div>
          ))}
        </div>
      ) : (rooms ?? []).length === 0 ? (
        <div className="rpg-card p-12 text-center flex flex-col items-center gap-4">
          <div className="w-12 h-12 rounded-full bg-muted/40 flex items-center justify-center">
            <DoorOpen className="h-6 w-6 text-muted-foreground" aria-hidden="true" />
          </div>
          <div>
            <p className="font-cinzel text-sm font-semibold text-muted-foreground">{t('noRooms')}</p>
            <button
              type="button"
              onClick={() => setShowCreate(true)}
              className="mt-2 text-xs text-primary hover:text-primary/80 transition-colors underline-offset-4 hover:underline"
            >
              {t('createRoom')} &rarr;
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {(rooms ?? []).map((room) => (
            <RoomRow key={room.id} room={room} />
          ))}
        </div>
      )}

      {/* Create Room Dialog */}
      <Dialog open={showCreate} onOpenChange={(open) => { setShowCreate(open); if (!open) setCreateError(null) }}>
        <DialogContent className="bg-card border-border max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <div className="flex items-center gap-3 mb-1">
              <div className="flex items-center justify-center w-10 h-10 rounded-full bg-primary/10 border border-primary/20">
                <DoorOpen className="h-5 w-5 text-primary" aria-hidden="true" />
              </div>
              <DialogTitle className="font-cinzel text-gradient-gold">{t('createRoom')}</DialogTitle>
            </div>
          </DialogHeader>
          <form onSubmit={handleCreateRoom} noValidate className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="new-room-name" className="text-sm text-muted-foreground font-medium">
                {t('roomName')}
              </Label>
              <Input
                id="new-room-name"
                ref={newNameRef}
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                required
                aria-invalid={!!createError}
                aria-describedby={createError ? 'new-room-name-error' : undefined}
                className="bg-background-secondary border-border focus:border-primary/50"
              />
              {createError && (
                <p id="new-room-name-error" role="alert" className="text-xs text-destructive">
                  {createError}
                </p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="new-room-desc" className="text-sm text-muted-foreground font-medium">
                {t('roomDescription')}
              </Label>
              <Input
                id="new-room-desc"
                value={newDesc}
                onChange={(e) => setNewDesc(e.target.value)}
                className="bg-background-secondary border-border focus:border-primary/50"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="new-room-count" className="text-sm text-muted-foreground font-medium">
                {t('tableCount')}
              </Label>
              <Input
                id="new-room-count"
                type="number"
                min="0"
                step="1"
                inputMode="numeric"
                value={newTableCount}
                onChange={(e) => setNewTableCount(e.target.value)}
                className="bg-background-secondary border-border focus:border-primary/50"
              />
            </div>
            {(allEquipment ?? []).length > 0 && (
              <div className="space-y-2">
                <Label className="text-sm text-muted-foreground font-medium">
                  {t('equipment.defaultEquipment')}
                </Label>
                <div className="rounded-md border border-border/50 bg-background-secondary/40 p-3 space-y-2 max-h-40 overflow-y-auto">
                  {(allEquipment ?? []).map((equip) => (
                    <label key={equip.id} className="flex items-center gap-2 cursor-pointer group">
                      <input
                        type="checkbox"
                        checked={newEquipmentIds.includes(equip.id)}
                        onChange={() => toggleNewEquipment(equip.id)}
                        className="w-4 h-4 rounded border-border accent-primary"
                      />
                      <span className="text-sm text-foreground group-hover:text-primary transition-colors">
                        {equip.name}
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => { setShowCreate(false); setCreateError(null) }} className="border-border">
                {tc('cancel')}
              </Button>
              <Button type="submit" disabled={createRoom.isPending || setRoomDefaultEquipment.isPending} className="min-w-[80px]">
                {(createRoom.isPending || setRoomDefaultEquipment.isPending) ? (
                  <span className="inline-flex items-center gap-2"><DiceLoader size="sm" hideRole /><span>{t('creating')}</span></span>
                ) : tc('save')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </section>
  )
}
