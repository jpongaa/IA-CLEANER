// "Principais motivos da lentidão": achados ordenados por severidade, com evidências, ações e passos manuais.
import clsx from 'clsx'
import { useState } from 'react'
import { ArrowRight, Check, ChevronDown, CircleCheck, ListChecks, Wand2 } from 'lucide-react'
import type { OptimizationAction, PerfFinding } from '@shared/types/performance'
import type { Severity } from '@shared/types/common'
import { Badge, Button, SeverityBadge } from '../ui'
import { CATEGORY, EVIDENCE_LABEL } from './labels'

const BAR: Record<Severity, string> = {
  critical: 'bg-danger',
  high: 'bg-danger/70',
  medium: 'bg-warn',
  low: 'bg-info',
  info: 'bg-ok'
}

export interface FindingHandlers {
  actions: OptimizationAction[]
  onAction: (a: OptimizationAction) => void
  onShowStartup?: (ids: string[]) => void
  runningId?: string | null
}

export function FindingCard({ f, handlers, defaultOpen }: { f: PerfFinding; handlers: FindingHandlers; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(Boolean(defaultOpen))
  const cat = CATEGORY[f.category] ?? CATEGORY.system
  const actions = (f.actionIds ?? [])
    .map((id) => handlers.actions.find((a) => a.id === id))
    .filter((a): a is OptimizationAction => Boolean(a))
  const evidence = Object.entries(f.evidence ?? {}).filter(([, v]) => v !== '' && v !== undefined && v !== null)
  return (
    <article className="relative overflow-hidden rounded-xl border border-border bg-surface">
      <span className={clsx('absolute inset-y-0 left-0 w-1', BAR[f.severity])} />
      <div className="py-3.5 pr-4 pl-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <SeverityBadge severity={f.severity} />
              <Badge icon={cat.icon}>{cat.label}</Badge>
            </div>
            <h4 className="mt-1.5 text-[15px] leading-snug font-semibold">{f.title}</h4>
          </div>
        </div>
        <p className="selectable mt-1.5 text-[13px] leading-relaxed text-muted">{f.detail}</p>

        {evidence.length > 0 && (
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {evidence.map(([k, v]) => (
              <span key={k} className="selectable max-w-full truncate rounded-md border border-border bg-surface-2 px-2 py-0.5 text-[12px]" title={`${k}: ${v}`}>
                <span className="text-faint">{EVIDENCE_LABEL[k] ?? k}:</span> <span className="text-text">{typeof v === 'boolean' ? (v ? 'sim' : 'não') : String(v)}</span>
              </span>
            ))}
          </div>
        )}

        {(actions.length > 0 || (f.startupIds?.length && handlers.onShowStartup) || f.manualSteps?.length) && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {actions.map((a) =>
              a.state === 'applied' && !a.longRunning ? (
                <Badge key={a.id} tone="ok" icon={Check} className="h-8 px-2.5 text-[12px]">
                  {a.title}: aplicado
                </Badge>
              ) : (
                <Button
                  key={a.id}
                  size="sm"
                  variant="primary"
                  icon={Wand2}
                  loading={handlers.runningId === a.id}
                  disabled={a.state === 'notApplicable'}
                  title={a.description}
                  onClick={() => handlers.onAction(a)}
                >
                  {a.title}
                </Button>
              )
            )}
            {f.startupIds?.length && handlers.onShowStartup ? (
              <Button size="sm" icon={ArrowRight} onClick={() => handlers.onShowStartup?.(f.startupIds ?? [])}>
                Ver na Inicialização
              </Button>
            ) : null}
            {f.manualSteps?.length ? (
              <Button size="sm" variant="ghost" icon={ListChecks} onClick={() => setOpen((o) => !o)}>
                {open ? 'Esconder passo a passo' : 'Como resolver (passo a passo)'}
                <ChevronDown className={clsx('size-3.5 transition-transform', open && 'rotate-180')} />
              </Button>
            ) : null}
          </div>
        )}

        {open && f.manualSteps?.length ? (
          <ol className="mt-3 list-decimal space-y-1.5 rounded-lg border border-border bg-surface-2 py-3 pr-3 pl-8 text-[13px]">
            {f.manualSteps.map((s, i) => (
              <li key={i} className="selectable pl-1">
                {s}
              </li>
            ))}
          </ol>
        ) : null}
      </div>
    </article>
  )
}

export function FindingList({ findings, handlers }: { findings: PerfFinding[]; handlers: FindingHandlers }) {
  return (
    <div className="space-y-2.5">
      {findings.map((f, i) => (
        <FindingCard key={f.id} f={f} handlers={handlers} defaultOpen={i === 0 && f.severity === 'critical'} />
      ))}
    </div>
  )
}

/** Lista compacta do que foi verificado e está OK (achados 'info'). */
export function OkList({ findings }: { findings: PerfFinding[] }) {
  if (!findings.length) return null
  return (
    <div className="grid grid-cols-2 gap-x-6 gap-y-2 xl:grid-cols-3">
      {findings.map((f) => (
        <div key={f.id} className="flex items-start gap-2 text-[13px]" title={f.detail}>
          <CircleCheck className="mt-0.5 size-4 shrink-0 text-ok" />
          <span className="text-text">{f.title}</span>
        </div>
      ))}
    </div>
  )
}
