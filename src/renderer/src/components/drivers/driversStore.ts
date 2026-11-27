// Estado da página Drivers fora do React: a coleta (e a consulta ao Windows Update, que demora)
// continua e mantém o progresso mesmo se o usuário trocar de página e voltar.
import { useEffect, useSyncExternalStore } from 'react'
import type { TaskProgress } from '@shared/types/common'
import type { DriverInventory } from '@shared/types/drivers'
import type { AiDriverReport } from '@shared/types/ai'
import { api, errMsg } from '../../lib/api'

export interface DriversState {
  inventory: DriverInventory | null
  /** Já tentou carregar o último inventário salvo */
  initialized: boolean
  /** Coleta local em andamento */
  refreshing: boolean
  /** Consulta ao Windows Update em andamento */
  wuRunning: boolean
  progress: TaskProgress | null
  /** Erro da última coleta (com dados antigos ainda visíveis, vira aviso) */
  error: string | null
  // IA
  aiReport: AiDriverReport | null
  aiLoading: boolean
  aiError: string | null
  aiProgress: string | null
  // Preferências de visualização (mantidas entre trocas de página)
  allOpen: boolean
}

let state: DriversState = {
  inventory: null,
  initialized: false,
  refreshing: false,
  wuRunning: false,
  progress: null,
  error: null,
  aiReport: null,
  aiLoading: false,
  aiError: null,
  aiProgress: null,
  allOpen: false
}

const listeners = new Set<() => void>()
function set(patch: Partial<DriversState>): void {
  state = { ...state, ...patch }
  for (const l of listeners) l()
}
function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

let eventsBound = false
function bindEvents(): void {
  if (eventsBound) return
  eventsBound = true
  try {
    api.on('drivers:progress', (p) => {
      if (state.refreshing || state.wuRunning) set({ progress: p })
    })
    api.on('ai:progress', (p) => {
      if (state.aiLoading && p.task === 'ai:drivers' && p.message) set({ aiProgress: p.message })
    })
  } catch {
    eventsBound = false
  }
}

let initPromise: Promise<void> | null = null

/** Carrega o último inventário salvo e o último relatório da IA; sem inventário, faz a coleta local (rápida). */
export function initDrivers(): Promise<void> {
  bindEvents()
  if (initPromise) return initPromise
  initPromise = (async () => {
    const [inv, reports] = await Promise.all([
      api.drivers.getLastInventory().catch(() => null),
      api.ai.getLastReports().catch(() => null)
    ])
    set({
      inventory: state.inventory ?? inv,
      aiReport: state.aiReport ?? reports?.drivers ?? null,
      initialized: true
    })
    if (!state.inventory && !state.refreshing) await refreshDrivers(false)
  })()
  return initPromise
}

/** Coleta de novo. includeWindowsUpdate=true também consulta o Windows Update (1–2 min). */
export async function refreshDrivers(includeWindowsUpdate: boolean): Promise<{ ok: boolean; error?: string }> {
  bindEvents()
  if (includeWindowsUpdate ? state.wuRunning : state.refreshing || state.wuRunning) return { ok: false }
  set(includeWindowsUpdate ? { wuRunning: true, error: null, progress: null } : { refreshing: true, error: null, progress: null })
  try {
    const inv = await api.drivers.getInventory({ includeWindowsUpdate })
    set({ inventory: inv, initialized: true })
    return { ok: true }
  } catch (e) {
    const msg = errMsg(e)
    set({ error: msg, initialized: true })
    return { ok: false, error: msg }
  } finally {
    set(includeWindowsUpdate ? { wuRunning: false, progress: null } : { refreshing: false, progress: null })
  }
}

export async function runAiDrivers(): Promise<void> {
  bindEvents()
  if (state.aiLoading) return
  set({ aiLoading: true, aiError: null, aiProgress: null })
  try {
    const report = await api.ai.adviseDrivers()
    set({ aiReport: report })
  } catch (e) {
    set({ aiError: errMsg(e) })
  } finally {
    set({ aiLoading: false, aiProgress: null })
  }
}

export function setAllOpen(open: boolean): void {
  set({ allOpen: open })
}

const newer = (a: string | undefined, b: string | undefined): boolean => Boolean(a) && (!b || Date.parse(a!) > Date.parse(b))

/** Outras telas (Painel, Assistente) podem ter coletado drivers ou rodado a IA: pega o que for mais novo. */
async function syncFromDisk(): Promise<void> {
  if (!state.initialized || state.refreshing || state.wuRunning) return
  const [inv, reports] = await Promise.all([
    api.drivers.getLastInventory().catch(() => null),
    state.aiLoading ? Promise.resolve(null) : api.ai.getLastReports().catch(() => null)
  ])
  const patch: Partial<DriversState> = {}
  if (inv && newer(inv.collectedAt, state.inventory?.collectedAt)) patch.inventory = inv
  const ai = reports?.drivers
  if (ai && newer(ai.generatedAt, state.aiReport?.generatedAt)) patch.aiReport = ai
  if (Object.keys(patch).length) set(patch)
}

export function useDriversState(): DriversState {
  const s = useSyncExternalStore(subscribe, () => state)
  useEffect(() => {
    if (state.initialized) void syncFromDisk()
    else void initDrivers()
  }, [])
  return s
}
