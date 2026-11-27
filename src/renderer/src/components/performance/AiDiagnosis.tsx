// "Diagnóstico com IA": a IA cruza a coleta e explica a causa real da lentidão (ela nunca executa nada).
import { useEffect, useState } from 'react'
import { CircleArrowUp, Info, Lightbulb, Target, Wand2 } from 'lucide-react'
import type { AiPerformanceReport, AiRecommendation } from '@shared/types/ai'
import type { OptimizationAction, PerformanceSnapshot } from '@shared/types/performance'
import { formatDate } from '@shared/format'
import { api, errMsg } from '../../lib/api'
import { AiAnalyzeCard, AiRecommendationList } from '../ai'
import { Badge, Button, ImpactBadge } from '../ui'
import { scoreInfo } from './labels'

export function AiDiagnosis({
  snapshot,
  onAction,
  onShowStartup
}: {
  snapshot: PerformanceSnapshot | null
  onAction: (a: OptimizationAction) => void
  onShowStartup: (ids: string[]) => void
}) {
  const [report, setReport] = useState<AiPerformanceReport | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api.ai
      .getLastReports()
      .then((r) => setReport(r.performance ?? null))
      .catch(() => undefined)
  }, [])

  const analyze = async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      setReport(await api.ai.diagnosePerformance())
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setLoading(false)
    }
  }

  const actions = snapshot?.actions ?? []
  const findAction = (id: string): OptimizationAction | undefined => actions.find((a) => a.id === id)
  const resolveRef = (ref: string): string => {
    const [kind, ...rest] = ref.split(':')
    const id = rest.join(':')
    if (kind === 'action') return findAction(id)?.title ?? id
    if (kind === 'startup') return snapshot?.startupItems.find((i) => i.id === id)?.name ?? id
    return ref
  }
  const recLabel = (r: AiRecommendation): string | null => {
    if (r.targetRefs.some((t) => t.startsWith('action:') && findAction(t.slice(7)))) return 'Aplicar'
    if (r.targetRefs.some((t) => t.startsWith('startup:'))) return 'Ver na inicialização'
    return null
  }
  const onRec = (r: AiRecommendation): void => {
    const act = r.targetRefs.find((t) => t.startsWith('action:') && findAction(t.slice(7)))
    if (act) {
      const a = findAction(act.slice(7))
      if (a) onAction(a)
      return
    }
    const ids = r.targetRefs.filter((t) => t.startsWith('startup:')).map((t) => t.slice(8))
    if (ids.length) onShowStartup(ids)
  }

  const disabledReason = !snapshot ? 'Faça a análise do PC primeiro: a IA usa os dados coletados.' : undefined
  const stale = report && snapshot && new Date(report.generatedAt).getTime() < new Date(snapshot.collectedAt).getTime()

  return (
    <AiAnalyzeCard
      title="Diagnóstico com IA"
      description={
        <span>
          A IA cruza todos os dados coletados e explica, em linguagem simples, o que <b>realmente</b> deixa seu PC lento — e por que apagar arquivos não
          resolveu.
        </span>
      }
      buttonLabel="Diagnosticar com IA"
      onAnalyze={() => void analyze()}
      loading={loading}
      progressTask="ai:performance"
      error={error}
      hasResult={Boolean(report)}
      usage={report?.usage}
      generatedAt={report?.generatedAt}
      disabledReason={disabledReason}
    >
      {report && (
        <div className="space-y-4">
          {stale && <p className="text-[12px] text-warn">Este diagnóstico é de {formatDate(report.generatedAt, true)}, anterior à última análise. Rode de novo para atualizar.</p>}
          {report.missingData && report.missingData.length > 0 && (
            <p className="flex items-start gap-1.5 text-[12px] text-muted">
              <Info className="mt-0.5 size-3.5 shrink-0 text-info" />
              <span>Para um diagnóstico mais completo: {report.missingData.join(' ')}</span>
            </p>
          )}
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-[17px] leading-snug font-semibold">{report.headline}</p>
              <p className="selectable mt-1.5 text-[13px] leading-relaxed text-muted">{report.summary}</p>
            </div>
            <div className="shrink-0 rounded-xl border border-border bg-surface-2 px-4 py-2 text-center">
              <p className="text-[11px] text-faint uppercase">Nota da IA</p>
              <p className="text-2xl font-bold tabular-nums" style={{ color: scoreInfo(report.healthScore).color }}>
                {Math.round(report.healthScore)}
              </p>
            </div>
          </div>

          {report.rootCauses.length > 0 && (
            <div>
              <p className="mb-2 flex items-center gap-1.5 text-[13px] font-semibold">
                <Target className="size-4 text-ai" /> Causas principais
              </p>
              <div className="space-y-2">
                {report.rootCauses.map((c, i) => {
                  const acts = c.actionIds.map(findAction).filter((a): a is OptimizationAction => Boolean(a))
                  return (
                    <div key={i} className="rounded-lg border border-border bg-surface-2 p-3">
                      <div className="flex items-center justify-between gap-2">
                        <p className="font-medium">{c.title}</p>
                        <ImpactBadge impact={c.impact} />
                      </div>
                      <p className="selectable mt-1 text-[13px] text-muted">{c.evidence}</p>
                      {acts.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-2">
                          {acts.map((a) =>
                            a.state === 'applied' && !a.longRunning ? (
                              <Badge key={a.id} tone="ok">
                                {a.title}: aplicado
                              </Badge>
                            ) : (
                              <Button key={a.id} size="sm" variant="primary" icon={Wand2} disabled={a.state === 'notApplicable'} onClick={() => onAction(a)}>
                                {a.title}
                              </Button>
                            )
                          )}
                        </div>
                      )}
                      {c.manualSteps.length > 0 && (
                        <ol className="mt-2 list-decimal space-y-1 pl-5 text-[13px]">
                          {c.manualSteps.map((s, j) => (
                            <li key={j} className="selectable">
                              {s}
                            </li>
                          ))}
                        </ol>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {report.quickWins.length > 0 && (
            <div>
              <p className="mb-2 flex items-center gap-1.5 text-[13px] font-semibold">
                <Wand2 className="size-4 text-ai" /> Ganhos rápidos
              </p>
              <AiRecommendationList recommendations={report.quickWins} actionLabel={recLabel} onAction={onRec} resolveRef={resolveRef} />
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            {report.myths && report.myths.length > 0 && (
              <div className="rounded-lg border border-ai/30 bg-ai/5 p-3">
                <p className="mb-1.5 flex items-center gap-1.5 text-[13px] font-semibold">
                  <Lightbulb className="size-4 text-ai" /> Por que apagar arquivos não deixou o PC mais rápido
                </p>
                <ul className="list-disc space-y-1 pl-5 text-[13px] text-muted">
                  {report.myths.map((m, i) => (
                    <li key={i} className="selectable">
                      {m}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {report.upgradeAdvice && (
              <div className="rounded-lg border border-accent/30 bg-accent/5 p-3">
                <p className="mb-1.5 flex items-center gap-1.5 text-[13px] font-semibold">
                  <CircleArrowUp className="size-4 text-accent" /> Upgrade que vale a pena
                </p>
                <p className="selectable text-[13px] text-muted">{report.upgradeAdvice}</p>
              </div>
            )}
          </div>
        </div>
      )}
    </AiAnalyzeCard>
  )
}
