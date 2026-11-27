// Página Reparar Erros: procura erros REAIS do Windows (não "limpeza de registro") e corrige com confirmação,
// backup e Desfazer. A verificação é somente leitura; cada correção é confirmada, revalidada e reverificada.
// "Corrigir os selecionados" aplica várias de uma vez com UM pedido de administrador (fixBatch).
import { useEffect, useState } from 'react'
import { History, Info, Toolbox, Wrench } from 'lucide-react'
import { formatDate } from '@shared/format'
import type { RepairFix, RepairIssue } from '@shared/types/repair'
import { api, errMsg } from '../lib/api'
import { useNav } from '../lib/nav'
import { Button, ErrorBox, PageHeader, useToast } from '../components/ui'
import { BatchBar, BatchDialog } from '../components/repair/BatchPanel'
import { ChecksGrid } from '../components/repair/ChecksGrid'
import type { GuideAction } from '../components/repair/CrashGuide'
import { FixDialog, type FixRequest } from '../components/repair/FixDialog'
import { FixedList } from '../components/repair/FixedList'
import { IssueCard, ToolCard } from '../components/repair/IssueCard'
import { actionable, anchorId, batchFixOf, categoryMeta, groupIssues, plural, problemsOf, toolsOf } from '../components/repair/meta'
import {
  applyRepairBatch,
  applyRepairFix,
  batchEntries,
  cancelRepairScan,
  clearBatch,
  isBusy,
  itemIdsFor,
  lastFixFor,
  onNotice,
  openRepairTool,
  scanRepair,
  selectedIds,
  setBatch,
  setBatchMany,
  setSelection,
  undoRepairFix,
  useRepairState
} from '../components/repair/repairStore'
import { ApplyBanner, DeepScanDialog, ScanHero, ScanProgressPanel } from '../components/repair/ScanPanel'
import { AllClearState, IntroState, LoadingState } from '../components/repair/States'
import { SummaryCard } from '../components/repair/SummaryCard'

/** Entra no "Selecionar todos": problema de verdade (não observação), com correção rápida e sem risco alto. */
function autoSelectable(issue: RepairIssue): boolean {
  const fix = batchFixOf(issue)
  return Boolean(fix) && !issue.tool && issue.severity !== 'info' && !fix!.longRunning && fix!.risk !== 'high'
}

export default function RepairPage() {
  const s = useRepairState()
  const toast = useToast()
  const { go } = useNav()
  const [askDeep, setAskDeep] = useState(false)
  const [fixReq, setFixReq] = useState<FixRequest | null>(null)
  const [askBatch, setAskBatch] = useState(false)

  // Avisos do que termina enquanto a página está aberta (fora dela, o resultado fica no cartão/lista).
  useEffect(() => onNotice((n) => toast[n.kind](n.text)), [toast])

  const busy = isBusy(s)
  const report = s.report
  const problems = report ? problemsOf(report.issues) : []
  const tools = report ? toolsOf(report.issues) : []
  const groups = groupIssues(problems)
  const allClear = report ? actionable(report.issues).length === 0 : false
  const firstCrash = problems.find((i) => i.category === 'crashes')?.id
  const entries = batchEntries(s)
  const autoList = problems.filter((i) => autoSelectable(i) && lastFixFor(i.id, s)?.verify !== 'restart')

  const quick = (): void => void scanRepair(false)
  const deep = (): void => setAskDeep(true)

  const onGuideAction = (a: GuideAction): void => {
    if (a.kind === 'page') go(a.page)
    else if (a.kind === 'deepScan') setAskDeep(true)
    else api.system.openExternal(a.uri).catch((e) => toast.error(`Não foi possível abrir: ${errMsg(e)}`))
  }

  const requestFix = (issue: RepairIssue, fix: RepairFix): void => {
    setFixReq({ issue, fix, itemIds: itemIdsFor(issue, fix, s) })
  }
  const open = (issue: RepairIssue, fix: RepairFix): void => void openRepairTool(issue, fix)

  return (
    <div className="space-y-5">
      <PageHeader
        title="Reparar Erros"
        icon={Wrench}
        description="Encontra e corrige os erros do Windows que realmente atrapalham: arquivos corrompidos, disco, Windows Update, entradas quebradas, travamentos e rede."
      />

      <ScanHero report={report} deepCarriedAt={s.deepCarriedAt} scanning={s.scanning} applying={s.applying} onQuick={quick} onDeep={deep} />

      {s.scanning && <ScanProgressPanel run={s.scanning} progress={s.progress} cancelling={s.cancelling} onCancel={() => void cancelRepairScan()} />}
      {s.applying && <ApplyBanner run={s.applying} progress={s.applyProgress} />}
      {s.error && !s.scanning && <ErrorBox error={`A verificação falhou: ${s.error}`} onRetry={quick} />}

      {!s.initialized ? (
        <LoadingState />
      ) : !report ? (
        s.scanning ? (
          <LoadingState />
        ) : (
          <IntroState onQuick={quick} onDeep={deep} busy={busy} />
        )
      ) : (
        <>
          {allClear ? <AllClearState report={report} onDeep={deep} busy={busy} /> : <SummaryCard report={report} onDeepScan={deep} busy={busy} />}

          <FixedList records={s.fixed} busy={busy} onUndo={(k) => void undoRepairFix(k)} onOpenHistory={() => go('history')} />

          {groups.length > 0 && (
            <section className="space-y-5">
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div>
                  <h2 className="text-[17px] font-semibold">{allClear ? 'Observações (sem urgência)' : 'Problemas encontrados'}</h2>
                  <p className="mt-0.5 text-[13px] text-muted">
                    {allClear
                      ? 'Nada aqui atrapalha o PC agora; fica só para você saber.'
                      : 'Do mais grave para o menos grave. Nada é alterado sem você confirmar, e o que muda configuração tem backup e Desfazer.'}
                  </p>
                </div>
              </div>
              {groups.map((g) => {
                const meta = categoryMeta(g.category)
                return (
                  <div key={g.category} id={anchorId('issues', g.category)} className="scroll-mt-4 space-y-3">
                    <div className="flex items-center gap-2.5">
                      <div className="grid size-8 shrink-0 place-items-center rounded-lg border border-border bg-surface-2">
                        <meta.icon className="size-4 text-accent" />
                      </div>
                      <div className="min-w-0">
                        <h3 className="text-[14px] font-semibold">
                          {meta.label}{' '}
                          <span className="font-normal text-muted">
                            ·{' '}
                            {g.worst === 'info' ? plural(g.issues.length, 'observação', 'observações') : plural(g.issues.length, 'problema', 'problemas')}
                          </span>
                        </h3>
                        <p className="truncate text-[12px] text-muted">{meta.desc}</p>
                      </div>
                    </div>
                    {g.issues.map((issue) => (
                      <IssueCard
                        key={issue.id}
                        issue={issue}
                        selected={selectedIds(issue, s)}
                        onSelect={(ids) => setSelection(issue.id, ids ?? (issue.items ?? []).map((i) => i.id))}
                        onFix={(fix) => requestFix(issue, fix)}
                        onOpen={(fix) => open(issue, fix)}
                        onGuideAction={onGuideAction}
                        busy={busy}
                        applyingFixId={s.applying?.issueId === issue.id ? s.applying.fixId : undefined}
                        error={s.issueErrors[issue.id]}
                        record={lastFixFor(issue.id, s)}
                        defaultGuideOpen={issue.id === firstCrash}
                        batchFix={batchFixOf(issue)}
                        inBatch={Boolean(s.batch[issue.id])}
                        onBatch={(on) => setBatch(issue, on)}
                      />
                    ))}
                  </div>
                )
              })}
            </section>
          )}

          {tools.length > 0 && (
            <section className="space-y-3" id="repair-tools">
              <div className="flex items-center gap-2.5">
                <div className="grid size-8 shrink-0 place-items-center rounded-lg border border-border bg-surface-2">
                  <Toolbox className="size-4 text-accent" />
                </div>
                <div>
                  <h2 className="text-[15px] font-semibold">Ferramentas de reparo</h2>
                  <p className="text-[12px] text-muted">Não são problemas encontrados: use só se você notar o sintoma descrito.</p>
                </div>
              </div>
              <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                {tools.map((t) => (
                  <ToolCard
                    key={t.id}
                    issue={t}
                    onFix={(fix) => requestFix(t, fix)}
                    onOpen={(fix) => open(t, fix)}
                    busy={busy}
                    applyingFixId={s.applying?.issueId === t.id ? s.applying.fixId : undefined}
                    error={s.issueErrors[t.id]}
                    record={lastFixFor(t.id, s)}
                  />
                ))}
              </div>
            </section>
          )}

          <ChecksGrid report={report} deepCarriedAt={s.deepCarriedAt} carriedCheckIds={s.carriedCheckIds} />

          {report.warnings.length > 0 && (
            <div className="rounded-lg border border-border bg-surface px-4 py-3 text-[12px] text-muted">
              <p className="mb-1 flex items-center gap-1.5 font-semibold text-text">
                <Info className="size-3.5 text-info" />
                Avisos da verificação
              </p>
              <ul className="selectable list-disc space-y-0.5 pl-5">
                {report.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </div>
          )}

          <div className="flex flex-wrap items-center justify-between gap-2 text-[12px] text-faint">
            <span>
              Verificação {report.deep ? 'completa' : 'rápida'} de {formatDate(report.scannedAt, true)}. Não fazemos “limpeza de registro”: só corrigimos o
              que está comprovadamente quebrado.
            </span>
            <Button size="sm" variant="ghost" icon={History} onClick={() => go('history')}>
              Histórico de correções
            </Button>
          </div>

          {(entries.length > 0 || autoList.length > 1 || Boolean(s.applying?.batch)) && (
            <BatchBar
              entries={entries}
              busy={busy}
              applying={s.applying?.batch ? s.applying : null}
              progress={s.applyProgress}
              selectableCount={autoList.length}
              onSelectAll={() => setBatchMany(autoList, true)}
              onClear={clearBatch}
              onApply={() => setAskBatch(true)}
            />
          )}
        </>
      )}

      <DeepScanDialog
        open={askDeep}
        onCancel={() => setAskDeep(false)}
        onConfirm={() => {
          setAskDeep(false)
          void scanRepair(true)
        }}
      />
      <FixDialog
        req={fixReq}
        onCancel={() => setFixReq(null)}
        onConfirm={(req) => {
          setFixReq(null)
          void applyRepairFix(req.issue, req.fix, req.itemIds)
        }}
      />
      <BatchDialog
        open={askBatch}
        entries={entries}
        onCancel={() => setAskBatch(false)}
        onConfirm={() => {
          setAskBatch(false)
          void applyRepairBatch(entries)
        }}
      />
    </div>
  )
}
