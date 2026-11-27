// Telemetria ao vivo da placa NVIDIA (nvidia-smi): gráficos de temperatura e clock, sensores e destaques.
// Sem placa NVIDIA / sem driver oficial, nada disto aparece (quem usa confere `hasGpuTelemetry`).
import clsx from 'clsx'
import { Fan, Gauge, Thermometer, Zap, type LucideIcon } from 'lucide-react'
import type { GpuInfo, LiveStats } from '@shared/types/hardware'
import { Badge, Card, type Tone } from '../ui'
import { LiveArea, type SeriesDef } from './charts'
import { fmtMhz, SERIES } from './format'
import { gpuLiveInsights, gpuThresholds, TEMP_LEVEL_LABEL, tempLevel, throttleStatus } from './gpuRules'
import { InsightRow, LiveTag, SubTitle } from './parts'

const WARN = '#fbbf24'

const S_TEMP: SeriesDef[] = [{ id: 'gt', label: 'Temperatura', color: SERIES.primary, get: (s) => s.gpuTempC }]
const S_CLOCK: SeriesDef[] = [{ id: 'gc', label: 'Clock', color: SERIES.primary, get: (s) => s.gpuClockMhz }]

export const fmtTemp = (c: number | undefined): string => (c === undefined ? '—' : `${Math.round(c)} °C`)
const fmtW = (w: number | undefined): string => (w === undefined ? '—' : `${w.toLocaleString('pt-BR', { maximumFractionDigits: w < 100 ? 1 : 0 })} W`)
const clockAxis = (v: number): string => (v === 0 ? '0' : `${(v / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 2 })} GHz`)
const tempAxis = (v: number): string => `${v} °C`

/** Topo do eixo do clock: clock máximo da placa (ou maior visto), arredondado para cima em 200 MHz. */
function clockTop(history: LiveStats[], g?: GpuInfo | null): number {
  let max = g?.nvidia?.maxClockMhz ?? 0
  for (const s of history) max = Math.max(max, s.gpuClockMhz ?? 0)
  return Math.max(1000, Math.ceil(max / 200) * 200)
}

function shortName(g?: GpuInfo | null): string {
  return g ? g.name.replace(/^NVIDIA\s+/i, '') : 'Placa NVIDIA'
}

/** Mini indicador (rótulo, valor, observação). */
export function MiniStat({ icon: Icon, label, value, note, tone }: { icon: LucideIcon; label: string; value: string; note?: string; tone?: Tone }) {
  return (
    <div className="min-w-0 rounded-lg border border-border bg-surface-2/60 px-3 py-2">
      <p className="flex items-center gap-1.5 text-[11px] font-medium tracking-wide text-muted uppercase">
        <Icon className="size-3.5 text-accent" />
        {label}
      </p>
      <p
        className={clsx(
          'mt-0.5 text-[15px] font-semibold tabular-nums',
          tone === 'danger' ? 'text-danger' : tone === 'warn' ? 'text-warn' : 'text-text'
        )}
      >
        {value}
      </p>
      <p className="truncate text-[11.5px] text-faint" title={note}>
        {note ?? ' '}
      </p>
    </div>
  )
}

function fanNote(s: LiveStats | null | undefined): string | undefined {
  if (s?.gpuFanPercent === undefined) return 'não informada pelo driver'
  if (s.gpuFanPercent === 0) return (s.gpuTempC ?? 0) < 60 ? 'parada em repouso (normal)' : 'parada'
  if (s.gpuFanPercent >= 90) return 'no máximo'
  return 'girando'
}

function powerNote(s: LiveStats | null | undefined, g?: GpuInfo | null): string | undefined {
  const limit = s?.gpuPowerLimitW ?? g?.nvidia?.powerLimitW
  return limit ? `de ${fmtW(limit)} permitidos` : undefined
}

function clockNote(s: LiveStats | null | undefined, g?: GpuInfo | null): string | undefined {
  const max = g?.nvidia?.maxClockMhz
  if (!s?.gpuClockMhz) return max ? `máximo ${fmtMhz(max)}` : undefined
  if (max && s.gpuClockMhz < max * 0.3) return 'repouso (economia, normal)'
  return max ? `de ${fmtMhz(max)} no máximo` : undefined
}

/** Card "Temperatura da placa de vídeo" (monitor ao vivo). */
export function GpuTempCard({ history, gpu }: { history: LiveStats[]; gpu?: GpuInfo | null }) {
  const latest = [...history].reverse().find((s) => s.gpuTempC !== undefined) ?? null
  const th = gpuThresholds(gpu)
  const lvl = latest?.gpuTempC !== undefined ? TEMP_LEVEL_LABEL[tempLevel(latest.gpuTempC, th)] : null
  return (
    <Card
      icon={Thermometer}
      title="Temperatura da placa de vídeo"
      subtitle={`${shortName(gpu)} — alvo ${th.hotC} °C, máximo ${th.maxC} °C`}
      actions={
        <>
          <LiveTag waiting={!latest} />
          {lvl && <Badge tone={lvl.tone}>{`${fmtTemp(latest?.gpuTempC)} · ${lvl.label}`}</Badge>}
        </>
      }
    >
      <LiveArea
        history={history}
        series={S_TEMP}
        format={fmtTemp}
        axisFormat={tempAxis}
        yMax={100}
        refLines={[{ y: th.hotC, label: `alvo ${th.hotC} °C`, color: WARN }]}
      />
      <div className="mt-3 grid grid-cols-2 gap-2.5">
        <MiniStat icon={Fan} label="Ventoinha" value={latest?.gpuFanPercent !== undefined ? `${latest.gpuFanPercent}%` : '—'} note={fanNote(latest)} />
        <MiniStat icon={Zap} label="Consumo" value={fmtW(latest?.gpuPowerW)} note={powerNote(latest, gpu)} />
      </div>
    </Card>
  )
}

/** Card "Clock da placa de vídeo" (monitor ao vivo). */
export function GpuClockCard({ history, gpu }: { history: LiveStats[]; gpu?: GpuInfo | null }) {
  const latest = [...history].reverse().find((s) => s.gpuClockMhz !== undefined || s.gpuThrottleFlags !== undefined) ?? null
  const status = throttleStatus(latest)
  const max = gpu?.nvidia?.maxClockMhz
  return (
    <Card
      icon={Gauge}
      title="Clock da placa de vídeo"
      subtitle={max ? `Máximo ${fmtMhz(max)} · em repouso fica baixo (economia)` : 'Em repouso fica baixo (economia)'}
      actions={<LiveTag waiting={!latest} />}
    >
      <LiveArea history={history} series={S_CLOCK} format={(v) => fmtMhz(v)} axisFormat={clockAxis} yMax={clockTop(history, gpu)} />
      <div className="mt-3 grid grid-cols-2 gap-2.5">
        <MiniStat icon={Gauge} label="Clock agora" value={fmtMhz(latest?.gpuClockMhz)} note={clockNote(latest, gpu)} />
        <MiniStat
          icon={Zap}
          label="Limitação de clock"
          value={status?.label ?? '—'}
          note={status?.detail}
          tone={status?.tone === 'danger' ? 'danger' : undefined}
        />
      </div>
    </Card>
  )
}

/** Sensores da placa NVIDIA + destaques ao vivo, para o card da GPU (aba Vídeo). */
export function GpuSensorsPanel({ history, gpu }: { history: LiveStats[]; gpu?: GpuInfo | null }) {
  const latest = [...history].reverse().find((s) => s.gpuTempC !== undefined || s.gpuClockMhz !== undefined) ?? null
  const th = gpuThresholds(gpu)
  const lvl = latest?.gpuTempC !== undefined ? tempLevel(latest.gpuTempC, th) : null
  const status = throttleStatus(latest)
  const insights = gpuLiveInsights(history, gpu)
  return (
    <>
      <SubTitle right={<LiveTag waiting={!latest} />}>Sensores agora (driver NVIDIA)</SubTitle>
      <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        <MiniStat
          icon={Thermometer}
          label="Temperatura"
          value={fmtTemp(latest?.gpuTempC)}
          note={lvl ? `${TEMP_LEVEL_LABEL[lvl].label} · alvo ${th.hotC} °C` : `alvo ${th.hotC} °C`}
          tone={lvl === 'critical' ? 'danger' : lvl === 'hot' ? 'warn' : undefined}
        />
        <MiniStat icon={Gauge} label="Clock" value={fmtMhz(latest?.gpuClockMhz)} note={clockNote(latest, gpu)} />
        <MiniStat icon={Zap} label="Consumo" value={fmtW(latest?.gpuPowerW)} note={powerNote(latest, gpu)} />
        <MiniStat icon={Fan} label="Ventoinha" value={latest?.gpuFanPercent !== undefined ? `${latest.gpuFanPercent}%` : '—'} note={fanNote(latest)} />
      </div>
      {status && (
        <p className="mt-2 text-[12.5px] text-muted">
          Limitação de clock agora:{' '}
          <span className={clsx('font-medium', status.tone === 'danger' ? 'text-danger' : status.tone === 'ok' ? 'text-ok' : 'text-text')}>{status.label}</span>
          {' — '}
          {status.detail}
        </p>
      )}
      {insights.length > 0 && (
        <ul className="mt-3 grid gap-2">
          {insights.map((i) => (
            <InsightRow key={i.id} insight={i} />
          ))}
        </ul>
      )}
    </>
  )
}
