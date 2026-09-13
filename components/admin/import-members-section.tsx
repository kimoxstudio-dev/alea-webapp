'use client'

import { useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { FileSpreadsheet, UploadCloud, AlertCircle } from 'lucide-react'
import { DiceLoader } from '@/components/ui/dice-loader'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useAdminImportUsers } from '@/lib/hooks/use-admin'
import type { MemberImportResult } from '@/lib/types'

interface ImportMembersSectionProps {
  inDialog?: boolean
}

export function ImportMembersSection({ inDialog = false }: ImportMembersSectionProps) {
  const t = useTranslations('admin')
  const importInputRef = useRef<HTMLInputElement | null>(null)

  const [importFile, setImportFile] = useState<File | null>(null)
  const [importResult, setImportResult] = useState<MemberImportResult | null>(null)
  const [importDragActive, setImportDragActive] = useState(false)

  const importMutation = useAdminImportUsers()

  function setNextImportFile(nextFile: File | null) {
    setImportFile(nextFile)
  }

  function openImportPicker() {
    importInputRef.current?.click()
  }

  function handleImportSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!importFile) return

    importMutation.mutate(importFile, {
      onSuccess: (result) => {
        setImportResult(result)
        setImportFile(null)
        if (importInputRef.current) {
          importInputRef.current.value = ''
        }
      },
    })
  }

  return (
    <div className={inDialog ? 'space-y-4' : 'space-y-6'}>
      <section className={`rounded-xl border border-border bg-background-secondary/60 shadow-[0_0_0_1px_rgba(201,163,107,0.06)] ${inDialog ? 'p-4 sm:p-5' : 'p-6'}`}>
        <div className={`flex items-start gap-4 ${inDialog ? 'mb-4' : 'mb-5'}`}>
          <div className="flex h-11 w-11 items-center justify-center rounded-xl border border-primary/20 bg-primary/10 text-primary">
            <FileSpreadsheet className="h-5 w-5" aria-hidden="true" />
          </div>
          <div className="space-y-1">
            <h2 className="font-cinzel text-xl text-foreground">{t('importMembersTitle')}</h2>
            <p className="max-w-3xl text-sm text-muted-foreground">{t('importMembersDescription')}</p>
          </div>
        </div>

        <form onSubmit={handleImportSubmit} className="space-y-4">
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
            <div className="space-y-3">
              <button
                type="button"
                className={`group flex w-full flex-col items-center justify-center rounded-xl border border-dashed px-5 text-center transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 ${inDialog ? 'min-h-44 py-6 sm:min-h-48' : 'min-h-52 py-8'} ${importDragActive ? 'border-primary/60 bg-primary/10 shadow-[0_0_30px_rgba(201,163,107,0.08)]' : 'border-border bg-background/40 hover:border-primary/30 hover:bg-background/70'}`}
                aria-describedby="member-import-meta member-import-selected-file"
                onClick={openImportPicker}
                onDragOver={(event) => {
                  event.preventDefault()
                  setImportDragActive(true)
                }}
                onDragLeave={() => setImportDragActive(false)}
                onDrop={(event) => {
                  event.preventDefault()
                  setImportDragActive(false)
                  setNextImportFile(event.dataTransfer.files?.[0] ?? null)
                }}
              >
                <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-full border border-primary/20 bg-primary/10 text-primary transition-transform group-hover:scale-105">
                  <UploadCloud className="h-7 w-7" aria-hidden="true" />
                </div>
                <p className="text-base font-semibold text-foreground">{t('importMembersDropLabel')}</p>
                <p id="member-import-meta" className="mt-2 text-sm text-muted-foreground">{t('importMembersMeta')}</p>
                {importFile && (
                  <p id="member-import-selected-file" className="mt-4 max-w-full break-words rounded-full border border-primary/20 bg-primary/10 px-3 py-1 text-xs text-primary">
                    {t('importMembersSelectedFile', { name: importFile.name })}
                  </p>
                )}
              </button>

              <Input
                ref={importInputRef}
                id="member-import-file"
                type="file"
                className="sr-only"
                accept=".csv,.xlsx,.odt,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.oasis.opendocument.text"
                onChange={(event) => {
                  setNextImportFile(event.target.files?.[0] ?? null)
                }}
              />
            </div>

            <Button type="submit" size="lg" className="w-full min-w-0 sm:min-w-52 lg:w-auto lg:self-stretch" disabled={!importFile || importMutation.isPending}>
              <span className="inline-flex h-4 w-4 shrink-0">
                {importMutation.isPending && <DiceLoader size="sm" hideRole />}
              </span>
              {t('importMembersAction')}
            </Button>
          </div>

          {importMutation.isError && (
            <div className="flex items-center gap-2 rounded-lg border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive-foreground">
              <AlertCircle className="h-4 w-4" aria-hidden="true" />
              <span>{t('importMembersFailed')}</span>
            </div>
          )}
        </form>
      </section>

      {importResult && (
        <section className="rounded-xl border border-border bg-background-secondary/40 p-5">
          <div className="flex flex-wrap gap-3 text-sm text-muted-foreground">
            <span>{t('importMembersCreated', { count: importResult.createdCount })}</span>
            <span>{t('importMembersUpdated', { count: importResult.updatedCount })}</span>
            <span>{t('importMembersSkipped', { count: importResult.skippedCount })}</span>
          </div>

          {importResult.issues.length > 0 && (
            <div className="mt-4 space-y-2">
              <p id="import-issues-heading" className="text-sm font-medium text-foreground">{t('importMembersIssues')}</p>
              <ul
                className="max-h-40 space-y-1 overflow-y-auto overflow-x-hidden text-xs text-muted-foreground"
                tabIndex={0}
                aria-labelledby="import-issues-heading"
              >
                {importResult.issues.slice(0, 8).map((issue) => (
                  <li key={`${issue.rowNumber}-${issue.memberNumber ?? 'missing'}`} className="break-words">
                    {t('importMembersIssueRow', { row: issue.rowNumber })}: {t(`importMembersIssueCodes.${issue.code}`)}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {importResult.normalizedRows.length > 0 && (
            <div className="mt-4 space-y-2">
              <p id="import-preview-heading" className="text-sm font-medium text-foreground">{t('importMembersNormalizedPreview')}</p>
              <ul
                className="max-h-40 space-y-1 overflow-y-auto overflow-x-hidden text-xs text-muted-foreground"
                tabIndex={0}
                aria-labelledby="import-preview-heading"
              >
                {importResult.normalizedRows.slice(0, 5).map((row) => (
                  <li key={`${row.rowNumber}-${row.memberNumber}`} className="break-words">
                    {row.memberNumber} · {row.fullName}{row.email ? ` · ${row.email}` : ''}{row.phone ? ` · ${row.phone}` : ''}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}
    </div>
  )
}
