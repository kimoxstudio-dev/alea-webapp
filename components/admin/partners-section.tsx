'use client'

import { useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Handshake, Plus, Pencil, Trash2 } from 'lucide-react'
import { DiceLoader } from '@/components/ui/dice-loader'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import { Skeleton } from '@/components/ui/skeleton'
import { Badge } from '@/components/ui/badge'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'
import {
  useAdminPartners,
  useAdminCreatePartner,
  useAdminUpdatePartner,
  useAdminDeletePartner,
  type PartnerPayload,
} from '@/lib/hooks/use-admin'
import type { AdminPartner } from '@/lib/types'
import { OptionalEnglishFields } from './optional-english-fields'
import { ImageUpload } from './image-upload'
import { isValidOptionalUrl } from '@/lib/validations/url'

interface PartnerFormState {
  name: string
  imageUrl: string
  linkUrl: string
  descriptionEs: string
  descriptionEn: string
  sortOrder: string
  active: boolean
}

type PartnerRequiredField = 'name' | 'imageUrl' | 'linkUrl'

interface PartnerFieldError {
  field: PartnerRequiredField
  kind: 'required' | 'invalidUrl'
}

/** Refs to the input for each required field, keyed the same way
 * `getPartnerFieldError` reports them, so a failed submit can move focus to
 * the offending field (#313 round 3: these dialogs are long and scrollable —
 * an inline error can mount off-screen with no visible or focus change). */
type PartnerFieldRefs = Partial<Record<PartnerRequiredField, HTMLInputElement | null>>

/** Client-side validation mirroring the server's required/URL-shape checks
 * (#313: a blank/invalid field used to either fall through to the browser's
 * native, English-only validation bubble, or round-trip to the API for a
 * generic 400 with no field-level feedback). Returns the first field to
 * report, or `null` when the form is valid. */
function getPartnerFieldError(form: PartnerFormState): PartnerFieldError | null {
  if (!form.name.trim()) return { field: 'name', kind: 'required' }
  if (!form.imageUrl.trim()) return { field: 'imageUrl', kind: 'required' }
  if (!isValidOptionalUrl(form.imageUrl)) return { field: 'imageUrl', kind: 'invalidUrl' }
  if (!isValidOptionalUrl(form.linkUrl)) return { field: 'linkUrl', kind: 'invalidUrl' }
  return null
}

function emptyForm(): PartnerFormState {
  return { name: '', imageUrl: '', linkUrl: '', descriptionEs: '', descriptionEn: '', sortOrder: '0', active: true }
}

function formFromPartner(partner: AdminPartner): PartnerFormState {
  return {
    name: partner.name,
    imageUrl: partner.imageUrl,
    linkUrl: partner.linkUrl ?? '',
    descriptionEs: partner.descriptionEs ?? '',
    descriptionEn: partner.descriptionEn ?? '',
    sortOrder: String(partner.sortOrder),
    active: partner.active,
  }
}

function formToPayload(form: PartnerFormState): PartnerPayload {
  return {
    name: form.name.trim(),
    imageUrl: form.imageUrl.trim(),
    linkUrl: form.linkUrl.trim() || null,
    descriptionEs: form.descriptionEs.trim() || null,
    descriptionEn: form.descriptionEn.trim() || null,
    sortOrder: Number.isFinite(Number(form.sortOrder)) ? Number(form.sortOrder) : 0,
    active: form.active,
  }
}

function PartnerFormFields({ form, onChange, idPrefix, fieldError, fieldRefs }: {
  form: PartnerFormState
  onChange: (form: PartnerFormState) => void
  idPrefix: string
  fieldError: PartnerFieldError | null
  fieldRefs: React.MutableRefObject<PartnerFieldRefs>
}) {
  const t = useTranslations('admin')
  const tc = useTranslations('common')

  const fieldErrorMessage = fieldError?.kind === 'invalidUrl' ? tc('invalidUrl') : tc('requiredField')
  const nameErrorId = `${idPrefix}-name-error`
  const imageUrlErrorId = `${idPrefix}-image-url-error`
  const linkUrlErrorId = `${idPrefix}-link-url-error`

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-name`} className="text-sm text-muted-foreground font-medium">
          {t('partners.name')}
        </Label>
        <Input
          id={`${idPrefix}-name`}
          ref={(el) => { fieldRefs.current.name = el }}
          value={form.name}
          onChange={(e) => onChange({ ...form, name: e.target.value })}
          required
          aria-invalid={fieldError?.field === 'name'}
          aria-describedby={fieldError?.field === 'name' ? nameErrorId : undefined}
          className="bg-background-secondary border-border focus:border-primary/50"
        />
        {fieldError?.field === 'name' && (
          <p id={nameErrorId} role="alert" className="text-xs text-destructive">{fieldErrorMessage}</p>
        )}
      </div>
      <div className="space-y-2">
        <ImageUpload
          idPrefix={idPrefix}
          folder="partners"
          value={form.imageUrl}
          onChange={(url) => onChange({ ...form, imageUrl: url })}
        />
        <Label htmlFor={`${idPrefix}-image-url`} className="text-sm text-muted-foreground font-medium">
          {t('partners.imageUrl')}
        </Label>
        <Input
          id={`${idPrefix}-image-url`}
          ref={(el) => { fieldRefs.current.imageUrl = el }}
          type="url"
          value={form.imageUrl}
          onChange={(e) => onChange({ ...form, imageUrl: e.target.value })}
          required
          aria-invalid={fieldError?.field === 'imageUrl'}
          aria-describedby={fieldError?.field === 'imageUrl' ? imageUrlErrorId : undefined}
          className="bg-background-secondary border-border focus:border-primary/50"
        />
        {fieldError?.field === 'imageUrl' && (
          <p id={imageUrlErrorId} role="alert" className="text-xs text-destructive">{fieldErrorMessage}</p>
        )}
      </div>
      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-link-url`} className="text-sm text-muted-foreground font-medium">
          {t('partners.linkUrl')}
        </Label>
        <Input
          id={`${idPrefix}-link-url`}
          ref={(el) => { fieldRefs.current.linkUrl = el }}
          type="url"
          value={form.linkUrl}
          onChange={(e) => onChange({ ...form, linkUrl: e.target.value })}
          aria-invalid={fieldError?.field === 'linkUrl'}
          aria-describedby={fieldError?.field === 'linkUrl' ? linkUrlErrorId : undefined}
          className="bg-background-secondary border-border focus:border-primary/50"
        />
        {fieldError?.field === 'linkUrl' && (
          <p id={linkUrlErrorId} role="alert" className="text-xs text-destructive">{fieldErrorMessage}</p>
        )}
      </div>
      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-desc-es`} className="text-sm text-muted-foreground font-medium">
          {t('partners.descriptionEs')}
        </Label>
        <Input
          id={`${idPrefix}-desc-es`}
          value={form.descriptionEs}
          onChange={(e) => onChange({ ...form, descriptionEs: e.target.value })}
          className="bg-background-secondary border-border focus:border-primary/50"
        />
      </div>

      {/* English copy is optional (OIR-206) — collapsed by default; the
          service falls back to the Spanish text above when left blank. */}
      <OptionalEnglishFields idPrefix={idPrefix}>
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-desc-en`} className="text-sm text-muted-foreground font-medium">
            {t('partners.descriptionEn')}
          </Label>
          <Input
            id={`${idPrefix}-desc-en`}
            value={form.descriptionEn}
            onChange={(e) => onChange({ ...form, descriptionEn: e.target.value })}
            placeholder={t('englishOptional.hint')}
            className="bg-background-secondary border-border focus:border-primary/50"
          />
        </div>
      </OptionalEnglishFields>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-sort-order`} className="text-sm text-muted-foreground font-medium">
            {t('partners.sortOrder')}
          </Label>
          <Input
            id={`${idPrefix}-sort-order`}
            type="number"
            value={form.sortOrder}
            onChange={(e) => onChange({ ...form, sortOrder: e.target.value })}
            className="bg-background-secondary border-border focus:border-primary/50"
          />
        </div>
        <div className="flex items-end gap-2 pb-2.5">
          <Checkbox
            id={`${idPrefix}-active`}
            checked={form.active}
            onCheckedChange={(checked) => onChange({ ...form, active: checked === true })}
          />
          <Label htmlFor={`${idPrefix}-active`} className="text-sm text-foreground font-medium">
            {t('partners.active')}
          </Label>
        </div>
      </div>
    </div>
  )
}

function PartnerRow({ partner }: { partner: AdminPartner }) {
  const t = useTranslations('admin')
  const tc = useTranslations('common')

  const [editing, setEditing] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [form, setForm] = useState<PartnerFormState>(() => formFromPartner(partner))
  const [saveError, setSaveError] = useState<string | null>(null)
  const [fieldError, setFieldError] = useState<PartnerFieldError | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [toggleError, setToggleError] = useState<string | null>(null)
  const fieldRefs = useRef<PartnerFieldRefs>({})

  const updatePartner = useAdminUpdatePartner()
  const deletePartner = useAdminDeletePartner()

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    const error = getPartnerFieldError(form)
    if (error) {
      setFieldError(error)
      fieldRefs.current[error.field]?.focus()
      return
    }
    setFieldError(null)
    setSaveError(null)
    try {
      await updatePartner.mutateAsync({ id: partner.id, data: formToPayload(form) })
      setEditing(false)
    } catch {
      setSaveError(t('partners.saveError'))
    }
  }

  async function handleDelete() {
    setDeleteError(null)
    try {
      await deletePartner.mutateAsync(partner.id)
      setDeleting(false)
    } catch {
      setDeleteError(t('partners.deleteError'))
    }
  }

  async function handleToggleActive(checked: boolean) {
    setToggleError(null)
    try {
      await updatePartner.mutateAsync({ id: partner.id, data: { active: checked } })
    } catch {
      setToggleError(t('partners.saveError'))
    }
  }

  return (
    <div className="rpg-card overflow-hidden">
      <div className="flex items-center justify-between gap-2 px-4 py-3.5">
        <div className="min-w-0 flex-1 flex items-center gap-3">
          <Checkbox
            checked={partner.active}
            onCheckedChange={(checked) => handleToggleActive(checked === true)}
            aria-label={t('partners.active')}
          />
          <div className="min-w-0 flex-1">
            <span className="font-medium text-foreground block truncate">{partner.name}</span>
            {(partner.descriptionEs || partner.descriptionEn) && (
              <span className="text-xs text-muted-foreground block truncate mt-0.5">
                {partner.descriptionEs || partner.descriptionEn}
              </span>
            )}
            {toggleError && (
              <span role="alert" className="text-xs text-destructive block truncate mt-0.5">
                {toggleError}
              </span>
            )}
          </div>
          <Badge variant={partner.active ? 'available' : 'outline'} className="flex-shrink-0">
            {partner.active ? t('partners.active') : t('partners.inactive')}
          </Badge>
          <span className="text-xs text-muted-foreground flex-shrink-0">#{partner.sortOrder}</span>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          <Button
            variant="ghost"
            size="icon"
            aria-label={t('partners.editPartner')}
            onClick={() => {
              setForm(formFromPartner(partner))
              setSaveError(null)
              setFieldError(null)
              setEditing(true)
            }}
            className="h-8 w-8 text-muted-foreground hover:text-primary hover:bg-primary/10 transition-colors"
          >
            <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label={t('partners.deletePartner')}
            onClick={() => {
              setDeleteError(null)
              setDeleting(true)
            }}
            className="h-8 w-8 text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
          </Button>
        </div>
      </div>

      {/* Edit dialog */}
      <Dialog
        open={editing}
        onOpenChange={(open) => {
          setEditing(open)
          if (!open) {
            setSaveError(null)
            setFieldError(null)
          }
        }}
      >
        <DialogContent className="bg-card border-border max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="font-cinzel text-gradient-gold">{t('partners.editPartner')}</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleSave} noValidate className="space-y-4 py-2">
            <PartnerFormFields
              form={form}
              onChange={setForm}
              idPrefix={`partner-edit-${partner.id}`}
              fieldError={fieldError}
              fieldRefs={fieldRefs}
            />
            {saveError && (
              <div role="alert" className="rounded-md bg-destructive/15 border border-destructive/30 px-3 py-2 text-sm text-destructive">
                {saveError}
              </div>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setEditing(false)} className="border-border">
                {tc('cancel')}
              </Button>
              <Button type="submit" disabled={updatePartner.isPending} className="min-w-[80px]">
                {updatePartner.isPending ? (
                  <span className="inline-flex items-center gap-2"><DiceLoader size="sm" hideRole /><span>{t('saving')}</span></span>
                ) : tc('save')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation dialog */}
      <Dialog
        open={deleting}
        onOpenChange={(open) => {
          setDeleting(open)
          if (!open) setDeleteError(null)
        }}
      >
        <DialogContent className="bg-card border-border">
          <DialogHeader>
            <DialogTitle className="font-cinzel text-gradient-gold">{t('partners.deletePartner')}</DialogTitle>
          </DialogHeader>
          <div className="py-2 space-y-3">
            <p className="text-sm text-muted-foreground">
              {t('partners.deletePartnerConfirm', { name: partner.name })}
            </p>
            {deleteError && (
              <div role="alert" className="rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3">
                <p className="text-sm text-destructive font-medium">{deleteError}</p>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setDeleting(false)} className="border-border">
              {tc('cancel')}
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={handleDelete}
              disabled={deletePartner.isPending}
              className="min-w-[80px]"
            >
              {deletePartner.isPending ? (
                <span className="inline-flex items-center gap-2"><DiceLoader size="sm" hideRole /><span>{tc('loading')}</span></span>
              ) : tc('delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

export function PartnersSection() {
  const t = useTranslations('admin')
  const tc = useTranslations('common')

  const { data: partners, isLoading } = useAdminPartners()
  const createPartner = useAdminCreatePartner()

  const [showCreate, setShowCreate] = useState(false)
  const [form, setForm] = useState<PartnerFormState>(emptyForm())
  const [createError, setCreateError] = useState<string | null>(null)
  const [fieldError, setFieldError] = useState<PartnerFieldError | null>(null)
  const fieldRefs = useRef<PartnerFieldRefs>({})

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    const error = getPartnerFieldError(form)
    if (error) {
      setFieldError(error)
      fieldRefs.current[error.field]?.focus()
      return
    }
    setFieldError(null)
    setCreateError(null)
    try {
      await createPartner.mutateAsync(formToPayload(form))
      setForm(emptyForm())
      setShowCreate(false)
    } catch {
      setCreateError(t('partners.saveError'))
    }
  }

  const sorted = [...(partners ?? [])].sort((a, b) => a.sortOrder - b.sortOrder)

  return (
    <section aria-labelledby="partners-heading" className="space-y-5">
      {/* Section header */}
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-8 h-8 rounded-md bg-primary/10 border border-primary/20">
            <Handshake className="h-4 w-4 text-primary" aria-hidden="true" />
          </div>
          <div>
            <h2 id="partners-heading" className="font-cinzel text-xl font-semibold text-foreground">
              {t('partners.title')}
            </h2>
            <p className="text-xs text-muted-foreground font-inter">{t('partners.sectionDescription')}</p>
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setForm(emptyForm())
            setCreateError(null)
            setFieldError(null)
            setShowCreate(true)
          }}
          className="gap-1.5 border-primary/30 text-primary/80 hover:bg-primary/10 hover:border-primary/50 hover:text-primary transition-colors"
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
          {t('partners.createPartner')}
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
      ) : sorted.length === 0 ? (
        <div className="rpg-card p-12 text-center flex flex-col items-center gap-4">
          <div className="w-12 h-12 rounded-full bg-muted/40 flex items-center justify-center">
            <Handshake className="h-6 w-6 text-muted-foreground" aria-hidden="true" />
          </div>
          <div>
            <p className="font-cinzel text-sm font-semibold text-muted-foreground">{t('partners.noPartners')}</p>
            <button
              type="button"
              onClick={() => {
                setForm(emptyForm())
                setCreateError(null)
                setShowCreate(true)
              }}
              className="mt-2 text-xs text-primary hover:text-primary/80 transition-colors underline-offset-4 hover:underline"
            >
              {t('partners.createPartner')} &rarr;
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {sorted.map((partner) => (
            <PartnerRow key={partner.id} partner={partner} />
          ))}
        </div>
      )}

      {/* Create Partner Dialog */}
      <Dialog
        open={showCreate}
        onOpenChange={(open) => {
          setShowCreate(open)
          if (!open) {
            setCreateError(null)
            setFieldError(null)
          }
        }}
      >
        <DialogContent className="bg-card border-border max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <div className="flex items-center gap-3 mb-1">
              <div className="flex items-center justify-center w-10 h-10 rounded-full bg-primary/10 border border-primary/20">
                <Handshake className="h-5 w-5 text-primary" aria-hidden="true" />
              </div>
              <DialogTitle className="font-cinzel text-gradient-gold">{t('partners.createPartner')}</DialogTitle>
            </div>
          </DialogHeader>
          <form onSubmit={handleCreate} noValidate className="space-y-4 py-2">
            <PartnerFormFields
              form={form}
              onChange={setForm}
              idPrefix="partner-new"
              fieldError={fieldError}
              fieldRefs={fieldRefs}
            />
            {createError && (
              <div role="alert" className="rounded-md bg-destructive/15 border border-destructive/30 px-3 py-2 text-sm text-destructive">
                {createError}
              </div>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setShowCreate(false)} className="border-border">
                {tc('cancel')}
              </Button>
              <Button type="submit" disabled={createPartner.isPending} className="min-w-[80px]">
                {createPartner.isPending ? (
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
