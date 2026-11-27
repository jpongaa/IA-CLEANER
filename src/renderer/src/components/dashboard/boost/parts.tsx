// Peças visuais do "Otimizar tudo": stepper, linha de tarefa com progresso, avisos.
import clsx from 'clsx'
import { useEffect, useState, type ReactNode } from 'react'
import { Check, CircleMinus, Loader2, X, type LucideIcon } from 'lucide-react'
import { formatDuration } from '@shared/format'
import { ProgressBar, type Tone } from '../../ui'
import type { BoostTask, TaskStatus } from './store'

export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [active])
  return now
}

export type StepVisual = TaskStatus | 'current'

export function StatusDot({ status, index, size = 'md' }: { status: StepVisual; index?: number; size?: 'sm' | 'md' }) {
  const base = clsx('grid shrink-0 place-items-center rounded-full border font-semibold', size === 'sm' ? 'size-6 text-[11px]' : 'size-8 text-[13px]')
  const icon = size === 'sm' ? 'size-3.5' : 'size-4'
  switch (status) {
    case 'running':
      return (
        <span className={clsx(base, 'border-accent bg-accent/15 text-accent shadow-[0_0_14px] shadow-accent/40')}>
          <Loader2 className={clsx(icon, 'animate-spin')} />
        </span>
      )
    case 'current':
      return <span className={clsx(base, 'border-ai bg-ai/20 text-ai shadow-[0_0_14px] shadow-ai/40')}>{index !== undefined ? index + 1 : '•'}</span>
    case 'done':
      return (
        <span className={clsx(base, 'border-ok/50 bg-ok/15 text-ok')}>
          <Check className={icon} strokeWidth={3} />
        </span>
      )
    case 'error':
      return (
        <span className={clsx(base, 'border-danger/50 bg-danger/15 text-danger')}>
          <X className={icon} strokeWidth={3} />
        </span>
      )
    case 'skipped':
      return (
        <span className={clsx(base, 'border-border bg-surface-3 text-faint')}>
          <CircleMinus className={icon} />
        </span>
      )
    default:
      return <span className={clsx(base, 'border-border bg-surface-2 text-faint')}>{index !== undefined ? index + 1 : ''}</span>
  }
}

export interface StepperItem {
  id: string
  label: string
  hint: string
  status: StepVisual
}

/** Faixa horizontal com as 5 etapas do fluxo. */
export function Stepper({ steps }: { steps: StepperItem[] }) {
  return (
    <ol className="grid grid-cols-5 gap-x-2" aria-label="Etapas do Otimizar tudo">
      {steps.map((s, i) => (
        <li key={s.id} className="min-w-0" aria-current={s.status === 'current' || s.status === 'running' ? 'step' : undefined}>
          <div className="flex items-center gap-2">
            <StatusDot status={s.status} index={i} />
            {i < steps.length - 1 && (
              <div className="h-0.5 flex-1 overflow-hidden rounded-full bg-surface-3">
                <div
                  className={clsx('h-full rounded-full transition-[width] duration-700', s.status === 'error' ? 'bg-danger/60' : 'bg-accent')}
                  style={{ width: s.status === 'done' || s.status === 'skipped' ? '100%' : s.status === 'running' ? '45%' : '0%' }}
                />
              </div>
            )}
          </div>
          <p className={clsx('mt-1.5 truncate text-[13px] font-medium', s.status === 'pending' && 'text-muted', s.status === 'current' && 'text-ai')}>{s.label}</p>
          <p className="truncate text-[11px] text-faint" title={s.hint}>
            {s.hint}
          </p>
        </li>
      ))}
    </ol>
  )
}

function taskText(t: BoostTask, now: number, pendingText: string): string {
  switch (t.status) {
    case 'running':
      return t.message || `Trabalhando… ${t.startedAt ? formatDuration(now - t.startedAt) : ''}`
    case 'done':
      return t.note || (t.startedAt && t.finishedAt ? `Concluído em ${formatDuration(t.finishedAt - t.startedAt)}` : 'Concluído')
    case 'error':
      return t.error || 'Falhou'
    case 'skipped':
      return t.note || 'Pulado'
    default:
      return pendingText
  }
}

/** Uma tarefa (análise ou aplicação) com ícone, status, mensagem e barra de progresso. */
export function TaskRow({ icon: Icon, title, task, pendingText, testId }: { icon: LucideIcon; title: string; task: BoostTask; pendingText: string; testId?: string }) {
  const now = useNow(task.status === 'running')
  const text = taskText(task, now, pendingText)
  return (
    <li className="flex items-start gap-3 rounded-xl border border-border bg-surface/70 p-3" data-testid={testId} data-status={task.status}>
      <StatusDot status={task.status} size="sm" />
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2 text-[13px] font-medium">
          <Icon className="size-4 shrink-0 text-accent" />
          <span className="truncate">{title}</span>
          {task.status === 'running' && task.startedAt && <span className="ml-auto shrink-0 text-[11px] font-normal text-faint tabular-nums">{formatDuration(now - task.startedAt)}</span>}
        </p>
        <p
          className={clsx(
            'mt-0.5 line-clamp-2 text-[12px]',
            task.status === 'error' ? 'text-danger' : task.status === 'running' ? 'text-accent' : 'text-muted'
          )}
          title={text}
        >
          {text}
        </p>
        {task.status === 'running' && (
          <ProgressBar className="mt-2" size="xs" value={task.percent} indeterminate={task.percent === undefined} tone="accent" />
        )}
      </div>
    </li>
  )
}

const NOTICE_CLS: Partial<Record<Tone, string>> = {
  info: 'border-info/30 bg-info/10 [&>svg]:text-info',
  warn: 'border-warn/30 bg-warn/10 [&>svg]:text-warn',
  danger: 'border-danger/30 bg-danger/10 [&>svg]:text-danger',
  ok: 'border-ok/30 bg-ok/10 [&>svg]:text-ok',
  ai: 'border-ai/30 bg-ai/10 [&>svg]:text-ai',
  neutral: 'border-border bg-surface-2 [&>svg]:text-muted'
}

export function Notice({ tone, icon: Icon, children, className }: { tone: Tone; icon: LucideIcon; children: ReactNode; className?: string }) {
  return (
    <div className={clsx('flex items-start gap-2 rounded-lg border px-3 py-2 text-[12.5px] text-text', NOTICE_CLS[tone], className)}>
      <Icon className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0">{children}</div>
    </div>
  )
}
