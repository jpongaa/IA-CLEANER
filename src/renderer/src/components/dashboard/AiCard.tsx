// Card da IA: resumo dos últimos relatórios ou convite para configurar.
import { ArrowRight, Bot, KeyRound, MessageSquare, Puzzle, Sparkles, Stethoscope } from 'lucide-react'
import type { AiReports, AiStatus } from '@shared/types/ai'
import { formatBytes } from '@shared/format'
import { useNav } from '../../lib/nav'
import { Button, Card, ImpactBadge } from '../ui'
import { timeAgo } from '../history/meta'
import { BlockSkeleton } from './common'
import { revealAndStartCheckup } from './checkupStore'
import { isNotImplemented, toMs } from './insights'

export function AiCard({
  status,
  reports,
  loading,
  statusError,
  checkupRunning
}: {
  status: AiStatus | null
  reports: AiReports | null
  loading: boolean
  statusError: string | null
  checkupRunning: boolean
}) {
  const { go } = useNav()
  const perf = reports?.performance
  const cleanup = reports?.cleanup
  const drivers = reports?.drivers
  const hasReports = Boolean(perf || cleanup || drivers)
  const configured = Boolean(status?.configured)
  const latest = [perf?.generatedAt, cleanup?.generatedAt, drivers?.generatedAt]
    .map(toMs)
    .filter(Number.isFinite)
    .sort((a, b) => b - a)[0]

  return (
    <Card
      ai
      icon={Sparkles}
      title="Análise da IA"
      subtitle={hasReports && latest ? `Último relatório ${timeAgo(latest)}` : 'Claude explica o que pesa e o que fazer primeiro'}
    >
      {loading && !status && !reports ? (
        <BlockSkeleton lines={4} />
      ) : hasReports ? (
        <div className="space-y-3">
          {perf && (
            <div>
              <p className="text-[14px] leading-snug font-semibold">{perf.headline}</p>
              {perf.summary && <p className="mt-1 line-clamp-3 text-[13px] text-muted">{perf.summary}</p>}
              {perf.rootCauses?.length > 0 && (
                <ul className="mt-2.5 space-y-1.5">
                  {perf.rootCauses.slice(0, 3).map((c, i) => (
                    <li key={i} className="flex items-start gap-2 text-[13px]">
                      <span className="mt-0.5 shrink-0">
                        <ImpactBadge impact={c.impact} />
                      </span>
                      <span className="min-w-0">{c.title}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {cleanup && (
            <button
              onClick={() => go('cleanup')}
              className="flex w-full items-start gap-2.5 rounded-lg border border-border bg-surface-2/60 p-2.5 text-left hover:border-border-strong"
            >
              <Sparkles className="mt-0.5 size-4 shrink-0 text-ai" />
              <span className="min-w-0 text-[12px]">
                <b className="text-text">Limpeza:</b>{' '}
                <span className="text-muted">
                  {cleanup.totalRecoverableBytes > 0 ? `${formatBytes(cleanup.totalRecoverableBytes)} recuperáveis segundo a IA. ` : ''}
                  {cleanup.summary}
                </span>
              </span>
            </button>
          )}
          {drivers && (
            <button
              onClick={() => go('drivers')}
              className="flex w-full items-start gap-2.5 rounded-lg border border-border bg-surface-2/60 p-2.5 text-left hover:border-border-strong"
            >
              <Puzzle className="mt-0.5 size-4 shrink-0 text-ai" />
              <span className="line-clamp-2 min-w-0 text-[12px]">
                <b className="text-text">Drivers:</b> <span className="text-muted">{drivers.summary}</span>
              </span>
            </button>
          )}
          <div className="flex flex-wrap gap-2 pt-1">
            {perf && (
              <Button size="sm" onClick={() => go('performance')}>
                Ver diagnóstico <ArrowRight className="size-3.5" />
              </Button>
            )}
            <Button size="sm" variant="ghost" icon={MessageSquare} onClick={() => go('assistant')}>
              Perguntar à IA
            </Button>
          </div>
        </div>
      ) : configured ? (
        <div className="space-y-3">
          <p className="text-[13px] text-muted">
            A IA está pronta. Faça o checkup completo: ela recebe o resultado e aponta os pontos críticos — o que está gastando mais espaço e
            memória, e o que resolver primeiro.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="ai" icon={Stethoscope} onClick={revealAndStartCheckup} disabled={checkupRunning}>
              Fazer checkup com IA
            </Button>
            <Button size="sm" variant="ghost" icon={MessageSquare} onClick={() => go('assistant')}>
              Conversar
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex items-start gap-3">
            <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-ai/15">
              <Bot className="size-5 text-ai" />
            </div>
            <p className="text-[13px] text-muted">
              {statusError && isNotImplemented(statusError)
                ? 'A integração com a IA ainda não está disponível nesta versão.'
                : 'Ative a IA (Claude) para receber um diagnóstico explicado em português: o que apagar, o que manter e o que realmente deixa o PC lento.'}
            </p>
          </div>
          <p className="text-[12px] text-faint">Sem a IA o app continua funcionando: as análises locais não usam a internet.</p>
          <Button size="sm" variant="ai" icon={KeyRound} onClick={() => go('settings')}>
            Configurar IA
          </Button>
        </div>
      )}
    </Card>
  )
}
