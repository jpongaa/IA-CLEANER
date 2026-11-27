// Peças visuais reutilizadas pelas abas da página Hardware.
import clsx from 'clsx'
import { useState, type ReactNode } from 'react'
import { CheckCircle2, ChevronDown, ChevronUp, CircleAlert, Info, Lightbulb, TriangleAlert, type LucideIcon } from 'lucide-react'
import type { HardwareInsight, LiveStats } from '@shared/types/hardware'
import { Badge, ProgressBar, SeverityBadge, type Tone } from '../ui'

/** Rótulo pequeno "ao vivo" com ponto pulsante. */
export function LiveTag({ waiting, unavailable }: { waiting?: boolean; unavailable?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold tracking-wide text-muted uppercase">
      <span className={clsx('size-1.5 rounded-full', unavailable ? 'bg-warn' : waiting ? 'bg-faint' : 'animate-pulse bg-ok')} />
      {unavailable ? 'indisponível' : waiting ? 'iniciando' : 'ao vivo'}
    </span>
  )
}

/** Etiqueta "ao vivo" para dados de disco/rede/GPU (que dependem do coletor PowerShell). */
export function ExtLiveTag({ latest }: { latest: LiveStats | null }) {
  return <LiveTag waiting={!latest?.extendedAvailable && !latest?.collectorError} unavailable={Boolean(latest?.collectorError)} />
}

/** Caixa de explicação curta (o usuário quer entender o porquê). */
export function Hint({ children, icon: Icon = Info, tone = 'info', className }: { children: ReactNode; icon?: LucideIcon; tone?: Tone; className?: string }) {
  return (
    <div
      className={clsx(
        'flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-[12.5px] leading-relaxed text-muted',
        tone === 'warn' ? 'border-warn/30 bg-warn/5' : tone === 'ok' ? 'border-ok/30 bg-ok/5' : 'border-border bg-surface-2/60',
        className
      )}
    >
      <Icon className={clsx('mt-0.5 size-4 shrink-0', tone === 'warn' ? 'text-warn' : tone === 'ok' ? 'text-ok' : 'text-info')} />
      <div className="min-w-0">{children}</div>
    </div>
  )
}

/** Chips (ex.: conjuntos de instruções). */
export function Chips({ items, empty = '—' }: { items: string[]; empty?: string }) {
  if (!items.length) return <span className="text-[13px] text-faint">{empty}</span>
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((i) => (
        <span key={i} className="rounded-md border border-border bg-surface-2 px-2 py-0.5 font-mono text-[11.5px] text-text">
          {i}
        </span>
      ))}
    </div>
  )
}

/** Barra de uso com rótulo e valores. */
export function UsageBar({ label, value, detail, tone, className }: { label: ReactNode; value: number; detail?: ReactNode; tone?: Tone; className?: string }) {
  const t: Tone = tone ?? (value >= 90 ? 'danger' : value >= 75 ? 'warn' : 'accent')
  return (
    <div className={className}>
      <div className="mb-1 flex items-baseline justify-between gap-3 text-[12.5px]">
        <span className="min-w-0 truncate text-muted">{label}</span>
        <span className="shrink-0 font-medium text-text tabular-nums">{detail ?? `${Math.round(value)}%`}</span>
      </div>
      <ProgressBar value={value} tone={t} size="sm" />
    </div>
  )
}

/** Título de grupo dentro de um card. */
export function SubTitle({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="mt-4 mb-2 flex items-center justify-between first:mt-0">
      <h4 className="text-[12px] font-semibold tracking-wide text-muted uppercase">{children}</h4>
      {right}
    </div>
  )
}

const SEV_ICON: Record<HardwareInsight['severity'], LucideIcon> = {
  critical: CircleAlert,
  high: CircleAlert,
  medium: TriangleAlert,
  low: Lightbulb,
  info: CheckCircle2
}
const SEV_COLOR: Record<HardwareInsight['severity'], string> = {
  critical: 'text-danger',
  high: 'text-danger',
  medium: 'text-warn',
  low: 'text-info',
  info: 'text-ok'
}

export function InsightRow({ insight }: { insight: HardwareInsight }) {
  const Icon = SEV_ICON[insight.severity]
  return (
    <li className="flex items-start gap-3 rounded-lg border border-border bg-surface-2/60 px-3 py-2.5">
      <Icon className={clsx('mt-0.5 size-4 shrink-0', SEV_COLOR[insight.severity])} />
      <div className="min-w-0 flex-1">
        <p className="text-[13px] leading-snug font-medium text-text">
          {insight.title} <SeverityBadge severity={insight.severity} />
        </p>
        <p className="mt-1 text-[12px] leading-relaxed text-muted">{insight.detail}</p>
        {insight.tip && (
          <p className="mt-1 text-[12px] leading-relaxed text-text/85">
            <span className="font-semibold text-accent">O que fazer: </span>
            {insight.tip}
          </p>
        )}
      </div>
    </li>
  )
}

/** Destaques: problemas em linhas; pontos positivos agrupados em chips. */
export function InsightsPanel({ insights, onAreaClick }: { insights: HardwareInsight[]; onAreaClick?: (area: HardwareInsight['area']) => void }) {
  const issues = insights.filter((i) => i.severity !== 'info')
  const good = insights.filter((i) => i.severity === 'info')
  const [expanded, setExpanded] = useState(issues.length <= 3)
  const shown = expanded ? issues : issues.slice(0, 3)
  const cols = shown.length >= 3 ? 'md:grid-cols-2 xl:grid-cols-3' : shown.length === 2 ? 'md:grid-cols-2' : ''
  return (
    <div className="space-y-2">
      {issues.length === 0 && (
        <p className="flex items-center gap-2 text-[13px] text-muted">
          <CheckCircle2 className="size-4 text-ok" /> Nenhum problema encontrado nas peças.
        </p>
      )}
      {shown.length > 0 && (
        <ul className={clsx('grid gap-2', cols)}>
          {shown.map((i) => (
            <InsightRow key={i.id} insight={i} />
          ))}
        </ul>
      )}
      {issues.length > 3 && (
        <button onClick={() => setExpanded((v) => !v)} className="flex items-center gap-1 text-[12.5px] font-medium text-accent hover:underline">
          {expanded ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
          {expanded ? 'Mostrar menos' : `Ver todos os ${issues.length} destaques`}
        </button>
      )}
      {good.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 pt-1">
          <span className="text-[12px] text-faint">Está tudo certo com:</span>
          {good.map((g) => (
            <button key={g.id} title={g.detail} onClick={() => onAreaClick?.(g.area)} className="cursor-pointer">
              <Badge tone="ok" icon={CheckCircle2}>
                {g.title}
              </Badge>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
