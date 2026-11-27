// Busca Profunda: acha o que ficou perdido no PC (instaladores e jogos baixados, zips já extraídos, jogos fora dos
// launchers como o Hydra, sobras de programas desinstalados, desinstaladores quebrados, programas sem desinstalador e
// programas indesejados). A busca só lê; toda ação que altera o PC passa por confirmação e é feita pelo backend
// (api.discover.act), que revalida no disco, usa a Lixeira por padrão e registra no Histórico.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CheckCircle2, ScanSearch, SearchX } from 'lucide-react'
import type { Finding, FindingAction, FindingKind } from '@shared/types/discover'
import { formatBytes } from '@shared/format'
import { Button, EmptyState, ErrorBox, PageHeader, Skeleton, useToast } from '../components/ui'
import { api, errMsg } from '../lib/api'
import { DiscoverHero } from '../components/discover/DiscoverHero'
import { ExtremeCard, SummaryCards } from '../components/discover/Summary'
import { FiltersBar } from '../components/discover/Filters'
import { HydraSection, KindSection, ScanDetails, splitHydra, type RowHandlers } from '../components/discover/Sections'
import { BulkBar } from '../components/discover/BulkBar'
import {
  BulkRecycleDialog,
  ElevateRetryDialog,
  FindingActionDialog,
  resultToastText,
  type BulkProgress,
  type PendingAction
} from '../components/discover/ActionDialogs'
import { applyResult, cancelScan, clearScanError, loadLast, setDeep, startScan, useDiscover } from '../components/discover/store'
import {
  canRetryElevated,
  CONFIRM_WORD,
  DEFAULT_FILTERS,
  filterAndSort,
  groupByKind,
  hydraGameList,
  isBulkEligible,
  isHydra,
  isPassive,
  recycleAction,
  summarize,
  type FindingFilters
} from '../components/discover/logic'

interface RetryRequest {
  finding: Finding
  action: FindingAction
  paths?: string[]
  confirmWord?: string
  elevated?: boolean
}

export default function DiscoverPage() {
  const toast = useToast()
  const st = useDiscover()
  const [filters, setFilters] = useState<FindingFilters>(DEFAULT_FILTERS)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [pending, setPending] = useState<PendingAction | null>(null)
  const [running, setRunning] = useState(false)
  const [busy, setBusy] = useState<{ findingId: string; action: string } | null>(null)
  const [bulkOpen, setBulkOpen] = useState(false)
  const [bulkRunning, setBulkRunning] = useState(false)
  const [bulkProgress, setBulkProgress] = useState<BulkProgress | null>(null)
  const [retry, setRetry] = useState<(RetryRequest & { message?: string }) | null>(null)
  const [retryRunning, setRetryRunning] = useState(false)
  const resultsRef = useRef<HTMLDivElement>(null)

  // Ao abrir: último resultado salvo (não perde dados ao trocar de página)
  useEffect(() => {
    void loadLast()
  }, [])

  const report = st.report
  const findings = useMemo(() => (Array.isArray(report?.findings) ? report!.findings : []), [report])
  const summary = useMemo(() => summarize(report), [report])
  const filtered = useMemo(() => filterAndSort(findings, filters), [findings, filters])
  const groups = useMemo(() => groupByKind(filtered.filter((f) => !isHydra(f)), filters.sort), [filtered, filters.sort])
  const hydraShown = useMemo(() => splitHydra(filtered.filter(isHydra)), [filtered])
  const hydraAll = useMemo(() => splitHydra(findings.filter(isHydra)), [findings])
  const hydraGames = useMemo(() => hydraGameList(hydraAll.launcher, hydraAll.games), [hydraAll])
  const hasHydra = hydraAll.launcher.length + hydraAll.games.length > 0
  const hydraVisible = hydraShown.launcher.length + hydraShown.games.length > 0

  // Seleção só com achados que ainda existem e podem ir em lote
  useEffect(() => {
    setSelected((prev) => {
      if (prev.size === 0) return prev
      const ok = new Set(findings.filter(isBulkEligible).map((f) => f.id))
      const next = new Set([...prev].filter((id) => ok.has(id)))
      return next.size === prev.size ? prev : next
    })
  }, [findings])
  const selectedFindings = useMemo(() => findings.filter((f) => selected.has(f.id)), [findings, selected])
  const visibleEligible = useMemo(() => filtered.filter(isBulkEligible), [filtered])

  const scan = useCallback(async () => {
    setSelected(new Set())
    const out = await startScan()
    if (out.status === 'ok') {
      const n = out.report.findings.length
      toast.success(n > 0 ? `Busca concluída: ${n} ${n === 1 ? 'achado' : 'achados'}.` : 'Busca concluída: nada perdido por aqui.')
    } else if (out.status === 'cancelled') toast.info('Busca cancelada.')
  }, [toast])

  const onSelect = useCallback((id: string, v: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (v) next.add(id)
      else next.delete(id)
      return next
    })
  }, [])
  const onSelectMany = useCallback((ids: string[], v: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev)
      for (const id of ids) {
        if (v) next.add(id)
        else next.delete(id)
      }
      return next
    })
  }, [])

  const onAction = useCallback(
    async (f: Finding, a: FindingAction) => {
      if (!isPassive(a.kind)) {
        setPending({ finding: f, action: a })
        return
      }
      // Só abre algo (pasta, site, Configurações, launcher): não altera o PC, vai direto.
      setBusy({ findingId: f.id, action: a.kind })
      try {
        const res = await api.discover.act({ findingId: f.id, action: a.kind })
        if (!res.ok && !res.cancelled) toast.error(res.message || `${a.label}: não deu certo.`)
      } catch (e) {
        toast.error(`${a.label}: ${errMsg(e)}`)
      } finally {
        setBusy(null)
      }
    },
    [toast]
  )

  /** Executa a ação já confirmada e mostra o resultado. Acesso negado sem admin -> oferece tentar como Administrador. */
  const execute = useCallback(
    async (req: RetryRequest) => {
      const { finding: f, action: a, paths, confirmWord, elevated } = req
      try {
        const res = await api.discover.act({
          findingId: f.id,
          action: a.kind,
          ...(confirmWord ? { confirmWord } : {}),
          ...(paths ? { paths } : {}),
          ...(elevated ? { elevated: true } : {})
        })
        const removed = applyResult(f.id, a.kind, paths, res)
        if (res.ok) toast.success(resultToastText(a, res))
        else if (res.cancelled) toast.info(res.message || 'Cancelado: nada foi alterado.')
        else if (!elevated && canRetryElevated(a, res)) setRetry({ ...req, message: res.message })
        else toast.error(res.message || `${a.label}: não deu certo.`)
        if (removed) onSelect(f.id, false)
      } catch (e) {
        toast.error(`${a.label}: ${errMsg(e)}`)
      }
    },
    [toast, onSelect]
  )

  const confirmAction = useCallback(
    async (paths: string[] | undefined, confirmWord: string | undefined) => {
      if (!pending) return
      setRunning(true)
      try {
        await execute({ finding: pending.finding, action: pending.action, paths, confirmWord })
      } finally {
        setRunning(false)
        setPending(null)
      }
    },
    [pending, execute]
  )

  const confirmRetry = useCallback(async () => {
    if (!retry) return
    setRetryRunning(true)
    try {
      await execute({ ...retry, elevated: true })
    } finally {
      setRetryRunning(false)
      setRetry(null)
    }
  }, [retry, execute])

  const runBulk = useCallback(async () => {
    const list = selectedFindings.filter(isBulkEligible)
    if (list.length === 0) return
    setBulkRunning(true)
    let okCount = 0
    let bytes = 0
    let stoppedByUser = false
    const fails: string[] = []
    for (let i = 0; i < list.length; i++) {
      const f = list[i]
      setBulkProgress({ done: i, total: list.length, current: f.title })
      const act = recycleAction(f)
      try {
        const res = await api.discover.act({ findingId: f.id, action: 'recycle', ...(act?.dangerous ? { confirmWord: act.confirmWord?.trim() || CONFIRM_WORD } : {}) })
        applyResult(f.id, 'recycle', undefined, res)
        if (res.ok) {
          okCount++
          bytes += typeof res.bytesFreed === 'number' && res.bytesFreed > 0 ? res.bytesFreed : Math.max(0, f.bytes)
        } else if (res.cancelled) {
          // UAC negado / cancelado: para aqui, o resto fica como está
          stoppedByUser = true
          break
        } else fails.push(`${f.title}: ${res.message || 'não deu certo'}`)
      } catch (e) {
        fails.push(`${f.title}: ${errMsg(e)}`)
      }
    }
    setBulkRunning(false)
    setBulkProgress(null)
    setBulkOpen(false)
    setSelected(new Set())
    if (okCount > 0)
      toast.success(
        `${okCount} ${okCount === 1 ? 'item foi' : 'itens foram'} para a Lixeira (${formatBytes(bytes)}). O espaço volta quando a Lixeira for esvaziada.`
      )
    if (stoppedByUser) toast.info('Cancelado: os itens que faltavam não foram alterados.')
    if (fails.length > 0)
      toast.error(`${fails.length} ${fails.length === 1 ? 'item não pôde' : 'itens não puderam'} ser movidos: ${fails.slice(0, 2).join(' · ')}${fails.length > 2 ? ' ...' : ''}`)
  }, [selectedFindings, toast])

  const pickKind = useCallback((k: FindingKind | 'all') => {
    setFilters((f) => ({ ...f, kind: k }))
    requestAnimationFrame(() => resultsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
  }, [])

  const actionBusy = running || bulkRunning || retryRunning || Boolean(busy)
  const h: RowHandlers = {
    notes: st.notes,
    selected,
    onSelect,
    onSelectMany,
    onAction: (f, a) => void onAction(f, a),
    busy,
    disabled: running || bulkRunning || retryRunning || st.scanning
  }

  const firstLoad = st.loading && !report

  return (
    <div className="space-y-6 pb-2">
      <PageHeader
        title="Busca Profunda"
        icon={ScanSearch}
        description="Acha o que ficou perdido: instaladores e jogos baixados, zips já extraídos, jogos fora dos launchers, sobras de programas desinstalados e programas sem desinstalador."
      />

      {firstLoad ? (
        <div className="space-y-3 rounded-2xl border border-border bg-surface p-6" data-testid="discover-loading">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-10 w-64" />
          <Skeleton className="h-3 w-96" />
          <div className="grid grid-cols-2 gap-3 pt-3 xl:grid-cols-4">
            <Skeleton className="h-16" />
            <Skeleton className="h-16" />
            <Skeleton className="h-16" />
            <Skeleton className="h-16" />
          </div>
        </div>
      ) : (
        <DiscoverHero
          report={report}
          summary={summary}
          scanning={st.scanning}
          progress={st.progress}
          deep={st.deep}
          onDeep={setDeep}
          onScan={() => void scan()}
          onCancel={cancelScan}
        />
      )}

      {st.scanError && !st.scanning && (
        <ErrorBox
          error={`A busca não terminou: ${st.scanError}`}
          onRetry={() => {
            clearScanError()
            void scan()
          }}
        />
      )}
      {st.loadError && !report && !st.scanning && (
        <ErrorBox error={`Não foi possível carregar o último resultado: ${st.loadError}`} onRetry={() => void loadLast(true)} />
      )}

      {report && findings.length === 0 && (
        <div className="rounded-xl border border-border bg-surface" data-testid="discover-empty">
          <EmptyState
            icon={CheckCircle2}
            title="Nada perdido por aqui"
            description={
              <>
                A busca não achou instaladores esquecidos, sobras de programas nem programas sem desinstalador.
                {st.deep ? '' : ' Para procurar também nos outros discos e em mais pastas, ligue a "Busca completa" e busque de novo.'}
              </>
            }
          />
        </div>
      )}
      {report && findings.length === 0 && <ExtremeCard />}

      {report && findings.length > 0 && (
        <>
          <SummaryCards summary={summary} activeKind={filters.kind} onPickKind={pickKind} />
          <ExtremeCard />

          <div ref={resultsRef} className="scroll-mt-4 space-y-4">
            <FiltersBar
              filters={filters}
              onChange={setFilters}
              summary={summary}
              shown={filtered.length}
              total={findings.length}
              safeCount={visibleEligible.length}
              allSafeSelected={visibleEligible.length > 0 && visibleEligible.every((f) => selected.has(f.id))}
              onSelectSafe={(v) => onSelectMany(visibleEligible.map((f) => f.id), v)}
              disabled={actionBusy || st.scanning}
            />

            {hasHydra && hydraVisible && <HydraSection launcher={hydraShown.launcher} games={hydraShown.games} gameList={hydraGames} h={h} />}

            {groups.map((g) => (
              <KindSection key={g.kind} kind={g.kind} findings={g.findings} h={h} />
            ))}

            {filtered.length === 0 && (
              <div className="rounded-xl border border-border bg-surface">
                <EmptyState
                  icon={SearchX}
                  title="Nenhum achado com esses filtros"
                  action={
                    <Button size="sm" onClick={() => setFilters({ ...DEFAULT_FILTERS, sort: filters.sort })}>
                      Limpar filtros
                    </Button>
                  }
                />
              </div>
            )}
          </div>

          <ScanDetails report={report} />

          <BulkBar
            selected={selectedFindings}
            eligibleCount={visibleEligible.length}
            onSelectAll={() => onSelectMany(visibleEligible.map((f) => f.id), true)}
            onClear={() => setSelected(new Set())}
            onRecycle={() => setBulkOpen(true)}
            disabled={actionBusy || st.scanning}
          />
        </>
      )}

      {!report && !firstLoad && <ExtremeCard />}

      <FindingActionDialog pending={pending} running={running} onConfirm={(p, w) => void confirmAction(p, w)} onCancel={() => !running && setPending(null)} />
      <ElevateRetryDialog
        open={Boolean(retry)}
        title={retry?.finding.title ?? ''}
        actionLabel={retry?.action.label ?? ''}
        message={retry?.message}
        running={retryRunning}
        onConfirm={() => void confirmRetry()}
        onCancel={() => !retryRunning && setRetry(null)}
      />
      <BulkRecycleDialog
        open={bulkOpen}
        findings={selectedFindings}
        running={bulkRunning}
        progress={bulkProgress}
        onConfirm={() => void runBulk()}
        onCancel={() => !bulkRunning && setBulkOpen(false)}
      />
    </div>
  )
}
