import clsx from 'clsx'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Activity, CircuitBoard, Copy, Cpu, Gpu, HardDrive, Lightbulb, MemoryStick, Monitor, MonitorCog, RefreshCw, type LucideIcon } from 'lucide-react'
import type { HardwareInfo, HardwareInsight } from '@shared/types/hardware'
import { formatBytes, formatDate } from '@shared/format'
import { Button, Card, ErrorBox, PageHeader, Skeleton, Spinner, Tabs, useToast, type TabItem } from '../components/ui'
import { api, errMsg } from '../lib/api'
import BoardTab from '../components/hardware/BoardTab'
import CpuTab from '../components/hardware/CpuTab'
import DisplayNetTab from '../components/hardware/DisplayNetTab'
import GpuTab from '../components/hardware/GpuTab'
import LiveTab from '../components/hardware/LiveTab'
import MemoryTab from '../components/hardware/MemoryTab'
import StorageTab from '../components/hardware/StorageTab'
import SystemTab from '../components/hardware/SystemTab'
import { buildSummaryText, copyText, diskKind, fmtMhz, fmtPct, shortCpuName, shortGpuName } from '../components/hardware/format'
import { gpuLiveInsights, hasGpuTelemetry, telemetryGpu } from '../components/hardware/gpuRules'
import { InsightsPanel } from '../components/hardware/parts'
import { useLiveStats } from '../components/hardware/useLiveStats'

type TabId = 'cpu' | 'board' | 'memory' | 'gpu' | 'storage' | 'displays' | 'system' | 'live'

const TABS: TabItem<TabId>[] = [
  { id: 'cpu', label: 'CPU', icon: Cpu },
  { id: 'board', label: 'Placa-mãe & BIOS', icon: CircuitBoard },
  { id: 'memory', label: 'Memória', icon: MemoryStick },
  { id: 'gpu', label: 'Vídeo', icon: Gpu },
  { id: 'storage', label: 'Armazenamento', icon: HardDrive },
  { id: 'displays', label: 'Monitores & Rede', icon: Monitor },
  { id: 'system', label: 'Sistema', icon: MonitorCog },
  { id: 'live', label: 'Monitor ao vivo', icon: Activity }
]

const AREA_TAB: Record<HardwareInsight['area'], TabId> = {
  cpu: 'cpu',
  memory: 'memory',
  gpu: 'gpu',
  storage: 'storage',
  display: 'displays',
  network: 'displays',
  board: 'board',
  system: 'system'
}

const SEVERITY_ORDER: Record<HardwareInsight['severity'], number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 }

// Lembra a aba ao trocar de página e voltar.
let rememberedTab: TabId = 'cpu'

function SummaryTile({
  icon: Icon,
  label,
  title,
  sub,
  live,
  note,
  onClick
}: {
  icon: LucideIcon
  label: string
  title: string
  sub?: string
  /** Valor ao vivo (destacado) */
  live?: string
  /** Informação fixa extra (sem destaque), quando não há valor ao vivo */
  note?: string
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className="group min-w-0 rounded-xl border border-border bg-surface p-3.5 text-left transition-colors hover:border-border-strong hover:bg-surface-2"
    >
      <div className="flex items-center gap-2 text-[11.5px] font-medium tracking-wide text-muted uppercase">
        <Icon className="size-4 text-accent" />
        {label}
      </div>
      <p className="mt-1.5 truncate text-[15px] font-semibold" title={title}>
        {title}
      </p>
      <p className="truncate text-[12px] text-muted" title={sub}>
        {sub ?? ' '}
      </p>
      <p className={clsx('mt-1 truncate text-[12px] tabular-nums', live ? 'text-accent' : 'text-faint')}>{live ?? note ?? ' '}</p>
    </button>
  )
}

function LoadingState() {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="space-y-2 rounded-xl border border-border bg-surface p-4">
            <Skeleton className="w-20" />
            <Skeleton className="h-5 w-32" />
            <Skeleton className="w-24" />
          </div>
        ))}
      </div>
      <Card>
        <Spinner label="Lendo as informações do hardware (processador, placa-mãe, memória, vídeo, discos)... leva uns 5 segundos." />
      </Card>
    </div>
  )
}

export default function HardwarePage() {
  const toast = useToast()
  const live = useLiveStats()
  const [info, setInfo] = useState<HardwareInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTabState] = useState<TabId>(rememberedTab)

  const setTab = useCallback((t: TabId) => {
    rememberedTab = t
    setTabState(t)
  }, [])

  useEffect(() => {
    let alive = true
    void (async () => {
      // 1) mostra na hora o último resultado salvo; 2) atualiza (instantâneo se já coletado nesta sessão)
      const last = await api.hardware.getLast().catch(() => null)
      if (alive && last) setInfo(last)
      try {
        const fresh = await api.hardware.getInfo(false)
        if (alive) setInfo(fresh)
      } catch (e) {
        if (alive) setError(errMsg(e))
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setInfo(await api.hardware.getInfo(true))
      toast.success('Informações do hardware atualizadas.')
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setLoading(false)
    }
  }, [toast])

  const copySummary = useCallback(async () => {
    if (!info) return
    try {
      await copyText(buildSummaryText(info))
      toast.success('Resumo do hardware copiado. Cole onde quiser (Ctrl+V).')
    } catch (e) {
      toast.error(errMsg(e))
    }
  }, [info, toast])

  const l = live.latest
  const physicalGpus = info?.gpus.filter((g) => !g.isVirtual) ?? []
  const mainGpu = physicalGpus.find((g) => !g.isIntegrated) ?? physicalGpus[0]
  const ramSpeed = info?.memory.modules.length ? Math.min(...info.memory.modules.map((m) => m.configuredMhz ?? m.speedMhz ?? Infinity)) : undefined
  const ramType = info ? [...new Set(info.memory.modules.map((m) => m.type))].join('/') : ''
  const storageTotal = info?.storage.reduce((s, d) => s + d.sizeBytes, 0) ?? 0
  const gpuLiveText = [
    l?.gpuPercent !== undefined ? `${fmtPct(l.gpuPercent)} em uso` : undefined,
    l?.gpuTempC !== undefined ? `${Math.round(l.gpuTempC)} °C` : undefined
  ]
    .filter(Boolean)
    .join(' · ')
  // Destaques ao vivo da placa NVIDIA (quente, limitada por temperatura/energia) entram junto com os fixos
  const telemetry = hasGpuTelemetry(live.history)
  const liveGpuInsights = useMemo(
    () => (telemetry && info ? gpuLiveInsights(live.history, telemetryGpu(info, live.latest)) : []),
    [telemetry, info, live.history, live.latest]
  )
  const insights = useMemo(
    () => [...liveGpuInsights, ...(info?.insights ?? [])].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]),
    [liveGpuInsights, info]
  )

  return (
    <div>
      <PageHeader
        title="Hardware"
        icon={Cpu}
        description={
          info
            ? `Tudo sobre as peças do seu PC, como no CPU-Z — explicado em português. Coletado em ${formatDate(info.collectedAt, true)}${info.durationMs ? ` (${(info.durationMs / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} s)` : ''}.`
            : 'Tudo sobre as peças do seu PC, como no CPU-Z — explicado em português.'
        }
        actions={
          <>
            <Button icon={Copy} onClick={copySummary} disabled={!info}>
              Copiar resumo
            </Button>
            <Button variant="primary" icon={RefreshCw} loading={loading && Boolean(info)} disabled={loading} onClick={refresh}>
              {loading && info ? 'Atualizando...' : 'Atualizar'}
            </Button>
          </>
        }
      />

      {error && <ErrorBox className="mb-4" error={`Não foi possível ler o hardware: ${error}`} onRetry={refresh} />}

      {!info ? (
        loading ? (
          <LoadingState />
        ) : null
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            <SummaryTile
              icon={Cpu}
              label="Processador"
              title={shortCpuName(info.cpu.name)}
              sub={`${info.cpu.cores} núcleos · ${info.cpu.threads} threads${info.cpu.microarchitecture ? ` · ${info.cpu.microarchitecture}` : ''}`}
              live={l ? `${fmtPct(l.cpuPercent)} em uso${l.cpuMhz ? ` · ${fmtMhz(l.cpuMhz)}` : ''}` : undefined}
              onClick={() => setTab('cpu')}
            />
            <SummaryTile
              icon={MemoryStick}
              label="Memória"
              title={`${formatBytes(info.memory.totalBytes, 0)} ${ramType}`}
              sub={[ramSpeed && Number.isFinite(ramSpeed) ? `${ramSpeed} MT/s` : undefined, info.memory.channelsGuess?.replace(' (provável)', '')].filter(Boolean).join(' · ')}
              live={l ? `${formatBytes(l.memUsedBytes)} em uso (${fmtPct((100 * l.memUsedBytes) / l.memTotalBytes)})` : undefined}
              onClick={() => setTab('memory')}
            />
            <SummaryTile
              icon={Gpu}
              label="Vídeo"
              title={mainGpu ? shortGpuName(mainGpu.name) : '—'}
              sub={mainGpu ? `${mainGpu.vramBytes ? `${formatBytes(mainGpu.vramBytes, 0)} · ` : ''}${mainGpu.isIntegrated ? 'integrada' : 'dedicada'}` : undefined}
              live={gpuLiveText || undefined}
              onClick={() => setTab('gpu')}
            />
            <SummaryTile
              icon={HardDrive}
              label="Armazenamento"
              title={`${info.storage.length} disco${info.storage.length === 1 ? '' : 's'} · ${formatBytes(storageTotal, 1)}`}
              sub={info.storage.map((d) => diskKind(d).short).join(' · ')}
              live={l?.diskActivePercent !== undefined ? `${fmtPct(l.diskActivePercent)} ativo (mais ocupado)` : undefined}
              onClick={() => setTab('storage')}
            />
            <SummaryTile
              icon={CircuitBoard}
              label="Placa-mãe"
              title={info.motherboard.product}
              sub={[info.motherboard.chipset, `BIOS ${info.bios.version}`].filter(Boolean).join(' · ')}
              note={
                info.bios.mode !== 'Unknown'
                  ? `${info.bios.mode}${info.bios.secureBoot !== undefined ? (info.bios.secureBoot ? ' · Secure Boot ativo' : ' · sem Secure Boot') : ''}`
                  : undefined
              }
              onClick={() => setTab('board')}
            />
          </div>

          {insights.length > 0 && (
            <Card icon={Lightbulb} title="Destaques" subtitle="Análise automática das peças (regras locais, sem IA) — o que vale a pena saber ou ajustar">
              <InsightsPanel insights={insights} onAreaClick={(a) => setTab(AREA_TAB[a])} />
            </Card>
          )}

          <Tabs tabs={TABS} value={tab} onChange={setTab} />

          <div className="pt-1">
            {tab === 'cpu' && <CpuTab info={info} live={live} />}
            {tab === 'board' && <BoardTab info={info} />}
            {tab === 'memory' && <MemoryTab info={info} live={live} />}
            {tab === 'gpu' && <GpuTab info={info} live={live} />}
            {tab === 'storage' && <StorageTab info={info} live={live} />}
            {tab === 'displays' && <DisplayNetTab info={info} live={live} />}
            {tab === 'system' && <SystemTab info={info} />}
            {tab === 'live' && <LiveTab info={info} live={live} />}
          </div>
        </div>
      )}
    </div>
  )
}
