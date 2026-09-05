'use client'

import { useEffect, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { Search, Pencil, Trash2, AlertCircle, FileUp, Link2, KeyRound } from 'lucide-react'
import { DiceLoader } from '@/components/ui/dice-loader'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { useAdminUsers, useAdminUpdateUser, useAdminDeleteUser, useAdminPatchUser, useAdminGenerateActivationLink, useAdminGenerateRecoveryLink } from '@/lib/hooks/use-admin'
import { getAuthServiceErrorMessageKey, extractErrorCode } from '@/lib/auth/service-error-messages'
import { ImportMembersSection } from './import-members-section'
import type { User } from '@/lib/types'

type UserRole = 'member' | 'admin'

interface EditState {
  memberNumber: string
  fullName: string
  email: string
  phone: string
  role: UserRole
  isActive: boolean
}

function StatusBadge({ isActive }: { isActive: boolean }) {
  const t = useTranslations('admin')
  if (!isActive) {
    return (
      <Badge className="border-orange-500/40 bg-orange-900/20 text-orange-400">
        {t('inactive')}
      </Badge>
    )
  }
  return (
    <Badge className="border-emerald-500/40 bg-emerald-900/20 text-emerald-400">
      {t('active')}
    </Badge>
  )
}

export function UsersSection() {
  const t = useTranslations('admin')
  const tc = useTranslations('common')
  const tAuth = useTranslations('auth')
  const locale = useLocale()

  const [page, setPage] = useState(1)
  const [search, setSearch] = useState('')
  const [searchInput, setSearchInput] = useState('')
  const [activationFeedback, setActivationFeedback] = useState<{ userId: string; kind: 'success' | 'error'; message: string } | null>(null)

  const [editUser, setEditUser] = useState<User | null>(null)
  const [isImportModalOpen, setIsImportModalOpen] = useState(false)
  const [editState, setEditState] = useState<EditState>({
    memberNumber: '',
    fullName: '',
    email: '',
    phone: '',
    role: 'member',
    isActive: true,
  })
  const [deleteUser, setDeleteUser] = useState<User | null>(null)

  const { data, isLoading, isError } = useAdminUsers(page, 10, search)
  const updateMutation = useAdminUpdateUser()
  const deleteMutation = useAdminDeleteUser()
  const patchMutation = useAdminPatchUser()
  const activationLinkMutation = useAdminGenerateActivationLink()
  const recoveryLinkMutation = useAdminGenerateRecoveryLink()

  useEffect(() => {
    if (!activationFeedback) return

    const timeoutId = window.setTimeout(() => {
      setActivationFeedback(null)
    }, 5000)

    return () => window.clearTimeout(timeoutId)
  }, [activationFeedback])

  function openEdit(user: User) {
    setEditState({
      memberNumber: user.memberNumber,
      fullName: user.fullName ?? '',
      email: user.email ?? '',
      phone: user.phone ?? '',
      role: user.role,
      isActive: user.isActive,
    })
    setEditUser(user)
  }

  function handleSearch(e: React.FormEvent) {
    e.preventDefault()
    setSearch(searchInput.trim())
    setPage(1)
  }

  function handleSaveEdit() {
    if (!editUser) return

    const data: {
      memberNumber: string
      role: UserRole
      is_active: boolean
      fullName?: string
      email?: string
      phone?: string
    } = {
      memberNumber: editState.memberNumber,
      role: editState.role,
      is_active: editState.isActive,
    }

    if (editState.fullName.trim() !== (editUser.fullName ?? '').trim()) {
      data.fullName = editState.fullName
    }
    if (editState.email.trim() !== (editUser.email ?? '').trim()) {
      data.email = editState.email
    }
    if (editState.phone.trim() !== (editUser.phone ?? '').trim()) {
      data.phone = editState.phone
    }

    updateMutation.mutate({
      id: editUser.id,
      data,
    }, {
      onSuccess: () => setEditUser(null),
    })
  }

  function handleDeleteConfirm() {
    if (!deleteUser) return
    deleteMutation.mutate(deleteUser.id, {
      onSuccess: () => setDeleteUser(null),
    })
  }

  async function handleCopyActivationLink(user: User) {
    setActivationFeedback(null)

    try {
      const result = await activationLinkMutation.mutateAsync({
        id: user.id,
        locale,
      })

      try {
        await navigator.clipboard.writeText(result.activationLink)
        setActivationFeedback({
          userId: user.id,
          kind: 'success',
          message: t('activationLinkCopied'),
        })
      } catch {
        window.prompt(t('activationLinkPrompt'), result.activationLink)
        setActivationFeedback({
          userId: user.id,
          kind: 'success',
          message: t('activationLinkReady'),
        })
      }
    } catch (error) {
      // The server's `message` is always a machine-readable `ERROR_CODES.AUTH_*`
      // code, never end-user text — mapped to a translated message here so
      // no raw English string ever reaches this Spanish-capable page (#313).
      const code = extractErrorCode(error)
      const messageKey = getAuthServiceErrorMessageKey(code)
      setActivationFeedback({
        userId: user.id,
        kind: 'error',
        message: messageKey ? tAuth(messageKey as Parameters<typeof tAuth>[0]) : t('activationLinkFailed'),
      })
    }
  }

  async function handleCopyRecoveryLink(user: User) {
    setActivationFeedback(null)

    // Recovery links are a credential, not a casual "forgot password" link:
    // whoever opens one can set a new password for this profile's Clerk
    // identity (recoverAccount() has no email involved — the admin-issued,
    // single-use token is the sole proof of authorization, see
    // lib/server/auth-service.ts). Require an explicit confirmation before
    // generating one.
    const confirmed = window.confirm(t('recoveryLinkWarning', { memberNumber: user.memberNumber }))
    if (!confirmed) return

    try {
      const result = await recoveryLinkMutation.mutateAsync({
        id: user.id,
        locale,
      })

      try {
        await navigator.clipboard.writeText(result.recoveryLink)
        setActivationFeedback({
          userId: user.id,
          kind: 'success',
          message: t('recoveryLinkCopied'),
        })
      } catch {
        window.prompt(t('recoveryLinkPrompt'), result.recoveryLink)
        setActivationFeedback({
          userId: user.id,
          kind: 'success',
          message: t('recoveryLinkReady'),
        })
      }
    } catch (error) {
      // Same server-code → translated-message mapping as handleCopyActivationLink above.
      const code = extractErrorCode(error)
      const messageKey = getAuthServiceErrorMessageKey(code)
      setActivationFeedback({
        userId: user.id,
        kind: 'error',
        message: messageKey ? tAuth(messageKey as Parameters<typeof tAuth>[0]) : t('recoveryLinkFailed'),
      })
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 rounded-xl border border-border bg-background-secondary/40 p-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <h2 className="font-cinzel text-xl text-foreground">{t('userManagement')}</h2>
          <p className="max-w-2xl text-sm text-muted-foreground">{t('userManagementDescription')}</p>
        </div>
        <Button
          type="button"
          onClick={() => setIsImportModalOpen(true)}
          className="w-full sm:w-auto"
        >
          <FileUp className="mr-2 h-4 w-4" aria-hidden="true" />
          {t('openImportMembers')}
        </Button>
      </div>

      <form onSubmit={handleSearch} className="flex flex-col gap-2 sm:flex-row">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" aria-hidden="true" />
          <Input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder={t('searchUsers')}
            className="pl-9"
            aria-label={t('searchUsers')}
          />
        </div>
        <Button type="submit" variant="outline" size="sm" className="w-full sm:w-auto">
          {tc('search')}
        </Button>
      </form>

      {isLoading && (
        <div className="flex justify-center py-8">
          <DiceLoader size="sm" />
        </div>
      )}

      {isError && (
        <div className="flex items-center gap-2 text-destructive-foreground py-4">
          <AlertCircle className="h-4 w-4" aria-hidden="true" />
          <span className="text-sm">{tc('error')}</span>
        </div>
      )}

      {data && data.data.length === 0 && (
        <p className="text-center text-muted-foreground py-8">{t('noUsers')}</p>
      )}

      {data && data.data.length > 0 && (
        <>
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-secondary/20">
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">{t('memberNumber')}</th>
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">{tc('name')}</th>
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">{tc('email')}</th>
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">{t('role')}</th>
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">{t('statusShort')}</th>
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">{t('noShowsShort')}</th>
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">{t('blockedShort')}</th>
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">{t('createdShort')}</th>
                  <th className="px-4 py-3 text-right font-medium text-muted-foreground">{tc('actions')}</th>
                </tr>
              </thead>
              <tbody>
                {data.data.map((user) => (
                  <tr key={user.id} className="border-b border-border last:border-0 hover:bg-secondary/10 transition-colors">
                    <td className="px-4 py-3 font-mono text-xs">{user.memberNumber}</td>
                    <td className="px-4 py-3 text-muted-foreground">{user.fullName ?? '—'}</td>
                    <td className="px-4 py-3 text-muted-foreground">{user.email ?? '—'}</td>
                    <td className="px-4 py-3">
                      <Badge variant={user.role === 'admin' ? 'default' : 'secondary'}>
                        {t(user.role)}
                      </Badge>
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge isActive={user.isActive} />
                    </td>
                    <td className="px-4 py-3 text-center">
                      {user.noShowCount > 0 ? (
                        <Badge className="border-red-500/40 bg-red-900/20 text-red-400">
                          {user.noShowCount}
                        </Badge>
                      ) : (
                        <span className="text-muted-foreground">0</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground text-xs">
                      {user.blockedUntil
                        ? new Date(user.blockedUntil).toLocaleDateString()
                        : '—'}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {new Date(user.createdAt).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1">
                        {user.noShowCount > 0 && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-xs text-amber-400 hover:bg-amber-900/20 hover:text-amber-300"
                            disabled={patchMutation.isPending}
                            onClick={() => patchMutation.mutate({ id: user.id, action: 'reset_no_shows' })}
                            aria-label={t('resetNoShows')}
                          >
                            {patchMutation.isPending && patchMutation.variables?.id === user.id && patchMutation.variables?.action === 'reset_no_shows' ? (
                              <DiceLoader size="sm" className="mr-1" hideRole />
                            ) : null}
                            {t('resetNoShows')}
                          </Button>
                        )}
                        {user.blockedUntil && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-xs text-emerald-400 hover:bg-emerald-900/20 hover:text-emerald-300"
                            disabled={patchMutation.isPending}
                            onClick={() => patchMutation.mutate({ id: user.id, action: 'unblock' })}
                            aria-label={t('unblockUser')}
                          >
                            {patchMutation.isPending && patchMutation.variables?.id === user.id && patchMutation.variables?.action === 'unblock' ? (
                              <DiceLoader size="sm" className="mr-1" hideRole />
                            ) : null}
                            {t('unblockUser')}
                          </Button>
                        )}
                        {!user.isActive && user.role === 'member' && (
                          <Button
                            variant="outline"
                            size="icon"
                            className="h-8 w-8 border-sky-500/40 text-sky-400 hover:bg-sky-900/20 hover:text-sky-300"
                            disabled={activationLinkMutation.isPending}
                            onClick={() => handleCopyActivationLink(user)}
                            aria-label={t('copyActivationLink')}
                            title={t('copyActivationLink')}
                          >
                            {activationLinkMutation.isPending && activationLinkMutation.variables?.id === user.id
                              ? <DiceLoader size="sm" hideRole />
                              : <Link2 className="h-3.5 w-3.5" aria-hidden="true" />}
                          </Button>
                        )}
                        {user.isActive && user.role === 'member' && (
                          <Button
                            variant="outline"
                            size="icon"
                            className="h-8 w-8 border-amber-500/40 text-amber-400 hover:bg-amber-900/20 hover:text-amber-300"
                            disabled={recoveryLinkMutation.isPending}
                            onClick={() => handleCopyRecoveryLink(user)}
                            aria-label={t('copyRecoveryLink')}
                            title={t('copyRecoveryLink')}
                          >
                            {recoveryLinkMutation.isPending && recoveryLinkMutation.variables?.id === user.id
                              ? <DiceLoader size="sm" hideRole />
                              : <KeyRound className="h-3.5 w-3.5" aria-hidden="true" />}
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => openEdit(user)}
                          aria-label={t('editUser')}
                        >
                          <Pencil className="h-4 w-4" aria-hidden="true" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => setDeleteUser(user)}
                          aria-label={t('deleteUser')}
                          className="text-destructive-foreground hover:bg-destructive/15"
                        >
                          <Trash2 className="h-4 w-4" aria-hidden="true" />
                        </Button>
                      </div>
                      {activationFeedback?.userId === user.id && (
                        <p className={`mt-2 text-right text-xs ${activationFeedback.kind === 'success' ? 'text-emerald-400' : 'text-destructive'}`}>
                          {activationFeedback.message}
                        </p>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {data.totalPages > 1 && (
            <div className="flex items-center justify-between text-sm text-muted-foreground">
              <span>
                {tc('showing')} {(page - 1) * 10 + 1}–{Math.min(page * 10, data.total)} {tc('of')} {data.total} {tc('results')}
              </span>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => p - 1)}
                >
                  {tc('previous')}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page >= data.totalPages}
                  onClick={() => setPage((p) => p + 1)}
                >
                  {tc('next')}
                </Button>
              </div>
            </div>
          )}
        </>
      )}

      {/* Edit Dialog */}
      <Dialog open={isImportModalOpen} onOpenChange={setIsImportModalOpen}>
        <DialogContent className="max-h-[90vh] max-w-4xl overflow-y-auto p-0 sm:max-h-[85vh]">
          <DialogHeader className="border-b border-border px-6 pb-4 pt-6">
            <DialogTitle>{t('importMembersTitle')}</DialogTitle>
            <DialogDescription>{t('importMembersDescription')}</DialogDescription>
          </DialogHeader>
          <div className="px-4 pb-4 pt-4 sm:px-6 sm:pb-6">
            <ImportMembersSection inDialog />
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={!!editUser} onOpenChange={(open) => { if (!open) setEditUser(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('editUserTitle')}</DialogTitle>
            <DialogDescription>
              {editUser?.memberNumber}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="edit-member-number">{t('memberNumber')}</Label>
              <Input
                id="edit-member-number"
                value={editState.memberNumber}
                onChange={(e) => setEditState((s) => ({ ...s, memberNumber: e.target.value }))}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="edit-full-name">{t('fullName')}</Label>
              <Input
                id="edit-full-name"
                value={editState.fullName}
                onChange={(e) => setEditState((s) => ({ ...s, fullName: e.target.value }))}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="edit-email">{tc('email')}</Label>
              <Input
                id="edit-email"
                type="email"
                value={editState.email}
                onChange={(e) => setEditState((s) => ({ ...s, email: e.target.value }))}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="edit-phone">{t('phone')}</Label>
              <Input
                id="edit-phone"
                value={editState.phone}
                onChange={(e) => setEditState((s) => ({ ...s, phone: e.target.value }))}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="edit-role">{t('role')}</Label>
              <Select
                value={editState.role}
                onValueChange={(v) => setEditState((s) => ({ ...s, role: v as UserRole }))}
              >
                <SelectTrigger id="edit-role">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="member">{t('member')}</SelectItem>
                  <SelectItem value="admin">{t('admin')}</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="edit-is-active">{t('status')}</Label>
              <div className="flex items-center gap-3">
                <input
                  id="edit-is-active"
                  type="checkbox"
                  className="h-4 w-4 cursor-pointer accent-emerald-500"
                  checked={editState.isActive}
                  onChange={(e) => setEditState((s) => ({ ...s, isActive: e.target.checked }))}
                />
                <span className="text-sm text-muted-foreground">
                  {editState.isActive ? t('active') : t('inactive')}
                </span>
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setEditUser(null)}>
              {tc('cancel')}
            </Button>
            <Button
              onClick={handleSaveEdit}
              disabled={updateMutation.isPending || !editState.memberNumber.trim()}
            >
              {updateMutation.isPending ? (
                <DiceLoader size="sm" className="mr-2" hideRole />
              ) : null}
              {tc('save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <AlertDialog open={!!deleteUser} onOpenChange={(open) => { if (!open) setDeleteUser(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('deleteUser')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('deleteUserConfirm')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tc('cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteConfirm}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleteMutation.isPending ? (
                <DiceLoader size="sm" className="mr-2" hideRole />
              ) : null}
              {tc('delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
