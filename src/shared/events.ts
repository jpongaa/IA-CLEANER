// Eventos main -> renderer (webContents.send). Nome do canal => tipo do payload.
import type { TaskProgress } from './types/common'
import type { DuplicatesProgress, ScanProgress, ScanResult } from './types/disk'
import type { LiveStats } from './types/hardware'
import type { AiChatDelta, AiChatDone } from './types/ai'
import type { UninstallTrack } from './types/apps'

export interface EventMap {
  'disk:progress': ScanProgress
  'disk:done': { scanId: string; result?: ScanResult; error?: string }
  'disk:dupesProgress': DuplicatesProgress
  'cleanup:progress': TaskProgress
  'apps:progress': TaskProgress
  /** Mudança no acompanhamento de uma desinstalação */
  'apps:uninstall': UninstallTrack
  'discover:progress': TaskProgress
  'repair:progress': TaskProgress
  'perf:progress': TaskProgress
  'drivers:progress': TaskProgress
  'hardware:live': LiveStats
  'ai:progress': TaskProgress
  'ai:chatDelta': AiChatDelta
  'ai:chatDone': AiChatDone
}

export type EventName = keyof EventMap

export const EVENT_NAMES = [
  'disk:progress',
  'disk:done',
  'disk:dupesProgress',
  'cleanup:progress',
  'apps:progress',
  'apps:uninstall',
  'discover:progress',
  'repair:progress',
  'perf:progress',
  'drivers:progress',
  'hardware:live',
  'ai:progress',
  'ai:chatDelta',
  'ai:chatDone'
] as const satisfies readonly EventName[]
