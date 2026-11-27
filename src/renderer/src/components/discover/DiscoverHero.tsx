// Topo da Busca Profunda: o que a busca procura, botão "Fazer busca" + "Busca completa", progresso e o total que dá
// para liberar (quando já existe um resultado).
import clsx from 'clsx'
import { ScanSearch, Search, ShieldCheck, TriangleAlert, X } from 'lucide-react'
import type { TaskProgress } from '@shared/types/common'
import type { DiscoverReport } from '@shared/types/discover'
import { formatBytes, formatDuration, formatRelative, getFormatLocale } from '@shared/format'
import { Button, ProgressBar, Toggle } from '../ui'
import { SEARCH_SCOPE } from './meta'
import type { DiscoverSummary } from './logic'

function scannedText(iso: string): string {
  const rel = formatRelative(iso)
  if (rel === 'hoje') return `hoje às ${new Date(iso).toLocaleTimeString(getFormatLocale(), { hour: '2-digit', minute: '2-digit' })}`
  return rel
}

export function DiscoverHero({
  report,
  summary,
  scanning,
  progress,
  deep,
  onDeep,
  onScan,
  onCancel
}: {
  report: DiscoverReport | null
  summary: DiscoverSummary
  scanning: boolean
  progress: TaskProgress | null
  deep: boolean
  onDeep: (v: boolean) => void
  onScan: () => void
  onCancel: () => void
}) {
  const safePct = summary.freeableBytes > 0 ? (summary.safeBytes / summary.freeableBytes) * 100 : 0
  return (
    <section className="ai-glow relative overflow-hidden rounded-2xl p-6" data-testid="discover-hero">
      <div className="pointer-events-none absolute -top-24 -right-24 size-72 rounded-full bg-accent/10 blur-3xl" />
      <div className="relative flex flex-wrap items-start justify-between gap-6">
        <div className="min-w-0 flex-1 basis-[420px]">
          {report ? (
            <>
              <p className="text-[12px] font-semibold tracking-wider text-muted uppercase">Total que dá para liberar</p>
              <p className="mt-1 text-[44px] leading-none font-semibold tracking-tight tabular-nums" data-testid="discover-total">
                {formatBytes(summary.freeableBytes)}
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1 text-[13px]">
                <span className="flex items-center gap-1.5">
                  <span className="size-2.5 rounded-full bg-ok" />
                  <b className="tabular-nums">{formatBytes(summary.safeBytes)}</b>
                  <span className="text-muted">pode apagar</span>
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="size-2.5 rounded-full bg-warn" />
                  <b className="tabular-nums">{formatBytes(summary.reviewBytes)}</b>
                  <span className="text-muted">revisar antes</span>
                </span>
                {summary.keepCount > 0 && (
                  <span className="flex items-center gap-1.5">
                    <span className="size-2.5 rounded-full bg-danger" />
                    <b className="tabular-nums">{summary.keepCount}</b>
                    <span className="text-muted">para manter</span>
                  </span>
                )}
              </div>
              <div className="mt-3 flex h-2.5 w-full max-w-xl overflow-hidden rounded-full bg-surface-3">
                <div className="h-full bg-ok transition-[width] duration-700" style={{ width: `${safePct}%` }} />
                <div className="h-full bg-warn transition-[width] duration-700" style={{ width: `${summary.freeableBytes > 0 ? 100 - safePct : 0}%` }} />
              </div>
              <p className="mt-3 text-[12px] text-faint">
                {summary.count} {summary.count === 1 ? 'achado' : 'achados'} · {report.deep ? 'busca completa' : 'busca'} feita {scannedText(report.scannedAt)}
                {report.durationMs ? ` · levou ${formatDuration(report.durationMs)}` : ''}
              </p>
            </>
          ) : (
            <>
              <p className="flex items-center gap-2 text-[12px] font-semibold tracking-wider text-accent uppercase">
                <ScanSearch className="size-3.5" /> Busca profunda
              </p>
              <p className="mt-2 text-[24px] leading-tight font-semibold">Ache o que ficou perdido no seu PC</p>
              <p className="mt-2 max-w-2xl text-[13px] text-muted">
                Jogos e programas baixados e esquecidos, instaladores que você nem lembra, restos de programas que já foram embora e programas ruins que
                não têm como desinstalar. A busca <b className="text-text">só lê</b>: nada é apagado sem a sua confirmação.
              </p>
            </>
          )}
        </div>

        <div className="flex w-[290px] shrink-0 flex-col items-stretch gap-3">
          <Button variant="primary" size="lg" icon={Search} onClick={onScan} loading={scanning} data-testid="discover-scan">
            {report ? 'Fazer busca de novo' : 'Fazer busca'}
          </Button>
          <div className="rounded-lg border border-border bg-surface-2/60 px-3 py-2" data-testid="discover-deep">
            <Toggle
              checked={deep}
              onChange={onDeep}
              disabled={scanning}
              label="Busca completa (mais demorada)"
              description="Procura também nos outros discos e em mais pastas. Pode levar alguns minutos."
            />
          </div>
          <span className="flex items-center gap-1.5 text-[12px] text-faint">
            <ShieldCheck className="size-3.5 shrink-0 text-ok" /> Só lê. Antes de qualquer ação, confere tudo de novo
          </span>
        </div>
      </div>

      {/* O que a busca procura */}
      {report ? (
        <div className="relative mt-5 flex flex-wrap items-center gap-1.5 text-[12px]">
          <span className="mr-1 text-faint">Procura por:</span>
          {SEARCH_SCOPE.map((s) => (
            <span key={s.title} title={s.text} className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface-2/70 px-2 py-1 text-muted">
              <s.icon className="size-3.5 text-accent" />
              {s.title}
            </span>
          ))}
        </div>
      ) : (
        <div className="relative mt-5 grid gap-2 sm:grid-cols-2 xl:grid-cols-4" data-testid="discover-scope">
          {SEARCH_SCOPE.map((s) => (
            <div key={s.title} className="flex items-start gap-2.5 rounded-xl border border-border bg-surface-2/60 p-3">
              <s.icon className="mt-0.5 size-4 shrink-0 text-accent" />
              <div className="min-w-0">
                <p className="text-[13px] font-medium">{s.title}</p>
                <p className="mt-0.5 text-[12px] leading-snug text-muted">{s.text}</p>
              </div>
            </div>
          ))}
        </div>
      )}

      {scanning && (
        <div className="relative mt-5 rounded-xl border border-border bg-surface-2/70 p-4" data-testid="discover-progress">
          <div className="mb-2 flex items-center justify-between gap-4 text-[13px]">
            <span className="truncate text-text">{progress?.message ?? 'Preparando a busca...'}</span>
            <div className="flex shrink-0 items-center gap-3">
              {progress?.total ? (
                <span className="text-faint tabular-nums">
                  {progress.current ?? 0}/{progress.total}
                </span>
              ) : null}
              <Button size="sm" variant="ghost" icon={X} onClick={onCancel} data-testid="discover-cancel">
                Cancelar
              </Button>
            </div>
          </div>
          <ProgressBar value={progress?.percent} indeterminate={progress?.percent === undefined} />
          <p className="mt-2 text-[12px] text-faint">Pode continuar usando o app: a busca segue em segundo plano, mesmo se trocar de página.</p>
        </div>
      )}

      {report?.cancelled && !scanning && (
        <p className={clsx('relative mt-4 flex items-center gap-2 rounded-lg border border-warn/30 bg-warn/10 px-3 py-2 text-[12.5px]')} data-testid="discover-partial">
          <TriangleAlert className="size-4 shrink-0 text-warn" />A última busca foi interrompida antes do fim: o resultado abaixo é parcial.
        </p>
      )}
    </section>
  )
}
