// Tipos comuns a todos os domínios. Datas sempre como epoch ms (number) ou ISO string.

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info'
export type Risk = 'low' | 'medium' | 'high'
/** Classificação de segurança de um item: pode apagar / revisar antes / manter (não apagar). */
export type Verdict = 'safe' | 'review' | 'keep'
export type Impact = 'high' | 'medium' | 'low'

export interface TaskProgress {
  /** Identifica a tarefa (ex.: 'cleanup:estimate', 'apps:inventory'). */
  task: string
  phase: string
  message?: string
  current?: number
  total?: number
  /** 0..100 quando conhecido. */
  percent?: number
}

export interface ActionResult {
  ok: boolean
  message: string
  /** Id da entrada no histórico de ações (para desfazer, quando suportado). */
  logId?: string
  /** O usuário cancelou o UAC ou a confirmação. */
  cancelled?: boolean
  bytesFreed?: number
  details?: unknown
}

export interface UndoInfo {
  /** Chave interpretada pelo domínio dono da ação (ex.: 'startup.toggle'). */
  kind: string
  payload: unknown
}

export interface ActionLogEntry {
  id: string
  /** ISO string */
  timestamp: string
  domain: 'cleanup' | 'performance' | 'apps' | 'disk' | 'drivers' | 'system' | 'ai' | 'discover' | 'repair'
  action: string
  title: string
  success: boolean
  bytesFreed?: number
  error?: string
  details?: unknown
  undo?: UndoInfo
  undone?: boolean
}

export type MediaType = 'SSD' | 'HDD' | 'SCM' | 'Unknown'

export interface DriveInfo {
  /** 'C:' */
  letter: string
  /** 'C:\\' */
  root: string
  label: string
  fileSystem: string
  totalBytes: number
  freeBytes: number
  mediaType: MediaType
  /** 'NVMe' | 'SATA' | 'USB' | 'RAID' | ... */
  busType: string
  physicalDiskName?: string
  physicalDiskNumber?: number
  /** Drive onde o Windows está instalado. */
  isSystem: boolean
  /** 'Healthy' | 'Warning' | 'Unhealthy' | ... */
  health?: string
  driveType: 'fixed' | 'removable' | 'network' | 'other'
}
