// Análise de Discos: varredura rápida de todos os HDs/SSDs (sem IA) — mapa de pastas, maiores arquivos,
// arquivos antigos, tipos e duplicados. A análise é só leitura; apagar (pastas do mapa, arquivos, cópias
// duplicadas) passa pela confirmação + guard + módulo de Limpeza. O que é marcado nas abas é somado numa barra fixa.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Copy, FileStack, FolderTree, HardDrive, History, PieChart, RefreshCw, ScanSearch } from 'lucide-react'
import type { DriveInfo } from '@shared/types/common'
import type { DriveScanResult, DuplicatesProgress, DuplicatesReport, ScanFreshness, ScanProgress, ScanResult } from '@shared/types/disk'
import { formatBytes, formatDuration, formatNumber } from '@shared/format'
import { Button, Card, EmptyState, ErrorBox, PageHeader, Skeleton, Tabs, useToast, type TabItem } from '../components/ui'
import { api, errMsg, useAsync, useEvent } from '../lib/api'
import { DriveCards } from '../components/disk/DriveCards'
import { ScanProgressPanel } from '../components/disk/ScanProgressPanel'
import { DriveSummary } from '../components/disk/DriveSummary'
import { FolderMap } from '../components/disk/FolderMap'
import { FileTable } from '../components/disk/FileTable'
import { TypesView } from '../components/disk/TypesView'
import { DuplicatesView } from '../components/disk/DuplicatesView'
import { useDeleteFlow } from '../components/disk/useDeleteFlow'
import { EverythingView } from '../components/disk/EverythingView'
import { InventoryHint } from '../components/disk/InventoryHint'
import { SelectionBar } from '../components/disk/SelectionBar'
import { StaleScanNotice } from '../components/disk/StaleScanNotice'
import { useDiskSelection } from '../components/disk/useSelection'
import { RecycleBinNotice, useRecycleBin } from '../components/disk/useRecycleBin'

type ResultTab = 'map' | 'big' | 'old' | 'types' | 'dupes'

const MB = 1024 * 1024
/** Detalhe do mapa de pastas: pastas ≥ 32 MB, até 10 níveis. */
const SCAN_OPTIONS = { minNodeBytes: 32 * MB, maxDepth: 10, topFiles: 300 }

interface Running {
  scanId?: string
  roots: string[]
  startedAt: number
}

export default function DiskPage() {
  const toast = useToast()
  const drivesQ = useAsync(() => api.disk.listDrives(), [])
  const drives: DriveInfo[] = useMemo(() => drivesQ.data ?? [], [drivesQ.data])

  const [scan, setScan] = useState<ScanResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [nativeOk, setNativeOk] = useState(true)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [running, setRunning] = useState<Running | null>(null)
  const [progress, setProgress] = useState<Record<string, ScanProgress>>({})
  const [cancelling, setCancelling] = useState(false)
  const [now, setNow] = useState(Date.now())
  const [activeRoot, setActiveRoot] = useState<string | null>(null)
  const [tab, setTab] = useState<ResultTab>('map')
  /** Filtro aplicado na lista de maiores arquivos (ex.: ao clicar numa pasta do mapa) */
  const [fileQuery, setFileQuery] = useState('')
  const [dupes, setDupes] = useState<DuplicatesReport | null>(null)
  const [dupesRunning, setDupesRunning] = useState(false)
  const [dupesProgress, setDupesProgress] = useState<DuplicatesProgress | null>(null)
  /** Conferência rápida: as maiores pastas/arquivos da análise ainda existem? */
  const [fresh, setFresh] = useState<ScanFreshness | null>(null)
  const [forgetting, setForgetting] = useState(false)
  /** Algo foi apagado nesta visita à página (destaca o aviso da Lixeira) */
  const [deletedHere, setDeletedHere] = useState(false)
  const sel = useDiskSelection()
  const bin = useRecycleBin(() => drivesQ.run())

  // ---------- carga inicial: último resultado + tarefas em andamento ----------
  const loadAll = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const [last, status, lastDupes] = await Promise.all([api.disk.getLastScan(), api.disk.getStatus(), api.disk.getLastDuplicates().catch(() => null)])
      setScan(last)
      setDupes(lastDupes)
      setNativeOk(status.nativeAvailable)
      if (status.scan.running) {
        setRunning({
          scanId: status.scan.scanId,
          roots: status.scan.roots,
          startedAt: Date.parse(status.scan.startedAt ?? '') || Date.now()
        })
        setProgress(Object.fromEntries(status.scan.progress.map((p) => [p.root, p])))
      }
      if (status.duplicates.running) {
        setDupesRunning(true)
        setDupesProgress(status.duplicates.progress ?? null)
      }
    } catch (e) {
      setLoadError(errMsg(e))
    } finally {
      setLoading(false)
    }
  }, [])
  useEffect(() => {
    void loadAll()
  }, [loadAll])

  // Lixeira (o espaço do que foi para lá só volta depois de esvaziar)
  useEffect(() => {
    void bin.refresh()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  /** Confere (só leitura, rápido) se as maiores pastas/arquivos da última análise ainda existem. */
  const checkFresh = useCallback(async () => {
    try {
      setFresh(await api.disk.checkScanFreshness())
    } catch {
      setFresh(null)
    }
  }, [])
  const hasScan = Boolean(scan)
  useEffect(() => {
    if (!loading && hasScan && !running) void checkFresh()
  }, [loading, hasScan]) // eslint-disable-line react-hooks/exhaustive-deps

  // Seleção padrão: todas as unidades fixas
  useEffect(() => {
    if (drives.length && selected.size === 0) {
      setSelected(new Set(drives.filter((d) => d.driveType === 'fixed').map((d) => d.root)))
    }
  }, [drives]) // eslint-disable-line react-hooks/exhaustive-deps

  // Relógio enquanto analisa
  useEffect(() => {
    if (!running) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [running])

  // ---------- eventos do backend ----------
  useEvent('disk:progress', (p) => {
    setProgress((prev) => ({ ...prev, [p.root]: p }))
    setRunning(
      (r) =>
        r ?? {
          scanId: p.scanId,
          roots: [p.root],
          startedAt: Date.now() - p.elapsedMs
        }
    )
  })
  useEvent('disk:done', (d) => {
    setRunning(null)
    setCancelling(false)
    if (d.result) {
      setScan(d.result)
      const ran = running?.roots ?? Object.keys(progress)
      // Unidades analisadas de novo: a seleção antiga delas sai (tamanhos podem ter mudado) e o aviso de
      // "análise desatualizada" é refeito.
      sel.remove(ran)
      void checkFresh()
      const fresh = d.result.drives.filter((x) => ran.some((r) => r.toUpperCase() === x.root.toUpperCase()))
      if (fresh[0]) setActiveRoot(fresh[0].root)
      const took = fresh.length ? Math.max(...fresh.map((x) => x.durationMs)) : 0
      if (d.result.cancelled) toast.info('Análise cancelada. As unidades que já tinham terminado foram salvas.')
      else toast.success(`Análise concluída${took ? ` em ${formatDuration(took)}` : ''}.`)
    } else if (d.error) {
      if (/cancelad/i.test(d.error)) toast.info(d.error)
      else toast.error(d.error)
    }
    drivesQ.run()
  })
  useEvent('disk:dupesProgress', (p) => {
    setDupesProgress(p)
    if (p.phase === 'done') {
      setDupesRunning(false)
      api.disk
        .getLastDuplicates()
        .then(setDupes)
        .catch(() => undefined)
    } else setDupesRunning(true)
  })

  // ---------- ações ----------
  const scannedByRoot = useMemo(() => new Map((scan?.drives ?? []).map((d) => [d.root.toUpperCase(), d])), [scan])

  const startScan = async (only?: string[]): Promise<void> => {
    const roots = only?.length ? only : drives.filter((d) => selected.has(d.root)).map((d) => d.root)
    if (!roots.length || running) return
    if (only?.length) setSelected(new Set(only))
    setProgress({})
    setRunning({ roots, startedAt: Date.now() })
    setNow(Date.now())
    try {
      const { scanId } = await api.disk.startScan({ roots, ...SCAN_OPTIONS })
      setRunning((r) => (r ? { ...r, scanId } : r))
    } catch (e) {
      setRunning(null)
      toast.error(errMsg(e))
    }
  }

  const cancelScan = async (): Promise<void> => {
    setCancelling(true)
    await api.disk.cancelScan().catch((e) => toast.error(errMsg(e)))
  }

  const startDupes = (roots: string[], minBytes: number): void => {
    setDupesRunning(true)
    setDupesProgress(null)
    api.disk
      .findDuplicates({ roots, minBytes })
      .then((groups) => {
        const wasted = groups.reduce((s, g) => s + g.wastedBytes, 0)
        toast.success(groups.length ? `${groups.length} grupo(s) de duplicados: ${formatBytes(wasted)} em cópias extras.` : 'Nenhum duplicado encontrado.')
        return api.disk.getLastDuplicates().then(setDupes)
      })
      .catch((e) => {
        const msg = errMsg(e)
        if (/cancelad/i.test(msg)) toast.info(msg)
        else toast.error(msg)
      })
      .finally(() => setDupesRunning(false))
  }

  const reloadResults = useCallback(async () => {
    const [last, d] = await Promise.all([api.disk.getLastScan().catch(() => null), api.disk.getLastDuplicates().catch(() => null)])
    if (last) setScan(last)
    setDupes(d)
  }, [])
  const del = useDeleteFlow(
    (gone) => {
      sel.remove(gone)
      setDeletedHere(true)
      void reloadResults()
      drivesQ.run()
    },
    {
      bin,
      // "Procurar de novo" no resultado da exclusão de duplicados: mesma busca (unidades e tamanho mínimo)
      onRescanDuplicates: () => {
        if (dupesRunning) return
        const roots = dupes?.roots.length ? dupes.roots : dupeDefaultRoots
        if (roots.length) startDupes(roots, dupes?.minBytes || 10 * MB)
      }
    }
  )

  /** "Tirar do mapa": remove da análise salva o que não existe mais (sem ler o disco de novo). */
  const forgetMissing = async (): Promise<void> => {
    if (!fresh?.missing.length) return
    setForgetting(true)
    try {
      const gone = fresh.missing.map((m) => m.path)
      await api.disk.forgetFiles(gone, {
        known: fresh.missing.map((m) => ({
          path: m.path,
          bytes: m.bytes,
          kind: m.kind
        }))
      })
      sel.remove(gone)
      await reloadResults()
      const n = fresh.missing.length
      toast.success(n === 1 ? `“${fresh.missing[0].path}” não existe mais e saiu do mapa.` : `${n} itens que não existem mais saíram do mapa.`)
      await checkFresh()
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setForgetting(false)
    }
  }

  // ---------- derivados ----------
  const resultDrives = scan?.drives ?? []
  const active: DriveScanResult | undefined =
    resultDrives.find((d) => d.root.toUpperCase() === activeRoot?.toUpperCase()) ?? resultDrives.find((d) => !d.error) ?? resultDrives[0]
  const activeInfo = active ? drives.find((d) => d.root.toUpperCase() === active.root.toUpperCase()) : undefined
  const selectedCount = drives.filter((d) => selected.has(d.root)).length
  const dupeRootsAvailable = useMemo(() => {
    const s = new Set<string>(drives.filter((d) => d.driveType !== 'network').map((d) => d.root))
    for (const d of resultDrives) s.add(d.root)
    return [...s].sort()
  }, [drives, resultDrives])
  const dupeDefaultRoots = useMemo(
    () => (dupes?.roots.length ? dupes.roots : resultDrives.length ? resultDrives.map((d) => d.root) : dupeRootsAvailable),
    [dupes, resultDrives, dupeRootsAvailable]
  )

  const driveTabs: TabItem<string>[] = resultDrives.map((d) => ({
    id: d.root,
    label: d.root,
    icon: HardDrive,
    badge: d.error ? 'erro' : formatBytes(d.totalBytes)
  }))
  const resultTabs: TabItem<ResultTab>[] = active
    ? [
        { id: 'map', label: 'Mapa de pastas', icon: FolderTree },
        {
          id: 'big',
          label: 'Maiores arquivos',
          icon: FileStack,
          badge: active.topFiles.length
        },
        {
          id: 'old',
          label: 'Antigos e grandes',
          icon: History,
          badge: active.oldLargeFiles.length
        },
        { id: 'types', label: 'Por tipo', icon: PieChart },
        {
          id: 'dupes',
          label: 'Duplicados',
          icon: Copy,
          badge: dupes ? dupes.groups.length : undefined
        }
      ]
    : []

  return (
    <div className="space-y-5">
      <PageHeader
        title="Análise de Discos"
        icon={HardDrive}
        description="Mapa completo do espaço em todos os HDs e SSDs: o que mais ocupa, arquivos esquecidos e duplicados. É só leitura — nada é apagado sem a sua confirmação."
        actions={
          <Button variant="ghost" icon={RefreshCw} loading={drivesQ.loading} onClick={() => drivesQ.run()}>
            Atualizar unidades
          </Button>
        }
      />

      {!nativeOk && (
        <div className="flex items-start gap-2.5 rounded-lg border border-warn/40 bg-warn/10 p-3 text-[13px]">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warn" />
          <p>
            O verificador rápido (<span className="font-mono">iacleaner-scanner.exe</span>) não foi encontrado. A análise vai funcionar no modo compatível, que
            é mais lento.
          </p>
        </div>
      )}

      {/* Unidades */}
      <Card
        title="Unidades"
        subtitle="Escolha quais HDs/SSDs analisar. Discos diferentes são lidos ao mesmo tempo; em HD (disco mecânico) a leitura é mais cuidadosa."
        actions={
          <>
            <Button
              size="sm"
              variant="ghost"
              disabled={Boolean(running) || !drives.length}
              onClick={() => setSelected(selectedCount === drives.length ? new Set() : new Set(drives.map((d) => d.root)))}
            >
              {selectedCount === drives.length ? 'Desmarcar todas' : 'Marcar todas'}
            </Button>
            <Button
              variant="primary"
              icon={ScanSearch}
              disabled={!selectedCount || Boolean(running)}
              loading={Boolean(running)}
              onClick={() => void startScan()}
            >
              {running ? 'Analisando...' : `Analisar ${selectedCount === 1 ? '1 unidade' : `${selectedCount} unidades`}`}
            </Button>
          </>
        }
      >
        {drivesQ.error ? (
          <ErrorBox error={`Não foi possível listar as unidades: ${drivesQ.error}`} onRetry={() => drivesQ.run()} />
        ) : !drivesQ.data && drivesQ.loading ? (
          <div className="grid grid-cols-3 gap-3">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-[150px] rounded-xl" />
            ))}
          </div>
        ) : drives.length ? (
          <DriveCards
            drives={drives}
            selected={selected}
            scanned={scannedByRoot}
            disabled={Boolean(running)}
            onToggle={(root) =>
              setSelected((s) => {
                const n = new Set(s)
                if (n.has(root)) n.delete(root)
                else n.add(root)
                return n
              })
            }
          />
        ) : (
          <EmptyState icon={HardDrive} title="Nenhuma unidade encontrada" />
        )}
      </Card>

      {running && (
        <ScanProgressPanel
          roots={running.roots}
          progress={progress}
          drives={drives}
          elapsedMs={Math.max(0, now - running.startedAt)}
          onCancel={() => void cancelScan()}
          cancelling={cancelling}
        />
      )}

      {fresh && fresh.missingCount > 0 && !loading && (
        <StaleScanNotice
          fresh={fresh}
          scanning={Boolean(running)}
          forgetting={forgetting}
          onRescan={(roots) => void startScan(roots)}
          onForget={() => void forgetMissing()}
        />
      )}
      {bin.info && (bin.info.bytes >= 1024 ** 3 || (deletedHere && bin.info.bytes > 0)) && <RecycleBinNotice bin={bin} emphasis={deletedHere} />}

      {/* Resultados */}
      {loading ? (
        <div className="space-y-3">
          <Skeleton className="h-10 w-1/3" />
          <Skeleton className="h-[320px] rounded-xl" />
        </div>
      ) : loadError ? (
        <ErrorBox error={`Não foi possível carregar a última análise: ${loadError}`} onRetry={() => void loadAll()} />
      ) : !active ? (
        !running && (
          <Card>
            <EmptyState
              icon={ScanSearch}
              title="Nenhuma análise ainda"
              description="Clique em “Analisar” para descobrir o que está ocupando espaço em cada unidade. Um SSD costuma levar menos de 1 minuto; HDs grandes, alguns minutos."
              action={
                <Button variant="primary" icon={ScanSearch} disabled={!selectedCount} onClick={() => void startScan()}>
                  Analisar agora
                </Button>
              }
            />
          </Card>
        )
      ) : (
        <Card padded={false}>
          <div className="px-5 pt-3">
            <Tabs
              tabs={driveTabs}
              value={active.root}
              onChange={(r) => {
                setActiveRoot(r)
                setFileQuery('')
              }}
            />
          </div>
          <div className="space-y-5 p-5">
            {active.error ? (
              <ErrorBox error={`Não foi possível analisar ${active.root}: ${active.error}`} />
            ) : (
              <>
                <DriveSummary drive={active} isSystem={Boolean(activeInfo?.isSystem ?? active.root.toUpperCase().startsWith('C:'))} />
                <Tabs
                  tabs={resultTabs}
                  value={tab}
                  onChange={(t) => {
                    setTab(t)
                    if (t !== 'big') setFileQuery('')
                  }}
                />
                {(tab === 'map' || tab === 'big' || tab === 'old' || tab === 'dupes') && <InventoryHint />}
                {tab === 'dupes' && sel.top.length > 0 && (
                  <SelectionBar selection={sel} permanent={del.mode === 'permanent'} busy={del.busy} onDelete={() => del.request(sel.top)} sticky={false} />
                )}
                {tab === 'map' && (
                  <FolderMap
                    drive={active}
                    selection={sel}
                    onDelete={del.request}
                    onEmptyBin={bin.requestEmpty}
                    busy={del.busy}
                    deleteMode={del.mode}
                    onError={toast.error}
                    onShowFiles={(folder) => {
                      setFileQuery(folder.endsWith('\\') ? folder : folder + '\\')
                      setTab('big')
                    }}
                  />
                )}
                {tab === 'big' && (
                  <div className="space-y-2">
                    <p className="text-[13px] text-muted">
                      Os {formatNumber(active.topFiles.length)} maiores arquivos de {active.root}. Arquivos de jogos, programas e do Windows aparecem para você
                      entender o espaço, mas só podem ser removidos desinstalando pelo jeito certo.
                    </p>
                    <FileTable
                      key={`big-${active.root}-${fileQuery}`}
                      initialQuery={fileQuery}
                      files={active.topFiles}
                      mode="top"
                      selection={sel}
                      onError={toast.error}
                    />
                  </div>
                )}
                {tab === 'old' && (
                  <div className="space-y-2">
                    <p className="text-[13px] text-muted">
                      Arquivos de <b className="text-text">100 MB ou mais</b> que não são modificados há <b className="text-text">6 meses ou mais</b>. Bons
                      candidatos para apagar ou mover para um HD externo (gravações de jogos, instaladores e ISOs antigos...).
                    </p>
                    <FileTable key={`old-${active.root}`} files={active.oldLargeFiles} mode="old" selection={sel} onError={toast.error} />
                  </div>
                )}
                {tab === 'types' && <TypesView drive={active} />}
                {tab === 'dupes' && (
                  <DuplicatesView
                    availableRoots={dupeRootsAvailable}
                    defaultRoots={dupeDefaultRoots}
                    report={dupes}
                    running={dupesRunning}
                    progress={dupesProgress}
                    onStart={startDupes}
                    onCancel={() => void api.disk.cancelDuplicates()}
                    onDelete={del.requestDuplicates}
                    busy={del.busy}
                    onError={toast.error}
                    deleteMode={del.mode}
                    staleNotice={del.dupesNotice}
                    onDismissStaleNotice={del.clearDupesNotice}
                  />
                )}
              </>
            )}
          </div>
        </Card>
      )}

      <EverythingView
        root={active?.root}
        onDeleted={() => {
          void bin.refresh()
          // o que saiu pelo painel também sai das listas da unidade (antigos e grandes, maiores arquivos)
          void api.disk
            .getLastScan()
            .then(setScan)
            .catch(() => undefined)
        }}
      />

      {tab !== 'dupes' && <SelectionBar selection={sel} permanent={del.mode === 'permanent'} busy={del.busy} onDelete={() => del.request(sel.top)} />}

      {del.dialog}
      {bin.dialog}
    </div>
  )
}
