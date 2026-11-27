// Medições antes/depois: mede sempre com os mesmos critérios e compara (tabela com barras lado a lado por métrica —
// cada métrica na sua própria escala, nunca dois eixos no mesmo gráfico).
import clsx from 'clsx'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { ArrowDownRight, ArrowUpRight, Gauge, History, Minus, Ruler, Timer, Zap } from 'lucide-react'
import type { TaskProgress } from '@shared/types/common'
import type { SpeedMeasurement } from '@shared/types/performance'
import { formatBytes, formatDate, formatNumber } from '@shared/format'
import { api, errMsg, useEvent } from '../../lib/api'
import { Badge, Button, Card, ErrorBox, ProgressBar, useToast } from '../ui'

interface Metric {
  key: string
  label: string
  hint: string
  get: (m: SpeedMeasurement) => number | undefined
  fmt: (v: number) => string
  /** true = maior é melhor */
  higherBetter: boolean
  /** Variação abaixo disso (fração) é ruído de medição */
  noise: number
}

const METRICS: Metric[] = [
  { key: 'score', label: 'Nota do diagnóstico', hint: '0 a 100, regras locais', get: (m) => m.score, fmt: (v) => `${Math.round(v)}`, higherBetter: true, noise: 0.01 },
  { key: 'ram', label: 'RAM em uso (PC parado)', hint: 'média de ~5 s', get: (m) => m.ramUsedBytesIdle, fmt: (v) => formatBytes(v), higherBetter: false, noise: 0.03 },
  { key: 'startup', label: 'Programas que abrem com o Windows', hint: 'itens ativos', get: (m) => m.startupItems, fmt: (v) => `${v}`, higherBetter: false, noise: 0 },
  { key: 'services', label: 'Serviços rodando', hint: 'todos', get: (m) => m.servicesRunning, fmt: (v) => `${v}`, higherBetter: false, noise: 0.01 },
  { key: 'procs', label: 'Processos abertos', hint: 'todos', get: (m) => m.processes, fmt: (v) => `${v}`, higherBetter: false, noise: 0.02 },
  { key: 'cpu', label: 'Processador livre (parado)', hint: '% ocioso', get: (m) => m.cpuIdlePercent, fmt: (v) => `${formatNumber(v, 1)}%`, higherBetter: true, noise: 0.06 },
  { key: 'read', label: 'Leitura do disco do sistema', hint: 'sem cache', get: (m) => m.diskReadMBps, fmt: (v) => `${formatNumber(v)} MB/s`, higherBetter: true, noise: 0.1 },
  { key: 'write', label: 'Gravação no disco do sistema', hint: 'sem cache', get: (m) => m.diskWriteMBps, fmt: (v) => `${formatNumber(v)} MB/s`, higherBetter: true, noise: 0.1 },
  { key: 'free', label: 'Espaço livre no disco do sistema', hint: '', get: (m) => m.systemDriveFreeBytes, fmt: (v) => formatBytes(v), higherBetter: true, noise: 0.005 },
  { key: 'boot', label: 'Tempo do último boot', hint: 'medido pelo Windows', get: (m) => m.bootSeconds, fmt: (v) => `${formatNumber(v, 1)} s`, higherBetter: false, noise: 0.05 }
]

const LABELS = ['Antes de otimizar', 'Depois de otimizar', 'Medição de rotina'] as const

/** Antes = a medição "Antes" mais recente que seja anterior à última; Depois = a última. */
export function pickPair(list: SpeedMeasurement[]): { before?: SpeedMeasurement; after?: SpeedMeasurement } {
  if (!list.length) return {}
  const after = list[0]
  const before = list.slice(1).find((m) => /antes/i.test(m.label ?? '')) ?? list[1]
  return before ? { before, after } : { after }
}

function Delta({ m, a, b }: { m: Metric; a?: number; b?: number }) {
  if (a === undefined || b === undefined) return <span className="text-faint">—</span>
  const diff = b - a
  const rel = a !== 0 ? Math.abs(diff) / Math.abs(a) : diff === 0 ? 0 : 1
  if (diff === 0 || rel <= m.noise) {
    return (
      <span className="inline-flex items-center gap-1 text-[12px] text-muted">
        <Minus className="size-3.5" /> igual
      </span>
    )
  }
  const better = m.higherBetter ? diff > 0 : diff < 0
  const Icon = diff > 0 ? ArrowUpRight : ArrowDownRight
  const txt =
    m.key === 'ram' || m.key === 'free'
      ? formatBytes(Math.abs(diff))
      : m.key === 'cpu'
        ? `${formatNumber(Math.abs(diff), 1)} pontos`
        : m.fmt(Math.abs(diff))
  return (
    <span className={clsx('inline-flex items-center gap-1 text-[12px] font-medium', better ? 'text-ok' : 'text-danger')}>
      <Icon className="size-3.5" />
      {diff > 0 ? '+' : '−'}
      {txt} <span className="font-normal">({better ? 'melhor' : 'pior'})</span>
    </span>
  )
}

function Bars({ a, b, fmtA, fmtB }: { a?: number; b?: number; fmtA: string; fmtB: string }) {
  const max = Math.max(a ?? 0, b ?? 0) || 1
  return (
    <div className="w-40 space-y-[2px]">
      {a !== undefined && <div className="h-1.5 rounded-r-[4px] bg-faint" style={{ width: `${Math.max(2, (a / max) * 100)}%` }} title={`Antes: ${fmtA}`} />}
      {b !== undefined && <div className="h-1.5 rounded-r-[4px] bg-accent" style={{ width: `${Math.max(2, (b / max) * 100)}%` }} title={`Depois: ${fmtB}`} />}
    </div>
  )
}

export function MeasureSection({ onBoost, onSnapshotChanged, boostDisabled }: { onBoost: () => void; onSnapshotChanged: () => void; boostDisabled?: boolean }) {
  const toast = useToast()
  const [list, setList] = useState<SpeedMeasurement[] | null>(null)
  const [measuring, setMeasuring] = useState(false)
  const [progress, setProgress] = useState<TaskProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [label, setLabel] = useState<string>('')

  const reload = useCallback(async () => {
    try {
      setList(await api.performance.getMeasurements())
    } catch (e) {
      setError(errMsg(e))
      setList([])
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  useEvent('perf:progress', (p) => {
    if (measuring && p.task === 'perf:measure') setProgress(p)
  })

  const suggested = !list?.length ? LABELS[0] : /antes/i.test(list[0].label ?? '') ? LABELS[1] : LABELS[0]
  const chosenLabel = label || suggested

  const measure = async (): Promise<void> => {
    setMeasuring(true)
    setError(null)
    setProgress({ task: 'perf:measure', phase: 'start', message: 'Preparando a medição...', percent: 0 })
    try {
      const m = await api.performance.measure(chosenLabel)
      setList((cur) => [m, ...(cur ?? [])])
      setLabel('')
      toast.success('Medição concluída.')
      onSnapshotChanged()
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setMeasuring(false)
      setProgress(null)
    }
  }

  const { before, after } = useMemo(() => pickPair(list ?? []), [list])

  return (
    <Card
      title="Medições antes/depois"
      icon={Ruler}
      subtitle="Prove o ganho: meça, clique em Otimizar tudo, reinicie o PC e meça de novo. A medição usa sempre os mesmos critérios."
      actions={
        <div className="flex items-center gap-2">
          <select className="input h-8 text-[12px]" value={chosenLabel} onChange={(e) => setLabel(e.target.value)} disabled={measuring} aria-label="Nome da medição">
            {LABELS.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
          <Button size="sm" icon={Timer} loading={measuring} onClick={() => void measure()}>
            Medir agora
          </Button>
          <Button size="sm" variant="primary" icon={Zap} onClick={onBoost} disabled={boostDisabled || measuring}>
            Otimizar tudo
          </Button>
        </div>
      }
    >
      <ol className="mb-4 grid grid-cols-3 gap-2 text-[12px]">
        {[
          ['1', 'Meça agora ("Antes")', 'Leva uns 20 s. Deixe o PC parado.'],
          ['2', 'Otimizar tudo', 'Revise o plano e aplique. Um pedido de permissão só.'],
          ['3', 'Reinicie e meça de novo', 'Escolha "Depois de otimizar" e compare aqui.']
        ].map(([n, t, d]) => (
          <li key={n} className="flex items-start gap-2 rounded-lg border border-border bg-surface-2 px-3 py-2">
            <span className="grid size-5 shrink-0 place-items-center rounded-full bg-accent/15 text-[11px] font-semibold text-accent">{n}</span>
            <span>
              <span className="block font-medium text-text">{t}</span>
              <span className="text-muted">{d}</span>
            </span>
          </li>
        ))}
      </ol>
      {measuring && (
        <div className="mb-4">
          <div className="flex items-center justify-between gap-3">
            <p className="text-[13px]">{progress?.message ?? 'Medindo...'}</p>
            <span className="text-[12px] text-muted tabular-nums">{progress?.percent !== undefined ? `${progress.percent}%` : ''}</span>
          </div>
          <ProgressBar className="mt-2" value={progress?.percent} indeterminate={progress?.percent === undefined} />
          <p className="mt-1.5 text-[12px] text-faint">Somente leitura, exceto um arquivo de teste de 256 MB na pasta temporária, apagado no fim.</p>
        </div>
      )}
      {error && <ErrorBox className="mb-3" error={error} onRetry={() => void measure()} />}
      {list === null ? null : !after ? (
        <p className="flex items-center gap-2 rounded-lg border border-dashed border-border p-4 text-[13px] text-muted">
          <Gauge className="size-4 text-accent" /> Nenhuma medição ainda. Clique em <b className="text-text">Medir agora</b> com "Antes de otimizar" para ter a base de
          comparação.
        </p>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border">
          <div className="flex flex-wrap items-center gap-4 border-b border-border bg-surface-2 px-4 py-2 text-[12px] text-muted">
            {before && (
              <span className="inline-flex items-center gap-1.5">
                <span className="inline-block h-1.5 w-4 rounded bg-faint" /> {before.label ?? 'Antes'} · {formatDate(before.takenAt, true)}
              </span>
            )}
            <span className="inline-flex items-center gap-1.5">
              <span className="inline-block h-1.5 w-4 rounded bg-accent" /> {after.label ?? 'Última'} · {formatDate(after.takenAt, true)}
            </span>
            {!before && <span className="text-faint">Meça de novo depois de otimizar para comparar.</span>}
          </div>
          <table className="tbl">
            <thead>
              <tr>
                <th>O que foi medido</th>
                {before && <th className="num">{before.label?.replace(' de otimizar', '') ?? 'Antes'}</th>}
                <th className="num">{after.label?.replace(' de otimizar', '') ?? 'Última'}</th>
                {before && <th className="w-44">Comparação</th>}
                {before && <th className="w-48">Diferença</th>}
              </tr>
            </thead>
            <tbody>
              {METRICS.map((m) => {
                const a = before ? m.get(before) : undefined
                const b = m.get(after)
                if (b === undefined && a === undefined) return null
                return (
                  <tr key={m.key}>
                    <td>
                      <p className="font-medium">{m.label}</p>
                      {m.hint && <p className="text-[11px] text-faint">{m.hint}</p>}
                    </td>
                    {before && <td className="num whitespace-nowrap text-muted">{a !== undefined ? m.fmt(a) : '—'}</td>}
                    <td className="num whitespace-nowrap font-medium">{b !== undefined ? m.fmt(b) : '—'}</td>
                    {before && (
                      <td>
                        <Bars a={a} b={b} fmtA={a !== undefined ? m.fmt(a) : '—'} fmtB={b !== undefined ? m.fmt(b) : '—'} />
                      </td>
                    )}
                    {before && (
                      <td>
                        <Delta m={m} a={a} b={b} />
                      </td>
                    )}
                  </tr>
                )
              })}
            </tbody>
          </table>
          {(after.notes ?? []).length > 0 && <p className="border-t border-border px-4 py-2 text-[11px] text-faint">{after.notes!.join(' ')}</p>}
        </div>
      )}
      {list && list.length > 1 && (
        <details className="mt-3 rounded-lg border border-border bg-surface-2 p-3 text-[12px]">
          <summary className="flex cursor-pointer items-center gap-1.5 select-none text-muted">
            <History className="size-3.5" /> Histórico de medições ({list.length})
          </summary>
          <table className="tbl mt-2">
            <thead>
              <tr>
                <th>Quando</th>
                <th>Nome</th>
                <th className="num">Nota</th>
                <th className="num">RAM parado</th>
                <th className="num">Inicialização</th>
                <th className="num">Processos</th>
                <th className="num">Leitura</th>
                <th className="num">Gravação</th>
              </tr>
            </thead>
            <tbody>
              {list.map((m) => (
                <tr key={m.id}>
                  <td className="text-muted">{formatDate(m.takenAt, true)}</td>
                  <td>{m.label ? <Badge tone={/depois/i.test(m.label) ? 'accent' : 'neutral'}>{m.label}</Badge> : '—'}</td>
                  <td className="num">{m.score ?? '—'}</td>
                  <td className="num">{formatBytes(m.ramUsedBytesIdle)}</td>
                  <td className="num">{m.startupItems}</td>
                  <td className="num">{m.processes}</td>
                  <td className="num">{m.diskReadMBps ? `${formatNumber(m.diskReadMBps)} MB/s` : '—'}</td>
                  <td className="num">{m.diskWriteMBps ? `${formatNumber(m.diskWriteMBps)} MB/s` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </Card>
  )
}
