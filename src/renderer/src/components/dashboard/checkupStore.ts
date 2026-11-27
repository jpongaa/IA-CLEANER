// "Checkup Completo": roda as coletas SOMENTE LEITURA em sequência, cada etapa tolerante a falha.
// Estado em nível de módulo (fora do React) para o progresso não se perder ao trocar de página.
// Nenhuma etapa altera o PC: performance.collect -> cleanup.estimate -> apps.getInventory -> ai.diagnosePerformance.
import { useSyncExternalStore } from 'react'
import type { TaskProgress } from '@shared/types/common'
import type { PerformanceSnapshot } from '@shared/types/performance'
import type { CleanupEstimate } from '@shared/types/cleanup'
import type { AppsInventory } from '@shared/types/apps'
import type { AiPerformanceReport } from '@shared/types/ai'
import type { EventName } from '@shared/events'
import { api, errMsg } from '../../lib/api'

export type StepId = 'performance' | 'cleanup' | 'apps' | 'ai'
export type StepStatus = 'pending' | 'running' | 'done' | 'error' | 'skipped'

export interface CheckupStep {
  id: StepId
  label: string
  description: string
  status: StepStatus
  message?: string
  percent?: number
  error?: string
  skipReason?: string
  startedAt?: number
  finishedAt?: number
}

export interface CheckupResults {
  snapshot?: PerformanceSnapshot
  estimate?: CleanupEstimate
  inventory?: AppsInventory
  aiReport?: AiPerformanceReport
  aiConfigured?: boolean
}

export interface CheckupState {
  status: 'idle' | 'running' | 'done'
  steps: CheckupStep[]
  startedAt?: number
  finishedAt?: number
  cancelled: boolean
  cancelRequested: boolean
  results: CheckupResults
}

const STEP_DEFS: { id: StepId; label: string; description: string; event: EventName }[] = [
  { id: 'performance', label: 'Desempenho', description: 'Inicialização, memória, disco, energia, segurança…', event: 'perf:progress' },
  { id: 'cleanup', label: 'Lixo recuperável', description: 'Temporários, caches e restos de instalação', event: 'cleanup:progress' },
  { id: 'apps', label: 'Jogos e programas', description: 'Tamanho e último uso de cada jogo', event: 'apps:progress' },
  { id: 'ai', label: 'Diagnóstico da IA', description: 'A IA aponta os pontos críticos', event: 'ai:progress' }
]

function freshSteps(): CheckupStep[] {
  return STEP_DEFS.map((d) => ({ id: d.id, label: d.label, description: d.description, status: 'pending' }))
}

let state: CheckupState = { status: 'idle', steps: freshSteps(), cancelled: false, cancelRequested: false, results: {} }
const listeners = new Set<() => void>()

function setState(updater: (s: CheckupState) => CheckupState): void {
  state = updater(state)
  for (const l of listeners) l()
}

function patchStep(id: StepId, patch: Partial<CheckupStep>): void {
  setState((s) => ({ ...s, steps: s.steps.map((st) => (st.id === id ? { ...st, ...patch } : st)) }))
}

function subscribe(l: () => void): () => void {
  listeners.add(l)
  return () => listeners.delete(l)
}

export function getCheckupState(): CheckupState {
  return state
}

export function useCheckup(): CheckupState {
  return useSyncExternalStore(subscribe, getCheckupState)
}

function progressPercent(p: TaskProgress): number | undefined {
  if (typeof p.percent === 'number' && Number.isFinite(p.percent)) return Math.max(0, Math.min(100, p.percent))
  if (typeof p.current === 'number' && typeof p.total === 'number' && p.total > 0) return Math.max(0, Math.min(100, (p.current / p.total) * 100))
  return undefined
}

async function runStep<T>(id: StepId, fn: () => Promise<T>): Promise<T | undefined> {
  patchStep(id, { status: 'running', startedAt: Date.now(), message: undefined, percent: undefined, error: undefined })
  try {
    const value = await fn()
    patchStep(id, { status: 'done', finishedAt: Date.now(), percent: 100 })
    return value
  } catch (e) {
    patchStep(id, { status: 'error', finishedAt: Date.now(), error: errMsg(e) })
    return undefined
  }
}

function skip(id: StepId, reason: string): void {
  patchStep(id, { status: 'skipped', skipReason: reason, finishedAt: Date.now() })
}

/** Inicia o checkup (ignora se já estiver rodando). */
export async function startCheckup(): Promise<void> {
  if (state.status === 'running') return
  setState(() => ({ status: 'running', steps: freshSteps(), startedAt: Date.now(), cancelled: false, cancelRequested: false, results: {} }))

  // Progresso: cada evento atualiza só a etapa correspondente enquanto ela estiver rodando.
  const unsubs: (() => void)[] = []
  for (const def of STEP_DEFS) {
    try {
      unsubs.push(
        api.on(def.event as 'perf:progress', (p: TaskProgress) => {
          const st = state.steps.find((x) => x.id === def.id)
          if (!st || st.status !== 'running' || !p) return
          patchStep(def.id, { message: p.message || p.phase || st.message, percent: progressPercent(p) ?? st.percent })
        })
      )
    } catch {
      // evento indisponível: segue sem progresso detalhado
    }
  }

  const stopIfCancelled = (from: number): boolean => {
    if (!state.cancelRequested) return false
    for (const def of STEP_DEFS.slice(from)) skip(def.id, 'Cancelado por você')
    return true
  }

  try {
    const snapshot = await runStep('performance', () => api.performance.collect())
    if (snapshot) setState((s) => ({ ...s, results: { ...s.results, snapshot } }))
    if (stopIfCancelled(1)) return

    const estimate = await runStep('cleanup', () => api.cleanup.estimate())
    if (estimate) setState((s) => ({ ...s, results: { ...s.results, estimate } }))
    if (stopIfCancelled(2)) return

    const inventory = await runStep('apps', () => api.apps.getInventory({ refresh: true }))
    if (inventory) setState((s) => ({ ...s, results: { ...s.results, inventory } }))
    if (stopIfCancelled(3)) return

    let configured = false
    try {
      configured = Boolean((await api.ai.getStatus())?.configured)
    } catch {
      configured = false
    }
    setState((s) => ({ ...s, results: { ...s.results, aiConfigured: configured } }))
    if (!configured) {
      skip('ai', 'IA não configurada')
    } else if (!snapshot) {
      skip('ai', 'Sem dados de desempenho para analisar')
    } else {
      const aiReport = await runStep('ai', () => api.ai.diagnosePerformance())
      if (aiReport) setState((s) => ({ ...s, results: { ...s.results, aiReport } }))
    }
  } finally {
    for (const u of unsubs) {
      try {
        u()
      } catch {
        // ignore
      }
    }
    setState((s) => ({ ...s, status: 'done', finishedAt: Date.now(), cancelled: s.cancelRequested }))
  }
}

/** Para botões no meio da página: rola até o topo (onde fica o progresso) e inicia o checkup. */
export function revealAndStartCheckup(): void {
  try {
    document.querySelector('main')?.scrollTo({ top: 0, behavior: 'smooth' })
  } catch {
    // sem rolagem: segue
  }
  void startCheckup()
}

/** Pede para parar depois da etapa atual (a limpeza de estimativa é interrompida na hora). */
export function cancelCheckup(): void {
  if (state.status !== 'running') return
  setState((s) => ({ ...s, cancelRequested: true }))
  const running = state.steps.find((s) => s.status === 'running')
  if (running?.id === 'cleanup') api.cleanup.cancel().catch(() => undefined)
}

/** Esconde o resumo do último checkup. */
export function dismissCheckup(): void {
  if (state.status === 'running') return
  setState(() => ({ status: 'idle', steps: freshSteps(), cancelled: false, cancelRequested: false, results: {} }))
}
