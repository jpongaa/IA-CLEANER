// Painel do fluxo "Otimizar tudo": cabeçalho, stepper das 5 etapas e o conteúdo da etapa atual.
import { BrushCleaning, Gauge, Loader2, ScanSearch, ShieldCheck, Sparkles, Wrench, X } from 'lucide-react'
import { formatDuration } from '@shared/format'
import { Button, ProgressBar } from '../../ui'
import { ApplyProgress, ResultView, StoppedView } from './ApplyView'
import { PlanReview } from './PlanReview'
import { Notice, Stepper, TaskRow, useNow, type StepperItem, type StepVisual } from './parts'
import { cancelBoost, closeBoost, isBoostBusy, type BoostState } from './store'

const WIZARD_BG = [
  'radial-gradient(760px circle at 0% 0%, color-mix(in oklab, var(--color-ai) 14%, transparent), transparent 60%)',
  'radial-gradient(640px circle at 100% 0%, color-mix(in oklab, var(--color-accent) 11%, transparent), transparent 60%)',
  'var(--color-surface)'
].join(', ')

function steps(s: BoostState): StepperItem[] {
  const order = ['measuring', 'analyzing', 'plan', 'applying', 'measuringAfter'] as const
  const stageIdx = s.stage === 'stopped' ? 3 : s.stage === 'done' ? 5 : order.indexOf(s.stage as (typeof order)[number])
  const vis = (i: number): StepVisual => {
    if (s.stage === 'stopped' && i === 3) return 'error'
    if (i < stageIdx) return i === 0 && s.before.approx ? 'skipped' : 'done'
    if (i === stageIdx) return i === 2 ? 'current' : 'running'
    return 'pending'
  }
  return [
    { id: 'm1', label: 'Medir antes', hint: s.before.approx ? 'Pelo diagnóstico' : 'RAM, disco, inicialização', status: vis(0) },
    { id: 'an', label: 'Analisar', hint: 'Só lendo, sem alterar', status: vis(1) },
    { id: 'pl', label: 'Revisar plano', hint: 'Você escolhe o que entra', status: vis(2) },
    { id: 'ap', label: 'Aplicar', hint: 'Com backup e Desfazer', status: vis(3) },
    { id: 'm2', label: 'Comparar', hint: 'Mesmos critérios do Antes', status: vis(4) }
  ]
}

function MeasuringView({ state }: { state: BoostState }) {
  const t = state.before.task
  const now = useNow(t.status === 'running')
  return (
    <div className="mx-auto max-w-2xl space-y-3 py-2 text-center" data-testid="boost-measuring">
      <div className="mx-auto grid size-14 place-items-center rounded-2xl border border-accent/30 bg-accent/10">
        <Gauge className="size-7 text-accent" />
      </div>
      <p className="text-[16px] font-semibold">Medindo como o PC está agora</p>
      <p className="text-[13px] text-muted">
        RAM ocupada com o PC parado, programas na inicialização, serviços, processos, espaço livre e a velocidade do disco do sistema. No fim medimos de
        novo, do mesmo jeito, para mostrar o ganho real. <b className="text-text">Deixe o PC parado por uns segundos.</b>
      </p>
      <div className="mx-auto max-w-md">
        <ProgressBar size="sm" value={t.percent} indeterminate={t.percent === undefined} />
        <p className="mt-1.5 text-[12px] text-accent">
          {t.message || 'Medindo…'} <span className="text-faint tabular-nums">· {t.startedAt ? formatDuration(now - t.startedAt) : ''}</span>
        </p>
      </div>
    </div>
  )
}

function AnalyzingView({ state }: { state: BoostState }) {
  const a = state.analysis
  return (
    <div className="space-y-3" data-testid="boost-analyzing">
      <p className="flex items-center gap-2 text-[13px] text-muted">
        <ShieldCheck className="size-4 text-ok" /> Analisando o PC inteiro — só lendo informações, nada é alterado. As quatro análises rodam juntas.
      </p>
      {state.before.task.status === 'skipped' && state.before.task.note && (
        <Notice tone="neutral" icon={Gauge}>
          {state.before.task.note}
        </Notice>
      )}
      <ul className="grid gap-2.5 md:grid-cols-2">
        <TaskRow icon={Gauge} title="Desempenho e plano de otimizações" task={a.performance} pendingText="Inicialização, memória, energia, serviços, jogos…" testId="an-performance" />
        <TaskRow icon={BrushCleaning} title="Lixo recuperável" task={a.cleanup} pendingText="Temporários, caches e restos de instalação" testId="an-cleanup" />
        <TaskRow icon={Wrench} title="Erros do sistema (verificação rápida)" task={a.repair} pendingText="Entradas quebradas, disco, Windows Update, travamentos…" testId="an-repair" />
        <TaskRow icon={ScanSearch} title="Busca Profunda (último resultado)" task={a.discover} pendingText="Instaladores esquecidos, sobras, jogos fora dos launchers" testId="an-discover" />
      </ul>
    </div>
  )
}

export function BoostWizard({ state }: { state: BoostState }) {
  const busy = isBoostBusy(state)
  const cancellable = state.stage === 'measuring' || state.stage === 'analyzing'
  return (
    <section className="relative overflow-hidden rounded-2xl border border-ai/30" style={{ background: WIZARD_BG }} data-testid="boost-wizard" data-stage={state.stage}>
      <div className="flex flex-wrap items-start justify-between gap-3 px-6 pt-5">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-[12px] font-semibold tracking-wider text-muted uppercase">
            <Sparkles className="size-4 text-ai" /> Otimizar tudo
          </p>
          <h2 className="mt-1 text-[19px] leading-snug font-semibold">
            {state.stage === 'plan'
              ? 'Seu plano está pronto: revise e escolha o que aplicar'
              : state.stage === 'done' || state.stage === 'measuringAfter'
                ? 'Resultado'
                : state.stage === 'stopped'
                  ? 'Aplicação interrompida'
                  : state.stage === 'applying'
                    ? 'Aplicando o que você escolheu'
                    : 'Descobrindo o que deixa este PC lento'}
          </h2>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {cancellable && (
            <Button size="sm" variant="ghost" icon={state.cancelRequested ? Loader2 : X} onClick={cancelBoost} disabled={state.cancelRequested}>
              {state.cancelRequested ? 'Cancelando…' : 'Cancelar'}
            </Button>
          )}
          {!busy && state.stage !== 'done' && (
            <Button size="sm" variant="ghost" icon={X} onClick={() => closeBoost()} aria-label="Fechar o Otimizar tudo">
              Fechar
            </Button>
          )}
        </div>
      </div>

      <div className="px-6 pt-4 pb-5">
        <Stepper steps={steps(state)} />
      </div>

      <div className="border-t border-border/70 bg-bg/40 px-6 py-5">
        {state.stage === 'measuring' && <MeasuringView state={state} />}
        {state.stage === 'analyzing' && <AnalyzingView state={state} />}
        {state.stage === 'plan' && <PlanReview state={state} />}
        {state.stage === 'applying' && <ApplyProgress state={state} />}
        {state.stage === 'stopped' && <StoppedView state={state} />}
        {(state.stage === 'measuringAfter' || state.stage === 'done') && <ResultView state={state} />}
      </div>
    </section>
  )
}
