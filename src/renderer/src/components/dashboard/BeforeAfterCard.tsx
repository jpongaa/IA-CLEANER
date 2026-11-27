// Card "Antes x Depois": última comparação do "Otimizar tudo" e o histórico de medições.
import { Gauge, Sparkles, TrendingUp } from 'lucide-react'
import type { SpeedMeasurement } from '@shared/types/performance'
import { formatBytes, formatDate } from '@shared/format'
import { Badge, Button, Card } from '../ui'
import { timeAgo } from '../history/meta'
import { BlockError, BlockSkeleton } from './common'
import { CompareTiles } from './boost/CompareView'
import { isAfterLabel, latestComparison, sortMeasurements } from './boost/logic'
import { startBoost } from './boost/store'

function scrollTop(): void {
  try {
    document.querySelector('main')?.scrollTo({ top: 0, behavior: 'smooth' })
  } catch {
    // sem rolagem: segue
  }
}

export function BeforeAfterCard({
  measurements,
  loading,
  error,
  onRetry,
  canStart
}: {
  measurements: SpeedMeasurement[] | null
  loading: boolean
  error: string | null
  onRetry: () => void
  canStart: boolean
}) {
  const list = sortMeasurements(measurements)
  const pair = latestComparison(list)
  const start = (): void => {
    scrollTop()
    void startBoost()
  }
  return (
    <Card
      title="Antes x Depois"
      icon={TrendingUp}
      subtitle="O ganho real das otimizações, medido do mesmo jeito antes e depois."
      actions={
        <Button size="sm" variant="ai" icon={Sparkles} onClick={start} disabled={!canStart}>
          Otimizar tudo
        </Button>
      }
    >
      <div data-testid="before-after-card">
        {loading && !measurements ? (
          <BlockSkeleton lines={3} />
        ) : error && !measurements ? (
          <BlockError error={error} onRetry={onRetry} what="Medições" />
        ) : list.length === 0 ? (
          <p className="text-[13px] text-muted">
            Nenhuma medição ainda. O <b className="text-text">Otimizar tudo</b> mede o PC antes (RAM parada, inicialização, serviços, disco), aplica só o que você
            aprovar e mede de novo no fim — assim você vê o ganho de verdade, sem promessa vazia.
          </p>
        ) : (
          <div className="space-y-3">
            {pair ? (
              <>
                <p className="flex flex-wrap items-center gap-2 text-[12px] text-muted">
                  <span>
                    {pair.after.label || 'Depois'} <b className="text-text">{timeAgo(pair.after.takenAt)}</b> · comparado com {pair.before.label?.toLowerCase() || 'a medição anterior'} de{' '}
                    {formatDate(pair.before.takenAt, true)}
                  </span>
                  {/reinici/i.test(pair.after.label ?? '') && <Badge tone="ok">Depois de reiniciar</Badge>}
                </p>
                <CompareTiles before={pair.before} after={pair.after} />
              </>
            ) : (
              <p className="flex items-center gap-2 text-[13px] text-muted">
                <Gauge className="size-4 text-accent" /> Ainda não há um “Depois” para comparar. Conclua o Otimizar tudo para ver o ganho.
              </p>
            )}
            <div>
              <p className="mb-1 text-[11px] font-semibold tracking-wide text-muted uppercase">Histórico de medições</p>
              <div className="overflow-hidden rounded-lg border border-border">
                <table className="w-full text-[12px]">
                  <thead>
                    <tr className="bg-surface-2 text-left text-[11px] text-muted">
                      <th className="px-2.5 py-1.5 font-medium">Quando</th>
                      <th className="px-2.5 py-1.5 font-medium">Medição</th>
                      <th className="px-2.5 py-1.5 text-right font-medium">Nota</th>
                      <th className="px-2.5 py-1.5 text-right font-medium">RAM parada</th>
                      <th className="px-2.5 py-1.5 text-right font-medium">Inicialização</th>
                      <th className="px-2.5 py-1.5 text-right font-medium">Livre no sistema</th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.slice(0, 5).map((m) => (
                      <tr key={m.id} className="border-t border-border/60">
                        <td className="px-2.5 py-1.5 whitespace-nowrap text-muted" title={formatDate(m.takenAt, true)}>
                          {timeAgo(m.takenAt)}
                        </td>
                        <td className="max-w-[180px] truncate px-2.5 py-1.5">
                          <span className={isAfterLabel(m.label) ? 'text-ok' : undefined}>{m.label || 'Medição'}</span>
                        </td>
                        <td className="px-2.5 py-1.5 text-right tabular-nums">{typeof m.score === 'number' ? Math.round(m.score) : '—'}</td>
                        <td className="px-2.5 py-1.5 text-right tabular-nums">{formatBytes(m.ramUsedBytesIdle)}</td>
                        <td className="px-2.5 py-1.5 text-right tabular-nums">{Number.isFinite(m.startupItems) ? m.startupItems : '—'}</td>
                        <td className="px-2.5 py-1.5 text-right tabular-nums">{formatBytes(m.systemDriveFreeBytes)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}
      </div>
    </Card>
  )
}
