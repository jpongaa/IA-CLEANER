// Metadados e regras do histórico de ações (usados pelo Histórico e pelo Painel).
import {
  Bot,
  CircleDot,
  Gamepad2,
  Gauge,
  HardDrive,
  Puzzle,
  ScanSearch,
  Settings2,
  Sparkles,
  Wrench,
  type LucideIcon
} from 'lucide-react'
import type { ActionLogEntry } from '@shared/types/common'
import { formatRelative, getFormatLocale } from '@shared/format'
import type { Tone } from '../ui'

export type ActionDomain = ActionLogEntry['domain']

export interface DomainMeta {
  label: string
  icon: LucideIcon
  tone: Tone
}

export const DOMAIN_META: Record<ActionDomain, DomainMeta> = {
  cleanup: { label: 'Limpeza', icon: Sparkles, tone: 'accent' },
  performance: { label: 'Desempenho', icon: Gauge, tone: 'info' },
  apps: { label: 'Jogos & Programas', icon: Gamepad2, tone: 'accent' },
  disk: { label: 'Discos', icon: HardDrive, tone: 'info' },
  drivers: { label: 'Drivers', icon: Puzzle, tone: 'info' },
  system: { label: 'Sistema', icon: Settings2, tone: 'neutral' },
  ai: { label: 'IA', icon: Bot, tone: 'ai' },
  discover: { label: 'Busca Profunda', icon: ScanSearch, tone: 'accent' },
  repair: { label: 'Reparar Erros', icon: Wrench, tone: 'info' }
}

export const DOMAIN_ORDER: ActionDomain[] = ['cleanup', 'performance', 'repair', 'apps', 'discover', 'disk', 'drivers', 'system', 'ai']

export function domainMeta(domain: string | undefined): DomainMeta {
  return DOMAIN_META[domain as ActionDomain] ?? { label: domain || 'Outro', icon: CircleDot, tone: 'neutral' }
}

/** Epoch ms de uma entrada (NaN se a data for inválida). */
export function entryTime(e: Pick<ActionLogEntry, 'timestamp'>): number {
  return new Date(e.timestamp).getTime()
}

function startOfDay(t: number): number {
  const d = new Date(t)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** "agora", "há 5 min", "há 3 h", depois "ontem", "há 4 dias" (dias de calendário, como o agrupamento do Histórico). */
export function timeAgo(value: string | number | undefined | null, now = Date.now()): string {
  if (value === undefined || value === null || value === '') return '—'
  const t = typeof value === 'number' ? value : new Date(value).getTime()
  if (!Number.isFinite(t)) return '—'
  const diff = now - t
  if (diff < 60_000) return 'agora'
  if (diff < 3_600_000) return `há ${Math.floor(diff / 60_000)} min`
  if (diff < 86_400_000) return `há ${Math.floor(diff / 3_600_000)} h`
  const days = Math.round((startOfDay(now) - startOfDay(t)) / 86_400_000)
  if (days === 1) return 'ontem'
  if (days > 1 && days < 30) return `há ${days} dias`
  return formatRelative(t, now)
}

/** Hora curta "14:32". */
export function timeOfDay(value: string): string {
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleTimeString(getFormatLocale(), { hour: '2-digit', minute: '2-digit' })
}

/** Qual módulo desfaz esta entrada (null = não dá para desfazer pelo app). */
export type UndoRoute = 'performance' | 'repair' | 'discover'

export function undoRoute(e: ActionLogEntry): UndoRoute | null {
  if (!e.undo || e.undone || e.success === false) return null
  const kind = String(e.undo.kind ?? '')
  if (e.domain === 'repair' || kind.startsWith('repair.')) return 'repair'
  // Ações da Busca Profunda (ex.: backup .reg de entrada removida) podem ter sido registradas como 'apps'.
  if (e.domain === 'discover' || kind.startsWith('reg.import') || kind.startsWith('discover.')) return 'discover'
  if (e.domain === 'performance') return 'performance'
  return null
}

/** Ações com dados de desfazer, bem-sucedidas e ainda não desfeitas (Desempenho, Reparar Erros, Busca Profunda). */
export function canUndo(e: ActionLogEntry): boolean {
  return undoRoute(e) !== null
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

/** Modo de exclusão registrado (Lixeira x definitivo), quando dá para inferir. */
export function deletionMode(e: ActionLogEntry): 'recycle' | 'permanent' | null {
  const d = asRecord(e.details)
  const mode = d?.mode ?? d?.deleteMode
  if (mode === 'recycle' || mode === 'permanent') return mode
  const text = `${e.action} ${e.title}`.toLowerCase()
  if (/recycle|lixeira|trash/.test(text)) return 'recycle'
  if (/permanent|definitiv/.test(text)) return 'permanent'
  return null
}

export interface EntryNote {
  tone: Tone
  text: string
}

/** Observação amigável sobre como reverter (ou por que não dá) cada tipo de ação. */
export function entryNote(e: ActionLogEntry): EntryNote | null {
  if (e.undone) return { tone: 'neutral', text: 'Esta ação já foi desfeita.' }
  if (e.success === false) {
    return { tone: 'neutral', text: 'A ação falhou, então nada (ou quase nada) foi alterado no seu PC.' }
  }
  if (e.domain === 'cleanup') {
    const mode = deletionMode(e)
    if (mode === 'recycle') {
      return {
        tone: 'info',
        text: 'Os itens foram enviados para a Lixeira. Para recuperar, abra a Lixeira do Windows, clique com o botão direito no item e escolha "Restaurar" (enquanto a Lixeira não for esvaziada).'
      }
    }
    if (mode === 'permanent') {
      return { tone: 'warn', text: 'Exclusão definitiva (sem Lixeira): não pode ser desfeita pelo app.' }
    }
    return {
      tone: 'neutral',
      text: 'Arquivos temporários e caches não passam pela Lixeira. Não há como desfazer, mas os programas recriam esses arquivos sozinhos quando precisam.'
    }
  }
  if (e.domain === 'performance') {
    if (e.undo) return null
    return { tone: 'neutral', text: 'Esta ação não tem "desfazer" automático.' }
  }
  if (e.domain === 'apps') {
    return { tone: 'neutral', text: 'Desinstalações não podem ser desfeitas pelo app: para ter de volta, reinstale pelo launcher ou pela loja original.' }
  }
  return null
}

/** Remove acentos e caixa para busca. */
export function normalizeText(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
}
