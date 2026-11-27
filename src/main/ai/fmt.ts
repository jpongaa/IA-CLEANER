// Utilitários de formatação do contexto da IA (texto compacto, datas no fuso do usuário). Sem dependências do app.
import { formatBytes, formatRelative } from '@shared/format'

export function arr<T>(x: T[] | T | null | undefined): T[] {
  return Array.isArray(x) ? x : x === null || x === undefined ? [] : [x]
}

export function num(x: unknown): number | undefined {
  return typeof x === 'number' && Number.isFinite(x) ? x : undefined
}

export function sz(bytes: number | undefined | null): string {
  return formatBytes(bytes ?? undefined)
}

export function toMs(v: number | string | undefined | null): number | undefined {
  if (v === undefined || v === null || v === '') return undefined
  const t = typeof v === 'number' ? v : new Date(v).getTime()
  return Number.isFinite(t) && t > 0 ? t : undefined
}

/** Data "de calendário" (sem hora, ou meia-noite UTC — ex.: data de driver/instalação '2025-09-09T00:00:00Z'). */
const CALENDAR_DATE = /^(\d{4}-\d{2}-\d{2})(?:$|T00:00:00(?:\.0+)?(?:Z|[+-]00:?00)?$)/

/** YYYY-MM-DD no fuso do usuário (à noite no Brasil, a data UTC já seria o dia seguinte). */
export function day(v: number | string | undefined | null): string {
  if (typeof v === 'string') {
    const cal = CALENDAR_DATE.exec(v.trim())
    if (cal) return cal[1]
  }
  const t = toMs(v)
  if (!t) return '?'
  const d = new Date(t)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** 'YYYY-MM-DD HH:MM' no fuso do usuário. */
export function dayTime(v: number | string | undefined | null): string {
  const t = toMs(v)
  if (!t) return '?'
  const d = new Date(t)
  return `${day(t)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function dayAgo(v: number | string | undefined | null, now: number): string {
  const t = toMs(v)
  if (!t) return 'desconhecido'
  return `${day(v)} (${formatRelative(t, now)})`
}

export function clip(s: unknown, max: number): string {
  const t = typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : ''
  return t.length > max ? t.slice(0, max - 1) + '…' : t
}

export function pct(part: number, total: number): string {
  if (!total) return '?'
  return `${Math.round((part / total) * 100)}%`
}

export function stale(v: number | string | undefined | null, now: number, days: number): boolean {
  const t = toMs(v)
  return Boolean(t && now - t > days * 86_400_000)
}

export function estimateTokens(text: string): number {
  // Texto PT-BR com caminhos e números: ~3,3 caracteres por token.
  return Math.ceil(text.length / 3.3)
}
