// Utilitários do domínio de desempenho (normalização de dados vindos do PowerShell).

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

export function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v))
}

export function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export const GB = 1024 ** 3
export const MB = 1024 ** 2

/** GUIDs dos planos de energia padrão do Windows. */
export const POWER = {
  balanced: '381b4222-f694-41f0-9685-ff5bb260df2e',
  high: '8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c',
  saver: 'a1841308-3541-4fab-bc81-f71556f20b4a',
  ultimate: 'e9a42b02-d5df-448d-aa00-03f14749eb61'
} as const

export const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Chave global do Perflib: "Disable Performance Counters" diferente de 0 desliga TODOS os contadores. */
export const PERFLIB_KEY = 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Perflib'
/** Bibliotecas de contadores do próprio Windows (Services\<nome>\Performance) que alimentam as classes WMI básicas. */
export const PERF_CORE_LIBS = ['PerfOS', 'PerfProc', 'PerfDisk', 'PerfNet'] as const
export const PERF_DISABLE_VALUE = 'Disable Performance Counters'

/** "1,5 GB" sem depender do formatBytes (evita importar o renderer). */
export function gbText(bytes: number | undefined, digits = 1): string {
  if (bytes === undefined || !Number.isFinite(bytes)) return '—'
  if (bytes < GB) return `${Math.round(bytes / MB).toLocaleString('pt-BR')} MB`
  return `${(bytes / GB).toLocaleString('pt-BR', { maximumFractionDigits: digits, minimumFractionDigits: 0 })} GB`
}

export function pct(n: number, digits = 0): string {
  return `${n.toLocaleString('pt-BR', { maximumFractionDigits: digits })}%`
}

export function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString('pt-BR')} ${n === 1 ? one : many}`
}

export function dateBr(iso: string | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })
}

/** Junta nomes: "A, B e C". */
export function joinPt(items: string[], max = 6): string {
  const list = items.slice(0, max)
  const rest = items.length - list.length
  if (rest > 0) list.push(`mais ${rest}`)
  if (list.length <= 1) return list.join('')
  return `${list.slice(0, -1).join(', ')} e ${list[list.length - 1]}`
}
