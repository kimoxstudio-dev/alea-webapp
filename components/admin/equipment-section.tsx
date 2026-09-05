'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Pencil, Plus, Trash2, Package } from 'lucide-react'
import { DiceLoader } from '@/components/ui/dice-loader'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'
import {
  useAdminEquipment,
  useAdminCreateEquipment,
  useAdminUpdateEquipment,
  useAdminDeleteEquipment,
} from '@/lib/hooks/use-admin'
import type { Equipment } from '@/lib/types'

function EquipmentRow({ item }: { item: Equipment }) {
  const t = useTranslations('admin')
  const tc = useTranslations('common')

  const [editing, setEditing] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [editName, setEditName] = useState(item.name)
  const [editDesc, setEditDesc] = useState(item.description ?? '')
  const [editError, setEditError] = useState<string | null>(null)

  const updateEquipment = useAdminUpdateEquipment()
  const deleteEquipment = useAdminDeleteEquipment()

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    if (!editName.trim()) {
      setEditError(tc('requiredField'))
      return
    }
    setEditError(null)
    await updateEquipment.mutateAsync({
      id: item.id,
      data: { name: editName.trim() || item.name, description: editDesc.trim() || null },
    })
    setEditing(false)
  }

  async function handleDelete() {
    await deleteEquipment.mutateAsync(item.id)
    setDeleting(false)
  }

  return (
    <div className="rpg-card overflow-hidden">
      <div className="flex items-center justify-between gap-2 px-4 py-3.5">
        <div className="min-w-0 flex-1">
          <span className="font-medium text-foreground block truncate">{item.name}</span>
          {item.description && (
            <span className="text-xs text-muted-foreground block truncate mt-0.5">{item.description}</span>
          )}
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          <Button
            variant="ghost"
            size="icon"
            aria-label={t('equipment.editEquipment')}
            onClick={() => {
              setEditName(item.name)
              setEditDesc(item.description ?? '')
              setEditError(null)
              setEditing(true)
            }}
            className="h-8 w-8 text-muted-foreground hover:text-primary hover:bg-primary/10 transition-colors"
          >
            <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label={t('equipment.deleteEquipment')}
            onClick={() => setDeleting(true)}
            className="h-8 w-8 text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
          </Button>
        </div>
      </div>

      {/* Edit dialog */}
      <Dialog open={editing} onOpenChange={(open) => { setEditing(open); if (!open) setEditError(null) }}>
        <DialogContent className="bg-card border-border">
          <DialogHeader>
            <DialogTitle className="font-cinzel text-gradient-gold">{t('equipment.editEquipment')}</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleSave} noValidate className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor={`equip-name-edit-${item.id}`} className="text-sm text-muted-foreground font-medium">
                {t('equipment.equipmentName')}
              </Label>
              <Input
                id={`equip-name-edit-${item.id}`}
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                required
                aria-invalid={!!editError}
                aria-describedby={editError ? `equip-name-edit-error-${item.id}` : undefined}
                className="bg-background-secondary border-border focus:border-primary/50"
              />
              {editError && (
                <p id={`equip-name-edit-error-${item.id}`} role="alert" className="text-xs text-destructive">
                  {editError}
                </p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor={`equip-desc-edit-${item.id}`} className="text-sm text-muted-foreground font-medium">
                {t('equipment.equipmentDescription')}
              </Label>
              <Input
                id={`equip-desc-edit-${item.id}`}
                value={editDesc}
                onChange={(e) => setEditDesc(e.target.value)}
                className="bg-background-secondary border-border focus:border-primary/50"
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setEditing(false)} className="border-border">
                {tc('cancel')}
              </Button>
              <Button type="submit" disabled={updateEquipment.isPending} className="min-w-[80px]">
                {updateEquipment.isPending ? (
                  <span className="inline-flex items-center gap-2"><DiceLoader size="sm" hideRole /><span>{t('saving')}</span></span>
                ) : tc('save')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation dialog */}
      <Dialog open={deleting} onOpenChange={setDeleting}>
        <DialogContent className="bg-card border-border">
          <DialogHeader>
            <DialogTitle className="font-cinzel text-gradient-gold">{t('equipment.deleteEquipment')}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground py-2">
            {t('equipment.deleteEquipmentConfirm', { name: item.name })}
          </p>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setDeleting(false)} className="border-border">
              {tc('cancel')}
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={handleDelete}
              disabled={deleteEquipment.isPending}
              className="min-w-[80px]"
            >
              {deleteEquipment.isPending ? (
                <span className="inline-flex items-center gap-2"><DiceLoader size="sm" hideRole /><span>{tc('loading')}</span></span>
              ) : tc('delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

export function EquipmentSection() {
  const t = useTranslations('admin')
  const tc = useTranslations('common')

  const { data: equipment, isLoading } = useAdminEquipment()
  const createEquipment = useAdminCreateEquipment()

  const [showCreate, setShowCreate] = useState(false)
  const [newName, setNewName] = useState('')
  const [newDesc, setNewDesc] = useState('')
  const [createError, setCreateError] = useState<string | null>(null)

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    if (!newName.trim()) {
      setCreateError(tc('requiredField'))
      return
    }
    setCreateError(null)
    await createEquipment.mutateAsync({ name: newName.trim(), description: newDesc.trim() || undefined })
    setNewName('')
    setNewDesc('')
    setShowCreate(false)
  }

  return (
    <section aria-labelledby="equipment-heading" className="space-y-5">
      {/* Section header */}
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-8 h-8 rounded-md bg-primary/10 border border-primary/20">
            <Package className="h-4 w-4 text-primary" aria-hidden="true" />
          </div>
          <h2 id="equipment-heading" className="font-cinzel text-xl font-semibold text-foreground">
            {t('equipment.equipmentManagement')}
          </h2>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setShowCreate(true)}
          className="gap-1.5 border-primary/30 text-primary/80 hover:bg-primary/10 hover:border-primary/50 hover:text-primary transition-colors"
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
          {t('equipment.createEquipment')}
        </Button>
      </div>

      {/* Loading state */}
      {isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="rpg-card px-4 py-3.5 flex items-center justify-between gap-4">
              <div className="space-y-1.5 flex-1">
                <Skeleton className="h-4 w-32 rounded" />
                <Skeleton className="h-3 w-48 rounded" />
              </div>
              <div className="flex gap-1">
                <Skeleton className="h-8 w-8 rounded" />
                <Skeleton className="h-8 w-8 rounded" />
              </div>
            </div>
          ))}
        </div>
      ) : (equipment ?? []).length === 0 ? (
        <div className="rpg-card p-12 text-center flex flex-col items-center gap-4">
          <div className="w-12 h-12 rounded-full bg-muted/40 flex items-center justify-center">
            <Package className="h-6 w-6 text-muted-foreground" aria-hidden="true" />
          </div>
          <div>
            <p className="font-cinzel text-sm font-semibold text-muted-foreground">{t('equipment.noEquipment')}</p>
            <button
              type="button"
              onClick={() => setShowCreate(true)}
              className="mt-2 text-xs text-primary hover:text-primary/80 transition-colors underline-offset-4 hover:underline"
            >
              {t('equipment.createEquipment')} &rarr;
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {(equipment ?? []).map((item) => (
            <EquipmentRow key={item.id} item={item} />
          ))}
        </div>
      )}

      {/* Create Equipment Dialog */}
      <Dialog open={showCreate} onOpenChange={(open) => { setShowCreate(open); if (!open) setCreateError(null) }}>
        <DialogContent className="bg-card border-border">
          <DialogHeader>
            <div className="flex items-center gap-3 mb-1">
              <div className="flex items-center justify-center w-10 h-10 rounded-full bg-primary/10 border border-primary/20">
                <Package className="h-5 w-5 text-primary" aria-hidden="true" />
              </div>
              <DialogTitle className="font-cinzel text-gradient-gold">{t('equipment.createEquipment')}</DialogTitle>
            </div>
          </DialogHeader>
          <form onSubmit={handleCreate} noValidate className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="new-equipment-name" className="text-sm text-muted-foreground font-medium">
                {t('equipment.equipmentName')}
              </Label>
              <Input
                id="new-equipment-name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                required
                aria-invalid={!!createError}
                aria-describedby={createError ? 'new-equipment-name-error' : undefined}
                className="bg-background-secondary border-border focus:border-primary/50"
              />
              {createError && (
                <p id="new-equipment-name-error" role="alert" className="text-xs text-destructive">
                  {createError}
                </p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="new-equipment-desc" className="text-sm text-muted-foreground font-medium">
                {t('equipment.equipmentDescription')}
              </Label>
              <Input
                id="new-equipment-desc"
                value={newDesc}
                onChange={(e) => setNewDesc(e.target.value)}
                className="bg-background-secondary border-border focus:border-primary/50"
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => { setShowCreate(false); setCreateError(null) }} className="border-border">
                {tc('cancel')}
              </Button>
              <Button type="submit" disabled={createEquipment.isPending} className="min-w-[80px]">
                {createEquipment.isPending ? (
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
