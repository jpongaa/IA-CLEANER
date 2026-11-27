// "Análise inteligente da IA": a IA olha os dados coletados (limpeza, discos, jogos) e aponta pontos críticos.
// Ela nunca executa nada: recomendações só selecionam itens na lista ou levam para outra página.
// O estado "IA não configurada", o progresso e o custo ficam a cargo do AiAnalyzeCard compartilhado.
import { useEffect, useMemo, useState } from 'react'
import { ShieldAlert, TriangleAlert } from 'lucide-react'
import type { AiCleanupReport, AiRecommendation } from '@shared/types/ai'
import type { AppsInventory } from '@shared/types/apps'
import type { CleanupEstimate } from '@shared/types/cleanup'
import { formatBytes } from '@shared/format'
import { AI_ACTION_PAGE, AiAnalyzeCard, AiRecommendationList, defaultRefLabel } from '../ai'
import { api, errMsg } from '../../lib/api'
import { useNav, type PageId } from '../../lib/nav'
import { baseName, isSelectable } from './meta'

/** Traduz erros técnicos da IA em mensagens que o usuário entende (mensagens já amigáveis passam direto). */
export function friendlyAiError(raw: string): string {
  const m = raw.toLowerCase()
  if (m.includes('não implementado') || m.includes('not implemented') || m.includes('no handler registered')) {
    return 'A análise por IA ainda não está disponível nesta versão do app. A limpeza funciona normalmente sem ela.'
  }
  if (/invalid x-api-key|authentication_error|\b401\b|unauthorized/.test(m)) return 'Chave da API inválida ou ausente. Configure sua chave em Configurações.'
  if (/\b429\b|rate.?limit|overloaded|\b529\b/.test(m)) return 'A IA está sobrecarregada no momento. Espere um pouco e tente de novo.'
  if (/enotfound|econnrefused|econnreset|fetch failed|network error|socket hang up/.test(m)) {
    return 'Não foi possível falar com a IA (sem internet ou serviço fora do ar). Tente de novo em instantes.'
  }
  return raw
}

/** Para onde cada ação da IA leva (mesma tabela do kit de IA; inclui resolve_finding -> Busca Profunda). */
const NAV_FOR: Partial<Record<AiRecommendation['action'], { page: PageId; label: string }>> = {
  ...AI_ACTION_PAGE,
  resolve_finding: AI_ACTION_PAGE.resolve_finding ?? { page: 'discover', label: 'Ver na Busca Profunda' }
}

export function AiCleanupCard({ estimate, onSelectTargets }: { estimate: CleanupEstimate | null; onSelectTargets: (ids: string[]) => void }) {
  const nav = useNav()
  const [report, setReport] = useState<AiCleanupReport | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [inventory, setInventory] = useState<AppsInventory | null>(null)

  // Último relatório salvo (não perde ao trocar de página)
  useEffect(() => {
    let alive = true
    api.ai
      .getLastReports()
      .then((r) => alive && setReport(r?.cleanup ?? null))
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [])

  // Nomes de jogos/programas para as referências da IA (opcional)
  useEffect(() => {
    if (!report || inventory) return
    api.apps
      .getLastInventory()
      .then((inv) => setInventory(inv))
      .catch(() => undefined)
  }, [report, inventory])

  const targetsById = useMemo(() => new Map((estimate?.targets ?? []).map((t) => [t.id, t])), [estimate])

  const resolveRef = (ref: string): string => {
    const i = ref.indexOf(':')
    const kind = ref.slice(0, i)
    const id = ref.slice(i + 1)
    if (kind === 'cleanup') return targetsById.get(id)?.title ?? id
    if (kind === 'game') return inventory?.games?.find((g) => g.id === id)?.name ?? id.replace(/^[a-z]+:/, '')
    if (kind === 'program') return inventory?.programs?.find((p) => p.id === id)?.name ?? id
    if (kind === 'file' || kind === 'dir') return baseName(id)
    // Tipos que esta página não conhece (ex.: found: da Busca Profunda): rótulo padrão do kit de IA.
    return defaultRefLabel(ref)
  }

  const cleanupIds = (rec: AiRecommendation): string[] =>
    (rec.targetRefs ?? [])
      .filter((r) => r.startsWith('cleanup:'))
      .map((r) => r.slice('cleanup:'.length))
      .filter((id) => {
        const t = targetsById.get(id)
        return t ? isSelectable(t) : false
      })

  const actionLabel = (rec: AiRecommendation): string | null => {
    if (rec.action === 'clean_target') return cleanupIds(rec).length ? 'Selecionar na lista' : null
    return NAV_FOR[rec.action]?.label ?? null
  }

  const onAction = (rec: AiRecommendation): void => {
    if (rec.action === 'clean_target') {
      onSelectTargets(cleanupIds(rec))
      return
    }
    const dest = NAV_FOR[rec.action]
    if (dest) nav.go(dest.page)
  }

  async function analyze(): Promise<void> {
    setLoading(true)
    setError(null)
    try {
      setReport(await api.ai.analyzeCleanup())
    } catch (e) {
      setError(friendlyAiError(errMsg(e)))
    } finally {
      setLoading(false)
    }
  }

  const sorted = report ? [...(report.recommendations ?? [])].sort((a, b) => a.priority - b.priority) : []

  return (
    <div data-testid="cleanup-ai">
      <AiAnalyzeCard
        title="Análise inteligente da IA"
        description={
          <>
            A IA lê esta análise (e a de Discos e de Jogos & Programas, se você já fez), aponta os pontos críticos e diz o que apagar e o que{' '}
            <b className="text-text">não</b> apagar. Ela só recomenda — quem decide é você.
            {!estimate && <span className="text-faint"> Dica: rode a análise de limpeza primeiro para a IA ter mais dados.</span>}
          </>
        }
        buttonLabel="Analisar com IA"
        onAnalyze={analyze}
        loading={loading}
        progressTask="ai:cleanup"
        error={error}
        hasResult={Boolean(report)}
        usage={report?.usage}
        generatedAt={report?.generatedAt}
      >
        {report && (
          <div className="space-y-5">
            <p className="selectable text-[13.5px] leading-relaxed text-text">{report.summary}</p>

            {(report.criticalPoints ?? []).length > 0 && (
              <div>
                <h4 className="mb-2 text-[12px] font-semibold tracking-wider text-muted uppercase">Pontos críticos</h4>
                <div className="grid gap-2 md:grid-cols-2">
                  {report.criticalPoints.map((c, i) => (
                    <div key={`${c.title}-${i}`} className="rounded-lg border border-warn/25 bg-warn/5 p-3">
                      <p className="flex items-start justify-between gap-2 text-[13px] font-medium">
                        <span className="flex items-start gap-1.5">
                          <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warn" />
                          {c.title}
                        </span>
                        {c.bytes ? <span className="shrink-0 text-warn tabular-nums">{formatBytes(c.bytes)}</span> : null}
                      </p>
                      <p className="mt-1 text-[12.5px] text-muted">{c.detail}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {sorted.length > 0 && (
              <div>
                <h4 className="mb-2 text-[12px] font-semibold tracking-wider text-muted uppercase">Recomendações</h4>
                <AiRecommendationList recommendations={sorted} actionLabel={actionLabel} onAction={onAction} resolveRef={resolveRef} />
              </div>
            )}

            {(report.keepWarnings ?? []).length > 0 && (
              <div>
                <h4 className="mb-2 text-[12px] font-semibold tracking-wider text-muted uppercase">Não apague</h4>
                <ul className="space-y-2">
                  {report.keepWarnings.map((w, i) => (
                    <li key={`${w.title}-${i}`} className="flex items-start gap-2 rounded-lg border border-danger/25 bg-danger/5 p-3">
                      <ShieldAlert className="mt-0.5 size-4 shrink-0 text-danger" />
                      <div className="min-w-0">
                        <p className="text-[13px] font-medium">{w.title}</p>
                        <p className="text-[12.5px] text-muted">{w.detail}</p>
                        {(w.refs ?? []).length > 0 && <p className="mt-0.5 truncate text-[11.5px] text-faint">{w.refs.map(resolveRef).join(' · ')}</p>}
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </AiAnalyzeCard>
    </div>
  )
}
