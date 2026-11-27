// "Verificar versões mais recentes com IA": a IA compara as versões instaladas com as publicadas
// pelos fabricantes (só sites oficiais) e indica o link oficial. A IA não instala nada.
import { ArrowRight, CircleCheck, CircleHelp, ExternalLink, Globe, OctagonAlert, RefreshCw } from 'lucide-react'
import { isOfficialDriverUrl, type DriverInventory } from '@shared/types/drivers'
import type { AiDriverItem, AiDriverReport } from '@shared/types/ai'
import { AiAnalyzeCard } from '../ai'
import { Badge, Button, useToast, type Tone } from '../ui'
import { CATEGORY_ICONS, categoryOf, hostOf, openOfficial } from './meta'

const STATUS: Record<AiDriverItem['status'], { label: string; tone: Tone; icon: typeof CircleCheck; order: number }> = {
  problem: { label: 'Problema', tone: 'danger', icon: OctagonAlert, order: 0 },
  update_available: { label: 'Atualização disponível', tone: 'warn', icon: RefreshCw, order: 1 },
  unknown: { label: 'Sem informação', tone: 'neutral', icon: CircleHelp, order: 2 },
  up_to_date: { label: 'Em dia', tone: 'ok', icon: CircleCheck, order: 3 }
}

export function AiDriversCard({
  inv,
  report,
  loading,
  error,
  progressText,
  onAnalyze
}: {
  inv: DriverInventory | null
  report: AiDriverReport | null
  loading: boolean
  error: string | null
  progressText: string | null
  onAnalyze: () => void
}) {
  const toast = useToast()
  const items = [...(report?.items ?? [])].sort((a, b) => (STATUS[a.status]?.order ?? 9) - (STATUS[b.status]?.order ?? 9))
  const updates = items.filter((i) => i.status === 'update_available').length
  const stale = Boolean(report && inv && Date.parse(inv.collectedAt) - Date.parse(report.generatedAt) > 7 * 86_400_000)

  return (
    <AiAnalyzeCard
      title="Verificar versões mais recentes com IA"
      description="A IA compara as versões instaladas com as mais recentes publicadas pelos fabricantes (pesquisando só em sites oficiais) e diz o que vale atualizar e onde baixar."
      buttonLabel="Verificar com IA"
      onAnalyze={onAnalyze}
      loading={loading}
      progressText={progressText ?? undefined}
      progressTask="ai:drivers"
      error={error}
      hasResult={Boolean(report)}
      usage={report?.usage}
      generatedAt={report?.generatedAt}
      disabledReason={inv ? undefined : 'Aguarde a lista de drivers terminar de carregar; a IA usa esses dados.'}
    >
      {report && (
        <div className="space-y-3">
          {report.summary && <p className="selectable text-[13.5px] leading-relaxed">{report.summary}</p>}
          <div className="flex flex-wrap items-center gap-2 text-[12px]">
            {updates > 0 ? (
              <Badge tone="warn" icon={RefreshCw}>
                {updates === 1 ? '1 atualização recomendada' : `${updates} atualizações recomendadas`}
              </Badge>
            ) : items.length > 0 ? (
              <Badge tone="ok" icon={CircleCheck}>
                Nenhuma atualização urgente
              </Badge>
            ) : null}
            {!report.usedWebSearch && (
              <span className="text-muted">
                A IA não pesquisou na web (desativado em Configurações): as “versões mais recentes” vêm do conhecimento do modelo e podem estar desatualizadas.
              </span>
            )}
            {stale && <span className="text-warn">Esta análise é antiga; a lista de drivers mudou desde então. Analise de novo.</span>}
          </div>
          {report.missingData && report.missingData.length > 0 && (
            <p className="text-[12px] text-muted">Dados que faltaram para a IA: {report.missingData.join(' ')}</p>
          )}
          {items.length > 0 && (
            <ul className="space-y-2">
              {items.map((it, i) => (
                <AiItem key={`${it.driverId}-${i}`} item={it} inv={inv} onOpen={(url) => void openOfficial(url, toast.error)} />
              ))}
            </ul>
          )}
        </div>
      )}
    </AiAnalyzeCard>
  )
}

function AiItem({ item, inv, onOpen }: { item: AiDriverItem; inv: DriverInventory | null; onOpen: (url: string) => void }) {
  const st = STATUS[item.status] ?? STATUS.unknown
  const driver = inv?.drivers.find((d) => d.id === item.driverId)
  const Icon = driver ? CATEGORY_ICONS[categoryOf(driver)] : st.icon
  const official = item.officialUrl && isOfficialDriverUrl(item.officialUrl) ? item.officialUrl : undefined
  const fallback = !official && driver?.officialUrl && isOfficialDriverUrl(driver.officialUrl) ? driver.officialUrl : undefined
  const url = official ?? fallback
  const sources = [...new Set((item.sources ?? []).filter((s) => isOfficialDriverUrl(s)))].slice(0, 4)
  return (
    <li className="rounded-lg border border-border bg-surface-2 p-3">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg border border-border bg-surface-3">
          <Icon className="size-4 text-accent" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-medium">{item.deviceName}</p>
            <Badge tone={st.tone} icon={st.icon}>
              {st.label}
            </Badge>
          </div>
          <p className="mt-1 flex flex-wrap items-center gap-1.5 text-[12px] text-muted">
            <span>Instalada</span>
            <span className="selectable font-mono text-text">{item.installedVersion || driver?.version || '—'}</span>
            {driver?.displayVersion && <span>({driver.displayVersion})</span>}
            {item.latestVersion && (
              <>
                <ArrowRight className="size-3" />
                <span>mais recente</span>
                <span className={`selectable font-mono ${item.status === 'update_available' ? 'text-warn' : 'text-text'}`}>{item.latestVersion}</span>
              </>
            )}
          </p>
          {item.recommendation && <p className="selectable mt-1.5 text-[13px] leading-relaxed">{item.recommendation}</p>}
          {sources.length > 0 && (
            <p className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] text-faint">
              <Globe className="size-3" /> Fontes:
              {sources.map((s) => (
                <button key={s} className="underline decoration-dotted hover:text-accent" onClick={() => onOpen(s)} title={s}>
                  {hostOf(s)}
                </button>
              ))}
            </p>
          )}
        </div>
        {url && (
          <Button size="sm" variant={item.status === 'update_available' ? 'primary' : 'secondary'} icon={ExternalLink} onClick={() => onOpen(url)} title={url}>
            {/^ms-settings:/i.test(url) ? 'Windows Update' : 'Site oficial'}
          </Button>
        )}
      </div>
    </li>
  )
}
