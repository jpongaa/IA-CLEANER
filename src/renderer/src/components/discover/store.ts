// Estado da Busca Profunda em nível de módulo (fora do React): a busca continua e o resultado não se perde ao trocar
// de página. A busca é somente leitura; as ações passam pela página (confirmação) e o resultado é aplicado aqui.
import { useSyncExternalStore } from 'react'
import type { ActionResult, TaskProgress } from '@shared/types/common'
import type { DiscoverReport, FindingActionKind } from '@shared/types/discover'
import { api, errMsg } from '../../lib/api'
import { applyActResult, normalizeReport, type FindingNote } from './logic'

export interface DiscoverState {
  report: DiscoverReport | null
  /** Carregando o último resultado salvo */
  loading: boolean
  loadError: string | null
  /** Já tentou carregar o último resultado nesta sessão */
  loaded: boolean
  scanning: boolean
  /** A busca em andamento foi iniciada por esta tela (a promessa trata o fim) */
  ownScan: boolean
  progress: TaskProgress | null
  scanError: string | null
  /** Opção "Busca completa" */
  deep: boolean
  /** Observações por achado (desinstalador aberto, tirado da inicialização...) */
  notes: Record<string, FindingNote>
}

let state: DiscoverState = {
  report: null,
  loading: false,
  loadError: null,
  loaded: false,
  scanning: false,
  ownScan: false,
  progress: null,
  scanError: null,
  deep: false,
  notes: {}
}
const listeners = new Set<() => void>()

function set(patch: Partial<DiscoverState>): void {
  state = { ...state, ...patch }
  for (const l of listeners) l()
}

function subscribe(l: () => void): () => void {
  listeners.add(l)
  ensureEvents()
  return () => listeners.delete(l)
}

export function useDiscover(): DiscoverState {
  return useSyncExternalStore(subscribe, () => state)
}

export function getDiscoverState(): DiscoverState {
  return state
}

const FINAL_PHASES = new Set(['done', 'error', 'cancelled'])

let eventsOn = false
/** Acompanha o progresso mesmo com a página fechada (e buscas iniciadas fora dela). */
function ensureEvents(): void {
  if (eventsOn) return
  eventsOn = true
  try {
    api.on('discover:progress', (p) => onProgress(p))
  } catch {
    eventsOn = false
  }
}

export function onProgress(p: TaskProgress | null | undefined): void {
  if (!p) return
  const final = FINAL_PHASES.has(p.phase)
  if (state.ownScan) {
    if (!final) set({ progress: p })
    return
  }
  // Busca que esta tela não iniciou: mostra o progresso e, no fim, carrega o resultado novo.
  if (!final) {
    set({ scanning: true, progress: p })
    return
  }
  if (!state.scanning) return
  set({ scanning: false, progress: null, scanError: p.phase === 'error' && p.message ? p.message : state.scanError })
  if (p.phase === 'done') void loadLast(true)
}

/** Carrega o último resultado salvo (uma vez por sessão, ou de novo com force). */
export async function loadLast(force = false): Promise<void> {
  if (state.loading || (state.loaded && !force)) return
  set({ loading: true, loadError: null })
  try {
    const r = normalizeReport(await api.discover.getLastReport())
    // Uma busca nova pode ter terminado enquanto carregava: não troca o resultado mais novo pelo salvo.
    const keep = state.report && r && new Date(state.report.scannedAt).getTime() > new Date(r.scannedAt).getTime()
    const replace = Boolean(r) && !keep
    set({ report: replace ? r : state.report, loading: false, loaded: true, notes: replace ? {} : state.notes })
  } catch (e) {
    set({ loading: false, loaded: true, loadError: errMsg(e) })
  }
}

export function setDeep(v: boolean): void {
  set({ deep: v })
}

export type ScanOutcome = { status: 'ok'; report: DiscoverReport } | { status: 'cancelled' } | { status: 'error'; message: string } | { status: 'busy' }

export async function startScan(): Promise<ScanOutcome> {
  if (state.scanning) return { status: 'busy' }
  set({ scanning: true, ownScan: true, progress: null, scanError: null })
  try {
    const report = normalizeReport(await api.discover.scan({ deep: state.deep }))
    if (!report) throw new Error('A busca não devolveu resultado.')
    set({ report, notes: {}, loaded: true, loadError: null })
    return { status: 'ok', report }
  } catch (e) {
    const message = errMsg(e)
    if (/cancelad/i.test(message)) return { status: 'cancelled' }
    set({ scanError: message })
    return { status: 'error', message }
  } finally {
    set({ scanning: false, ownScan: false, progress: null })
  }
}

export function cancelScan(): void {
  api.discover.cancel().catch(() => undefined)
}

export function clearScanError(): void {
  set({ scanError: null })
}

/** Aplica o resultado de uma ação no relatório da tela. Devolve true se o achado saiu da lista. */
export function applyResult(findingId: string, action: FindingActionKind, paths: string[] | undefined, res: ActionResult): boolean {
  if (!state.report) return false
  const out = applyActResult(state.report, findingId, action, paths, res)
  const notes = { ...state.notes }
  if (out.removed) delete notes[findingId]
  else if (out.note) notes[findingId] = out.note
  set({ report: out.report, notes })
  return out.removed
}
