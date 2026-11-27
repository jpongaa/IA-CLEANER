// Stepper de progresso do Checkup Completo e o resumo final com atalhos.
import clsx from 'clsx'
import { useEffect, useState, type ReactNode } from 'react'
import {
  ArrowRight,
  Bot,
  Check,
  CircleCheck,
  CircleMinus,
  Gamepad2,
  Gauge,
  HardDrive,
  HeartPulse,
  Loader2,
  RefreshCw,
  Rocket,
  Sparkles,
  TriangleAlert,
  X,
  type LucideIcon
} from 'lucide-react'
import { formatBytes, formatDuration, formatPercent } from '@shared/format'
import { useNav, type PageId } from '../../lib/nav'
import { Button, ProgressBar, type Tone } from '../ui'
import { cancelCheckup, dismissCheckup, startCheckup, type CheckupState, type CheckupStep } from './checkupStore'
import { startBoost } from './boost/store'
import { computeHealth, sortFindings, staleGames, systemDrive, usedPercent } from './insights'
import { toneVar } from './common'

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [active])
  return now
}

function StepIcon({ step, index }: { step: CheckupStep; index: number }) {
  const base = 'grid size-8 shrink-0 place-items-center rounded-full border text-[13px] font-semibold'
  switch (step.status) {
    case 'running':
      return (
        <span className={clsx(base, 'border-accent bg-accent/15 text-accent shadow-[0_0_14px] shadow-accent/40')}>
          <Loader2 className="size-4 animate-spin" />
        </span>
      )
    case 'done':
      return (
        <span className={clsx(base, 'border-ok/50 bg-ok/15 text-ok')}>
          <Check className="size-4" strokeWidth={3} />
        </span>
      )
    case 'error':
      return (
        <span className={clsx(base, 'border-danger/50 bg-danger/15 text-danger')}>
          <X className="size-4" strokeWidth={3} />
        </span>
      )
    case 'skipped':
      return (
        <span className={clsx(base, 'border-border bg-surface-3 text-faint')}>
          <CircleMinus className="size-4" />
        </span>
      )
    default:
      return <span className={clsx(base, 'border-border bg-surface-2 text-faint')}>{index + 1}</span>
  }
}

function stepText(s: CheckupStep, now: number): string {
  switch (s.status) {
    case 'running':
      return s.message || `Analisando… ${s.startedAt ? formatDuration(now - s.startedAt) : ''}`
    case 'done':
      return s.startedAt && s.finishedAt ? `Concluído em ${formatDuration(s.finishedAt - s.startedAt)}` : 'Concluído'
    case 'error':
      return s.error || 'Falhou'
    case 'skipped':
      return s.skipReason || 'Pulado'
    default:
      return s.description
  }
}

export function CheckupProgress({ state }: { state: CheckupState }) {
  const now = useNow(state.status === 'running')
  const current = state.steps.find((s) => s.status === 'running')
  const doneCount = state.steps.filter((s) => s.status !== 'pending' && s.status !== 'running').length
  const overall = ((doneCount + (current?.percent ?? 0) / 100) / state.steps.length) * 100

  return (
    <div>
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <p className="flex items-center gap-2 text-[14px] font-semibold">
            <Loader2 className="size-4 animate-spin text-accent" />
            Checkup em andamento
            <span className="font-normal text-muted tabular-nums">· {formatDuration(now - (state.startedAt ?? now))}</span>
          </p>
          <p className="mt-0.5 text-[12px] text-muted">Pode continuar usando o app — o progresso não se perde se você trocar de página.</p>
        </div>
        <Button size="sm" variant="ghost" icon={X} onClick={cancelCheckup} disabled={state.cancelRequested}>
          {state.cancelRequested ? 'Parando após esta etapa…' : 'Cancelar'}
        </Button>
      </div>

      <ol className="grid grid-cols-2 gap-x-3 gap-y-4 lg:grid-cols-4">
        {state.steps.map((s, i) => (
          <li key={s.id} className="min-w-0">
            <div className="flex items-center gap-2">
              <StepIcon step={s} index={i} />
              {i < state.steps.length - 1 && (
                <div className="hidden h-0.5 flex-1 overflow-hidden rounded-full bg-surface-3 lg:block">
                  <div
                    className={clsx('h-full rounded-full transition-[width] duration-700', s.status === 'error' ? 'bg-danger/60' : 'bg-accent')}
                    style={{ width: s.status === 'pending' ? '0%' : s.status === 'running' ? `${s.percent ?? 15}%` : '100%' }}
                  />
                </div>
              )}
            </div>
            <p className={clsx('mt-2 text-[13px] font-medium', s.status === 'pending' && 'text-muted')}>{s.label}</p>
            <p
              className={clsx('line-clamp-2 text-[12px]', s.status === 'error' ? 'text-danger' : s.status === 'running' ? 'text-accent' : 'text-muted')}
              title={stepText(s, now)}
            >
              {stepText(s, now)}
            </p>
          </li>
        ))}
      </ol>

      <div className="mt-4">
        <ProgressBar value={overall} tone="accent" size="sm" indeterminate={Boolean(current) && current?.percent === undefined && doneCount === 0} />
      </div>
    </div>
  )
}

interface TileProps {
  icon: LucideIcon
  tone: Tone
  title: string
  value: ReactNode
  text?: ReactNode
  action?: { label: string; page: PageId }
}

function SummaryTile({ icon: Icon, tone, title, value, text, action }: TileProps) {
  const { go } = useNav()
  return (
    <div className="flex min-w-0 flex-col rounded-xl border border-border bg-surface/80 p-3.5">
      <p className="flex items-center gap-2 text-[12px] font-medium text-muted">
        <Icon className="size-4" style={{ color: toneVar(tone) }} />
        {title}
      </p>
      <p className="mt-1.5 text-[18px] leading-tight font-semibold tabular-nums">{value}</p>
      {text && <p className="mt-1 line-clamp-2 text-[12px] text-muted">{text}</p>}
      {action && (
        <button
          onClick={() => go(action.page)}
          className="mt-auto inline-flex items-center gap-1 self-start pt-2 text-[12px] font-medium text-accent hover:underline"
        >
          {action.label}
          <ArrowRight className="size-3.5" />
        </button>
      )}
    </div>
  )
}

export function CheckupSummary({ state }: { state: CheckupState }) {
  const { snapshot, estimate, inventory, aiReport, aiConfigured } = state.results
  const failed = state.steps.filter((s) => s.status === 'error')
  const duration = state.startedAt && state.finishedAt ? formatDuration(state.finishedAt - state.startedAt) : null
  const tiles: TileProps[] = []

  if (snapshot || aiReport) {
    const h = computeHealth(snapshot ?? null, aiReport)
    tiles.push({
      icon: HeartPulse,
      tone: h.tone,
      title: 'Saúde do PC',
      value: h.score === null ? '—' : `${h.score}/100 · ${h.label}`,
      text: h.headline,
      action: { label: 'Ver diagnóstico', page: 'performance' }
    })
  }
  if (snapshot) {
    const top = sortFindings(snapshot.findings)
    const important = top.filter((f) => f.severity === 'critical' || f.severity === 'high').length
    const attention = top.filter((f) => f.severity === 'medium').length
    tiles.push({
      icon: TriangleAlert,
      tone: important ? 'danger' : attention ? 'warn' : 'ok',
      title: 'Problemas encontrados',
      value:
        important + attention === 0
          ? 'Nenhum relevante'
          : important
            ? `${important} ${important === 1 ? 'importante' : 'importantes'}`
            : `${attention} de atenção`,
      text:
        important + attention === 0
          ? 'Nada que esteja deixando o PC lento.'
          : `${important && attention ? `+${attention} de atenção. ` : ''}Principal: ${top[0]?.title ?? '—'}`,
      action: { label: 'Ver problemas', page: 'performance' }
    })
    const startup = (snapshot.startupItems ?? []).filter((s) => s.enabled)
    const heavy = startup.filter((s) => s.impact === 'high').length
    tiles.push({
      icon: Rocket,
      tone: startup.length > 12 || heavy > 2 ? 'warn' : 'ok',
      title: 'Abrem com o Windows',
      value: `${startup.length} ${startup.length === 1 ? 'programa' : 'programas'}`,
      text: heavy ? `${heavy} com impacto alto no tempo de inicialização` : 'Nenhum com impacto alto',
      action: { label: 'Revisar inicialização', page: 'performance' }
    })
    const sys = systemDrive(snapshot.drives)
    if (sys && usedPercent(sys) >= 90) {
      tiles.push({
        icon: HardDrive,
        tone: 'danger',
        title: `Disco do sistema (${sys.letter})`,
        value: `${formatPercent(usedPercent(sys))} cheio`,
        text: `Só ${formatBytes(sys.freeBytes)} livres: isso por si só deixa o Windows lento.`,
        action: { label: 'Ver o que ocupa espaço', page: 'disk' }
      })
    }
  }
  if (estimate) {
    tiles.push({
      icon: Sparkles,
      tone: 'accent',
      title: 'Lixo que pode sair com segurança',
      value: formatBytes(estimate.safeBytes),
      text: estimate.totalBytes > estimate.safeBytes ? `${formatBytes(estimate.totalBytes)} no total, contando itens para revisar` : 'Temporários, caches e restos',
      action: { label: 'Ir para a Limpeza', page: 'cleanup' }
    })
  }
  if (inventory) {
    const st = staleGames(inventory)
    tiles.push({
      icon: Gamepad2,
      tone: st.count ? 'warn' : 'ok',
      title: 'Jogos parados há 6+ meses',
      value: st.count ? `${st.count} · ${formatBytes(st.bytes)}` : 'Nenhum',
      text: st.top.length ? st.top.map((g) => g.name).join(', ') : `${st.totalGames} jogos encontrados no total`,
      action: { label: 'Ver jogos', page: 'apps' }
    })
  }
  if (aiReport) {
    tiles.push({
      icon: Bot,
      tone: 'ai',
      title: 'Diagnóstico da IA',
      value: aiReport.rootCauses?.length ? `${aiReport.rootCauses.length} causas principais` : 'Pronto',
      text: aiReport.headline,
      action: { label: 'Ver relatório da IA', page: 'performance' }
    })
  } else if (aiConfigured === false) {
    tiles.push({
      icon: Bot,
      tone: 'ai',
      title: 'Diagnóstico da IA',
      value: 'Não configurada',
      text: 'Ative a IA para receber uma explicação dos pontos críticos e o que fazer primeiro.',
      action: { label: 'Configurar IA', page: 'settings' }
    })
  }

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="flex items-center gap-2 text-[14px] font-semibold">
            {state.cancelled ? <CircleMinus className="size-4 text-warn" /> : <CircleCheck className="size-4 text-ok" />}
            {state.cancelled ? 'Checkup interrompido' : 'Checkup concluído'}
            {duration && <span className="font-normal text-muted">em {duration}</span>}
          </p>
          <p className="mt-0.5 text-[12px] text-muted">Nada foi alterado no seu PC. Escolha por onde começar:</p>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" icon={X} onClick={dismissCheckup}>
            Fechar resumo
          </Button>
          <Button size="sm" icon={RefreshCw} onClick={() => void startCheckup()}>
            Refazer
          </Button>
          <Button
            size="sm"
            variant="ai"
            icon={Sparkles}
            title="Mede, monta um plano com o que dá para resolver e só aplica o que você aprovar"
            onClick={() => {
              dismissCheckup()
              void startBoost()
            }}
          >
            Otimizar tudo
          </Button>
        </div>
      </div>

      {failed.length > 0 && (
        <div className="mb-3 rounded-lg border border-warn/30 bg-warn/5 p-2.5 text-[12px]">
          <p className="font-medium text-warn">
            {failed.length === 1 ? 'Uma etapa não pôde ser concluída' : `${failed.length} etapas não puderam ser concluídas`} — o resto do checkup
            seguiu normalmente:
          </p>
          <ul className="mt-1 space-y-0.5 text-muted">
            {failed.map((s) => (
              <li key={s.id} className="truncate" title={s.error}>
                <b className="text-text">{s.label}:</b> {s.error}
              </li>
            ))}
          </ul>
        </div>
      )}

      {tiles.length > 0 ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(210px,1fr))] gap-3">
          {tiles.map((t) => (
            <SummaryTile key={t.title} {...t} />
          ))}
        </div>
      ) : (
        <p className="flex items-center gap-2 text-[13px] text-muted">
          <Gauge className="size-4" /> Nenhuma etapa trouxe resultados. Verifique os erros acima e tente de novo.
        </p>
      )}
    </div>
  )
}
