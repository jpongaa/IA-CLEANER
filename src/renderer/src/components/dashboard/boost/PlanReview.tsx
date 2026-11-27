// Etapa 3 do "Otimizar tudo": plano revisável (checkboxes, o porquê de cada item, badges, totais e estimativa)
// e a confirmação. Nada é aplicado sem o usuário clicar em "Aplicar plano" e confirmar.
import clsx from 'clsx'
import { useMemo, useState, type ReactNode } from 'react'
import {
  ArrowRight,
  Ban,
  BrushCleaning,
  Clock,
  Gauge,
  HardDrive,
  Info,
  ListChecks,
  RefreshCw,
  RotateCcw,
  Rocket,
  ScanSearch,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  TriangleAlert,
  Undo2,
  Wrench,
  Zap,
  type LucideIcon
} from 'lucide-react'
import { cleanupAppName } from '@shared/types/cleanup'
import { formatBytes, formatPercent } from '@shared/format'
import { useNav } from '../../../lib/nav'
import { Badge, Button, Checkbox, ConfirmDialog, RiskBadge, SeverityBadge, Toggle, type Tone } from '../../ui'
import { isNotImplemented } from '../insights'
import { toneVar } from '../common'
import {
  EFFECT_LABEL,
  estimateEffect,
  formatMetric,
  perfSubgroups,
  selectedEntries,
  type EffectEstimate,
  type EffectLevel,
  type PerfSubgroup,
  type PlanEntry,
  type PlanGroup
} from './logic'
import { applyPlan, planIsStale, reanalyze, setGroup, setRestartExplorer, setRestorePoint, toggleEntry, type BoostState, type BoostTask } from './store'
import { Notice } from './parts'

const EFFECT_TONE: Record<EffectLevel, Tone> = { high: 'ok', medium: 'accent', low: 'info', none: 'neutral' }

function appNames(exes: string[]): string {
  const names = [...new Set(exes.map(cleanupAppName))]
  return names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} e ${names[names.length - 1]}`
}

// ------------------------------------------------------------------ resumo

function SummaryTile({ icon: Icon, tone, label, value, hint, testId }: { icon: LucideIcon; tone: Tone; label: string; value: ReactNode; hint?: ReactNode; testId?: string }) {
  return (
    <div className="min-w-0 rounded-xl border border-border bg-surface/80 p-3.5" data-testid={testId}>
      <p className="flex items-center gap-2 text-[12px] font-medium text-muted">
        <Icon className="size-4" style={{ color: toneVar(tone) }} />
        {label}
      </p>
      <p className="mt-1.5 truncate text-[18px] leading-tight font-semibold tabular-nums">{value}</p>
      {hint && <p className="mt-1 line-clamp-2 text-[12px] text-muted">{hint}</p>}
    </div>
  )
}

function PlanSummary({ effect, state }: { effect: EffectEstimate; state: BoostState }) {
  const sys = effect.systemDrive
  const b = state.before.m
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <SummaryTile
          testId="boost-effect"
          icon={Gauge}
          tone={EFFECT_TONE[effect.level]}
          label="Efeito esperado (estimativa)"
          value={<span style={{ color: toneVar(EFFECT_TONE[effect.level]) }}>{EFFECT_LABEL[effect.level]}</span>}
          hint={
            effect.level === 'none'
              ? 'Nada marcado ainda.'
              : `${effect.highImpact} ${effect.highImpact === 1 ? 'item de impacto alto' : 'itens de impacto alto'}. O ganho real aparece na medição “Depois”.`
          }
        />
        <SummaryTile
          testId="boost-space"
          icon={HardDrive}
          tone="accent"
          label="Espaço a liberar"
          value={`${effect.bytesUnknown ? '≥ ' : ''}${formatBytes(effect.bytes)}`}
          hint={
            sys && effect.bytes > 0
              ? `${sys.letter} de ${formatPercent(sys.usedBefore)} para ${formatPercent(sys.usedAfter)} de uso (${formatBytes(sys.freeAfter)} livres)`
              : 'Temporários, caches e restos que podem sair com segurança'
          }
        />
        <SummaryTile
          icon={Rocket}
          tone="warn"
          label="Inicialização"
          value={effect.counts.startup ? `−${effect.counts.startup} ${effect.counts.startup === 1 ? 'programa' : 'programas'}` : 'Sem mudança'}
          hint={effect.counts.startup ? 'Menos coisas abrindo com o Windows: boot mais rápido e mais RAM livre.' : 'Nenhum programa marcado para sair da inicialização.'}
        />
        <SummaryTile
          icon={Wrench}
          tone="info"
          label="Otimizações e correções"
          value={`${effect.counts.perf} + ${effect.counts.repair}`}
          hint={`${effect.counts.perf} ${effect.counts.perf === 1 ? 'ajuste do Windows' : 'ajustes do Windows'} · ${effect.counts.repair} ${effect.counts.repair === 1 ? 'erro corrigido' : 'erros corrigidos'}`}
        />
      </div>
      {b && (
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted" data-testid="boost-baseline">
          <span className="font-medium text-text">Ponto de partida{state.before.approx ? ' (aproximado)' : ''}:</span>
          <span>
            {state.before.approx ? 'RAM em uso' : 'RAM parada'} {formatMetric('bytes', b.ramUsedBytesIdle)}
          </span>
          <span>· {b.startupItems} na inicialização</span>
          {Number.isFinite(b.servicesRunning) && <span>· {b.servicesRunning} serviços</span>}
          {Number.isFinite(b.processes) && <span>· {b.processes} processos</span>}
          <span>· {formatMetric('bytes', b.systemDriveFreeBytes)} livres no sistema</span>
          {typeof b.score === 'number' && <span>· nota {Math.round(b.score)}</span>}
        </p>
      )}
    </div>
  )
}

// ------------------------------------------------------------------ seções

// Num plano de melhorias, "impacto alto" em vermelho parece perigo: aqui o rótulo diz o que significa.
const GAIN: Record<string, { label: string; tone: Tone }> = {
  high: { label: 'Ganho alto', tone: 'ok' },
  medium: { label: 'Ganho médio', tone: 'accent' },
  low: { label: 'Ganho pequeno', tone: 'neutral' },
  unknown: { label: 'Ganho ?', tone: 'neutral' }
}
const BOOT_WEIGHT: Record<string, { label: string; tone: Tone }> = {
  high: { label: 'Pesa muito no boot', tone: 'warn' },
  medium: { label: 'Pesa no boot', tone: 'info' },
  low: { label: 'Pesa pouco', tone: 'neutral' },
  unknown: { label: 'Peso desconhecido', tone: 'neutral' }
}

function GainBadge({ e }: { e: PlanEntry }) {
  const m = (e.group === 'startup' ? BOOT_WEIGHT : GAIN)[e.impact ?? 'unknown'] ?? GAIN.unknown
  return <Badge tone={m.tone}>{m.label}</Badge>
}

function EntryBadges({ e }: { e: PlanEntry }) {
  return (
    <div className="flex flex-wrap items-center gap-1">
      {e.kindLabel && <Badge tone="neutral">{e.kindLabel}</Badge>}
      {e.severity && <SeverityBadge severity={e.severity} />}
      {e.impact && e.group !== 'cleanup' && <GainBadge e={e} />}
      {e.risk && e.risk !== 'low' && <RiskBadge risk={e.risk} />}
      {e.requiresAdmin && (
        <Badge tone="warn" icon={ShieldAlert}>
          Administrador
        </Badge>
      )}
      {e.requiresRestart && (
        <Badge tone="info" icon={RotateCcw}>
          Reiniciar
        </Badge>
      )}
      {e.reversible === true && e.group !== 'cleanup' && (
        <Badge tone="ok" icon={Undo2}>
          Tem desfazer
        </Badge>
      )}
      {e.reversible === true && e.group === 'cleanup' && (
        <Badge tone="ok" icon={Undo2}>
          Vai para a Lixeira
        </Badge>
      )}
      {e.reversible === false && e.group !== 'cleanup' && (
        <Badge tone="neutral" icon={Ban}>
          Sem desfazer
        </Badge>
      )}
    </div>
  )
}

function EntryRow({ e, checked, disabled }: { e: PlanEntry; checked: boolean; disabled?: boolean }) {
  return (
    <li
      className={clsx('flex items-start gap-3 px-4 py-2.5 transition-colors', checked ? 'bg-accent/[0.04]' : 'hover:bg-surface-2/50')}
      data-testid="boost-entry"
      data-key={e.key}
      data-checked={checked}
    >
      <div className="pt-0.5">
        <Checkbox checked={checked} disabled={disabled} onChange={(v) => toggleEntry(e.key, v)} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <button
            type="button"
            className="min-w-0 text-left text-[13px] font-medium hover:text-accent disabled:cursor-default"
            onClick={() => toggleEntry(e.key, !checked)}
            disabled={disabled}
          >
            {e.title}
          </button>
          <EntryBadges e={e} />
        </div>
        <p className="mt-0.5 line-clamp-2 text-[12px] text-muted" title={e.why}>
          {e.why}
        </p>
        {e.currentValue && <p className="mt-0.5 text-[11px] text-faint">{e.currentValue}</p>}
        {e.blockedBy?.length ? (
          <p className="mt-1 flex items-center gap-1.5 text-[12px] text-warn">
            <TriangleAlert className="size-3.5 shrink-0" /> {appNames(e.blockedBy)} {e.blockedBy.length === 1 ? 'está aberto' : 'estão abertos'}: feche antes de aplicar, senão este
            item é pulado.
          </p>
        ) : null}
        {e.warn && (
          <p className={clsx('mt-1 flex items-start gap-1.5 text-[12px]', e.group === 'cleanup' ? 'text-danger' : 'text-warn')}>
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" /> {e.warn}
          </p>
        )}
      </div>
      {e.group === 'cleanup' && (
        <span className="shrink-0 pt-0.5 text-[13px] font-semibold text-accent tabular-nums" title={e.approximate ? 'Medição parcial: pode ser mais' : undefined}>
          {e.sizeUnknown ? '?' : `${e.approximate ? '≥ ' : ''}${formatBytes(e.bytes)}`}
        </span>
      )}
    </li>
  )
}

function SectionShell({
  icon: Icon,
  title,
  subtitle,
  group,
  entries,
  selected,
  children,
  testId,
  subgroups
}: {
  icon: LucideIcon
  title: string
  subtitle: string
  group?: PlanGroup
  entries: PlanEntry[]
  selected: Record<string, boolean>
  children?: ReactNode
  testId?: string
  /** Subseções (otimizações agrupadas como o backend informa); só aparecem com 2 ou mais */
  subgroups?: PerfSubgroup[]
}) {
  const n = entries.filter((e) => selected[e.key]).length
  const bytes = group === 'cleanup' ? entries.filter((e) => selected[e.key]).reduce((s, e) => s + (e.bytes ?? 0), 0) : 0
  return (
    <section className="overflow-hidden rounded-xl border border-border bg-surface" data-testid={testId}>
      <header className="flex items-start justify-between gap-3 border-b border-border/70 px-4 py-3">
        <div className="min-w-0 flex-1">
          <h4 className="flex items-center gap-2 text-[14px] font-semibold">
            <Icon className="size-4 text-accent" />
            {title}
            {entries.length > 0 && (
              <span className="rounded bg-surface-3 px-1.5 text-[11px] font-medium text-muted tabular-nums">
                {n}/{entries.length}
              </span>
            )}
            {bytes > 0 && <span className="text-[12px] font-semibold text-accent tabular-nums">{formatBytes(bytes)}</span>}
          </h4>
          <p className="mt-0.5 text-[12px] text-muted">{subtitle}</p>
        </div>
        {group && entries.length > 1 && (
          <div className="flex shrink-0 gap-1">
            <Button size="sm" variant="ghost" onClick={() => setGroup(group, true)} disabled={n === entries.length}>
              Marcar todos
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setGroup(group, false)} disabled={n === 0}>
              Desmarcar
            </Button>
          </div>
        )}
      </header>
      {entries.length > 0 && subgroups && subgroups.length > 1 ? (
        <div className="divide-y divide-border/70">
          {subgroups.map((g) => (
            <div key={g.id} data-testid="boost-subgroup" data-group={g.id}>
              <p className="flex flex-wrap items-baseline gap-x-2 bg-surface-2/40 px-4 pt-2 pb-1.5 text-[11px] font-semibold tracking-wide text-muted uppercase">
                {g.title}
                <span className="font-medium tabular-nums normal-case">
                  {g.entries.filter((e) => selected[e.key]).length}/{g.entries.length}
                </span>
                {g.hint && <span className="text-[11px] font-normal tracking-normal text-faint normal-case">· {g.hint}</span>}
              </p>
              <ul className="divide-y divide-border/50">
                {g.entries.map((e) => (
                  <EntryRow key={e.key} e={e} checked={Boolean(selected[e.key])} />
                ))}
              </ul>
            </div>
          ))}
        </div>
      ) : entries.length > 0 ? (
        <ul className="divide-y divide-border/50">
          {entries.map((e) => (
            <EntryRow key={e.key} e={e} checked={Boolean(selected[e.key])} />
          ))}
        </ul>
      ) : (
        <div className="px-4 py-3 text-[13px] text-muted">{children}</div>
      )}
    </section>
  )
}

function Unavailable({ task, error, what, page }: { task: BoostTask; error?: string; what: string; page?: { label: string; go: () => void } }) {
  const msg = error ?? task.error
  if (task.status === 'skipped' || (msg && isNotImplemented(msg))) {
    return (
      <span className="flex flex-wrap items-center gap-2">
        <Info className="size-4 text-faint" /> {what}: ainda não disponível nesta versão.
        {page && (
          <button className="inline-flex items-center gap-1 font-medium text-accent hover:underline" onClick={page.go}>
            {page.label} <ArrowRight className="size-3.5" />
          </button>
        )}
      </span>
    )
  }
  if (msg) {
    return (
      <span className="flex flex-wrap items-center gap-2 text-danger">
        <TriangleAlert className="size-4" /> {what}: {msg}
        <button className="inline-flex items-center gap-1 font-medium text-accent hover:underline" onClick={() => void reanalyze()}>
          Analisar de novo <RefreshCw className="size-3.5" />
        </button>
      </span>
    )
  }
  return null
}

function AttentionCard({ state }: { state: BoostState }) {
  const { go } = useNav()
  const manual = state.view?.repairManual ?? []
  const notes = state.view?.notes ?? []
  const discover = state.data.discover
  const discoverAvailable = state.analysis.discover.status === 'done'
  const findings = discover?.findings ?? []
  const discoverBytes = findings.reduce((s, f) => s + (Number.isFinite(f.bytes) ? f.bytes : 0), 0)
  const safeCount = findings.filter((f) => f.verdict === 'safe').length
  if (!manual.length && !notes.length && !discoverAvailable) return null
  return (
    <section className="rounded-xl border border-warn/25 bg-warn/[0.04] p-4" data-testid="boost-attention">
      <h4 className="flex items-center gap-2 text-[14px] font-semibold">
        <ListChecks className="size-4 text-warn" />
        Precisa da sua atenção (fora do plano automático)
      </h4>
      <p className="mt-0.5 text-[12px] text-muted">
        Estes pontos não são aplicados por aqui porque precisam reiniciar, demoram, têm mais risco ou exigem você decidir item a item.
      </p>
      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        {manual.length > 0 && (
          <div className="min-w-0 rounded-lg border border-border bg-surface/70 p-3">
            <p className="flex items-center gap-2 text-[13px] font-medium">
              <Wrench className="size-4 text-accent" /> Erros do sistema ({manual.length})
            </p>
            <ul className="mt-2 space-y-1.5">
              {manual.slice(0, 4).map(({ issue, reason, steps }) => (
                <li key={issue.id} className="text-[12px]">
                  <span className="flex items-center gap-1.5">
                    <SeverityBadge severity={issue.severity} />
                    <span className="truncate font-medium text-text" title={issue.title}>
                      {issue.title}
                    </span>
                  </span>
                  <span className="mt-0.5 block text-muted">{reason}</span>
                  {steps && (
                    <ul className="mt-0.5 space-y-0.5 pl-3 text-faint">
                      {steps.slice(0, 3).map((st) => (
                        <li key={st} className="list-disc">
                          {st}
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
              {manual.length > 4 && <li className="text-[12px] text-faint">+ {manual.length - 4} outros</li>}
            </ul>
            <Button size="sm" className="mt-2.5" icon={Wrench} onClick={() => go('repair')}>
              Abrir Reparar Erros
            </Button>
          </div>
        )}
        {discoverAvailable && (
          <div className="min-w-0 rounded-lg border border-border bg-surface/70 p-3">
            <p className="flex items-center gap-2 text-[13px] font-medium">
              <ScanSearch className="size-4 text-accent" /> Busca Profunda
            </p>
            {discover ? (
              <p className="mt-2 text-[12px] text-muted">
                A última busca achou <b className="text-text">{findings.length}</b> {findings.length === 1 ? 'item' : 'itens'} (
                <b className="text-text">{formatBytes(discoverBytes)}</b>): instaladores esquecidos, sobras de programas, jogos fora dos launchers.
                {safeCount > 0 && ` ${safeCount} parecem seguros para sair.`} Cada um precisa da sua revisão.
              </p>
            ) : (
              <p className="mt-2 text-[12px] text-muted">
                Você ainda não fez a Busca Profunda: ela acha instaladores e repacks baixados, zips já extraídos, sobras de programas desinstalados e jogos
                fora dos launchers — muitas vezes dezenas de GB.
              </p>
            )}
            <Button size="sm" className="mt-2.5" icon={ScanSearch} onClick={() => go('discover')}>
              {discover ? 'Revisar na Busca Profunda' : 'Fazer a Busca Profunda'}
            </Button>
          </div>
        )}
        {notes.length > 0 && (
          <div className="min-w-0 rounded-lg border border-border bg-surface/70 p-3 lg:col-span-2">
            <p className="flex items-center gap-2 text-[13px] font-medium">
              <Info className="size-4 text-info" /> Passos manuais recomendados
            </p>
            <ul className="mt-1.5 space-y-1 text-[12px] text-muted">
              {notes.map((n) => (
                <li key={n}>• {n}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  )
}

// ------------------------------------------------------------------ confirmação

function ConfirmApply({ open, state, effect, onCancel }: { open: boolean; state: BoostState; effect: EffectEstimate; onCancel: () => void }) {
  const chosen = selectedEntries(state.view, state.selected)
  const groups: { id: PlanGroup; label: string; icon: LucideIcon }[] = [
    { id: 'perf', label: 'Otimizações do Windows', icon: Zap },
    { id: 'startup', label: 'Sair da inicialização', icon: Rocket },
    { id: 'repair', label: 'Correções de erros', icon: Wrench },
    { id: 'cleanup', label: 'Limpeza', icon: BrushCleaning }
  ]
  const c = effect.counts
  const steps: string[] = []
  if (state.restorePoint) steps.push('Criar um ponto de restauração do Windows (para voltar o sistema ao estado atual se algo der errado).')
  if (c.perf || c.startup)
    steps.push(
      [c.perf ? `aplicar ${c.perf} ${c.perf === 1 ? 'otimização' : 'otimizações'}` : '', c.startup ? `tirar ${c.startup} ${c.startup === 1 ? 'programa' : 'programas'} da inicialização` : '']
        .filter(Boolean)
        .join(' e ')
        .replace(/^./, (m) => m.toUpperCase()) + '.'
    )
  if ((c.perf || c.startup) && state.restartExplorer && state.data.plan?.explorerRestartHelps)
    steps.push('Reiniciar o Windows Explorer (a barra de tarefas some por 2 segundos; pastas abertas fecham).')
  if (c.repair)
    steps.push(
      `Corrigir ${c.repair} ${c.repair === 1 ? 'erro do sistema' : 'erros do sistema'} de uma vez (com backup quando altera algo${
        selectedEntries(state.view, state.selected).some((e) => e.group === 'repair' && e.requiresAdmin) && !state.isAdmin ? '; um único pedido de permissão para todas' : ''
      }).`
    )
  if (c.cleanup) steps.push(`Limpar ${c.cleanup} ${c.cleanup === 1 ? 'item' : 'itens'} de lixo seguro (cerca de ${formatBytes(effect.bytes)}).`)
  steps.push('Medir de novo e mostrar a comparação Antes x Depois.')

  return (
    <ConfirmDialog
      open={open}
      title="Aplicar o plano?"
      confirmLabel="Sim, aplicar plano"
      onCancel={onCancel}
      onConfirm={() => {
        onCancel()
        void applyPlan()
      }}
      message={
        <div className="space-y-2.5" data-testid="boost-confirm">
          <p>Vamos fazer, nesta ordem:</p>
          <ol className="list-decimal space-y-1 pl-5 text-[13px]">
            {steps.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
          <div className="rounded-lg border border-border bg-surface-2 p-2.5">
            <Checkbox checked={state.restorePoint} onChange={setRestorePoint} label="Criar ponto de restauração antes (recomendado)" />
          </div>
          {!state.restorePoint && (
            <Notice tone="warn" icon={TriangleAlert}>
              Sem ponto de restauração. As otimizações e correções continuam com <b>Desfazer</b> no Histórico, mas não haverá como voltar o sistema inteiro.
            </Notice>
          )}
          {effect.uacPrompts > 0 && (
            <Notice tone="info" icon={ShieldAlert}>
              O Windows pode pedir permissão de administrador (UAC) <b>{effect.uacPrompts === 1 ? 'uma vez' : `até ${effect.uacPrompts} vezes`}</b>. Clique em <b>Sim</b> para
              continuar. Se clicar em <b>Não</b>, respeitamos e paramos.
            </Notice>
          )}
          {effect.closeApps.length > 0 && (
            <Notice tone="warn" icon={TriangleAlert}>
              Feche <b>{appNames(effect.closeApps)}</b> antes de continuar — senão os itens deles são pulados.
            </Notice>
          )}
          {effect.restartNeeded && (
            <Notice tone="info" icon={RotateCcw}>
              Algumas mudanças só têm efeito depois de reiniciar o PC. No fim, você pode pedir para o app lembrar de medir de novo.
            </Notice>
          )}
          <Notice tone="ok" icon={Undo2}>
            Tudo fica registrado no <b>Histórico</b>; o que pode ser desfeito ganha o botão <b>Desfazer</b>.
            {c.cleanup > 0 && ' A limpeza apaga só temporários e caches (não seus arquivos): não tem desfazer, e os programas recriam o que precisarem.'}
          </Notice>
          {effect.noUndo.length > 0 && (
            <Notice tone="neutral" icon={Ban}>
              Sem desfazer (não apagam seus arquivos): {effect.noUndo.join(', ')}.
            </Notice>
          )}
        </div>
      }
      details={
        <div className="space-y-3">
          {groups.map((g) => {
            const list = chosen.filter((e) => e.group === g.id)
            if (!list.length) return null
            return (
              <div key={g.id}>
                <p className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold tracking-wide text-muted uppercase">
                  <g.icon className="size-3.5" /> {g.label} ({list.length})
                </p>
                <ul className="space-y-1 text-[12.5px]">
                  {list.map((e) => (
                    <li key={e.key} className="flex items-center justify-between gap-3">
                      <span className="flex min-w-0 items-center gap-1.5">
                        <span className="truncate">{e.title}</span>
                        {e.requiresAdmin && <ShieldAlert className="size-3.5 shrink-0 text-warn" aria-label="Pede administrador" />}
                        {e.requiresRestart && <RotateCcw className="size-3.5 shrink-0 text-info" aria-label="Precisa reiniciar" />}
                      </span>
                      {e.group === 'cleanup' && <span className="shrink-0 text-muted tabular-nums">{e.sizeUnknown ? '?' : formatBytes(e.bytes)}</span>}
                    </li>
                  ))}
                </ul>
              </div>
            )
          })}
        </div>
      }
    />
  )
}

// ------------------------------------------------------------------ página do plano

export function PlanReview({ state }: { state: BoostState }) {
  const { go } = useNav()
  const [confirmOpen, setConfirmOpen] = useState(false)
  const view = state.view
  const effect = useMemo(
    () => estimateEffect(view, state.selected, { restorePoint: state.restorePoint, isAdmin: state.isAdmin, drives: state.data.snapshot?.drives }),
    [view, state.selected, state.restorePoint, state.isAdmin, state.data.snapshot]
  )
  const stale = planIsStale(state)
  if (!view) return null
  const total = view.perf.length + view.startup.length + view.repair.length + view.cleanup.length
  const perfTask = state.analysis.performance

  return (
    <div className="space-y-4" data-testid="boost-plan">
      <PlanSummary effect={effect} state={state} />

      <div className="space-y-3 rounded-xl border border-border bg-surface/80 p-3.5">
        <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
          <Toggle
            checked={state.restorePoint}
            onChange={setRestorePoint}
            label="Criar ponto de restauração do Windows antes de aplicar (recomendado)"
            description="Uma “foto” do sistema para voltar atrás se algo der errado. Feito junto com as otimizações, no mesmo pedido de permissão."
          />
          {!state.isAdmin && (
            <p className="flex shrink-0 items-center gap-1.5 text-[12px] text-muted md:max-w-[300px]">
              <ShieldCheck className="size-4 shrink-0 text-info" />
              <span>
                Itens com <b className="text-warn">Administrador</b> fazem o Windows pedir permissão.
              </span>
            </p>
          )}
        </div>
        {state.data.plan?.explorerRestartHelps && (
          <div className="border-t border-border/60 pt-3" data-testid="boost-explorer-toggle">
            <Toggle
              checked={state.restartExplorer}
              onChange={setRestartExplorer}
              label="Reiniciar o Windows Explorer no final"
              description="Algumas mudanças (como a pesquisa do Iniciar) passam a valer na hora. A barra de tarefas some por 2 segundos e as pastas abertas fecham. Sem isso, valem no próximo boot."
            />
          </div>
        )}
      </div>

      {total === 0 && (
        <Notice tone="ok" icon={Sparkles}>
          <b>Nada para aplicar agora.</b> A análise não encontrou otimizações, erros com correção rápida ou lixo seguro para limpar. Veja abaixo o que precisa da
          sua atenção.
        </Notice>
      )}

      <SectionShell
        testId="boost-section-perf"
        icon={Zap}
        title="Otimizações do Windows"
        subtitle="Ajustes escolhidos para ESTE PC (energia, jogos, serviços, disco). Cada um tem o porquê e, quando possível, Desfazer."
        group="perf"
        entries={view.perf}
        subgroups={perfSubgroups(view.perf)}
        selected={state.selected}
      >
        {perfTask.status === 'error' || state.data.planError ? (
          <Unavailable task={perfTask} error={state.data.planError} what="Plano de otimizações" page={{ label: 'Ver Desempenho', go: () => go('performance') }} />
        ) : perfTask.status === 'skipped' ? (
          <Unavailable task={perfTask} what="Diagnóstico de desempenho" />
        ) : (
          <span className="flex items-center gap-2">
            <ShieldCheck className="size-4 text-ok" /> Nenhum ajuste necessário: o Windows já está bem configurado para este PC.
          </span>
        )}
      </SectionShell>

      {(view.startup.length > 0 || (!state.data.planError && perfTask.status === 'done')) && (
        <SectionShell
          testId="boost-section-startup"
          icon={Rocket}
          title="Programas que abrem com o Windows"
          subtitle="Vêm marcados só launchers, atualizadores e entradas quebradas. Chat, nuvem e periféricos (Discord, OneDrive...) ficam desmarcados: você decide. Tirar da inicialização não desinstala nada e dá para desfazer."
          group="startup"
          entries={view.startup}
          selected={state.selected}
        >
          <span className="flex items-center gap-2">
            <ShieldCheck className="size-4 text-ok" /> Nenhum programa pesado sobrando na inicialização.
          </span>
        </SectionShell>
      )}

      <SectionShell
        testId="boost-section-repair"
        icon={Wrench}
        title="Erros do sistema com correção rápida"
        subtitle="Só correções de risco baixo e que não exigem reiniciar. Erros de verdade — nada de “limpeza de registro”, que não acelera e pode quebrar coisas."
        group="repair"
        entries={view.repair}
        selected={state.selected}
      >
        {state.analysis.repair.status === 'done' ? (
          <span className="flex items-center gap-2">
            <ShieldCheck className="size-4 text-ok" />
            {(state.data.repair?.issues?.length ?? 0) > 0 ? 'Nenhum erro com correção rápida. Os demais estão em “Precisa da sua atenção”.' : 'Nenhum erro encontrado na verificação rápida.'}
          </span>
        ) : (
          <Unavailable task={state.analysis.repair} what="Verificação de erros" page={{ label: 'Abrir Reparar Erros', go: () => go('repair') }} />
        )}
      </SectionShell>

      <SectionShell
        testId="boost-section-cleanup"
        icon={BrushCleaning}
        title="Lixo seguro para limpar"
        subtitle="Somente itens classificados como seguros: temporários, caches e restos. Arquivos em uso são pulados automaticamente."
        group="cleanup"
        entries={view.cleanup}
        selected={state.selected}
      >
        {state.analysis.cleanup.status === 'done' ? (
          <span className="flex items-center gap-2">
            <ShieldCheck className="size-4 text-ok" /> Nada de lixo seguro acumulado agora.
          </span>
        ) : (
          <Unavailable task={state.analysis.cleanup} what="Análise de limpeza" page={{ label: 'Abrir Limpeza', go: () => go('cleanup') }} />
        )}
      </SectionShell>

      <AttentionCard state={state} />

      {/* Barra fixa: total escolhido + aplicar */}
      <div className="sticky bottom-4 z-20" data-testid="boost-apply-bar">
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border-strong bg-surface/95 px-5 py-3.5 shadow-2xl shadow-black/40 backdrop-blur">
          <div className="min-w-0">
            <p className="text-[14px]">
              {effect.counts.total === 0 ? (
                <span className="text-muted">Nada marcado. Marque o que deseja aplicar.</span>
              ) : (
                <>
                  <b className="tabular-nums">{effect.counts.total}</b> {effect.counts.total === 1 ? 'item escolhido' : 'itens escolhidos'}
                  {effect.bytes > 0 && (
                    <>
                      {' '}
                      · <b className="text-accent tabular-nums">{formatBytes(effect.bytes)}</b>
                    </>
                  )}{' '}
                  · efeito <b style={{ color: toneVar(EFFECT_TONE[effect.level]) }}>{EFFECT_LABEL[effect.level].toLowerCase()}</b>
                </>
              )}
            </p>
            <p className="mt-0.5 flex items-center gap-1.5 text-[12px] text-faint">
              {stale ? (
                <>
                  <Clock className="size-3.5 text-warn" /> O plano tem mais de 30 minutos: analise de novo antes de aplicar.
                </>
              ) : (
                <>
                  <ShieldCheck className="size-3.5 text-ok" /> Nada foi alterado até agora. Você confirma antes de qualquer mudança.
                </>
              )}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button variant={stale ? 'primary' : 'ghost'} icon={RefreshCw} onClick={() => void reanalyze()}>
              Analisar de novo
            </Button>
            <Button variant="ai" size="lg" icon={Zap} disabled={stale || effect.counts.total === 0} onClick={() => setConfirmOpen(true)} data-testid="boost-apply">
              Aplicar plano
            </Button>
          </div>
        </div>
      </div>

      <ConfirmApply open={confirmOpen} state={state} effect={effect} onCancel={() => setConfirmOpen(false)} />
    </div>
  )
}
