// Ativar/desativar itens de inicialização de forma reversível (como o Gerenciador de Tarefas):
// - Run/pastas: valor binário em Explorer\StartupApproved (1º byte 02 = ativo, 03 = desativado) — o programa não é apagado;
// - tarefas agendadas: Enable/Disable-ScheduledTask.
import type { ActionResult, UndoInfo } from '@shared/types/common'
import type { StartupItem } from '@shared/types/performance'
import { logAction } from '../core/actionLog'
import { applyRegistry, type RegSet } from './psActions'
import { setTaskEnabled } from './actions'
import { notStartedMessage } from './parts'

const APPROVED = 'Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved'

export interface StartupTarget {
  kind: 'registry' | 'task'
  /** Chave StartupApproved (registry) */
  approvedKey?: string
  valueName?: string
  elevated: boolean
  taskPath?: string
  taskName?: string
}

/** Interpreta o id do item ('run:HKCU:Nome', 'run32:HKLM:Nome', 'folder:user:App.lnk', 'task:\\Pasta\\Nome'). */
export function parseStartupId(id: string): StartupTarget | null {
  let m = /^run:(HKCU|HKLM):(.+)$/s.exec(id)
  if (m) return { kind: 'registry', approvedKey: `${m[1]}:\\${APPROVED}\\Run`, valueName: m[2], elevated: m[1] === 'HKLM' }
  m = /^run32:HKLM:(.+)$/s.exec(id)
  if (m) return { kind: 'registry', approvedKey: `HKLM:\\${APPROVED}\\Run32`, valueName: m[1], elevated: true }
  m = /^folder:(user|common):(.+)$/s.exec(id)
  if (m) {
    const hive = m[1] === 'user' ? 'HKCU' : 'HKLM'
    return { kind: 'registry', approvedKey: `${hive}:\\${APPROVED}\\StartupFolder`, valueName: m[2], elevated: hive === 'HKLM' }
  }
  m = /^task:(.*\\)([^\\]+)$/s.exec(id)
  if (m) return { kind: 'task', taskPath: m[1], taskName: m[2], elevated: false }
  return null
}

/** Valor StartupApproved: 12 bytes. Ativo = 02 + zeros; desativado = 03 00 00 00 + FILETIME de agora. */
export function approvedValue(enabled: boolean, now = Date.now()): string {
  const buf = Buffer.alloc(12)
  buf[0] = enabled ? 0x02 : 0x03
  if (!enabled) buf.writeBigUInt64LE(BigInt(now + 11_644_473_600_000) * 10_000n, 4)
  return buf.toString('base64')
}

export function startupRegSet(t: StartupTarget, enabled: boolean): RegSet {
  return { path: t.approvedKey!, name: t.valueName!, kind: 'Binary', value: approvedValue(enabled) }
}

export async function setStartupItem(id: string, enabled: boolean, known?: StartupItem): Promise<ActionResult> {
  const t = parseStartupId(id)
  if (!t) return { ok: false, message: `Item de inicialização inválido: ${id}` }
  const name = known?.name ?? t.valueName ?? t.taskName ?? id
  const verb = enabled ? 'Ativado' : 'Desativado'
  let undo: UndoInfo | undefined
  if (t.kind === 'registry') {
    const r = await applyRegistry([startupRegSet(t, enabled)], t.elevated)
    if (r.cancelled) return { ok: false, cancelled: true, message: 'Permissão de administrador negada (UAC cancelado). Nada foi alterado.' }
    // UAC sem resposta/expirado = negado: nada rodou, nada vai ao Histórico.
    if (r.notStarted) return { ok: false, message: notStartedMessage(r.error) }
    if (!r.ok) {
      const entry = await logAction({ domain: 'performance', action: 'startup.toggle', title: `${verb} na inicialização: ${name}`, success: false, error: r.error })
      return { ok: false, message: `Não foi possível alterar "${name}": ${r.error ?? 'erro desconhecido'}`, logId: entry.id }
    }
    undo = { kind: 'perf.registry', payload: { snaps: r.snaps, elevated: t.elevated } }
  } else {
    const r = await setTaskEnabled(t.taskPath!, t.taskName!, enabled, Boolean(known?.requiresAdmin))
    if (r.cancelled) return { ok: false, cancelled: true, message: r.message }
    if (r.notStarted) return { ok: false, message: r.message }
    if (!r.ok) {
      const entry = await logAction({ domain: 'performance', action: 'startup.toggle', title: `${verb} na inicialização: ${name}`, success: false, error: r.message })
      return { ok: false, message: r.message, logId: entry.id }
    }
    undo = { kind: 'perf.task', payload: { taskPath: t.taskPath, taskName: t.taskName, enable: !enabled, elevated: Boolean(r.elevated) } }
  }
  const entry = await logAction({
    domain: 'performance',
    action: 'startup.toggle',
    title: `${verb} na inicialização: ${name}`,
    success: true,
    details: { id, enabled },
    undo
  })
  return {
    ok: true,
    message: enabled ? `"${name}" voltará a abrir junto com o Windows.` : `"${name}" não vai mais abrir sozinho ao ligar o PC (continua instalado).`,
    logId: entry.id
  }
}
