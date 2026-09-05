'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Dices, Plus, Pencil, Trash2 } from 'lucide-react'
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
  useAdminLibraryGames,
  useAdminCreateLibraryGame,
  useAdminUpdateLibraryGame,
  useAdminDeleteLibraryGame,
  type LibraryGamePayload,
} from '@/lib/hooks/use-admin'
import { useRequiredFieldFocus } from '@/lib/hooks/use-required-field-focus'
import type { AdminLibraryGame } from '@/lib/types'
import { OptionalEnglishFields } from './optional-english-fields'
import { ImageUpload } from './image-upload'

interface LibraryGameFormState {
  title: string
  categoryEs: string
  categoryEn: string
  players: string
  playTime: string
  weight: string
  sortOrder: string
  active: boolean
  imageUrl: string
}

function emptyForm(): LibraryGameFormState {
  return { title: '', categoryEs: '', categoryEn: '', players: '', playTime: '', weight: '0', sortOrder: '0', active: true, imageUrl: '' }
}

function formFromGame(game: AdminLibraryGame): LibraryGameFormState {
  return {
    title: game.title,
    categoryEs: game.categoryEs,
    categoryEn: game.categoryEn,
    players: game.players,
    playTime: game.playTime,
    weight: String(game.weight),
    sortOrder: String(game.sortOrder),
    active: game.active,
    imageUrl: game.imgUrl ?? '',
  }
}

function formToPayload(form: LibraryGameFormState): LibraryGamePayload {
  return {
    title: form.title.trim(),
    categoryEs: form.categoryEs.trim(),
    categoryEn: form.categoryEn.trim(),
    players: form.players.trim(),
    playTime: form.playTime.trim(),
    weight: Number.isFinite(Number(form.weight)) ? Number(form.weight) : 0,
    sortOrder: Number.isFinite(Number(form.sortOrder)) ? Number(form.sortOrder) : 0,
    active: form.active,
    imageUrl: form.imageUrl.trim() || null,
  }
}

type LibraryGameRequiredField = 'title' | 'categoryEs' | 'players' | 'playTime'

/** Fields the form marks `required` — checked client-side on submit (#313: a
 * blank one used to fall through to the browser's native, English-only
 * validation bubble instead of this app's Spanish-capable error display).
 * Returns the first blank required field so the error can be anchored to it,
 * or `null` when the form is valid. */
function getBlankRequiredField(form: LibraryGameFormState): LibraryGameRequiredField | null {
  if (!form.title.trim()) return 'title'
  if (!form.categoryEs.trim()) return 'categoryEs'
  if (!form.players.trim()) return 'players'
  if (!form.playTime.trim()) return 'playTime'
  return null
}

function LibraryGameFormFields({ form, onChange, idPrefix, errorField, getFieldRef }: {
  form: LibraryGameFormState
  onChange: (form: LibraryGameFormState) => void
  idPrefix: string
  errorField: LibraryGameRequiredField | null
  getFieldRef: ReturnType<typeof useRequiredFieldFocus<LibraryGameRequiredField>>['getRef']
}) {
  const t = useTranslations('admin')
  const tc = useTranslations('common')

  const titleErrorId = `${idPrefix}-title-error`
  const categoryEsErrorId = `${idPrefix}-category-es-error`
  const playersErrorId = `${idPrefix}-players-error`
  const playTimeErrorId = `${idPrefix}-play-time-error`

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-title`} className="text-sm text-muted-foreground font-medium">
          {t('libraryGames.titleField')}
        </Label>
        <Input
          id={`${idPrefix}-title`}
          ref={getFieldRef('title')}
          value={form.title}
          onChange={(e) => onChange({ ...form, title: e.target.value })}
          required
          aria-invalid={errorField === 'title'}
          aria-describedby={errorField === 'title' ? titleErrorId : undefined}
          className="bg-background-secondary border-border focus:border-primary/50"
        />
        {errorField === 'title' && (
          <p id={titleErrorId} role="alert" className="text-xs text-destructive">{tc('requiredField')}</p>
        )}
      </div>
      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-category-es`} className="text-sm text-muted-foreground font-medium">
          {t('libraryGames.categoryEs')}
        </Label>
        <Input
          id={`${idPrefix}-category-es`}
          ref={getFieldRef('categoryEs')}
          value={form.categoryEs}
          onChange={(e) => onChange({ ...form, categoryEs: e.target.value })}
          required
          aria-invalid={errorField === 'categoryEs'}
          aria-describedby={errorField === 'categoryEs' ? categoryEsErrorId : undefined}
          className="bg-background-secondary border-border focus:border-primary/50"
        />
        {errorField === 'categoryEs' && (
          <p id={categoryEsErrorId} role="alert" className="text-xs text-destructive">{tc('requiredField')}</p>
        )}
      </div>

      {/* English copy is optional (OIR-206) — collapsed by default; the
          service falls back to the Spanish text above when left blank. */}
      <OptionalEnglishFields idPrefix={idPrefix}>
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-category-en`} className="text-sm text-muted-foreground font-medium">
            {t('libraryGames.categoryEn')}
          </Label>
          <Input
            id={`${idPrefix}-category-en`}
            value={form.categoryEn}
            onChange={(e) => onChange({ ...form, categoryEn: e.target.value })}
            placeholder={t('englishOptional.hint')}
            className="bg-background-secondary border-border focus:border-primary/50"
          />
        </div>
      </OptionalEnglishFields>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-players`} className="text-sm text-muted-foreground font-medium">
            {t('libraryGames.players')}
          </Label>
          <Input
            id={`${idPrefix}-players`}
            ref={getFieldRef('players')}
            value={form.players}
            onChange={(e) => onChange({ ...form, players: e.target.value })}
            required
            aria-invalid={errorField === 'players'}
            aria-describedby={errorField === 'players' ? playersErrorId : undefined}
            className="bg-background-secondary border-border focus:border-primary/50"
          />
          {errorField === 'players' && (
            <p id={playersErrorId} role="alert" className="text-xs text-destructive">{tc('requiredField')}</p>
          )}
        </div>
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-play-time`} className="text-sm text-muted-foreground font-medium">
            {t('libraryGames.playTime')}
          </Label>
          <Input
            id={`${idPrefix}-play-time`}
            ref={getFieldRef('playTime')}
            value={form.playTime}
            onChange={(e) => onChange({ ...form, playTime: e.target.value })}
            required
            aria-invalid={errorField === 'playTime'}
            aria-describedby={errorField === 'playTime' ? playTimeErrorId : undefined}
            className="bg-background-secondary border-border focus:border-primary/50"
          />
          {errorField === 'playTime' && (
            <p id={playTimeErrorId} role="alert" className="text-xs text-destructive">{tc('requiredField')}</p>
          )}
        </div>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-weight`} className="text-sm text-muted-foreground font-medium">
            {t('libraryGames.weight')}
          </Label>
          <Input
            id={`${idPrefix}-weight`}
            type="number"
            min="0"
            max="5"
            step="0.1"
            value={form.weight}
            onChange={(e) => onChange({ ...form, weight: e.target.value })}
            className="bg-background-secondary border-border focus:border-primary/50"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-sort-order`} className="text-sm text-muted-foreground font-medium">
            {t('libraryGames.sortOrder')}
          </Label>
          <Input
            id={`${idPrefix}-sort-order`}
            type="number"
            value={form.sortOrder}
            onChange={(e) => onChange({ ...form, sortOrder: e.target.value })}
            className="bg-background-secondary border-border focus:border-primary/50"
          />
        </div>
      </div>
      <div className="space-y-2">
        <ImageUpload
          idPrefix={idPrefix}
          folder="library-games"
          value={form.imageUrl}
          onChange={(url) => onChange({ ...form, imageUrl: url })}
        />
        <Label htmlFor={`${idPrefix}-image-url`} className="text-sm text-muted-foreground font-medium">
          {t('libraryGames.imageUrl')}
        </Label>
        <Input
          id={`${idPrefix}-image-url`}
          type="url"
          value={form.imageUrl}
          onChange={(e) => onChange({ ...form, imageUrl: e.target.value })}
          placeholder="https://…"
          className="bg-background-secondary border-border focus:border-primary/50"
        />
      </div>
      <div className="flex items-center gap-2">
        <Checkbox
          id={`${idPrefix}-active`}
          checked={form.active}
          onCheckedChange={(checked) => onChange({ ...form, active: checked === true })}
        />
        <Label htmlFor={`${idPrefix}-active`} className="text-sm text-foreground font-medium">
          {t('libraryGames.active')}
        </Label>
      </div>
    </div>
  )
}

function LibraryGameRow({ game }: { game: AdminLibraryGame }) {
  const t = useTranslations('admin')
  const tc = useTranslations('common')

  const [editing, setEditing] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [form, setForm] = useState<LibraryGameFormState>(() => formFromGame(game))
  const [saveError, setSaveError] = useState<string | null>(null)
  const [errorField, setErrorField] = useState<LibraryGameRequiredField | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [toggleError, setToggleError] = useState<string | null>(null)
  const { getRef: getFieldRef, focus: focusField } = useRequiredFieldFocus<LibraryGameRequiredField>()

  const updateGame = useAdminUpdateLibraryGame()
  const deleteGame = useAdminDeleteLibraryGame()

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    const blankField = getBlankRequiredField(form)
    if (blankField) {
      setErrorField(blankField)
      focusField(blankField)
      return
    }
    setErrorField(null)
    setSaveError(null)
    try {
      await updateGame.mutateAsync({ id: game.id, data: formToPayload(form) })
      setEditing(false)
    } catch {
      setSaveError(t('libraryGames.saveError'))
    }
  }

  async function handleDelete() {
    setDeleteError(null)
    try {
      await deleteGame.mutateAsync(game.id)
      setDeleting(false)
    } catch {
      setDeleteError(t('libraryGames.deleteError'))
    }
  }

  async function handleToggleActive(checked: boolean) {
    setToggleError(null)
    try {
      await updateGame.mutateAsync({ id: game.id, data: { active: checked } })
    } catch {
      setToggleError(t('libraryGames.saveError'))
    }
  }

  return (
    <div className="rpg-card overflow-hidden">
      <div className="flex items-center justify-between gap-2 px-4 py-3.5">
        <div className="min-w-0 flex-1 flex items-center gap-3">
          <Checkbox
            checked={game.active}
            onCheckedChange={(checked) => handleToggleActive(checked === true)}
            aria-label={t('libraryGames.active')}
          />
          <div className="min-w-0 flex-1">
            <span className="font-medium text-foreground block truncate">{game.title}</span>
            <span className="text-xs text-muted-foreground block truncate mt-0.5">
              {game.categoryEs} / {game.categoryEn}
            </span>
            {toggleError && (
              <span role="alert" className="text-xs text-destructive block truncate mt-0.5">
                {toggleError}
              </span>
            )}
          </div>
          <Badge variant={game.active ? 'available' : 'outline'} className="flex-shrink-0">
            {game.active ? t('libraryGames.active') : t('libraryGames.inactive')}
          </Badge>
          <span className="text-xs text-muted-foreground flex-shrink-0">#{game.sortOrder}</span>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          <Button
            variant="ghost"
            size="icon"
            aria-label={t('libraryGames.editLibraryGame')}
            onClick={() => {
              setForm(formFromGame(game))
              setSaveError(null)
              setErrorField(null)
              setEditing(true)
            }}
            className="h-8 w-8 text-muted-foreground hover:text-primary hover:bg-primary/10 transition-colors"
          >
            <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label={t('libraryGames.deleteLibraryGame')}
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
            setErrorField(null)
          }
        }}
      >
        <DialogContent className="bg-card border-border max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="font-cinzel text-gradient-gold">{t('libraryGames.editLibraryGame')}</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleSave} noValidate className="space-y-4 py-2">
            <LibraryGameFormFields
              form={form}
              onChange={setForm}
              idPrefix={`library-game-edit-${game.id}`}
              errorField={errorField}
              getFieldRef={getFieldRef}
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
              <Button type="submit" disabled={updateGame.isPending} className="min-w-[80px]">
                {updateGame.isPending ? (
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
            <DialogTitle className="font-cinzel text-gradient-gold">{t('libraryGames.deleteLibraryGame')}</DialogTitle>
          </DialogHeader>
          <div className="py-2 space-y-3">
            <p className="text-sm text-muted-foreground">
              {t('libraryGames.deleteLibraryGameConfirm', { title: game.title })}
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
              disabled={deleteGame.isPending}
              className="min-w-[80px]"
            >
              {deleteGame.isPending ? (
                <span className="inline-flex items-center gap-2"><DiceLoader size="sm" hideRole /><span>{tc('loading')}</span></span>
              ) : tc('delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

export function LibraryGamesSection() {
  const t = useTranslations('admin')
  const tc = useTranslations('common')

  const { data: games, isLoading } = useAdminLibraryGames()
  const createGame = useAdminCreateLibraryGame()

  const [showCreate, setShowCreate] = useState(false)
  const [form, setForm] = useState<LibraryGameFormState>(emptyForm())
  const [createError, setCreateError] = useState<string | null>(null)
  const [errorField, setErrorField] = useState<LibraryGameRequiredField | null>(null)
  const { getRef: getFieldRef, focus: focusField } = useRequiredFieldFocus<LibraryGameRequiredField>()

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    const blankField = getBlankRequiredField(form)
    if (blankField) {
      setErrorField(blankField)
      focusField(blankField)
      return
    }
    setErrorField(null)
    setCreateError(null)
    try {
      await createGame.mutateAsync(formToPayload(form))
      setForm(emptyForm())
      setShowCreate(false)
    } catch {
      setCreateError(t('libraryGames.saveError'))
    }
  }

  const sorted = [...(games ?? [])].sort((a, b) => a.sortOrder - b.sortOrder)

  return (
    <section aria-labelledby="library-games-heading" className="space-y-5">
      {/* Section header */}
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-8 h-8 rounded-md bg-primary/10 border border-primary/20">
            <Dices className="h-4 w-4 text-primary" aria-hidden="true" />
          </div>
          <div>
            <h2 id="library-games-heading" className="font-cinzel text-xl font-semibold text-foreground">
              {t('libraryGames.title')}
            </h2>
            <p className="text-xs text-muted-foreground font-inter">{t('libraryGames.sectionDescription')}</p>
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setForm(emptyForm())
            setCreateError(null)
            setErrorField(null)
            setShowCreate(true)
          }}
          className="gap-1.5 border-primary/30 text-primary/80 hover:bg-primary/10 hover:border-primary/50 hover:text-primary transition-colors"
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
          {t('libraryGames.createLibraryGame')}
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
            <Dices className="h-6 w-6 text-muted-foreground" aria-hidden="true" />
          </div>
          <div>
            <p className="font-cinzel text-sm font-semibold text-muted-foreground">{t('libraryGames.noLibraryGames')}</p>
            <button
              type="button"
              onClick={() => {
                setForm(emptyForm())
                setCreateError(null)
                setShowCreate(true)
              }}
              className="mt-2 text-xs text-primary hover:text-primary/80 transition-colors underline-offset-4 hover:underline"
            >
              {t('libraryGames.createLibraryGame')} &rarr;
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {sorted.map((game) => (
            <LibraryGameRow key={game.id} game={game} />
          ))}
        </div>
      )}

      {/* Create Library Game Dialog */}
      <Dialog
        open={showCreate}
        onOpenChange={(open) => {
          setShowCreate(open)
          if (!open) {
            setCreateError(null)
            setErrorField(null)
          }
        }}
      >
        <DialogContent className="bg-card border-border max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <div className="flex items-center gap-3 mb-1">
              <div className="flex items-center justify-center w-10 h-10 rounded-full bg-primary/10 border border-primary/20">
                <Dices className="h-5 w-5 text-primary" aria-hidden="true" />
              </div>
              <DialogTitle className="font-cinzel text-gradient-gold">{t('libraryGames.createLibraryGame')}</DialogTitle>
            </div>
          </DialogHeader>
          <form onSubmit={handleCreate} noValidate className="space-y-4 py-2">
            <LibraryGameFormFields
              form={form}
              onChange={setForm}
              idPrefix="library-game-new"
              errorField={errorField}
              getFieldRef={getFieldRef}
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
              <Button type="submit" disabled={createGame.isPending} className="min-w-[80px]">
                {createGame.isPending ? (
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
