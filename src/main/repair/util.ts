// Utilitários do domínio Reparar Erros (sem 'electron').
import { psQuote } from '../core/powershell'

/** PS 5.1: arrays de 1 item viram objeto e vazios viram null. */
export function arr<T>(x: T | T[] | null | undefined): T[] {
  if (Array.isArray(x)) return x.filter((v) => v !== null && v !== undefined)
  return x === null || x === undefined ? [] : [x]
}

export function num(x: unknown): number | undefined {
  if (typeof x === 'number' && Number.isFinite(x)) return x
  if (typeof x === 'string' && x.trim() !== '' && Number.isFinite(Number(x))) return Number(x)
  return undefined
}

export function str(x: unknown): string | undefined {
  if (typeof x !== 'string') return undefined
  const t = x.trim()
  return t ? t : undefined
}

export function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString('pt-BR')} ${n === 1 ? one : many}`
}

/** Junta nomes: "A, B e C". */
export function joinPt(items: string[], max = 6): string {
  const list = items.slice(0, max)
  const rest = items.length - list.length
  if (rest > 0) list.push(`mais ${rest}`)
  if (list.length <= 1) return list.join('')
  return `${list.slice(0, -1).join(', ')} e ${list[list.length - 1]}`
}

export function dateBr(v: string | number | undefined | null, withTime = true): string {
  if (v === undefined || v === null || v === '') return '—'
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) return '—'
  return withTime ? d.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : d.toLocaleDateString('pt-BR')
}

export const GB = 1024 ** 3
export const MB = 1024 ** 2

export function gbText(bytes: number | undefined, digits = 1): string {
  if (bytes === undefined || !Number.isFinite(bytes)) return '—'
  if (bytes < GB) return `${Math.round(bytes / MB).toLocaleString('pt-BR')} MB`
  return `${(bytes / GB).toLocaleString('pt-BR', { maximumFractionDigits: digits, minimumFractionDigits: 0 })} GB`
}

/** Embute um valor como JSON num script PowerShell (string entre aspas simples, escapada com psQuote). */
export function psJson(value: unknown): string {
  return `(ConvertFrom-Json ${psQuote(JSON.stringify(value))})`
}

/** Texto curto para listas/evidências (sem quebras de linha). */
export function oneLine(s: string | undefined, max = 220): string {
  const t = (s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > max ? t.slice(0, max - 1) + '…' : t
}

export function hex8(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return '—'
  return '0x' + (n >>> 0).toString(16).toUpperCase().padStart(8, '0')
}

export const DAY = 24 * 60 * 60_000
