// Metadados e utilidades da página Jogos & Programas (renderer).
import type { DriveInfo } from '@shared/types/common'
import type { AppsInventory, GameInfo, Launcher, ProgramInfo } from '@shared/types/apps'

export const STALE_DAYS = 182
export const DAY_MS = 86_400_000

export const LAUNCHERS: Record<Launcher, { label: string; color: string; saves: string }> = {
  steam: {
    label: 'Steam',
    color: '#66c0f4',
    saves: 'Jogos com Steam Cloud mantêm o progresso na sua conta. Alguns jogos guardam saves em Documentos ou AppData; esses normalmente continuam no PC.'
  },
  epic: {
    label: 'Epic Games',
    color: '#d4d4d8',
    saves: 'Jogos com salvamento na nuvem da Epic mantêm o progresso. Saves locais (Documentos/AppData) costumam continuar no PC.'
  },
  ea: {
    label: 'EA app',
    color: '#ff6b6b',
    saves: 'A maioria dos jogos da EA sincroniza o progresso com a sua conta EA. Saves locais em Documentos costumam continuar no PC.'
  },
  ubisoft: {
    label: 'Ubisoft',
    color: '#5b9bff',
    saves: 'Com a sincronização na nuvem do Ubisoft Connect ligada, o progresso fica na sua conta Ubisoft.'
  },
  battlenet: {
    label: 'Battle.net',
    color: '#3fb8ff',
    saves: 'O progresso de jogos da Blizzard fica salvo na sua conta Battle.net.'
  },
  gog: {
    label: 'GOG',
    color: '#b794ff',
    saves: 'Jogos da GOG nem sempre têm nuvem: se o jogo guarda saves na pasta dele, copie antes de desinstalar.'
  },
  xbox: {
    label: 'Xbox',
    color: '#6ccf6c',
    saves: 'Jogos do Xbox/Game Pass salvam o progresso na nuvem da Microsoft.'
  },
  riot: { label: 'Riot', color: '#ff5a65', saves: 'O progresso dos jogos da Riot fica na sua conta Riot.' },
  rockstar: {
    label: 'Rockstar',
    color: '#fcbf3a',
    saves: 'Jogos da Rockstar com nuvem ligada mantêm o progresso na sua conta Rockstar.'
  },
  other: { label: 'Outro', color: '#94a3b8', saves: 'Confira se o jogo guarda o progresso na nuvem antes de desinstalar.' }
}

export function launcherLabel(l: Launcher): string {
  return LAUNCHERS[l]?.label ?? l
}

/** "SSD NVMe" / "SSD" / "HDD" / "" */
export function driveKindLabel(d: DriveInfo | undefined): string {
  if (!d) return ''
  if (d.driveType === 'removable' || d.busType?.toUpperCase() === 'USB') return 'USB'
  if (d.mediaType === 'HDD') return 'HDD'
  if (d.mediaType === 'SSD' || d.mediaType === 'SCM') return d.busType?.toUpperCase() === 'NVME' ? 'SSD NVMe' : 'SSD'
  return d.busType || ''
}

export function usedPercent(d: Pick<DriveInfo, 'totalBytes' | 'freeBytes'>): number {
  if (!d.totalBytes) return 0
  return Math.max(0, Math.min(100, ((d.totalBytes - d.freeBytes) / d.totalBytes) * 100))
}

export function isStale(lastPlayed: number | undefined, now = Date.now()): boolean {
  return typeof lastPlayed === 'number' && lastPlayed > 0 && now - lastPlayed >= STALE_DAYS * DAY_MS
}

export function formatPlaytime(min: number | undefined): string {
  if (!min || min <= 0) return '—'
  if (min < 60) return `${Math.round(min)} min`
  const h = min / 60
  return `${h.toLocaleString('pt-BR', { maximumFractionDigits: h < 10 ? 1 : 0 })} h`
}

/** "há 8 meses" sem o "há" para frases como "não jogado há 8 meses". */
export function monthsAgo(t: number, now = Date.now()): string {
  const days = Math.floor((now - t) / DAY_MS)
  if (days < 30) return `${days} dias`
  const months = Math.floor(days / 30.44)
  if (months < 12) return months === 1 ? '1 mês' : `${months} meses`
  const years = Math.floor(days / 365.25)
  const rem = Math.floor((days - years * 365.25) / 30.44)
  const y = years === 1 ? '1 ano' : `${years} anos`
  return rem >= 2 ? `${y} e ${rem} meses` : y
}

/** Remove acentos e caixa para busca. */
export function norm(s: string | undefined): string {
  return (s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
}

export type SortDir = 'asc' | 'desc'
export interface SortState<K extends string> {
  key: K
  dir: SortDir
}

/** Comparação com "vazios por último" independente da direção. */
export function cmp(a: number | string | undefined, b: number | string | undefined, dir: SortDir): number {
  const ea = a === undefined || a === null || a === '' || (typeof a === 'number' && !Number.isFinite(a))
  const eb = b === undefined || b === null || b === '' || (typeof b === 'number' && !Number.isFinite(b))
  if (ea && eb) return 0
  if (ea) return 1
  if (eb) return -1
  const r = typeof a === 'string' && typeof b === 'string' ? a.localeCompare(b, 'pt-BR', { sensitivity: 'base' }) : (a as number) - (b as number)
  return dir === 'asc' ? r : -r
}

export function driveMap(drives: DriveInfo[]): Map<string, DriveInfo> {
  return new Map(drives.map((d) => [d.letter.toUpperCase(), d]))
}

/** Resolve uma ref da IA ('game:steam:570', 'program:reg:HKLM:...') para o item do inventário. */
export function resolveAppRef(inv: AppsInventory | null, ref: string): { kind: 'game'; item: GameInfo } | { kind: 'program'; item: ProgramInfo } | null {
  if (!inv) return null
  const m = /^(game|program):(.+)$/i.exec(ref.trim())
  if (!m) return null
  const id = m[2].trim().toLowerCase()
  if (m[1].toLowerCase() === 'game') {
    const g = inv.games.find((x) => x.id.toLowerCase() === id)
    return g ? { kind: 'game', item: g } : null
  }
  const p = inv.programs.find((x) => x.id.toLowerCase() === id)
  return p ? { kind: 'program', item: p } : null
}

export function isAppRef(ref: string): boolean {
  return /^(game|program):/i.test(ref.trim())
}
