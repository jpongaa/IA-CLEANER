// Comparação Antes x Depois (tabela completa no fim do fluxo e versão compacta para o card do Painel).
import clsx from 'clsx'
import { ArrowDown, ArrowUp, Equal, RotateCcw } from 'lucide-react'
import type { SpeedMeasurement } from '@shared/types/performance'
import { formatDate } from '@shared/format'
import { Badge } from '../../ui'
import { compareMeasurements, formatDelta, formatMetric, formatPct, summarizeRows, type MetricRow } from './logic'

const VERDICT_CLS: Record<MetricRow['verdict'], string> = {
  better: 'text-ok',
  worse: 'text-danger',
  same: 'text-muted',
  na: 'text-faint'
}

function ChangeCell({ row }: { row: MetricRow }) {
  if (row.before === null || row.after === null) {
    return <span className="text-faint">{row.afterRestart ? 'depois de reiniciar' : 'sem dado'}</span>
  }
  if (row.verdict === 'same') {
    return (
      <span className="inline-flex items-center gap-1 text-muted" title="Diferença dentro da variação normal da medição">
        <Equal className="size-3.5" /> igual
      </span>
    )
  }
  const up = row.after > row.before
  const Icon = up ? ArrowUp : ArrowDown
  return (
    <span className={clsx('inline-flex items-center gap-1 font-medium tabular-nums', VERDICT_CLS[row.verdict])}>
      <Icon className="size-3.5" strokeWidth={2.5} />
      {formatDelta(row)}
      {row.pct !== null && <span className="text-[11px] font-normal opacity-80">({formatPct(row.pct)})</span>}
    </span>
  )
}

const WIN_LABEL: Record<string, string> = { score: 'Nota', ram: 'RAM parada', startup: 'Inicialização', free: 'Espaço livre', boot: 'Boot' }

function stamp(m?: SpeedMeasurement | null): string {
  return m ? formatDate(m.takenAt, true) : '—'
}

export function CompareTable({
  before,
  after,
  approx,
  testId
}: {
  before?: SpeedMeasurement | null
  after?: SpeedMeasurement | null
  approx?: boolean
  testId?: string
}) {
  const rows = compareMeasurements(before, after)
  const sum = summarizeRows(rows)
  const ramTotal = after?.ramTotalBytes || before?.ramTotalBytes
  const wins = rows.filter((r) => r.verdict === 'better' && ['score', 'ram', 'startup', 'free', 'boot'].includes(r.id))
  return (
    <div data-testid={testId}>
      {wins.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-2" data-testid="boost-wins">
          {wins.map((r) => (
            <span key={r.id} className="inline-flex items-center gap-1.5 rounded-lg border border-ok/30 bg-ok/10 px-2.5 py-1.5 text-[12px]">
              <span className="text-muted">{WIN_LABEL[r.id] ?? r.label}</span>
              <b className="text-ok tabular-nums">{formatDelta(r)}</b>
            </span>
          ))}
        </div>
      )}
      <div className="mb-2 flex flex-wrap items-center gap-2 text-[12px] text-muted">
        <span>
          Antes: <b className="font-medium text-text">{stamp(before)}</b>
        </span>
        <span className="text-faint">·</span>
        <span>
          Depois: <b className="font-medium text-text">{stamp(after)}</b>
        </span>
        {approx && (
          <Badge tone="neutral" className="ml-auto">
            Medição aproximada
          </Badge>
        )}
      </div>
      <div className="overflow-hidden rounded-xl border border-border">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="bg-surface-2 text-left text-[11px] tracking-wide text-muted uppercase">
              <th className="px-3 py-2 font-semibold">O que medimos</th>
              <th className="px-3 py-2 text-right font-semibold">Antes</th>
              <th className="px-3 py-2 text-right font-semibold">Depois</th>
              <th className="px-3 py-2 text-right font-semibold">Mudança</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-border/60" data-metric={r.id} data-verdict={r.verdict}>
                <td className="px-3 py-2">
                  <p className="font-medium">{approx && r.id === 'ram' ? 'RAM em uso (no momento do diagnóstico)' : r.label}</p>
                  {r.hint && <p className="text-[11px] text-faint">{r.hint}</p>}
                </td>
                <td className="px-3 py-2 text-right whitespace-nowrap text-muted tabular-nums">{formatMetric(r.kind, r.before, r.id === 'ram' ? ramTotal : undefined)}</td>
                <td className="px-3 py-2 text-right font-medium whitespace-nowrap tabular-nums">{formatMetric(r.kind, r.after, r.id === 'ram' ? ramTotal : undefined)}</td>
                <td className="px-3 py-2 text-right whitespace-nowrap">
                  <ChangeCell row={r} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > 0 && (
        <p className="mt-2 text-[12px] text-muted">
          <b className="text-ok">{sum.better}</b> {sum.better === 1 ? 'melhorou' : 'melhoraram'} · <b className="text-text">{sum.same}</b>{' '}
          {sum.same === 1 ? 'ficou igual' : 'ficaram iguais'}
          {sum.worse > 0 && (
            <>
              {' '}
              · <b className="text-danger">{sum.worse}</b> {sum.worse === 1 ? 'piorou' : 'pioraram'}
            </>
          )}
          . “Igual” = diferença dentro da variação normal da medição.
        </p>
      )}
      {(before?.notes?.length || after?.notes?.length) && (
        <ul className="mt-1.5 space-y-0.5 text-[11px] text-faint">
          {[...new Set([...(before?.notes ?? []), ...(after?.notes ?? [])])].map((n) => (
            <li key={n}>• {n}</li>
          ))}
        </ul>
      )}
    </div>
  )
}

const COMPACT_ORDER = ['score', 'ram', 'startup', 'free', 'services', 'processes', 'read', 'boot']

/** Versão compacta (card do Painel): só as métricas principais, com seta e %. */
export function CompareTiles({ before, after, max = 6 }: { before: SpeedMeasurement; after: SpeedMeasurement; max?: number }) {
  const rows = compareMeasurements(before, after)
    .filter((r) => r.before !== null && r.after !== null)
    .sort((a, b) => COMPACT_ORDER.indexOf(a.id) - COMPACT_ORDER.indexOf(b.id))
    .filter((r) => COMPACT_ORDER.includes(r.id))
    .slice(0, max)
  if (rows.length === 0) return <p className="text-[13px] text-muted">As duas medições não têm dados em comum para comparar.</p>
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(170px,1fr))] gap-2.5">
      {rows.map((r) => {
        const Icon = r.verdict === 'same' ? Equal : (r.after ?? 0) > (r.before ?? 0) ? ArrowUp : ArrowDown
        return (
          <div key={r.id} className="min-w-0 rounded-lg border border-border bg-surface-2/50 p-2.5" data-metric={r.id} data-verdict={r.verdict}>
            <p className="truncate text-[11px] font-medium text-muted" title={r.label}>
              {r.label}
            </p>
            <p className="mt-1 truncate text-[12px] text-faint tabular-nums">
              {formatMetric(r.kind, r.before)} → <span className="font-semibold text-text">{formatMetric(r.kind, r.after)}</span>
            </p>
            <p className={clsx('mt-0.5 flex items-center gap-1 text-[12px] font-semibold tabular-nums', VERDICT_CLS[r.verdict])}>
              <Icon className="size-3.5" strokeWidth={2.5} />
              {r.verdict === 'same' ? 'igual' : `${formatDelta(r)} ${r.pct !== null ? `(${formatPct(r.pct)})` : ''}`}
              {r.afterRestart && <RotateCcw className="ml-auto size-3 text-faint" aria-label="Depende de reiniciar" />}
            </p>
          </div>
        )
      })}
    </div>
  )
}
