// Topo da página: total recuperável, divisão seguro/revisar, botão de análise e progresso.
import clsx from 'clsx'
import { Flame, Search, ShieldCheck, Sparkles, X } from 'lucide-react'
import type { CleanupEstimate } from '@shared/types/cleanup'
import type { TaskProgress } from '@shared/types/common'
import { formatBytes, formatDuration, formatRelative, getFormatLocale } from '@shared/format'
import { Button, ProgressBar } from '../ui'

export function CleanupHero({
  estimate,
  estimating,
  progress,
  onEstimate,
  onCancel,
  systemDriveFree
}: {
  estimate: CleanupEstimate | null
  estimating: boolean
  progress: TaskProgress | null
  onEstimate: () => void
  onCancel: () => void
  /** % livre do disco do sistema (quando conhecido) */
  systemDriveFree?: { letter: string; percent: number; freeBytes: number } | null
}) {
  // Itens da Busca extrema ficam fora do número principal (são revisados um a um, na seção própria).
  const xs = (estimate?.targets ?? []).filter((t) => t.extreme && t.verdict !== 'keep')
  const extremeBytes = xs.reduce((s, t) => s + t.bytes, 0)
  const extremeSafe = xs.filter((t) => t.verdict === 'safe').reduce((s, t) => s + t.bytes, 0)
  const totalBytes = estimate ? Math.max(0, estimate.totalBytes - extremeBytes) : 0
  const safeBytes = estimate ? Math.max(0, estimate.safeBytes - extremeSafe) : 0
  const reviewBytes = Math.max(0, totalBytes - safeBytes)
  const safePct = totalBytes > 0 ? (safeBytes / totalBytes) * 100 : 0

  return (
    <section className="ai-glow relative overflow-hidden rounded-2xl p-6">
      <div className="pointer-events-none absolute -top-24 -right-24 size-72 rounded-full bg-accent/10 blur-3xl" />
      <div className="relative flex flex-wrap items-start justify-between gap-6">
        <div className="min-w-0 flex-1">
          {estimate ? (
            <>
              <p className="text-[12px] font-semibold tracking-wider text-muted uppercase">Total que pode ser liberado</p>
              <p className="mt-1 text-[44px] leading-none font-semibold tracking-tight tabular-nums" data-testid="cleanup-total">
                {formatBytes(totalBytes)}
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1 text-[13px]">
                <span className="flex items-center gap-1.5">
                  <span className="size-2.5 rounded-full bg-ok" />
                  <b className="tabular-nums">{formatBytes(safeBytes)}</b>
                  <span className="text-muted">seguros para apagar</span>
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="size-2.5 rounded-full bg-warn" />
                  <b className="tabular-nums">{formatBytes(reviewBytes)}</b>
                  <span className="text-muted">para revisar antes</span>
                </span>
                {xs.length > 0 && (
                  <span className="flex items-center gap-1.5" data-testid="cleanup-extreme-total">
                    <Flame className="size-3.5 text-warn" />
                    <span className="text-muted">+</span>
                    <b className="tabular-nums">{formatBytes(extremeBytes)}</b>
                    <span className="text-muted">em itens pesados (Busca extrema)</span>
                  </span>
                )}
              </div>
              <div className="mt-3 flex h-2.5 w-full max-w-xl overflow-hidden rounded-full bg-surface-3">
                <div className="h-full bg-ok transition-[width] duration-700" style={{ width: `${safePct}%` }} />
                <div className="h-full bg-warn transition-[width] duration-700" style={{ width: `${100 - safePct}%` }} />
              </div>
              <p className="mt-3 text-[12px] text-faint">
                Analisado {formatRelative(estimate.scannedAt) === 'hoje' ? `hoje às ${new Date(estimate.scannedAt).toLocaleTimeString(getFormatLocale(), { hour: '2-digit', minute: '2-digit' })}` : formatRelative(estimate.scannedAt)}
                {estimate.durationMs ? ` · levou ${formatDuration(estimate.durationMs)}` : ''}
                {systemDriveFree ? (
                  <>
                    {' · '}
                    <span className={clsx(systemDriveFree.percent < 15 ? 'text-warn' : 'text-faint')}>
                      disco {systemDriveFree.letter} com {systemDriveFree.percent.toFixed(0)}% livre ({formatBytes(systemDriveFree.freeBytes)})
                    </span>
                  </>
                ) : null}
              </p>
            </>
          ) : (
            <>
              <p className="flex items-center gap-2 text-[12px] font-semibold tracking-wider text-accent uppercase">
                <Sparkles className="size-3.5" /> Limpeza inteligente
              </p>
              <p className="mt-2 text-[24px] leading-tight font-semibold">Descubra o que dá para apagar com segurança</p>
              <p className="mt-2 max-w-2xl text-[13px] text-muted">
                O app procura caches, temporários, sobras de instaladores e outros arquivos que só ocupam espaço — e separa o que é seguro do que
                precisa de cuidado. A análise <b className="text-text">só lê</b>: nada é apagado sem a sua confirmação.
              </p>
            </>
          )}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2">
          <Button variant="primary" size="lg" icon={Search} onClick={onEstimate} loading={estimating} data-testid="cleanup-analyze">
            {estimate ? 'Analisar de novo' : 'Analisar o que pode ser limpo'}
          </Button>
          <span className="flex items-center gap-1.5 text-[12px] text-faint">
            <ShieldCheck className="size-3.5 text-ok" /> Windows, programas e documentos são protegidos
          </span>
        </div>
      </div>

      {estimating && (
        <div className="relative mt-5 rounded-xl border border-border bg-surface-2/70 p-4" data-testid="cleanup-progress">
          <div className="mb-2 flex items-center justify-between gap-4 text-[13px]">
            <span className="truncate text-text">{progress?.message ?? 'Preparando a análise...'}</span>
            <div className="flex shrink-0 items-center gap-3">
              {progress?.total ? (
                <span className="text-faint tabular-nums">
                  {progress.current ?? 0}/{progress.total}
                </span>
              ) : null}
              <Button size="sm" variant="ghost" icon={X} onClick={onCancel}>
                Cancelar
              </Button>
            </div>
          </div>
          <ProgressBar value={progress?.percent} indeterminate={progress?.percent === undefined} />
        </div>
      )}
    </section>
  )
}
