// Tipos internos dos detectores (rascunhos antes de resolver tamanho/último uso).
import type { GameInfo, LauncherInfo, LeftoverFolder, SizeSource } from '@shared/types/apps'

export interface GameDraft {
  id: string
  launcher: GameInfo['launcher']
  name: string
  installPath: string
  uninstall: GameInfo['uninstall']
  /** Tamanho informado pelo launcher (quando houver) */
  bytes?: number
  bytesSource?: SizeSource
  workshopBytes?: number
  lastPlayed?: number
  lastPlayedSource?: string
  playtimeMinutes?: number
  /** O launcher registra partidas e não tem nenhuma para este jogo */
  neverPlayed?: boolean
  lastUpdated?: number
  mainExe?: string
  /** Outros .exe conhecidos (para Prefetch/último acesso) */
  exeHints?: string[]
  /** PackageFamilyName (Xbox/Store) para casar com UserAssist/apps da Store */
  pfn?: string
  /** Ids de programas (entradas de desinstalação) que são este jogo */
  programIds?: string[]
}

export interface LauncherResult {
  info: LauncherInfo
  games: GameDraft[]
  leftovers?: Omit<LeftoverFolder, 'drive'>[]
  warnings?: string[]
}

export const STEAM_TOOL_APPIDS = new Set([
  '228980', // Steamworks Common Redistributables
  '1070560', // Steam Linux Runtime
  '1391110',
  '1628350',
  '1493710', // Proton Experimental
  '2180100',
  '2805730',
  '2348590',
  '1887720',
  '1580130',
  '1420170',
  '1245040',
  '1113280',
  '1054830',
  '961940',
  '858280',
  '930400'
])

export const STEAM_TOOL_NAME = /^(steamworks common redistributables|steam linux runtime|proton\b|steamworks sdk redist)/i

/** Id de programa a partir da entrada de desinstalação. */
export function programIdOf(hive: string, key: string): string {
  return `reg:${hive}:${key}`
}
