import { Activity, ArrowDown, ArrowUp, Cpu, Gpu, HardDrive, MemoryStick, Network, Thermometer, type LucideIcon } from 'lucide-react'
import type { HardwareInfo, LiveStats } from '@shared/types/hardware'
import { formatBytes } from '@shared/format'
import { Card, ErrorBox, Spinner } from '../ui'
import { CoreBars, LiveArea, type SeriesDef } from './charts'
import { fmtMhz, fmtPct, fmtRate, SERIES } from './format'
import { fmtTemp, GpuClockCard, GpuTempCard } from './GpuTelemetry'
import { gpuLiveInsights, hasGpuTelemetry, telemetryGpu } from './gpuRules'
import { ExtLiveTag, Hint, InsightRow, LiveTag, UsageBar } from './parts'
import type { LiveState } from './useLiveStats'

function Tile({ icon: Icon, label, value, sub }: { icon: LucideIcon; label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-border bg-surface p-3.5">
      <div className="flex items-center justify-between">
        <p className="text-[11.5px] font-medium tracking-wide text-muted uppercase">{label}</p>
        <Icon className="size-4 text-accent" />
      </div>
      <p className="mt-1.5 text-[20px] font-semibold">{value}</p>
      <p className="mt-0.5 truncate text-[12px] text-muted">{sub ?? ' '}</p>
    </div>
  )
}

const GB = 1024 ** 3
const pct = (v: number): string => fmtPct(v)
const pctAxis = (v: number): string => `${v}%`
const gb = (v: number): string => `${(v / GB).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} GB`
const rateAxis = (v: number): string => (v === 0 ? '0' : `${formatBytes(v, 1).replace(',0 ', ' ')}/s`)
const gbAxis = (v: number): string => (v === 0 ? '0' : gb(v))

const S_CPU: SeriesDef[] = [{ id: 'cpu', label: 'CPU', color: SERIES.primary, get: (s) => s.cpuPercent }]
const S_MEM: SeriesDef[] = [{ id: 'mem', label: 'Em uso', color: SERIES.primary, get: (s) => s.memUsedBytes }]
const S_GPU: SeriesDef[] = [{ id: 'gpu', label: 'GPU', color: SERIES.primary, get: (s) => s.gpuPercent }]
const S_DISK: SeriesDef[] = [
  { id: 'dr', label: 'Leitura', color: SERIES.primary, get: (s) => s.diskReadBps },
  { id: 'dw', label: 'Gravação', color: SERIES.secondary, get: (s) => s.diskWriteBps }
]
const S_NET: SeriesDef[] = [
  { id: 'rx', label: 'Download', color: SERIES.primary, get: (s) => s.netRxBps },
  { id: 'tx', label: 'Upload', color: SERIES.secondary, get: (s) => s.netTxBps }
]

export default function LiveTab({ info, live }: { info: HardwareInfo; live: LiveState }) {
  const { latest: l, history, error } = live
  if (error) return <ErrorBox error={`Não foi possível iniciar o monitor ao vivo: ${error}`} />
  if (!l) {
    return (
      <Card>
        <Spinner label="Iniciando o monitor ao vivo..." />
      </Card>
    )
  }
  const waitingExt = !l.extendedAvailable && !l.collectorError
  const memPct = (100 * l.memUsedBytes) / l.memTotalBytes
  const disks = [...(l.perDisk ?? [])].sort((a, b) => a.name.localeCompare(b.name))
  const gpuName = info.gpus.find((g) => !g.isVirtual)?.name
  const nvGpu = telemetryGpu(info, l)
  const telemetry = hasGpuTelemetry(history)
  const gpuInsights = telemetry ? gpuLiveInsights(history, nvGpu) : []
  const gpuSub = [
    l.gpuMemDedicatedBytes !== undefined ? `VRAM ${formatBytes(l.gpuMemDedicatedBytes)}` : undefined,
    l.gpuTempC !== undefined ? fmtTemp(l.gpuTempC) : undefined
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <div className="space-y-4">
      {l.collectorError && (
        <Hint tone="warn">
          Disco, rede e GPU ao vivo não estão disponíveis neste computador (CPU e memória continuam funcionando). Detalhe técnico:{' '}
          {l.collectorError}
        </Hint>
      )}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Tile icon={Cpu} label="CPU" value={pct(l.cpuPercent)} sub={l.cpuMhz ? `${fmtMhz(l.cpuMhz)} agora` : `${info.cpu.threads} threads`} />
        <Tile icon={MemoryStick} label="Memória" value={pct(memPct)} sub={`${formatBytes(l.memUsedBytes)} de ${formatBytes(l.memTotalBytes)}`} />
        <Tile icon={HardDrive} label="Disco" value={l.diskActivePercent !== undefined ? pct(l.diskActivePercent) : '—'} sub={waitingExt ? 'iniciando...' : l.collectorError ? 'indisponível' : 'do disco mais ocupado'} />
        <Tile icon={ArrowDown} label="Download" value={fmtRate(l.netRxBps)} sub="placas físicas" />
        <Tile icon={ArrowUp} label="Upload" value={fmtRate(l.netTxBps)} sub="placas físicas" />
        <Tile
          icon={Gpu}
          label="GPU"
          value={l.gpuPercent !== undefined ? pct(l.gpuPercent) : '—'}
          sub={gpuSub || (waitingExt ? 'iniciando...' : 'indisponível')}
        />
      </div>

      {gpuInsights.length > 0 && (
        <ul className={gpuInsights.length > 1 ? 'grid gap-2 md:grid-cols-2' : 'grid gap-2'}>
          {gpuInsights.map((i) => (
            <InsightRow key={i.id} insight={i} />
          ))}
        </ul>
      )}

      <div className="grid gap-4 xl:grid-cols-2">
        <Card icon={Cpu} title="Processador — uso total" subtitle="Últimos 60 segundos" actions={<LiveTag />}>
          <LiveArea history={history} series={S_CPU} format={pct} axisFormat={pctAxis} yMax={100} />
        </Card>
        <Card icon={Activity} title="Uso por thread" subtitle={`${l.perCore.length} threads lógicas — uma barra no topo e as outras baixas é normal em jogos`}>
          <CoreBars perCore={l.perCore} />
        </Card>
        <Card icon={MemoryStick} title="Memória em uso" subtitle={`de ${formatBytes(l.memTotalBytes)} utilizáveis`} actions={<LiveTag />}>
          <LiveArea history={history} series={S_MEM} format={gb} yMax={l.memTotalBytes} axisFormat={gbAxis} />
        </Card>
        <Card icon={Gpu} title="Placa de vídeo" subtitle={gpuName ? `${gpuName} — motor mais ocupado` : 'Motor mais ocupado'} actions={<ExtLiveTag latest={l} />}>
          {waitingExt && history.every((s: LiveStats) => s.gpuPercent === undefined) ? (
            <Spinner label="Aguardando os primeiros dados da GPU..." className="py-14" />
          ) : (
            <LiveArea history={history} series={S_GPU} format={pct} axisFormat={pctAxis} yMax={100} />
          )}
        </Card>
        {telemetry && <GpuTempCard history={history} gpu={nvGpu} />}
        {telemetry && <GpuClockCard history={history} gpu={nvGpu} />}
        <Card icon={HardDrive} title="Discos" subtitle="Leitura e gravação somadas de todos os discos" actions={<ExtLiveTag latest={l} />}>
          <LiveArea history={history} series={S_DISK} format={fmtRate} axisFormat={rateAxis} minTop={1024 ** 2} />
          {disks.length > 0 && (
            <div className="mt-3 grid gap-2.5 sm:grid-cols-3">
              {disks.map((d) => (
                <UsageBar key={d.number} label={d.name} value={d.activePercent} detail={`${fmtPct(d.activePercent)} ativo`} />
              ))}
            </div>
          )}
        </Card>
        <Card icon={Network} title="Rede" subtitle="Tráfego das placas de rede físicas" actions={<ExtLiveTag latest={l} />}>
          <LiveArea history={history} series={S_NET} format={fmtRate} axisFormat={rateAxis} minTop={128 * 1024} />
        </Card>
      </div>

      <Hint icon={Thermometer}>
        Os gráficos só rodam enquanto esta página está aberta, para não gastar recursos.{' '}
        {telemetry
          ? 'Temperatura, clock, consumo e ventoinha da placa de vídeo vêm do próprio driver NVIDIA (a cada 2 segundos). A temperatura do processador e as ventoinhas do gabinete'
          : 'Temperaturas e ventoinhas'}{' '}
        não aparecem aqui porque o Windows não as informa sem drivers de terceiros — use o HWiNFO para isso (link na aba CPU). Disco 100% ativo por
        muito tempo, RAM acima de 90% ou CPU sempre alta sem nada aberto são sinais de gargalo — veja a página Desempenho.
      </Hint>
    </div>
  )
}
