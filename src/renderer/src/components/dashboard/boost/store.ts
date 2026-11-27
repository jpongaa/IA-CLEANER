// "Otimizar tudo": 1) mede ANTES, 2) analisa (somente leitura), 3) monta o plano revisável, 4) aplica SÓ o que o usuário
// marcou e confirmou, 5) mede DEPOIS e compara. Estado em nível de módulo (fora do React) para o fluxo não se perder
// ao trocar de página. Cada etapa tolera falha/ausência do backend: o que não existe vira "indisponível", nunca trava.
import { useSyncExternalStore } from 'react'
import type { TaskProgress } from '@shared/types/common'
import type { BoostBatchResult, BoostPlan, PerformanceSnapshot, SpeedMeasurement } from '@shared/types/performance'
import type { CleanupEstimate, CleanupRunReport } from '@shared/types/cleanup'
import type { RepairBatchResult, RepairReport } from '@shared/types/repair'
import type { DiscoverReport } from '@shared/types/discover'
import type { EventName } from '@shared/events'
import { api, errMsg } from '../../../lib/api'
import { isNotImplemented } from '../insights'
import { getFormatLocale } from '@shared/format'
import {
  buildPlanView,
  clearReminder,
  defaultSelection,
  measurementFromSnapshot,
  saveReminder,
  selectedEntries,
  type PlanEntry,
  type PlanGroup,
  type PlanView
} from './logic'

export type BoostStage = 'idle' | 'measuring' | 'analyzing' | 'plan' | 'applying' | 'stopped' | 'measuringAfter' | 'done'
export type TaskStatus = 'pending' | 'running' | 'done' | 'error' | 'skipped'

export interface BoostTask {
  status: TaskStatus
  message?: string
  percent?: number
  error?: string
  /** Observação (ex.: motivo de ter pulado, resumo do resultado) */
  note?: string
  startedAt?: number
  finishedAt?: number
}

export type AnalysisId = 'performance' | 'cleanup' | 'repair' | 'discover'
export type ApplyId = 'restore' | 'perf' | 'repair' | 'cleanup'

export interface MeasureSlot {
  m?: SpeedMeasurement
  /** Medição aproximada (derivada do diagnóstico) */
  approx?: boolean
  task: BoostTask
}

export interface RepairOutcome {
  key: string
  issueId: string
  fixId: string
  title: string
  ok: boolean
  message: string
  cancelled?: boolean
  skipped?: boolean
  logId?: string
  /** A correção só vale depois de reiniciar o PC */
  requiresRestart?: boolean
  /** Tem Desfazer no Histórico (informado pelo lote) */
  reversible?: boolean
}

export interface BoostData {
  snapshot?: PerformanceSnapshot
  plan?: BoostPlan
  planError?: string
  estimate?: CleanupEstimate
  repair?: RepairReport
  /** null = nenhuma Busca Profunda feita ainda */
  discover?: DiscoverReport | null
}

export interface UndoState {
  status: 'running' | 'done' | 'error'
  batch?: BoostBatchResult
  repair: { title: string; ok: boolean; message: string }[]
  error?: string
}

export interface ApplyState {
  tasks: Record<ApplyId, BoostTask>
  /** Itens escolhidos no momento de aplicar (para o relatório) */
  chosen: PlanEntry[]
  restoreRequested: boolean
  explorerRequested?: boolean
  /** "Desfazer o que foi aplicado" (depois do resultado) */
  undo?: UndoState
  batch?: BoostBatchResult
  batchError?: string
  restoreError?: string
  repair: RepairOutcome[]
  /** Resumo do lote de correções (repair.fixBatch); ausente quando o backend não tem o lote e foi uma por uma */
  repairBatch?: { elevatedOnce?: boolean; cancelled?: boolean; oneByOne?: boolean }
  cleanup?: CleanupRunReport
  cleanupError?: string
  /** Fluxo interrompido (UAC negado, ponto de restauração falhou...) */
  stopped?: { reason: string; canRetryWithoutRestore: boolean; anythingApplied: boolean }
}

export interface BoostState {
  stage: BoostStage
  startedAt?: number
  finishedAt?: number
  before: MeasureSlot
  after: MeasureSlot
  analysis: Record<AnalysisId, BoostTask>
  data: BoostData
  view?: PlanView
  selected: Record<string, boolean>
  restorePoint: boolean
  /** Reiniciar o Explorer no fim do lote (só oferecido quando o plano diz que ajuda) */
  restartExplorer: boolean
  planBuiltAt?: number
  isAdmin: boolean
  apply: ApplyState
  cancelRequested: boolean
  reminderSaved: boolean
}

const pending = (): BoostTask => ({ status: 'pending' })

function freshAnalysis(): Record<AnalysisId, BoostTask> {
  return { performance: pending(), cleanup: pending(), repair: pending(), discover: pending() }
}

function freshApply(): ApplyState {
  return { tasks: { restore: pending(), perf: pending(), repair: pending(), cleanup: pending() }, chosen: [], restoreRequested: true, repair: [] }
}

function initial(): BoostState {
  return {
    stage: 'idle',
    before: { task: pending() },
    after: { task: pending() },
    analysis: freshAnalysis(),
    data: {},
    selected: {},
    restorePoint: true,
    restartExplorer: false,
    isAdmin: false,
    apply: freshApply(),
    cancelRequested: false,
    reminderSaved: false
  }
}

let state: BoostState = initial()
const listeners = new Set<() => void>()

function setState(updater: (s: BoostState) => BoostState): void {
  state = updater(state)
  for (const l of listeners) l()
}

function subscribe(l: () => void): () => void {
  listeners.add(l)
  return () => listeners.delete(l)
}

export function getBoostState(): BoostState {
  return state
}

export function useBoost(): BoostState {
  return useSyncExternalStore(subscribe, getBoostState)
}

export function isBoostBusy(s: BoostState = state): boolean {
  return s.stage === 'measuring' || s.stage === 'analyzing' || s.stage === 'applying' || s.stage === 'measuringAfter'
}

// ------------------------------------------------------------------ utilidades

function pct(p: TaskProgress): number | undefined {
  if (typeof p.percent === 'number' && Number.isFinite(p.percent)) return Math.max(0, Math.min(100, p.percent))
  if (typeof p.current === 'number' && typeof p.total === 'number' && p.total > 0) return Math.max(0, Math.min(100, (p.current / p.total) * 100))
  return undefined
}

function listen(event: EventName, fn: (p: TaskProgress) => void): () => void {
  try {
    return api.on(event as 'perf:progress', (p) => {
      if (p && typeof p === 'object') fn(p)
    })
  } catch {
    return () => undefined
  }
}

function patchAnalysis(id: AnalysisId, patch: Partial<BoostTask>): void {
  setState((s) => ({ ...s, analysis: { ...s.analysis, [id]: { ...s.analysis[id], ...patch } } }))
}

function patchApply(id: ApplyId, patch: Partial<BoostTask>): void {
  setState((s) => ({ ...s, apply: { ...s.apply, tasks: { ...s.apply.tasks, [id]: { ...s.apply.tasks[id], ...patch } } } }))
}

function patchSlot(which: 'before' | 'after', patch: Partial<MeasureSlot>, task?: Partial<BoostTask>): void {
  setState((s) => ({ ...s, [which]: { ...s[which], ...patch, task: { ...s[which].task, ...(task ?? {}) } } }))
}

function progressTo(target: (patch: Partial<BoostTask>) => void, current: () => BoostTask) {
  return (p: TaskProgress): void => {
    const t = current()
    if (t.status !== 'running') return
    target({ message: p.message || p.phase || t.message, percent: pct(p) ?? t.percent })
  }
}

const NOT_AVAILABLE = 'Ainda não disponível nesta versão'

// ------------------------------------------------------------------ 1) medir antes

async function measure(which: 'before' | 'after', label: string): Promise<void> {
  patchSlot(
    which,
    { m: undefined, approx: false },
    { status: 'running', startedAt: Date.now(), message: undefined, percent: undefined, error: undefined, note: undefined }
  )
  const unsub = listen(
    'perf:progress',
    progressTo(
      (p) => patchSlot(which, {}, p),
      () => state[which].task
    )
  )
  try {
    const m = await api.performance.measure(label)
    patchSlot(which, { m, approx: false }, { status: 'done', finishedAt: Date.now(), percent: 100 })
  } catch (e) {
    const msg = errMsg(e)
    if (which === 'before') {
      // Sem a medição detalhada: segue e compara pelo diagnóstico (marcado como aproximado).
      patchSlot(
        which,
        { approx: true },
        {
          status: 'skipped',
          finishedAt: Date.now(),
          note: isNotImplemented(msg)
            ? 'Medição detalhada indisponível nesta versão: vamos comparar pelo diagnóstico.'
            : `A medição falhou (${msg}). Vamos comparar pelo diagnóstico.`
        }
      )
    } else {
      patchSlot(which, {}, { status: 'error', finishedAt: Date.now(), error: msg })
    }
  } finally {
    unsub()
  }
}

/** Medição aproximada "Depois": nova coleta do diagnóstico (somente leitura). */
async function measureAfterApprox(): Promise<void> {
  patchSlot(
    'after',
    { m: undefined, approx: true },
    { status: 'running', startedAt: Date.now(), message: 'Refazendo o diagnóstico…', percent: undefined, error: undefined }
  )
  const unsub = listen(
    'perf:progress',
    progressTo(
      (p) => patchSlot('after', {}, p),
      () => state.after.task
    )
  )
  try {
    const snap = await api.performance.collect()
    setState((s) => ({ ...s, data: { ...s.data, snapshot: snap } }))
    patchSlot('after', { m: measurementFromSnapshot(snap, 'Depois de otimizar'), approx: true }, { status: 'done', finishedAt: Date.now(), percent: 100 })
  } catch (e) {
    patchSlot('after', {}, { status: 'error', finishedAt: Date.now(), error: errMsg(e) })
  } finally {
    unsub()
  }
}

// ------------------------------------------------------------------ 2) analisar

async function runAnalysisTask(id: AnalysisId, fn: () => Promise<string | void>): Promise<void> {
  patchAnalysis(id, { status: 'running', startedAt: Date.now(), message: undefined, percent: undefined, error: undefined, note: undefined })
  try {
    const note = await fn()
    patchAnalysis(id, { status: 'done', finishedAt: Date.now(), percent: 100, note: note || undefined })
  } catch (e) {
    const msg = errMsg(e)
    if (isNotImplemented(msg)) patchAnalysis(id, { status: 'skipped', finishedAt: Date.now(), note: NOT_AVAILABLE })
    else if (state.cancelRequested) patchAnalysis(id, { status: 'skipped', finishedAt: Date.now(), note: 'Cancelado por você' })
    else patchAnalysis(id, { status: 'error', finishedAt: Date.now(), error: msg })
  }
}

async function runAnalysis(): Promise<void> {
  setState((s) => ({ ...s, stage: 'analyzing', analysis: freshAnalysis(), data: {}, view: undefined, selected: {}, planBuiltAt: undefined }))
  const unsubs = [
    listen(
      'perf:progress',
      progressTo(
        (p) => patchAnalysis('performance', p),
        () => state.analysis.performance
      )
    ),
    listen(
      'cleanup:progress',
      progressTo(
        (p) => patchAnalysis('cleanup', p),
        () => state.analysis.cleanup
      )
    ),
    listen(
      'repair:progress',
      progressTo(
        (p) => patchAnalysis('repair', p),
        () => state.analysis.repair
      )
    )
  ]
  try {
    // As quatro análises são independentes e só leem: rodam juntas para o usuário esperar menos.
    await Promise.allSettled([
      runAnalysisTask('performance', async () => {
        const snapshot = await api.performance.collect()
        setState((s) => ({ ...s, data: { ...s.data, snapshot } }))
        patchAnalysis('performance', { message: 'Montando o plano sob medida para este PC…' })
        try {
          const plan = await api.performance.getBoostPlan()
          setState((s) => ({ ...s, data: { ...s.data, plan } }))
          const n = (plan.items?.length ?? 0) + (plan.startupToDisable?.length ?? 0)
          return `${snapshot.findings?.filter((f) => f.severity !== 'info').length ?? 0} pontos encontrados · ${n} ${n === 1 ? 'sugestão' : 'sugestões'}`
        } catch (e) {
          const msg = errMsg(e)
          setState((s) => ({ ...s, data: { ...s.data, planError: msg } }))
          return isNotImplemented(msg) ? 'Diagnóstico pronto (plano automático indisponível nesta versão)' : `Diagnóstico pronto, mas o plano falhou: ${msg}`
        }
      }),
      runAnalysisTask('cleanup', async () => {
        const estimate = await api.cleanup.estimate()
        setState((s) => ({ ...s, data: { ...s.data, estimate } }))
        return undefined
      }),
      runAnalysisTask('repair', async () => {
        const repair = await api.repair.scan({ deep: false })
        setState((s) => ({ ...s, data: { ...s.data, repair } }))
        const n = repair.issues?.length ?? 0
        return n ? `${n} ${n === 1 ? 'problema encontrado' : 'problemas encontrados'}` : 'Nenhum erro encontrado'
      }),
      runAnalysisTask('discover', async () => {
        const discover = await api.discover.getLastReport()
        setState((s) => ({ ...s, data: { ...s.data, discover: discover ?? null } }))
        const n = discover?.findings?.length ?? 0
        return discover ? `Última busca: ${n} ${n === 1 ? 'achado' : 'achados'} para você revisar` : 'Nenhuma Busca Profunda feita ainda'
      })
    ])
  } finally {
    for (const u of unsubs) u()
  }

  if (state.cancelRequested) {
    closeBoost(true)
    return
  }
  const data = state.data
  // Sem medição detalhada: o "Antes" vem do diagnóstico recém-coletado.
  if (state.before.approx && !state.before.m && data.snapshot) patchSlot('before', { m: measurementFromSnapshot(data.snapshot, 'Antes de otimizar') })
  const view = buildPlanView({ plan: data.plan, snapshot: data.snapshot, estimate: data.estimate, repair: data.repair })
  setState((s) => ({ ...s, stage: 'plan', view, selected: defaultSelection(view), planBuiltAt: Date.now() }))
}

// ------------------------------------------------------------------ API pública

/** Começa o fluxo (ignora se já estiver em andamento). Nada é alterado até o usuário clicar em "Aplicar plano". */
export async function startBoost(): Promise<void> {
  if (isBoostBusy() || state.stage === 'plan') return
  setState(() => ({ ...initial(), stage: 'measuring', startedAt: Date.now(), restorePoint: true }))
  try {
    const info = await api.system.getAppInfo()
    setState((s) => ({ ...s, isAdmin: Boolean(info?.isAdmin) }))
  } catch {
    // sem a informação: assume modo usuário (avisa sobre o UAC)
  }
  await measure('before', 'Antes de otimizar')
  if (state.cancelRequested) {
    closeBoost(true)
    return
  }
  await runAnalysis()
}

/** Refaz a análise (o "Antes" é mantido). */
export async function reanalyze(): Promise<void> {
  if (isBoostBusy()) return
  setState((s) => ({ ...s, cancelRequested: false }))
  await runAnalysis()
}

/** Cancela a medição/análise (nada foi alterado) ou para a aplicação depois da etapa atual. */
export function cancelBoost(): void {
  if (!isBoostBusy()) return
  setState((s) => ({ ...s, cancelRequested: true }))
  if (state.stage === 'analyzing') {
    if (state.analysis.cleanup.status === 'running') api.cleanup.cancel().catch(() => undefined)
    if (state.analysis.repair.status === 'running') api.repair.cancel().catch(() => undefined)
  }
  if (state.stage === 'applying' && state.apply.tasks.cleanup.status === 'running') api.cleanup.cancel().catch(() => undefined)
}

/** Fecha o painel do fluxo (não durante uma etapa em andamento, a não ser internamente após cancelar). */
export function closeBoost(force = false): void {
  if (!force && isBoostBusy()) return
  setState(() => initial())
}

export function toggleEntry(key: string, value: boolean): void {
  if (state.stage !== 'plan') return
  setState((s) => ({ ...s, selected: { ...s.selected, [key]: value } }))
}

export function setGroup(group: PlanGroup, value: boolean): void {
  if (state.stage !== 'plan' || !state.view) return
  const keys = state.view[group].map((e) => e.key)
  setState((s) => {
    const sel = { ...s.selected }
    for (const k of keys) sel[k] = value
    return { ...s, selected: sel }
  })
}

export function setRestorePoint(value: boolean): void {
  if (state.stage !== 'plan') return
  setState((s) => ({ ...s, restorePoint: value }))
}

export function setRestartExplorer(value: boolean): void {
  if (state.stage !== 'plan') return
  setState((s) => ({ ...s, restartExplorer: value }))
}

/** Plano montado há mais de 30 min: analisar de novo antes de aplicar (o PC pode ter mudado). */
export const PLAN_MAX_AGE_MS = 30 * 60_000

export function planIsStale(s: BoostState = state, now = Date.now()): boolean {
  return Boolean(s.planBuiltAt && now - s.planBuiltAt > PLAN_MAX_AGE_MS)
}

function skipRemaining(reason: string): void {
  setState((s) => {
    const tasks = { ...s.apply.tasks }
    for (const k of Object.keys(tasks) as ApplyId[]) if (tasks[k].status === 'pending') tasks[k] = { status: 'skipped', note: reason, finishedAt: Date.now() }
    return { ...s, apply: { ...s.apply, tasks } }
  })
}

function stop(reason: string, canRetryWithoutRestore: boolean): void {
  const anythingApplied =
    Boolean(state.apply.batch?.results?.some((r) => r.ok)) ||
    state.apply.repair.some((r) => r.ok) ||
    Boolean(state.apply.cleanup?.results?.some((r) => r.bytesFreed > 0 || r.filesDeleted > 0))
  skipRemaining('Não executado: o processo foi interrompido')
  setState((s) => ({ ...s, stage: 'stopped', apply: { ...s.apply, stopped: { reason, canRetryWithoutRestore, anythingApplied } } }))
}

/**
 * Aplica SÓ os itens marcados (chamado depois da confirmação na interface). Ordem: ponto de restauração +
 * otimizações (um único UAC) -> correções de erros -> limpeza -> medir depois. Falhas aparecem item a item.
 */
export async function applyPlan(opts: { withoutRestorePoint?: boolean } = {}): Promise<void> {
  if (state.stage !== 'plan' && state.stage !== 'stopped') return
  const chosen = selectedEntries(state.view, state.selected)
  if (chosen.length === 0) return
  const restore = state.restorePoint && !opts.withoutRestorePoint
  const perfIds = chosen.filter((e) => e.group === 'perf' && e.actionId).map((e) => e.actionId!)
  const startupIds = chosen.filter((e) => e.group === 'startup' && e.startupId).map((e) => e.startupId!)
  const repairs = chosen.filter((e) => e.group === 'repair' && e.issueId && e.fixId)
  const targetIds = chosen.filter((e) => e.group === 'cleanup' && e.targetId).map((e) => e.targetId!)
  const hasBatch = perfIds.length + startupIds.length > 0
  const restartExplorer = hasBatch && state.restartExplorer && Boolean(state.data.plan?.explorerRestartHelps)

  const apply = freshApply()
  apply.chosen = chosen
  apply.restoreRequested = restore
  apply.explorerRequested = restartExplorer
  if (!restore) apply.tasks.restore = { status: 'skipped', note: opts.withoutRestorePoint ? 'Você escolheu continuar sem' : 'Desligado por você' }
  if (!hasBatch) apply.tasks.perf = { status: 'skipped', note: 'Nada escolhido' }
  if (!repairs.length) apply.tasks.repair = { status: 'skipped', note: 'Nada escolhido' }
  if (!targetIds.length) apply.tasks.cleanup = { status: 'skipped', note: 'Nada escolhido' }
  setState((s) => ({ ...s, stage: 'applying', apply, cancelRequested: false, after: { task: pending() }, reminderSaved: false }))

  const unsubs = [
    listen('perf:progress', (p) => {
      const id: ApplyId | null = state.apply.tasks.perf.status === 'running' ? 'perf' : state.apply.tasks.restore.status === 'running' ? 'restore' : null
      if (id)
        progressTo(
          (x) => patchApply(id, x),
          () => state.apply.tasks[id]
        )(p)
    }),
    listen(
      'repair:progress',
      progressTo(
        (p) => patchApply('repair', p),
        () => state.apply.tasks.repair
      )
    ),
    listen(
      'cleanup:progress',
      progressTo(
        (p) => patchApply('cleanup', p),
        () => state.apply.tasks.cleanup
      )
    )
  ]

  try {
    // ---- 1) ponto de restauração + otimizações/inicialização (um único pedido de administrador)
    if (hasBatch) {
      const t0 = Date.now()
      if (restore) patchApply('restore', { status: 'running', startedAt: t0, message: 'Criando o ponto de restauração (o Windows pode pedir permissão)…' })
      patchApply('perf', { status: 'running', startedAt: t0, message: restore ? 'Aguardando o ponto de restauração…' : 'Aplicando…' })
      let batch: BoostBatchResult | undefined
      try {
        batch = await api.performance.applyBatch({
          actionIds: perfIds,
          startupIdsToDisable: startupIds,
          createRestorePoint: restore,
          ...(restartExplorer ? { restartExplorer: true } : {})
        })
      } catch (e) {
        const msg = errMsg(e)
        const text = isNotImplemented(msg) ? 'Aplicar otimizações em lote ainda não está disponível nesta versão.' : msg
        setState((s) => ({ ...s, apply: { ...s.apply, batchError: text } }))
        if (restore) patchApply('restore', { status: 'error', finishedAt: Date.now(), error: 'Não foi criado (a etapa não rodou).' })
        patchApply('perf', { status: 'error', finishedAt: Date.now(), error: text })
        if (restore) {
          stop(
            `As otimizações não puderam ser aplicadas e o ponto de restauração não foi criado: ${text} Para não mexer no PC sem a rede de segurança, paramos aqui.`,
            true
          )
          return
        }
      }
      if (batch) {
        const results = Array.isArray(batch.results) ? batch.results : []
        setState((s) => ({ ...s, apply: { ...s.apply, batch: { ...batch!, results } } }))
        if (restore) {
          const rp = batch.restorePoint
          if (rp?.ok) patchApply('restore', { status: 'done', finishedAt: Date.now(), note: rp.message })
          else if (rp?.cancelled || batch.cancelled)
            patchApply('restore', { status: 'skipped', finishedAt: Date.now(), note: 'Permissão de administrador negada' })
          else {
            const err = rp?.message || 'O Windows não confirmou a criação do ponto de restauração.'
            setState((s) => ({ ...s, apply: { ...s.apply, restoreError: err } }))
            patchApply('restore', { status: 'error', finishedAt: Date.now(), error: err })
          }
        }
        const ok = results.filter((r) => r.ok).length
        const skipped = results.filter((r) => !r.ok && r.skipped).length
        const failed = results.length - ok - skipped
        if (batch.cancelled && ok === 0) {
          patchApply('perf', { status: 'skipped', finishedAt: Date.now(), note: 'Permissão de administrador negada: nada foi alterado' })
        } else if (results.length === 0) {
          patchApply('perf', {
            status: 'skipped',
            finishedAt: Date.now(),
            note: restore && !batch.restorePoint?.ok ? 'Não executado: o ponto de restauração não foi criado' : 'Nada foi executado'
          })
        } else {
          patchApply('perf', {
            status: failed && !ok ? 'error' : 'done',
            finishedAt: Date.now(),
            percent: 100,
            note: `${ok} de ${results.length} aplicados${failed ? ` · ${failed} com falha` : ''}${skipped ? ` · ${skipped} pulados` : ''}`,
            error: failed && !ok ? 'Nenhum item foi aplicado' : undefined
          })
        }
        if (batch.cancelled) {
          stop('Você negou a permissão de administrador (UAC). Para respeitar sua escolha, os próximos passos não foram executados.', false)
          return
        }
        if (restore && !batch.restorePoint?.ok && ok === 0) {
          stop(
            `O ponto de restauração não foi criado${state.apply.restoreError ? `: ${state.apply.restoreError}` : '.'} Nenhuma otimização foi aplicada. Você pode continuar sem ele ou voltar ao plano.`,
            true
          )
          return
        }
      }
    } else if (restore) {
      patchApply('restore', { status: 'running', startedAt: Date.now(), message: 'Criando o ponto de restauração (o Windows pode pedir permissão)…' })
      let rp
      try {
        rp = await api.performance.createRestorePoint('IA Cleaner: antes de "Otimizar tudo"')
      } catch (e) {
        rp = { ok: false, message: errMsg(e) }
      }
      if (rp.ok) patchApply('restore', { status: 'done', finishedAt: Date.now(), note: rp.message })
      else {
        patchApply('restore', {
          status: rp.cancelled ? 'skipped' : 'error',
          finishedAt: Date.now(),
          error: rp.cancelled ? undefined : rp.message,
          note: rp.cancelled ? 'Permissão de administrador negada' : undefined
        })
        setState((s) => ({ ...s, apply: { ...s.apply, restoreError: rp.message } }))
        stop(
          rp.cancelled
            ? 'Você negou a permissão para criar o ponto de restauração. Nada foi alterado. Você pode continuar sem ele ou voltar ao plano.'
            : `O ponto de restauração não foi criado: ${rp.message} Nada foi alterado. Você pode continuar sem ele ou voltar ao plano.`,
          true
        )
        return
      }
    }

    if (state.cancelRequested) {
      stop('Você pediu para parar. O que já foi feito está listado abaixo e no Histórico.', false)
      return
    }

    // ---- 2) correções de erros: todas num lote só (repair.fixBatch = um único pedido de administrador);
    //         cada uma revalida no backend e guarda backup quando altera algo.
    if (repairs.length) {
      const needsAdmin = !state.isAdmin && repairs.some((e) => e.requiresAdmin)
      patchApply('repair', {
        status: 'running',
        startedAt: Date.now(),
        message: needsAdmin ? 'Corrigindo (o Windows pede permissão uma vez para todas)…' : 'Corrigindo…'
      })
      const { cancelled } = await runRepairBatch(repairs)
      const res = state.apply.repair
      const ok = res.filter((r) => r.ok).length
      const anyFailed = res.some((r) => !r.ok && !r.skipped && !r.cancelled)
      if (cancelled) {
        // UAC negado: respeita a escolha e para (a limpeza não roda). As que não precisavam de admin podem ter rodado.
        patchApply('repair', {
          status: ok ? 'done' : 'skipped',
          finishedAt: Date.now(),
          note: ok
            ? `${ok} de ${res.length} corrigidos · permissão de administrador negada para as demais`
            : 'Permissão de administrador negada: nada foi corrigido'
        })
        stop(
          `Você negou a permissão de administrador (UAC) para as correções de erros. ${
            ok ? 'Só as que não precisavam de permissão foram aplicadas' : 'Nenhuma correção foi aplicada'
          } e, para respeitar sua escolha, a limpeza não foi executada.`,
          false
        )
        return
      }
      const batchInfo = state.apply.repairBatch
      patchApply('repair', {
        status: ok === 0 && anyFailed ? 'error' : 'done',
        finishedAt: Date.now(),
        percent: 100,
        note: `${ok} de ${res.length} corrigidos${batchInfo?.elevatedOnce ? ' · um único pedido de permissão' : ''}`,
        error: ok === 0 && anyFailed ? 'Nenhuma correção funcionou' : undefined
      })
    }

    if (state.cancelRequested) {
      stop('Você pediu para parar. O que já foi feito está listado abaixo e no Histórico.', false)
      return
    }

    // ---- 3) limpeza dos itens seguros escolhidos
    if (targetIds.length) {
      patchApply('cleanup', { status: 'running', startedAt: Date.now() })
      try {
        const report = await api.cleanup.run({ targetIds })
        const results = Array.isArray(report.results) ? report.results : []
        setState((s) => ({ ...s, apply: { ...s.apply, cleanup: { ...report, results } } }))
        const failed = results.filter((r) => r.status === 'failed').length
        patchApply('cleanup', {
          status: report.cancelled ? 'skipped' : failed && failed === results.length ? 'error' : 'done',
          finishedAt: Date.now(),
          percent: 100,
          note: report.cancelled
            ? 'Cancelada'
            : `Liberados ${formatBytesShort(report.totalFreed)}${report.adminDenied ? ' · itens do sistema pulados (permissão negada)' : ''}`,
          error: failed && failed === results.length ? 'Nenhum item pôde ser limpo' : undefined
        })
      } catch (e) {
        const msg = errMsg(e)
        const text = isNotImplemented(msg) ? 'Limpeza ainda não disponível nesta versão.' : msg
        setState((s) => ({ ...s, apply: { ...s.apply, cleanupError: text } }))
        patchApply('cleanup', { status: 'error', finishedAt: Date.now(), error: text })
      }
    }
  } finally {
    for (const u of unsubs) u()
  }

  // ---- 4) medir depois (mesmos critérios do "Antes")
  await measureAfter()
}

function repairBase(e: PlanEntry): Pick<RepairOutcome, 'key' | 'issueId' | 'fixId' | 'title'> {
  return { key: e.key, issueId: e.issueId!, fixId: e.fixId!, title: e.title }
}

/**
 * Aplica as correções escolhidas com repair.fixBatch (um único UAC para as que exigem administrador) e guarda o
 * resultado item a item. Se o backend ainda não tem o lote, cai para uma por uma (repair.fix).
 */
async function runRepairBatch(repairs: PlanEntry[]): Promise<{ cancelled: boolean }> {
  let res: RepairBatchResult
  try {
    res = await api.repair.fixBatch(repairs.map((e) => ({ issueId: e.issueId!, fixId: e.fixId! })))
  } catch (err) {
    const msg = errMsg(err)
    if (isNotImplemented(msg)) return runRepairOneByOne(repairs)
    const outs: RepairOutcome[] = repairs.map((e) => ({ ...repairBase(e), ok: false, message: `As correções não puderam ser aplicadas: ${msg}` }))
    setState((s) => ({ ...s, apply: { ...s.apply, repair: outs, repairBatch: {} } }))
    return { cancelled: false }
  }
  const results = Array.isArray(res?.results) ? res.results : []
  const cancelled = Boolean(res?.cancelled)
  const used = new Set<number>()
  const outs: RepairOutcome[] = repairs.map((e) => {
    const i = results.findIndex((r, k) => !used.has(k) && r && r.issueId === e.issueId && r.fixId === e.fixId)
    const r = i >= 0 ? results[i] : undefined
    if (i >= 0) used.add(i)
    if (!r) {
      return {
        ...repairBase(e),
        ok: false,
        skipped: true,
        cancelled: cancelled || undefined,
        message: cancelled ? 'Permissão de administrador negada: não corrigido.' : 'Não executado (o app não recebeu o resultado desta correção).'
      }
    }
    return {
      ...repairBase(e),
      ok: Boolean(r.ok),
      message: r.message || (r.ok ? 'Corrigido.' : 'Falhou.'),
      cancelled: !r.ok && (r.cancelled || cancelled) ? true : undefined,
      logId: r.logId,
      requiresRestart: r.requiresRestart,
      reversible: r.reversible
    }
  })
  const denied = cancelled || outs.some((o) => o.cancelled)
  setState((s) => ({ ...s, apply: { ...s.apply, repair: outs, repairBatch: { elevatedOnce: res?.elevatedOnce, cancelled: denied } } }))
  return { cancelled: denied }
}

/** Versão sem lote no backend: uma correção por vez (cada uma com admin pode pedir permissão). */
async function runRepairOneByOne(repairs: PlanEntry[]): Promise<{ cancelled: boolean }> {
  setState((s) => ({ ...s, apply: { ...s.apply, repairBatch: { oneByOne: true } } }))
  let adminDenied = false
  for (let i = 0; i < repairs.length; i++) {
    const e = repairs[i]
    const base = repairBase(e)
    const push = (o: RepairOutcome): void => setState((s) => ({ ...s, apply: { ...s.apply, repair: [...s.apply.repair, o] } }))
    if (state.cancelRequested) {
      push({ ...base, ok: false, skipped: true, message: 'Não executado: você pediu para parar.' })
      continue
    }
    if (adminDenied && e.requiresAdmin) {
      push({ ...base, ok: false, skipped: true, message: 'Pulado: você negou a permissão de administrador numa correção anterior.' })
      continue
    }
    patchApply('repair', { message: `Corrigindo ${i + 1} de ${repairs.length}: ${e.title}`, percent: (i / repairs.length) * 100 })
    try {
      const r = await api.repair.fix({ issueId: e.issueId!, fixId: e.fixId! })
      push({ ...base, ok: Boolean(r.ok), message: r.message || (r.ok ? 'Corrigido.' : 'Falhou.'), cancelled: r.cancelled, logId: r.logId })
      if (r.cancelled) adminDenied = true
    } catch (err) {
      const msg = errMsg(err)
      push({ ...base, ok: false, message: isNotImplemented(msg) ? 'Correção automática ainda não disponível nesta versão.' : msg })
    }
  }
  // Uma por uma: negar uma não cancela as outras (as sem admin seguem), então o fluxo continua.
  return { cancelled: false }
}

function formatBytesShort(n: number | undefined): string {
  if (!n || !Number.isFinite(n) || n <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = n
  let u = 0
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024
    u++
  }
  return `${v.toLocaleString(getFormatLocale(), { maximumFractionDigits: v >= 100 || u === 0 ? 0 : 1 })} ${units[u]}`
}

async function measureAfter(): Promise<void> {
  setState((s) => ({ ...s, stage: 'measuringAfter' }))
  if (state.before.approx) await measureAfterApprox()
  else await measure('after', 'Depois de otimizar')
  setState((s) => ({ ...s, stage: 'done', finishedAt: Date.now() }))
}

/** Depois de interrompido: continuar sem o ponto de restauração (o usuário pediu explicitamente). */
export async function continueWithoutRestorePoint(): Promise<void> {
  if (state.stage !== 'stopped' || !state.apply.stopped?.canRetryWithoutRestore) return
  setState((s) => ({ ...s, selected: Object.fromEntries(s.apply.chosen.map((e) => [e.key, true])) }))
  await applyPlan({ withoutRestorePoint: true })
}

/** Depois de interrompido: volta ao plano (mesma seleção). */
export function backToPlan(): void {
  if (state.stage !== 'stopped') return
  setState((s) => ({ ...s, stage: 'plan', apply: freshApply() }))
}

/** Depois de interrompido com algo já aplicado: mede e compara mesmo assim. */
export async function measureNow(): Promise<void> {
  if (state.stage !== 'stopped' && state.stage !== 'done') return
  await measureAfter()
}

/** Motivos para reiniciar (PT-BR) com base no que foi aplicado. */
export function restartReasons(s: BoostState = state): string[] {
  const reasons: string[] = []
  const batch = s.apply.batch?.results ?? []
  const restartItems = batch.filter((r) => r.ok && r.requiresRestart).map((r) => r.title)
  const chosenRestart = s.apply.chosen.filter((e) => e.requiresRestart && e.group === 'perf').map((e) => e.title)
  const titles = [...new Set([...restartItems, ...chosenRestart.filter((t) => batch.some((r) => r.ok && r.title === t))])]
  if (titles.length) reasons.push(`Só valem depois de reiniciar: ${titles.join(', ')}.`)
  else if (s.apply.batch?.restartNeeded) reasons.push('Parte das otimizações aplicadas só vale depois de reiniciar o PC.')
  const repairRestart = s.apply.repair.filter((r) => r.ok && r.requiresRestart).map((r) => r.title)
  if (repairRestart.length) reasons.push(`Correções que só valem depois de reiniciar: ${repairRestart.join(', ')}.`)
  const startupOk = s.apply.chosen.filter((e) => e.group === 'startup').length
  if (startupOk && batch.some((r) => r.ok)) reasons.push('Os programas tirados da inicialização só deixam de abrir (e de ocupar memória) no próximo boot.')
  if (s.data.snapshot?.pendingReboot) reasons.push('O Windows já tinha uma reinicialização pendente (atualizações).')
  return reasons
}

/** O que dá para desfazer de uma vez: otimizações/inicialização (undoBatch, um UAC) e correções reversíveis. */
export function undoableLogs(s: BoostState = state): { batch: string[]; repair: { logId: string; title: string }[] } {
  const batch = (s.apply.batch?.results ?? []).filter((r) => r.ok && r.logId && r.reversible !== false).map((r) => r.logId!)
  const reversibleRepair = new Set(s.apply.chosen.filter((e) => e.group === 'repair' && e.reversible).map((e) => e.key))
  const repair = s.apply.repair
    .filter((r) => r.ok && r.logId && (r.reversible ?? reversibleRepair.has(r.key)))
    .map((r) => ({ logId: r.logId!, title: r.title }))
  return { batch, repair }
}

/** "Desfazer o que foi aplicado" (chamado depois da confirmação na interface). A limpeza não tem volta. */
export async function undoApplied(): Promise<void> {
  if (state.stage !== 'done' || state.apply.undo?.status === 'running') return
  const { batch, repair } = undoableLogs()
  if (!batch.length && !repair.length) return
  setState((s) => ({ ...s, apply: { ...s.apply, undo: { status: 'running', repair: [] } } }))
  let batchRes: BoostBatchResult | undefined
  let error: string | undefined
  if (batch.length) {
    try {
      batchRes = await api.performance.undoBatch(batch)
    } catch (e) {
      const msg = errMsg(e)
      error = isNotImplemented(msg) ? 'Desfazer em lote ainda não está disponível nesta versão: use o Histórico.' : msg
    }
  }
  const repairOut: UndoState['repair'] = []
  if (!batchRes?.cancelled) {
    for (const r of repair) {
      try {
        const res = await api.repair.undo(r.logId)
        repairOut.push({ title: r.title, ok: Boolean(res.ok), message: res.message })
        if (res.cancelled) break
      } catch (e) {
        repairOut.push({ title: r.title, ok: false, message: errMsg(e) })
      }
    }
  }
  // Desfeito: o lembrete de medir depois de reiniciar perde o sentido.
  const anyUndone = Boolean(batchRes?.results?.some((r) => r.ok)) || repairOut.some((r) => r.ok)
  if (anyUndone && state.reminderSaved) clearReminder()
  setState((s) => ({
    ...s,
    reminderSaved: anyUndone ? false : s.reminderSaved,
    apply: { ...s.apply, undo: { status: error && !repairOut.length ? 'error' : 'done', batch: batchRes, repair: repairOut, error } }
  }))
}

/** Guarda o lembrete para medir de novo na próxima abertura do app (depois de reiniciar). */
export function rememberToMeasureAfterRestart(): boolean {
  const ok = saveReminder({ before: state.before.m, afterId: state.after.m?.id, reasons: restartReasons() })
  setState((s) => ({ ...s, reminderSaved: ok }))
  return ok
}
