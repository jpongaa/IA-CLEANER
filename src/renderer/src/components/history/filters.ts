// Filtros, agrupamento e totais do Histórico (lógica pura, sem React).
import type { ActionLogEntry } from '@shared/types/common'
import { canUndo, domainMeta, entryTime, normalizeText, type ActionDomain } from './meta'

export type StatusFilter = 'all' | 'success' | 'error' | 'undone'
export type PeriodFilter = 'all' | 'today' | '7d' | '30d' | '90d'

export interface HistoryFilters {
  search: string
  domain: ActionDomain | 'all'
  status: StatusFilter
  period: PeriodFilter
}

export const DEFAULT_FILTERS: HistoryFilters = { search: '', domain: 'all', status: 'all', period: 'all' }

export const PERIOD_OPTIONS: { id: PeriodFilter; label: string }[] = [
  { id: 'all', label: 'Todo o período' },
  { id: 'today', label: 'Hoje' },
  { id: '7d', label: 'Últimos 7 dias' },
  { id: '30d', label: 'Últimos 30 dias' },
  { id: '90d', label: 'Últimos 90 dias' }
]

export const STATUS_OPTIONS: { id: StatusFilter; label: string }[] = [
  { id: 'all', label: 'Todas' },
  { id: 'success', label: 'Sucesso' },
  { id: 'error', label: 'Com erro' },
  { id: 'undone', label: 'Desfeitas' }
]

export function hasActiveFilters(f: HistoryFilters): boolean {
  return f.search.trim() !== '' || f.domain !== 'all' || f.status !== 'all' || f.period !== 'all'
}

function startOfToday(now: number): number {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

function periodStart(p: PeriodFilter, now: number): number {
  switch (p) {
    case 'today':
      return startOfToday(now)
    case '7d':
      return now - 7 * 86_400_000
    case '30d':
      return now - 30 * 86_400_000
    case '90d':
      return now - 90 * 86_400_000
    default:
      return -Infinity
  }
}

/** Texto pesquisável de uma entrada (título, ação, domínio, erro e detalhes). */
function searchable(e: ActionLogEntry): string {
  let details = ''
  if (e.details !== undefined) {
    try {
      details = JSON.stringify(e.details).slice(0, 4000)
    } catch {
      details = ''
    }
  }
  return normalizeText([e.title, e.action, domainMeta(e.domain).label, e.error ?? '', details].join(' '))
}

export function applyFilters(entries: ActionLogEntry[], f: HistoryFilters, now = Date.now()): ActionLogEntry[] {
  const start = periodStart(f.period, now)
  const terms = normalizeText(f.search.trim()).split(/\s+/).filter(Boolean)
  return entries.filter((e) => {
    if (f.domain !== 'all' && e.domain !== f.domain) return false
    if (f.status === 'success' && (!e.success || e.undone)) return false
    if (f.status === 'error' && e.success) return false
    if (f.status === 'undone' && !e.undone) return false
    if (start > -Infinity) {
      const t = entryTime(e)
      if (!Number.isFinite(t) || t < start) return false
    }
    if (terms.length) {
      const text = searchable(e)
      if (!terms.every((t) => text.includes(t))) return false
    }
    return true
  })
}

export interface HistoryStats {
  count: number
  freedBytes: number
  errors: number
  undoable: number
}

export function computeStats(entries: ActionLogEntry[]): HistoryStats {
  let freedBytes = 0
  let errors = 0
  let undoable = 0
  for (const e of entries) {
    if (e.success && typeof e.bytesFreed === 'number' && Number.isFinite(e.bytesFreed) && e.bytesFreed > 0) freedBytes += e.bytesFreed
    if (!e.success) errors++
    if (canUndo(e)) undoable++
  }
  return { count: entries.length, freedBytes, errors, undoable }
}

export interface DayGroup {
  key: string
  label: string
  entries: ActionLogEntry[]
  freedBytes: number
}

function dayKey(t: number): string {
  const d = new Date(t)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function dayLabel(t: number, now: number): string {
  const today = startOfToday(now)
  if (t >= today) return 'Hoje'
  if (t >= today - 86_400_000) return 'Ontem'
  const d = new Date(t)
  const sameYear = d.getFullYear() === new Date(now).getFullYear()
  const s = d.toLocaleDateString('pt-BR', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    ...(sameYear ? {} : { year: 'numeric' })
  })
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/** Agrupa por dia (mantém a ordem: mais recente primeiro). */
export function groupByDay(entries: ActionLogEntry[], now = Date.now()): DayGroup[] {
  const sorted = [...entries].sort((a, b) => (entryTime(b) || 0) - (entryTime(a) || 0))
  const groups: DayGroup[] = []
  const byKey = new Map<string, DayGroup>()
  for (const e of sorted) {
    const t = entryTime(e)
    const key = Number.isFinite(t) ? dayKey(t) : 'unknown'
    let g = byKey.get(key)
    if (!g) {
      g = { key, label: Number.isFinite(t) ? dayLabel(t, now) : 'Data desconhecida', entries: [], freedBytes: 0 }
      byKey.set(key, g)
      groups.push(g)
    }
    g.entries.push(e)
    if (e.success && typeof e.bytesFreed === 'number' && e.bytesFreed > 0) g.freedBytes += e.bytesFreed
  }
  return groups
}
