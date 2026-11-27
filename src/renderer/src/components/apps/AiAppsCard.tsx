// IA na página Jogos & Programas: recomendações do último relatório de limpeza que citam jogos/programas
// (refs 'game:' / 'program:') + botão para pedir uma nova análise. A IA só recomenda; quem age é o usuário.
import { useMemo, useState } from 'react'
import { KeyRound, ShieldAlert } from 'lucide-react'
import type { AiCleanupReport, AiRecommendation } from '@shared/types/ai'
import type { AppsInventory, GameInfo } from '@shared/types/apps'
import { formatBytes } from '@shared/format'
import { AiAnalyzeCard, AiGlyph, AiRecommendationList, useAiStatus } from '../ai'
import { Button } from '../ui'
import { api, errMsg } from '../../lib/api'
import { useNav } from '../../lib/nav'
import { isAppRef, resolveAppRef } from './meta'
import type { UninstallTarget } from './UninstallDialog'

const APP_ACTIONS = new Set(['uninstall_game', 'uninstall_program', 'move_game'])

export function AiAppsCard({
  inventory,
  report,
  onReport,
  onUninstall,
  onMove
}: {
  inventory: AppsInventory | null
  report: AiCleanupReport | null
  onReport: (r: AiCleanupReport) => void
  onUninstall: (t: UninstallTarget) => void
  onMove: (g: GameInfo) => void
}) {
  const nav = useNav()
  const { status, loaded } = useAiStatus()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const recs = useMemo(
    () => (report?.recommendations ?? []).filter((r) => APP_ACTIONS.has(r.action) || r.targetRefs.some(isAppRef)).sort((a, b) => a.priority - b.priority),
    [report]
  )
  const keeps = useMemo(() => (report?.keepWarnings ?? []).filter((k) => k.refs?.some(isAppRef)), [report])

  const analyze = async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      onReport(await api.ai.analyzeCleanup())
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setLoading(false)
    }
  }

  const firstTarget = (r: AiRecommendation): ReturnType<typeof resolveAppRef> => {
    for (const ref of r.targetRefs) {
      const hit = resolveAppRef(inventory, ref)
      if (hit) return hit
    }
    return null
  }

  const actionLabel = (r: AiRecommendation): string | null => {
    const t = firstTarget(r)
    if (!t) return null
    if (r.action === 'move_game' && t.kind === 'game') return 'Como mover'
    if (r.action === 'uninstall_game' || r.action === 'uninstall_program') return t.item.uninstall ? 'Desinstalar…' : null
    return null
  }

  const onAction = (r: AiRecommendation): void => {
    const t = firstTarget(r)
    if (!t) return
    if (r.action === 'move_game' && t.kind === 'game') onMove(t.item)
    else onUninstall(t)
  }

  const resolveRef = (ref: string): string => {
    const t = resolveAppRef(inventory, ref)
    if (!t) return ref.replace(/^(game|program|cleanup|file|dir):/, '')
    return t.item.bytes ? `${t.item.name} (${formatBytes(t.item.bytes)})` : t.item.name
  }

  // Sem chave e sem relatório: faixa compacta (não empurra a lista de jogos para baixo).
  if (loaded && status && !status.configured && !report) {
    return (
      <div className="flex items-center gap-3 rounded-xl border border-ai/30 bg-ai/5 px-4 py-3">
        <AiGlyph size="sm" />
        <p className="min-w-0 flex-1 text-[13px] text-muted">
          <b className="text-text">IA não configurada.</b> Com ela, o app aponta quais jogos e programas vale a pena desinstalar ou mover — e o que não remover.
        </p>
        <Button size="sm" variant="ai" icon={KeyRound} onClick={() => nav.go('settings')}>
          Configurar IA
        </Button>
      </div>
    )
  }

  return (
    <AiAnalyzeCard
      title="IA: o que vale a pena desinstalar ou mover?"
      description="A IA cruza o tamanho de cada jogo, quando você jogou pela última vez e o espaço dos seus discos para sugerir o que remover ou mover — e avisa o que NÃO remover."
      onAnalyze={() => void analyze()}
      loading={loading}
      progressTask="ai:cleanup"
      error={error}
      hasResult={Boolean(report)}
      usage={report?.usage}
      generatedAt={report?.generatedAt}
      disabledReason={!inventory ? 'Aguarde a lista de jogos e programas.' : undefined}
    >
      {report && (
        <div className="space-y-3">
          <AiRecommendationList
            recommendations={recs}
            actionLabel={actionLabel}
            onAction={onAction}
            resolveRef={resolveRef}
            emptyText="A última análise não trouxe recomendações sobre jogos ou programas. Atualize a lista e analise de novo."
          />
          {keeps.length > 0 && (
            <div className="rounded-lg border border-danger/30 bg-danger/5 p-3">
              <p className="mb-1.5 flex items-center gap-2 text-[13px] font-semibold text-danger">
                <ShieldAlert className="size-4" /> A IA recomenda NÃO remover
              </p>
              <ul className="space-y-1.5 text-[13px]">
                {keeps.map((k, i) => (
                  <li key={i}>
                    <b>{k.title}</b> <span className="text-muted">— {k.detail}</span>
                    {k.refs?.length ? <span className="block truncate text-[12px] text-faint">{k.refs.filter(isAppRef).map(resolveRef).join(' · ')}</span> : null}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </AiAnalyzeCard>
  )
}
