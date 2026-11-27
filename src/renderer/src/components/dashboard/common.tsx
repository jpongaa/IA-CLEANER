// Peças visuais pequenas reutilizadas pelos blocos do Painel.
import clsx from 'clsx'
import type { ReactNode } from 'react'
import { Construction } from 'lucide-react'
import { ErrorBox, Skeleton, type Tone } from '../ui'
import { isNotImplemented } from './insights'

const TONE_VAR: Record<Tone, string> = {
  ok: 'var(--color-ok)',
  warn: 'var(--color-warn)',
  danger: 'var(--color-danger)',
  info: 'var(--color-info)',
  accent: 'var(--color-accent)',
  ai: 'var(--color-ai)',
  neutral: 'var(--color-faint)'
}

export function toneVar(t: Tone): string {
  return TONE_VAR[t]
}

/** Anel de pontuação 0..100. */
export function ScoreRing({ score, tone, label, size = 148, stroke = 11 }: { score: number | null; tone: Tone; label: string; size?: number; stroke?: number }) {
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  const v = score ?? 0
  const color = toneVar(tone)
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }} role="img" aria-label={score === null ? 'Saúde do PC: sem dados' : `Saúde do PC: ${score} de 100 (${label})`}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--color-surface-3)" strokeWidth={stroke} />
        {score !== null && (
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke={color}
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={c}
            strokeDashoffset={c * (1 - v / 100)}
            style={{ transition: 'stroke-dashoffset 900ms ease', filter: `drop-shadow(0 0 6px color-mix(in oklab, ${color} 55%, transparent))` }}
          />
        )}
      </svg>
      <div className="absolute inset-0 grid place-items-center text-center">
        <div>
          <p className="leading-none">
            <span className="text-[40px] font-semibold tabular-nums">{score ?? '?'}</span>
            {score !== null && <span className="text-sm text-faint">/100</span>}
          </p>
          <p className="mt-1.5 text-[11px] font-semibold tracking-wider uppercase" style={{ color }}>
            {label}
          </p>
        </div>
      </div>
    </div>
  )
}

/** Erro de um bloco: "em desenvolvimento" discreto ou ErrorBox com tentar de novo. */
export function BlockError({ error, onRetry, what }: { error: string; onRetry?: () => void; what?: string }) {
  if (isNotImplemented(error)) {
    return (
      <div className="flex items-start gap-2.5 rounded-lg border border-border bg-surface-2/60 p-3 text-[13px] text-muted">
        <Construction className="mt-0.5 size-4 shrink-0 text-faint" />
        <span>{what ? `${what}: ainda não disponível nesta versão.` : 'Este recurso ainda não está disponível nesta versão.'}</span>
      </div>
    )
  }
  return <ErrorBox error={what ? `${what}: ${error}` : error} onRetry={onRetry} />
}

export function BlockSkeleton({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <div className={clsx('space-y-2.5', className)}>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} className={clsx('h-4', i === lines - 1 ? 'w-2/3' : 'w-full')} />
      ))}
    </div>
  )
}

/** Barra de uso fina com rótulo à direita (RAM/CPU). */
export function MiniMeter({ label, percent, tone, right }: { label: string; percent: number | null; tone: Tone; right?: ReactNode }) {
  const v = percent === null ? 0 : Math.max(0, Math.min(100, percent))
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between text-[12px]">
        <span className="text-muted">{label}</span>
        <span className="font-medium tabular-nums">{right ?? (percent === null ? '—' : `${Math.round(v)}%`)}</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-3">
        <div className="h-full rounded-full transition-[width] duration-500" style={{ width: `${v}%`, background: toneVar(tone) }} />
      </div>
    </div>
  )
}
