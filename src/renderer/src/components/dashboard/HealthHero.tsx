// Destaque "Saúde do PC": nota (local ou da IA), frase principal e o botão do Checkup Completo.
import { Bot, Clock, HeartPulse, ShieldCheck, Sparkles, Stethoscope } from 'lucide-react'
import { formatDate } from '@shared/format'
import { Badge, Button, Skeleton } from '../ui'
import { timeAgo } from '../history/meta'
import { CheckupProgress, CheckupSummary } from './CheckupPanel'
import { startCheckup, type CheckupState } from './checkupStore'
import { startBoost } from './boost/store'
import { ScoreRing } from './common'
import type { HealthView } from './insights'

const HERO_BG = [
  'radial-gradient(720px circle at 0% 0%, color-mix(in oklab, var(--color-ai) 16%, transparent), transparent 62%)',
  'radial-gradient(640px circle at 100% 110%, color-mix(in oklab, var(--color-accent) 13%, transparent), transparent 60%)',
  'var(--color-surface)'
].join(', ')

export function HealthHero({ health, loading, checkup }: { health: HealthView; loading: boolean; checkup: CheckupState }) {
  const running = checkup.status === 'running'
  return (
    <section className="relative overflow-hidden rounded-2xl border border-border" style={{ background: HERO_BG }}>
      <div className="flex flex-col gap-6 p-6 lg:flex-row lg:items-center">
        {loading && health.score === null ? (
          <Skeleton className="size-[148px] shrink-0 rounded-full" />
        ) : (
          <ScoreRing score={health.score} tone={health.tone} label={health.label} />
        )}

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="flex items-center gap-1.5 text-[12px] font-semibold tracking-wider text-muted uppercase">
              <HeartPulse className="size-4 text-accent" />
              Saúde do PC
            </p>
            {health.source === 'ai' && (
              <Badge tone="ai" icon={Bot}>
                Nota da IA
              </Badge>
            )}
            {health.source === 'local' && <Badge tone="neutral">Nota calculada pelo app</Badge>}
          </div>

          {loading && health.score === null ? (
            <div className="mt-3 space-y-2">
              <Skeleton className="h-6 w-3/4" />
              <Skeleton className="h-4 w-1/2" />
            </div>
          ) : (
            <>
              <h2 className="mt-1.5 text-[21px] leading-snug font-semibold text-balance">{health.headline}</h2>
              {health.summary && <p className="mt-1.5 line-clamp-2 max-w-2xl text-[13px] text-muted">{health.summary}</p>}
              <div className="mt-3 flex flex-wrap items-center gap-2 text-[12px]">
                {health.importantCount > 0 && (
                  <Badge tone="danger">
                    {health.importantCount} {health.importantCount === 1 ? 'problema importante' : 'problemas importantes'}
                  </Badge>
                )}
                {health.attentionCount > 0 && (
                  <Badge tone="warn">
                    {health.attentionCount} {health.attentionCount === 1 ? 'ponto de atenção' : 'pontos de atenção'}
                  </Badge>
                )}
                {health.at && (
                  <span className="inline-flex items-center gap-1 text-muted" title={formatDate(health.at, true)}>
                    <Clock className="size-3.5" /> Verificado {timeAgo(health.at)}
                  </span>
                )}
              </div>
            </>
          )}
        </div>

        <div className="flex shrink-0 flex-col items-stretch gap-2 lg:w-[270px]">
          <Button
            size="lg"
            variant="ai"
            icon={Sparkles}
            disabled={running}
            onClick={() => void startBoost()}
            className="h-12 text-[15px]"
            data-testid="boost-start"
            title="Mede o PC, analisa tudo, mostra um plano para você revisar e só aplica o que você aprovar. No fim, mede de novo."
          >
            Otimizar tudo
          </Button>
          <Button variant="secondary" icon={Stethoscope} loading={running} onClick={() => void startCheckup()}>
            {running ? 'Checkup em andamento…' : 'Só verificar (Checkup Completo)'}
          </Button>
          <p className="flex items-center justify-center gap-1.5 text-center text-[11px] text-muted">
            <ShieldCheck className="size-3.5 shrink-0 text-ok" />
            Nada muda no PC sem você revisar e confirmar
          </p>
        </div>
      </div>

      {checkup.status !== 'idle' && (
        <div className="border-t border-border/70 bg-bg/40 px-6 py-5">
          {running ? <CheckupProgress state={checkup} /> : <CheckupSummary state={checkup} />}
        </div>
      )}
    </section>
  )
}
