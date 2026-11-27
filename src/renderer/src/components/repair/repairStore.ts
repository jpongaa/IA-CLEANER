// Estado da página Reparar Erros fora do React: a verificação completa (15–40 min) e correções demoradas
// continuam — e mantêm o progresso — mesmo se o usuário trocar de página e voltar.
// O backend mantém, numa verificação rápida, o que só a completa enxerga (report.deepCarriedAt/carriedCheckIds),
// inclusive no relatório salvo: a página só mostra.
import { useEffect, useSyncExternalStore } from 'react'
import type { TaskProgress } from '@shared/types/common'
import type { RepairBatchResult, RepairCategory, RepairFix, RepairIssue, RepairReport } from '@shared/types/repair'
import { api, errMsg } from '../../lib/api'
import { actionable, batchFixOf, itemsSelectable, plural } from './meta'

/** Resultado da nova verificação feita logo depois de uma correção. */
export type VerifyStatus =
  /** Reverificando agora */
  | 'checking'
  /** A nova verificação não encontrou mais o problema */
  | 'resolved'
  /** Ainda restam alguns itens */
  | 'partial'
  /** O problema continua aparecendo */
  | 'still'
  /** Só vale depois de reiniciar o PC */
  | 'restart'
  /** Não deu para confirmar (verificação rápida não olha isso / reverificação falhou) */
  | 'unverified'

export interface FixRecord {
  key: string
  issueId: string
  issueTitle: string
  category: RepairCategory
  fixId: string
  fixLabel: string
  /** Quantos itens foram enviados (quando o problema tem itens) */
  itemCount?: number
  /** ISO */
  at: string
  message: string
  logId?: string
  reversible: boolean
  requiresRestart: boolean
  verify: VerifyStatus
  /** Itens que ainda restam (verify = 'partial') */
  remaining?: number
  undone?: boolean
  undoing?: boolean
  /** Veio de um "Corrigir os selecionados" */
  batch?: boolean
}

export interface ScanRun {
  deep: boolean
  startedAt: number
  /** 'recheck' = verificação rápida automática depois de corrigir/desfazer */
  purpose: 'scan' | 'recheck'
}

export interface ApplyRun {
  issueId: string
  fixId: string
  label: string
  startedAt: number
  longRunning: boolean
  requiresAdmin: boolean
  /** Lote: quantas correções */
  batch?: number
}

export interface RepairState {
  report: RepairReport | null
  /** Já tentou carregar o último relatório salvo */
  initialized: boolean
  scanning: ScanRun | null
  cancelling: boolean
  progress: TaskProgress | null
  /** Erro da última verificação */
  error: string | null
  applying: ApplyRun | null
  applyProgress: TaskProgress | null
  /** Último erro de correção por problema (mostrado no próprio cartão) */
  issueErrors: Record<string, string>
  /** Correções feitas nesta sessão (mais nova primeiro) */
  fixed: FixRecord[]
  /** Itens selecionados por problema (ausente = todos) */
  selection: Record<string, string[]>
  /** Problemas marcados para "Corrigir os selecionados": issueId -> fixId */
  batch: Record<string, string>
  /** Quando parte do relatório (o que só a verificação completa olha) veio da verificação completa anterior */
  deepCarriedAt: string | null
  /** Verificações cujo resultado veio dessa verificação completa anterior */
  carriedCheckIds: string[]
}

let state: RepairState = {
  report: null,
  initialized: false,
  scanning: null,
  cancelling: false,
  progress: null,
  error: null,
  applying: null,
  applyProgress: null,
  issueErrors: {},
  fixed: [],
  selection: {},
  batch: {},
  deepCarriedAt: null,
  carriedCheckIds: []
}

const listeners = new Set<() => void>()
function set(patch: Partial<RepairState>): void {
  state = { ...state, ...patch }
  for (const l of listeners) l()
}
function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

// ---------------------------------------------------------------- avisos (toasts)
// A página assina enquanto estiver aberta; fora dela, o resultado continua visível no cartão/lista.
export interface Notice {
  kind: 'success' | 'error' | 'info'
  text: string
}
const noticeListeners = new Set<(n: Notice) => void>()
function notify(kind: Notice['kind'], text: string): void {
  for (const l of noticeListeners) l({ kind, text })
}
export function onNotice(fn: (n: Notice) => void): () => void {
  noticeListeners.add(fn)
  return () => noticeListeners.delete(fn)
}

// ---------------------------------------------------------------- eventos
let eventsBound = false
function bindEvents(): void {
  if (eventsBound) return
  eventsBound = true
  try {
    api.on('repair:progress', (p) => {
      // O backend diz de qual tarefa é o progresso (outra tela pode estar verificando ao mesmo tempo).
      if (p.task === 'repair:fix') {
        if (state.applying) set({ applyProgress: p })
      } else if (p.task === 'repair:scan') {
        if (state.scanning) set({ progress: p })
      } else if (state.applying) set({ applyProgress: p })
      else if (state.scanning) set({ progress: p })
    })
  } catch {
    eventsBound = false
  }
}

function withReport(report: RepairReport | null): Partial<RepairState> {
  return { report, deepCarriedAt: report?.deepCarriedAt ?? null, carriedCheckIds: report?.carriedCheckIds ?? [] }
}

let initPromise: Promise<void> | null = null

/** Carrega o último relatório salvo (não verifica sozinho: a verificação é iniciada pelo usuário). */
export function initRepair(): Promise<void> {
  bindEvents()
  if (initPromise) return initPromise
  initPromise = (async () => {
    const last = await api.repair.getLastReport().catch(() => null)
    set({ ...withReport(state.report ?? last), initialized: true })
  })()
  return initPromise
}

export function isBusy(s: RepairState = state): boolean {
  return Boolean(s.scanning || s.applying)
}

// ---------------------------------------------------------------- verificação

async function runScan(deep: boolean, purpose: ScanRun['purpose']): Promise<RepairReport | null> {
  bindEvents()
  if (state.scanning) return null
  set({ scanning: { deep, startedAt: Date.now(), purpose }, progress: null, error: null, cancelling: false })
  try {
    const fresh = await api.repair.scan({ deep })
    set({ ...withReport(fresh), ...(purpose === 'scan' ? { issueErrors: {} } : {}) })
    pruneBatch(fresh)
    return fresh
  } catch (e) {
    if (state.cancelling) {
      notify('info', 'Verificação cancelada. O resultado anterior foi mantido.')
    } else if (purpose === 'scan') {
      const msg = errMsg(e)
      set({ error: msg })
      notify('error', `A verificação falhou: ${msg}`)
    }
    return null
  } finally {
    set({ scanning: null, progress: null, cancelling: false })
  }
}

/** Verificação iniciada pelo usuário. deep = completa (pede administrador, 15–40 min). */
export async function scanRepair(deep: boolean): Promise<void> {
  if (isBusy()) return
  const r = await runScan(deep, 'scan')
  if (!r) return
  const n = actionable(r.issues).length
  notify(
    n ? 'info' : 'success',
    n ? `Verificação concluída: ${plural(n, 'problema encontrado', 'problemas encontrados')}.` : 'Verificação concluída: nenhum erro encontrado!'
  )
}

export async function cancelRepairScan(): Promise<void> {
  if (!state.scanning || state.cancelling) return
  set({ cancelling: true })
  try {
    await api.repair.cancel()
  } catch (e) {
    set({ cancelling: false })
    notify('error', `Não foi possível cancelar: ${errMsg(e)}`)
  }
}

// ---------------------------------------------------------------- seleção de itens

export function setSelection(issueId: string, ids: string[] | null): void {
  const next = { ...state.selection }
  if (ids === null) delete next[issueId]
  else next[issueId] = ids
  set({ selection: next })
}

/**
 * Seleção inicial dos itens. Listas grandes agrupadas (ex.: hosts) começam só com o que merece atenção (suspeitos,
 * bloqueios de atualização) — numa lista "sem urgência" isso é nada: o usuário marca o que quiser.
 */
export function defaultSelection(issue: RepairIssue): string[] {
  const items = issue.items ?? []
  if (items.length > 12 && items.some((i) => i.group)) {
    return items.filter((i) => /^suspeito/i.test(i.note ?? '') || /^(suspeit|bloqueiam)/i.test(i.group ?? '')).map((i) => i.id)
  }
  return items.map((i) => i.id)
}

/** Itens selecionados que ainda existem no problema (ausente = a seleção inicial). */
export function selectedIds(issue: RepairIssue, s: RepairState = state): string[] {
  const sel = s.selection[issue.id]
  if (!sel) return defaultSelection(issue)
  const valid = new Set((issue.items ?? []).map((i) => i.id))
  return sel.filter((id) => valid.has(id))
}

/** itemIds para o pedido: só quando o usuário escolheu parte dos itens de uma correção por item. */
export function itemIdsFor(issue: RepairIssue, fix: RepairFix, s: RepairState = state): string[] | undefined {
  if (!fix.perItem || !itemsSelectable(issue)) return undefined
  const all = issue.items?.length ?? 0
  const sel = selectedIds(issue, s)
  return sel.length < all ? sel : undefined
}

// ---------------------------------------------------------------- "Corrigir os selecionados"

export function setBatch(issue: RepairIssue, on: boolean): void {
  const fix = batchFixOf(issue)
  const next = { ...state.batch }
  if (on && fix) next[issue.id] = fix.id
  else delete next[issue.id]
  set({ batch: next })
}

export function setBatchMany(issues: RepairIssue[], on: boolean): void {
  const next = { ...state.batch }
  for (const i of issues) {
    const fix = batchFixOf(i)
    if (on && fix) next[i.id] = fix.id
    else delete next[i.id]
  }
  set({ batch: next })
}

export function clearBatch(): void {
  set({ batch: {} })
}

/** Tira do lote o que não está mais no relatório. */
function pruneBatch(report: RepairReport): void {
  const ids = new Set(report.issues.map((i) => i.id))
  const next = Object.fromEntries(Object.entries(state.batch).filter(([id, fixId]) => ids.has(id) && report.issues.find((i) => i.id === id)?.fixes.some((f) => f.id === fixId)))
  if (Object.keys(next).length !== Object.keys(state.batch).length) set({ batch: next })
}

export interface BatchEntry {
  issue: RepairIssue
  fix: RepairFix
  itemIds?: string[]
}

/** O que está marcado para o lote, com os itens escolhidos em cada problema. */
export function batchEntries(s: RepairState = state): BatchEntry[] {
  const out: BatchEntry[] = []
  for (const issue of s.report?.issues ?? []) {
    const fixId = s.batch[issue.id]
    const fix = fixId ? issue.fixes.find((f) => f.id === fixId) : undefined
    if (!fix) continue
    out.push({ issue, fix, itemIds: itemIdsFor(issue, fix, s) })
  }
  return out
}

// ---------------------------------------------------------------- correções

function patchRecord(key: string, patch: Partial<FixRecord>): void {
  set({ fixed: state.fixed.map((r) => (r.key === key ? { ...r, ...patch } : r)) })
}

let seq = 0

function newRecord(issue: RepairIssue, fix: RepairFix, res: { message: string; logId?: string; requiresRestart?: boolean; reversible?: boolean }, itemIds: string[] | undefined, batch: boolean): FixRecord {
  return {
    key: `${issue.id}:${fix.id}:${++seq}`,
    issueId: issue.id,
    issueTitle: issue.title,
    category: issue.category,
    fixId: fix.id,
    fixLabel: fix.label,
    itemCount: issue.items?.length ? (itemIds?.length ?? issue.items.length) : undefined,
    at: new Date().toISOString(),
    message: res.message,
    logId: res.logId,
    reversible: Boolean(res.reversible ?? fix.reversible) && Boolean(res.logId),
    requiresRestart: Boolean(res.requiresRestart),
    verify: 'checking',
    ...(batch ? { batch: true } : {})
  }
}

/** Depois da reverificação rápida: o problema sumiu? Ainda aparece? Só a completa consegue confirmar? */
function verifyAfter(entries: { record: FixRecord; issue: RepairIssue }[], fresh: RepairReport | null): void {
  for (const { record, issue } of entries) {
    if (!fresh) {
      patchRecord(record.key, { verify: record.requiresRestart ? 'restart' : 'unverified' })
      continue
    }
    if (record.requiresRestart) {
      patchRecord(record.key, { verify: 'restart' })
      continue
    }
    const still = fresh.issues.find((i) => i.id === issue.id)
    if (still) {
      const before = issue.items?.length ?? 0
      const left = still.items?.length ?? 0
      patchRecord(record.key, before > 0 && left > 0 && left < before ? { verify: 'partial', remaining: left } : { verify: 'still' })
      continue
    }
    // Sumiu. Se quem acha este problema é uma verificação só da completa (SFC/DISM/discos), a rápida não confirma.
    const deepOnly = Boolean(issue.checkId && fresh.checks.find((c) => c.id === issue.checkId)?.deepOnly)
    patchRecord(record.key, { verify: deepOnly ? 'unverified' : 'resolved' })
  }
}

function restartOf(fix: RepairFix, details: unknown): boolean {
  const d = (details as { requiresRestart?: boolean } | undefined)?.requiresRestart
  return typeof d === 'boolean' ? d : Boolean(fix.requiresRestart)
}

/** Aplica uma correção já confirmada pelo usuário e reverifica. itemIds omitido = todos os itens. */
export async function applyRepairFix(issue: RepairIssue, fix: RepairFix, itemIds?: string[]): Promise<void> {
  bindEvents()
  if (isBusy()) return
  const errors = { ...state.issueErrors }
  delete errors[issue.id]
  set({
    applying: { issueId: issue.id, fixId: fix.id, label: fix.label, startedAt: Date.now(), longRunning: Boolean(fix.longRunning), requiresAdmin: fix.requiresAdmin },
    applyProgress: null,
    issueErrors: errors
  })
  let record: FixRecord | null = null
  try {
    const res = await api.repair.fix({ issueId: issue.id, fixId: fix.id, ...(itemIds ? { itemIds } : {}) })
    if (res.cancelled) {
      notify('info', 'Permissão de administrador negada. Nada foi alterado.')
      return
    }
    if (!res.ok) {
      set({ issueErrors: { ...state.issueErrors, [issue.id]: res.message || 'A correção não funcionou.' } })
      notify('error', `${fix.label}: ${res.message || 'não funcionou.'}`)
      return
    }
    const d = res.details as { reversible?: boolean } | undefined
    record = newRecord(issue, fix, { message: res.message, logId: res.logId, requiresRestart: restartOf(fix, res.details), reversible: d?.reversible ?? fix.reversible }, itemIds, false)
    set({ fixed: [record, ...state.fixed] })
    // A correção mexeu nos itens: a seleção antiga não vale mais.
    setSelection(issue.id, null)
    notify('success', record.requiresRestart && !/reinic/i.test(res.message) ? `${res.message} Reinicie o PC para concluir.` : res.message || 'Correção aplicada.')
  } catch (e) {
    const msg = errMsg(e)
    set({ issueErrors: { ...state.issueErrors, [issue.id]: msg } })
    notify('error', `${fix.label}: ${msg}`)
    return
  } finally {
    set({ applying: null, applyProgress: null })
  }
  if (!record) return
  // Reverifica (rápido) para mostrar se resolveu de verdade.
  const rec = record
  verifyAfter([{ record: rec, issue }], await runScan(false, 'recheck'))
}

/** Só abre uma tela do Windows (opensOnly): sem confirmação, sem Histórico, sem reverificar. */
export async function openRepairTool(issue: RepairIssue, fix: RepairFix): Promise<void> {
  try {
    const res = await api.repair.fix({ issueId: issue.id, fixId: fix.id })
    notify(res.ok ? 'info' : 'error', res.message || (res.ok ? `${fix.label}: aberto.` : `Não foi possível abrir: ${fix.label}`))
  } catch (e) {
    notify('error', `Não foi possível abrir: ${errMsg(e)}`)
  }
}

/**
 * "Corrigir os selecionados": UM pedido de administrador para todas (fixBatch). UAC negado = nada aplicado.
 * Cada correção vai para o Histórico com seu Desfazer; no fim, uma reverificação rápida confirma tudo.
 */
export async function applyRepairBatch(entries: BatchEntry[]): Promise<RepairBatchResult | null> {
  bindEvents()
  if (isBusy() || !entries.length) return null
  const n = entries.length
  const errors = { ...state.issueErrors }
  for (const e of entries) delete errors[e.issue.id]
  set({
    applying: {
      issueId: '',
      fixId: '',
      label: plural(n, 'correção', 'correções'),
      startedAt: Date.now(),
      longRunning: entries.some((e) => e.fix.longRunning),
      requiresAdmin: entries.some((e) => e.fix.requiresAdmin || e.issue.items?.some((i) => i.requiresAdmin)),
      batch: n
    },
    applyProgress: null,
    issueErrors: errors
  })
  let res: RepairBatchResult
  const done: { record: FixRecord; issue: RepairIssue }[] = []
  try {
    res = await api.repair.fixBatch(entries.map((e) => ({ issueId: e.issue.id, fixId: e.fix.id, ...(e.itemIds ? { itemIds: e.itemIds } : {}) })))
  } catch (e) {
    notify('error', `Não foi possível aplicar as correções: ${errMsg(e)}`)
    set({ applying: null, applyProgress: null })
    return null
  }
  try {
    if (res.cancelled) {
      notify('info', 'Permissão de administrador negada. Nada foi aplicado.')
      return res
    }
    const failed: Record<string, string> = {}
    for (const r of res.results) {
      const entry = entries.find((e) => e.issue.id === r.issueId && e.fix.id === r.fixId)
      if (!entry) continue
      if (r.ok) {
        const record = newRecord(entry.issue, entry.fix, r, entry.itemIds, true)
        done.push({ record, issue: entry.issue })
      } else if (!r.cancelled) failed[r.issueId] = r.message || 'A correção não funcionou.'
    }
    const nextBatch = { ...state.batch }
    for (const d of done) delete nextBatch[d.issue.id]
    const nextSel = { ...state.selection }
    for (const d of done) delete nextSel[d.issue.id]
    set({ fixed: [...done.map((d) => d.record).reverse(), ...state.fixed], issueErrors: { ...state.issueErrors, ...failed }, batch: nextBatch, selection: nextSel })
    const nFail = Object.keys(failed).length
    const restart = done.some((d) => d.record.requiresRestart)
    if (!done.length) notify('error', `Nenhuma correção foi aplicada.${nFail ? ' Veja o motivo em cada cartão.' : ''}`)
    else
      notify(
        nFail ? 'info' : 'success',
        `${plural(done.length, 'correção aplicada', 'correções aplicadas')} de ${n}${res.elevatedOnce ? ' (um único pedido de administrador)' : ''}.${nFail ? ` ${plural(nFail, 'não funcionou', 'não funcionaram')}: veja o motivo no cartão.` : ''}${restart ? ' Reinicie o PC para concluir.' : ''}`
      )
  } finally {
    set({ applying: null, applyProgress: null })
  }
  if (done.length) verifyAfter(done, await runScan(false, 'recheck'))
  return res
}

/** Desfaz uma correção desta sessão (restaura o backup) e reverifica. */
export async function undoRepairFix(key: string): Promise<void> {
  const rec = state.fixed.find((r) => r.key === key)
  if (!rec?.logId || rec.undone || rec.undoing || isBusy()) return
  patchRecord(key, { undoing: true })
  try {
    const res = await api.repair.undo(rec.logId)
    if (res.cancelled) {
      notify('info', 'Permissão de administrador negada. Nada foi desfeito.')
      return
    }
    if (!res.ok) {
      notify('error', `Não foi possível desfazer: ${res.message}`)
      return
    }
    patchRecord(key, { undone: true })
    notify('success', res.message || 'Correção desfeita: a configuração anterior foi restaurada.')
  } catch (e) {
    notify('error', `Não foi possível desfazer: ${errMsg(e)}`)
    return
  } finally {
    patchRecord(key, { undoing: false })
  }
  await runScan(false, 'recheck')
}

/** Correção mais recente deste problema nesta sessão (para o aviso no cartão). */
export function lastFixFor(issueId: string, s: RepairState = state): FixRecord | undefined {
  return s.fixed.find((r) => r.issueId === issueId && !r.undone)
}

/** Outras telas (ex.: Painel/Assistente) podem ter verificado: pega o relatório mais novo. */
async function syncFromDisk(): Promise<void> {
  if (!state.initialized || isBusy()) return
  const last = await api.repair.getLastReport().catch(() => null)
  if (!last) return
  const cur = state.report
  if (!cur || Date.parse(last.scannedAt) > Date.parse(cur.scannedAt)) {
    set(withReport(last))
    pruneBatch(last)
  }
}

export function useRepairState(): RepairState {
  const s = useSyncExternalStore(subscribe, () => state)
  useEffect(() => {
    if (state.initialized) void syncFromDisk()
    else void initRepair()
  }, [])
  return s
}
