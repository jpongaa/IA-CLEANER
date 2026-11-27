import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Flame, Info, Sparkles } from 'lucide-react'
import type { CleanupEstimate, CleanupRunReport } from '@shared/types/cleanup'
import type { TaskProgress } from '@shared/types/common'
import { formatBytes } from '@shared/format'
import { ErrorBox, PageHeader, Skeleton, Toggle, useToast } from '../components/ui'
import { api, errMsg, useEvent } from '../lib/api'
import { CleanupHero } from '../components/cleanup/Summary'
import { TargetGroups } from '../components/cleanup/TargetList'
import { ConfirmCleanupDialog, ReportModal, RunProgressModal, SelectionBar } from '../components/cleanup/RunDialogs'
import { AiCleanupCard } from '../components/cleanup/AiCleanupCard'
import { WhyCleaningCard } from '../components/cleanup/WhyCard'
import { ExtremeSection } from '../components/cleanup/ExtremeSection'
import { RecycleBinCard } from '../components/cleanup/RecycleBinCard'
import { isSelectable } from '../components/cleanup/meta'

/** Preferência da "Busca extrema" (só deste computador; sem ela, começa desligada). */
const EXTREME_PREF = 'iacleaner.cleanup.extreme'
function readExtremePref(): boolean {
  try {
    return localStorage.getItem(EXTREME_PREF) === '1'
  } catch {
    return false
  }
}
function writeExtremePref(v: boolean): void {
  try {
    localStorage.setItem(EXTREME_PREF, v ? '1' : '0')
  } catch {
    // armazenamento indisponível: só não lembra
  }
}

function defaultSelection(est: CleanupEstimate | null): Set<string> {
  return new Set((est?.targets ?? []).filter((t) => t.selectedByDefault && isSelectable(t)).map((t) => t.id))
}

/** Fases que encerram uma tarefa (o backend sempre envia uma delas no fim). */
const FINAL_PHASES = new Set(['done', 'error', 'cancelled'])

export default function CleanupPage() {
  const toast = useToast()
  const [estimate, setEstimate] = useState<CleanupEstimate | null>(null)
  const [loadingLast, setLoadingLast] = useState(true)
  const [estimating, setEstimating] = useState(false)
  const [progress, setProgress] = useState<TaskProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [running, setRunning] = useState(false)
  const [runProgress, setRunProgress] = useState<TaskProgress | null>(null)
  const [report, setReport] = useState<CleanupRunReport | null>(null)
  const [sysDrive, setSysDrive] = useState<{ letter: string; percent: number; freeBytes: number } | null>(null)
  const [extreme, setExtreme] = useState<boolean>(readExtremePref)
  const listRef = useRef<HTMLDivElement>(null)
  // Tarefas iniciadas POR ESTA página (a promessa delas trata o fim). As outras (Checkup do Painel, ou uma análise
  // começada antes de trocar de página) são acompanhadas pelos eventos de progresso.
  const ownEstimate = useRef(false)
  const ownRun = useRef(false)

  const reloadEstimate = useCallback(() => {
    api.cleanup
      .getLastEstimate()
      .then((est) => {
        if (!est) return
        setEstimate(est)
        setSelected(defaultSelection(est))
      })
      .catch(() => undefined)
  }, [])

  // Ao abrir: último resultado salvo (não perde dados ao trocar de página) e tarefa em andamento, se houver
  useEffect(() => {
    let alive = true
    api.cleanup
      .getLastEstimate()
      .then((est) => {
        if (!alive) return
        setEstimate(est)
        setSelected(defaultSelection(est))
      })
      .catch((e) => alive && setError(errMsg(e)))
      .finally(() => alive && setLoadingLast(false))
    api.cleanup
      .getStatus()
      .then((st) => {
        if (!alive || !st) return
        if (st.busy === 'estimate' && !ownEstimate.current) {
          setEstimating(true)
          setProgress(st.progress?.task === 'cleanup:estimate' ? st.progress : null)
        } else if (st.busy === 'run' && !ownRun.current) {
          setRunning(true)
          setRunProgress(st.progress?.task === 'cleanup:run' ? st.progress : null)
        }
      })
      .catch(() => undefined)
    // Espaço livre do disco do sistema (opcional: vem do módulo de discos)
    api.disk
      .listDrives()
      .then((drives) => {
        const d = drives.find((x) => x.isSystem)
        if (alive && d && d.totalBytes > 0) setSysDrive({ letter: d.letter, percent: (d.freeBytes / d.totalBytes) * 100, freeBytes: d.freeBytes })
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [])

  useEvent('cleanup:progress', (p) => {
    if (!p) return
    const final = FINAL_PHASES.has(p.phase)
    if (p.task === 'cleanup:estimate') {
      if (ownEstimate.current) {
        if (!final) setProgress(p)
        return
      }
      // Análise que esta página não iniciou: mostra o progresso e, no fim, carrega o resultado novo.
      if (!final) {
        setEstimating(true)
        setProgress(p)
        return
      }
      setEstimating(false)
      setProgress(null)
      if (p.phase === 'done') reloadEstimate()
      else if (p.phase === 'error' && p.message) setError(p.message)
    } else if (p.task === 'cleanup:run') {
      if (ownRun.current) {
        if (!final) setRunProgress(p)
        return
      }
      if (!final) {
        setRunning(true)
        setRunProgress(p)
        return
      }
      setRunning(false)
      setRunProgress(null)
      reloadEstimate()
      if (p.phase === 'done' && p.message) toast.success(p.message)
    }
  })

  const analyze = useCallback(async () => {
    ownEstimate.current = true
    setEstimating(true)
    setError(null)
    setProgress(null)
    try {
      const est = await api.cleanup.estimate({ extreme })
      setEstimate(est)
      setSelected(defaultSelection(est))
    } catch (e) {
      const msg = errMsg(e)
      if (/cancelad/i.test(msg)) toast.info('Análise cancelada.')
      else setError(msg)
    } finally {
      ownEstimate.current = false
      setEstimating(false)
      setProgress(null)
    }
  }, [toast, extreme])

  const normalTargets = useMemo(() => (estimate?.targets ?? []).filter((t) => !t.extreme), [estimate])
  const extremeTargets = useMemo(() => (estimate?.targets ?? []).filter((t) => t.extreme), [estimate])

  /** A Lixeira foi esvaziada pelo cartão: o item "Lixeira" da análise passa a valer 0 (sem precisar analisar de novo). */
  const onBinEmptied = useCallback((drive: string | null) => {
    setEstimate((prev) => {
      if (!prev) return prev
      const targets = prev.targets.map((t) => {
        if (t.kind !== 'recycleBin') return t
        if (!drive) return { ...t, bytes: 0, files: 0, breakdown: [], selectedByDefault: false }
        const left = (t.breakdown ?? []).filter((b) => b.label !== drive)
        return { ...t, bytes: left.reduce((s, b) => s + b.bytes, 0), files: left.reduce((s, b) => s + (b.files ?? 0), 0), breakdown: left }
      })
      return { ...prev, targets }
    })
    setSelected((prev) => {
      const next = new Set(prev)
      next.delete('recycle-bin')
      return next
    })
  }, [])

  const selectedTargets = useMemo(() => (estimate?.targets ?? []).filter((t) => selected.has(t.id)), [estimate, selected])

  const toggle = useCallback((id: string, v: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (v) next.add(id)
      else next.delete(id)
      return next
    })
  }, [])
  const toggleMany = useCallback((ids: string[], v: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev)
      for (const id of ids) {
        if (v) next.add(id)
        else next.delete(id)
      }
      return next
    })
  }, [])

  const selectFromAi = useCallback(
    (ids: string[]) => {
      if (ids.length === 0) return
      toggleMany(ids, true)
      toast.success(`${ids.length} ${ids.length === 1 ? 'item selecionado' : 'itens selecionados'} conforme a recomendação da IA.`)
      const first = listRef.current?.querySelector(`[data-target-id="${CSS.escape(ids[0])}"]`)
      ;(first ?? listRef.current)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    },
    [toggleMany, toast]
  )

  async function runCleanup(): Promise<void> {
    const ids = selectedTargets.map((t) => t.id)
    setConfirmOpen(false)
    ownRun.current = true
    setRunning(true)
    setRunProgress(null)
    try {
      const rep = await api.cleanup.run({ targetIds: ids })
      setReport(rep)
      const est = await api.cleanup.getLastEstimate().catch(() => null)
      if (est) setEstimate(est)
      setSelected(new Set())
      if (rep.totalFreed > 0) toast.success(`Limpeza concluída: ${formatBytes(rep.totalFreed)} liberados.`)
    } catch (e) {
      toast.error(`Não foi possível limpar: ${errMsg(e)}`)
    } finally {
      ownRun.current = false
      setRunning(false)
      setRunProgress(null)
    }
  }

  const busy = estimating || running

  return (
    <div className="space-y-6 pb-2">
      <PageHeader
        title="Limpeza Inteligente"
        icon={Sparkles}
        description="Encontra o que pode ser apagado com segurança, separa o que precisa de cuidado e explica cada item. Nada é apagado sem a sua confirmação."
      />

      <CleanupHero
        estimate={estimate}
        estimating={estimating}
        progress={progress}
        onEstimate={analyze}
        onCancel={() => api.cleanup.cancel().catch(() => undefined)}
        systemDriveFree={sysDrive}
      />

      {error && <ErrorBox error={error} onRetry={analyze} />}

      <div className="grid gap-3 lg:grid-cols-2">
        <section className="rounded-xl border border-border bg-surface px-4 py-3" data-testid="cleanup-extreme-toggle">
          <Toggle
            checked={extreme}
            disabled={estimating || running}
            onChange={(v) => {
              setExtreme(v)
              writeExtremePref(v)
            }}
            label={
              <span className="flex items-center gap-1.5">
                <Flame className="size-4 text-warn" /> Busca extrema
              </span>
            }
            description="Procura também o que é pesado no Windows: Limpeza de Disco oficial, componentes (DISM), drivers antigos, hibernação, pontos de restauração, discos virtuais, caches de edição de vídeo e gravações de jogos. Demora um pouco mais."
          />
          {extreme && estimate && extremeTargets.length === 0 && !estimating && (
            <p className="mt-2 text-[12px] text-warn">Ligada. Clique em &ldquo;Analisar de novo&rdquo; para incluir os itens pesados.</p>
          )}
          {!extreme && extremeTargets.length > 0 && (
            <p className="mt-2 text-[12px] text-faint">Desligada: a próxima análise não vai incluir os itens pesados mostrados abaixo.</p>
          )}
        </section>
        <RecycleBinCard refreshKey={`${estimate?.scannedAt ?? ''}|${report?.finishedAt ?? ''}`} onEmptied={onBinEmptied} />
      </div>

      <AiCleanupCard estimate={estimate} onSelectTargets={selectFromAi} />

      {loadingLast ? (
        <div className="space-y-3 rounded-xl border border-border bg-surface p-5">
          <Skeleton className="h-5 w-48" />
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
        </div>
      ) : estimate ? (
        <div ref={listRef}>
          <TargetGroups targets={normalTargets} selected={selected} onToggle={toggle} onToggleMany={toggleMany} />
          {extremeTargets.length > 0 && (
            <div className="mt-5">
              <ExtremeSection targets={extremeTargets} selected={selected} onToggle={toggle} />
            </div>
          )}
          {estimate.warnings && estimate.warnings.length > 0 && (
            <details className="mt-3 text-[12px] text-faint">
              <summary className="cursor-pointer select-none hover:text-muted">
                <Info className="mr-1 inline size-3.5" />
                {estimate.warnings.length} {estimate.warnings.length === 1 ? 'aviso' : 'avisos'} da análise (itens ignorados pela proteção)
              </summary>
              <ul className="selectable mt-2 space-y-1 pl-5">
                {estimate.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </details>
          )}
          <SelectionBar selected={selectedTargets} onClean={() => setConfirmOpen(true)} onClear={() => setSelected(new Set())} disabled={busy} />
        </div>
      ) : null}

      <WhyCleaningCard systemDriveFreePercent={sysDrive?.percent} />

      <ConfirmCleanupDialog open={confirmOpen} targets={selectedTargets} onConfirm={runCleanup} onCancel={() => setConfirmOpen(false)} />
      <RunProgressModal open={running} progress={runProgress} onCancel={() => api.cleanup.cancel().catch(() => undefined)} />
      <ReportModal report={report} onClose={() => setReport(null)} />
    </div>
  )
}
