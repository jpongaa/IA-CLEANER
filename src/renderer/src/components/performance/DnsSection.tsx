// Teste de DNS: compara o DNS atual com Cloudflare, Google e Quad9 (somente leitura) e permite trocar com desfazer.
import clsx from 'clsx'
import { useEffect, useMemo, useState } from 'react'
import { CircleCheck, Globe, Info, Lightbulb, Trophy, Wifi, Zap } from 'lucide-react'
import type { ActionLogEntry, TaskProgress } from '@shared/types/common'
import type { DnsBenchmarkResult, OptimizationAction } from '@shared/types/performance'
import { formatDate, formatNumber } from '@shared/format'
import { api, errMsg, useEvent } from '../../lib/api'
import { Badge, Button, Card, EmptyState, ErrorBox, ProgressBar, useToast } from '../ui'
import { OptimizationsSection } from './OptimizationsSection'

export function DnsSection({
  actions,
  log,
  runningId,
  onApply,
  onUndone
}: {
  actions: OptimizationAction[]
  log: ActionLogEntry[]
  runningId: string | null
  onApply: (a: OptimizationAction) => void
  onUndone: () => void
}) {
  const toast = useToast()
  const [result, setResult] = useState<DnsBenchmarkResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [testing, setTesting] = useState(false)
  const [progress, setProgress] = useState<TaskProgress | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    api.performance
      .getLastDnsBenchmark()
      .then((r) => alive && setResult(r))
      .catch(() => undefined)
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [])

  useEvent('perf:progress', (p) => {
    if (testing && p.task === 'perf:dns') setProgress(p)
  })

  const test = async (): Promise<void> => {
    setTesting(true)
    setError(null)
    setProgress({ task: 'perf:dns', phase: 'start', message: 'Preparando o teste...', percent: 0 })
    try {
      const r = await api.performance.dnsBenchmark()
      setResult(r)
      toast.success('Teste de DNS concluído.')
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setTesting(false)
      setProgress(null)
    }
  }

  const max = useMemo(() => Math.max(1, ...(result?.servers ?? []).map((s) => s.medianMs ?? 0)), [result])
  const recAction = result?.recommendation ? actions.find((a) => a.id === result.recommendation!.actionId) : undefined

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4 rounded-xl border border-border bg-surface-2 p-3.5 text-[13px]">
        <p className="text-muted">
          O DNS traduz o nome do site (ex.: youtube.com) para o endereço do servidor. Um DNS lento faz o site <b className="text-text">demorar para começar a abrir</b>
          . Sendo honesto: ele não aumenta a velocidade de download nem diminui o ping nos jogos. O teste consulta {result?.domains.length ?? 12} sites populares 3
          vezes em cada servidor, direto (sem o cache do Windows), e não altera nada.
        </p>
        <Button variant="primary" icon={Zap} loading={testing} onClick={() => void test()}>
          {result ? 'Testar de novo' : 'Testar agora'}
        </Button>
      </div>

      {testing && (
        <Card>
          <div className="flex items-center justify-between gap-3">
            <p className="text-[13px]">{progress?.message ?? 'Testando...'}</p>
            <span className="text-[12px] text-muted tabular-nums">{progress?.percent !== undefined ? `${progress.percent}%` : ''}</span>
          </div>
          <ProgressBar className="mt-2" value={progress?.percent} indeterminate={progress?.percent === undefined} />
        </Card>
      )}
      {error && <ErrorBox error={error} onRetry={() => void test()} />}

      {!loading && !result && !testing && (
        <Card>
          <EmptyState icon={Globe} title="Nenhum teste de DNS ainda" description="Clique em Testar agora: leva uns 10 segundos e é somente leitura." />
        </Card>
      )}

      {result && (
        <Card
          title="Resultado"
          icon={Wifi}
          subtitle={`Testado em ${formatDate(result.testedAt, true)} · tempo de resposta mediano (quanto menor, melhor)`}
          padded={false}
        >
          <table className="tbl">
            <thead>
              <tr>
                <th>Servidor</th>
                <th>Endereço</th>
                <th className="w-[22%]">Tempo de resposta</th>
                <th className="num w-24">Mediana</th>
                <th className="num w-24">1ª consulta</th>
                <th className="num w-20">Falhas</th>
              </tr>
            </thead>
            <tbody>
              {result.servers.map((s) => {
                const best = s.id === result.bestId
                const failRate = s.failures / Math.max(1, s.samples + s.failures)
                return (
                  <tr key={s.id} className={clsx(best && 'bg-ok/5')}>
                    <td>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="font-medium">{s.name}</span>
                        {s.current && <Badge tone="info">Em uso</Badge>}
                        {best && (
                          <Badge tone="ok" icon={Trophy}>
                            Mais rápido
                          </Badge>
                        )}
                      </div>
                    </td>
                    <td className="selectable font-mono text-[12px] text-muted">{s.address}</td>
                    <td>
                      {s.medianMs !== undefined ? (
                        <div className="h-2 w-full max-w-48 min-w-20 rounded-full bg-surface-3" title={`${s.name}: ${formatNumber(s.medianMs, 1)} ms`}>
                          <div className={clsx('h-2 rounded-full', best ? 'bg-ok' : s.current ? 'bg-info' : 'bg-accent')} style={{ width: `${Math.max(3, (s.medianMs / max) * 100)}%` }} />
                        </div>
                      ) : (
                        <span className="text-[12px] text-danger">não respondeu</span>
                      )}
                    </td>
                    <td className="num font-medium">{s.medianMs !== undefined ? `${formatNumber(s.medianMs, 1)} ms` : '—'}</td>
                    <td className="num text-muted">{s.coldMs !== undefined ? `${formatNumber(s.coldMs, 1)} ms` : '—'}</td>
                    <td className={clsx('num', failRate > 0.1 ? 'text-danger' : 'text-muted')}>
                      {s.failures}/{s.samples + s.failures}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          <div className="space-y-2 border-t border-border px-5 py-3 text-[12px]">
            {result.adapters.map((a) => (
              <p key={a.alias} className="text-muted">
                <b className="text-text">{a.alias}</b>: IPv4 {a.v4.join(', ') || '—'} ({a.automaticV4 ? 'automático' : 'manual'}) · IPv6 {a.v6.slice(0, 2).join(', ') || '—'} (
                {a.automaticV6 ? 'automático' : 'manual'})
              </p>
            ))}
          </div>
        </Card>
      )}

      {result?.recommendation && (
        <div className={clsx('flex items-start gap-3 rounded-xl border p-4', result.recommendation.strong ? 'border-ok/40 bg-ok/10' : 'border-info/30 bg-info/10')}>
          <Lightbulb className={clsx('mt-0.5 size-5 shrink-0', result.recommendation.strong ? 'text-ok' : 'text-info')} />
          <div className="min-w-0 flex-1 text-[13px]">
            <p className="font-semibold">{result.recommendation.strong ? 'Vale trocar' : 'Pode ajudar um pouco'}</p>
            <p className="mt-0.5 text-muted">{result.recommendation.text}</p>
          </div>
          {recAction && recAction.state !== 'applied' && (
            <Button variant={result.recommendation.strong ? 'primary' : 'secondary'} size="sm" loading={runningId === recAction.id} onClick={() => onApply(recAction)}>
              Usar este DNS
            </Button>
          )}
          {recAction?.state === 'applied' && (
            <Badge tone="ok" icon={CircleCheck}>
              Em uso
            </Badge>
          )}
        </div>
      )}
      {result && result.notes.length > 0 && (
        <ul className="space-y-1 text-[12px] text-muted">
          {result.notes.map((n) => (
            <li key={n} className="flex items-start gap-1.5">
              <Info className="mt-0.5 size-3.5 shrink-0 text-info" /> {n}
            </li>
          ))}
        </ul>
      )}

      <div>
        <h3 className="mb-2 text-[14px] font-semibold">Trocar o DNS manualmente</h3>
        <OptimizationsSection
          actions={actions}
          log={log}
          runningId={runningId}
          onApply={onApply}
          onUndone={onUndone}
          intro={
            <p className="mb-3 text-[12px] text-muted">
              Troca o DNS de todos os adaptadores de rede ativos (precisa de administrador). O "Desfazer" volta exatamente à configuração anterior, inclusive
              "automático".
            </p>
          }
        />
      </div>
    </div>
  )
}
