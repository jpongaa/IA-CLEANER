// Formatação compartilhada (main e renderer). PT-BR por padrão; a interface troca com setFormatLocale().

let LOCALE = 'pt-BR'
/** Idioma dos números/datas formatados (a interface chama ao trocar de idioma; o main fica em PT-BR). */
export function setFormatLocale(locale: string): void {
  LOCALE = locale
}
export function getFormatLocale(): string {
  return LOCALE
}

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']

export function formatBytes(bytes: number | undefined | null, decimals = 1): string {
  if (bytes === undefined || bytes === null || !Number.isFinite(bytes)) return '—'
  if (bytes === 0) return '0 B'
  const sign = bytes < 0 ? '-' : ''
  let value = Math.abs(bytes)
  let unit = 0
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024
    unit++
  }
  const digits = unit === 0 ? 0 : value >= 100 ? 0 : decimals
  return `${sign}${value.toLocaleString(LOCALE, { minimumFractionDigits: digits, maximumFractionDigits: digits })} ${UNITS[unit]}`
}

export function formatNumber(n: number | undefined | null, digits = 0): string {
  if (n === undefined || n === null || !Number.isFinite(n)) return '—'
  return n.toLocaleString(LOCALE, { maximumFractionDigits: digits })
}

export function formatPercent(n: number | undefined | null, digits = 0): string {
  if (n === undefined || n === null || !Number.isFinite(n)) return '—'
  return `${n.toLocaleString(LOCALE, { maximumFractionDigits: digits })}%`
}

/** Data/hora curta PT-BR a partir de epoch ms ou ISO. */
export function formatDate(value: number | string | undefined | null, withTime = false): string {
  if (value === undefined || value === null || value === '') return '—'
  const d = typeof value === 'number' ? new Date(value) : new Date(value)
  if (Number.isNaN(d.getTime())) return '—'
  return withTime ? d.toLocaleString(LOCALE, { dateStyle: 'short', timeStyle: 'short' }) : d.toLocaleDateString(LOCALE)
}

/** "há 3 meses", "hoje", "há 2 anos". */
export function formatRelative(value: number | string | undefined | null, now = Date.now()): string {
  if (value === undefined || value === null || value === '') return 'nunca/desconhecido'
  const t = typeof value === 'number' ? value : new Date(value).getTime()
  if (!Number.isFinite(t) || t <= 0) return 'nunca/desconhecido'
  const days = Math.floor((now - t) / 86_400_000)
  if (days < 0) return 'agora'
  if (days === 0) return 'hoje'
  if (days === 1) return 'ontem'
  if (days < 30) return `há ${days} dias`
  const months = Math.floor(days / 30.44)
  if (months < 12) return months === 1 ? 'há 1 mês' : `há ${months} meses`
  const years = Math.floor(days / 365.25)
  return years === 1 ? 'há 1 ano' : `há ${years} anos`
}

export function formatDuration(ms: number | undefined | null): string {
  if (ms === undefined || ms === null || !Number.isFinite(ms)) return '—'
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}min ${s % 60}s`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h ${m % 60}min`
  return `${Math.floor(h / 24)} dias`
}

export function formatUsd(v: number | undefined | null): string {
  if (v === undefined || v === null || !Number.isFinite(v)) return '—'
  return `US$ ${v.toLocaleString(LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: v < 1 ? 3 : 2 })}`
}
