// Domínio Busca Profunda ("Achados"): o que ficou perdido no PC. A busca é SOMENTE LEITURA; cada ação é confirmada na
// interface e revalidada aqui antes de executar (actions.ts). Progresso em 'discover:progress'.
import type { ActionResult, TaskProgress } from '@shared/types/common'
import type { DiscoverApi, DiscoverReport, Finding } from '@shared/types/discover'
import { throttledEmitter } from '../core/events'
import { getLatest, setLatest } from '../core/state'
import { checkLeftovers, deleteLeftovers, performAct, undo } from './actions'
import { insideOrEqual } from './fsx'
import { runScan } from './scan'

const REMOVING = new Set(['recycle', 'deleteLeftovers', 'forceRemove', 'removeBrokenEntry'])

function strArray(x: unknown): string[] {
  return Array.isArray(x) ? (x.filter((v) => typeof v === 'string') as string[]) : []
}

/** Caminhos que saíram do disco nesta ação (DeleteFilesReport.deleted ou passos 'recycle' do executor). */
function deletedPaths(details: unknown): string[] {
  if (!details || typeof details !== 'object') return []
  const d = details as { deleted?: unknown; steps?: unknown }
  const out = strArray(d.deleted)
  if (Array.isArray(d.steps)) {
    for (const s of d.steps as { op?: string; ok?: boolean; target?: string }[]) if (s && s.op === 'recycle' && s.ok && typeof s.target === 'string') out.push(s.target)
  }
  return out
}

/**
 * Depois de uma ação que deu certo, atualiza o último relatório salvo (senão o item volta quando a página recarrega):
 *  - remoção: tira o achado (ou só os caminhos apagados) e, nos OUTROS achados, os caminhos/sub-itens que ficavam
 *    dentro do que foi apagado (ex.: o jogo do Hydra que estava na lista do launcher);
 *  - tirar da inicialização: o achado fica, sem essa ação;
 *  - desinstalador aberto: o achado fica, com a anotação (a desinstalação é acompanhada em Jogos & Programas).
 */
export async function applyActToReport(findingId: string, action: string, result: ActionResult): Promise<void> {
  const report = await getLatest('discover')
  if (!report) return
  const removedPaths = REMOVING.has(action) ? deletedPaths(result.details) : []
  const gone = (p: string): boolean => removedPaths.some((d) => insideOrEqual(p, d))
  const findings: Finding[] = []
  for (const f of report.findings) {
    if (f.id === findingId) {
      if (REMOVING.has(action)) {
        // removido por inteiro (remover à força / entrada do registro) ou só alguns caminhos
        const explicit = strArray((result.details as { deleted?: unknown } | undefined)?.deleted)
        if (!explicit.length) continue
        const left = f.paths.filter((p) => !gone(p))
        if (!left.length) continue
        const items = f.items?.filter((i) => !i.path || !gone(i.path))
        const itemBytes = items?.reduce((s, i) => s + (i.bytes ?? 0), 0)
        findings.push({ ...f, paths: left, items, bytes: itemBytes && items?.length ? itemBytes : Math.max(0, f.bytes - (result.bytesFreed ?? 0)) })
        continue
      }
      if (action === 'disableStartup') {
        findings.push({ ...f, actions: f.actions.filter((a) => a.kind !== 'disableStartup'), meta: { ...f.meta, startupIds: undefined, tasks: undefined } })
        continue
      }
      if (action === 'runUninstaller') {
        const note = `Desinstalador oficial aberto em ${new Date().toLocaleString('pt-BR')} (o andamento aparece em Jogos & Programas).`
        findings.push({ ...f, evidence: [...f.evidence.filter((e) => !/^Desinstalador oficial aberto em/.test(e)), note] })
        continue
      }
      findings.push(f)
      continue
    }
    if (!removedPaths.length) {
      findings.push(f)
      continue
    }
    // outros achados: caminhos e sub-itens que ficavam dentro do que foi apagado
    const left = f.paths.filter((p) => !gone(p))
    if (f.paths.length && !left.length) continue
    const items = f.items?.map((i) => (i.path && gone(i.path) ? { ...i, exists: false, note: 'apagado pela Busca Profunda' } : i))
    findings.push(left.length !== f.paths.length || items !== f.items ? { ...f, paths: left, items } : f)
  }
  const totals: DiscoverReport['totals'] = {}
  for (const f of findings) {
    const t = (totals[f.kind] ??= { count: 0, bytes: 0 })
    t.count++
    t.bytes += f.bytes || 0
  }
  await setLatest('discover', { ...report, findings, totals })
}

export function createDiscoverApi(): DiscoverApi {
  let running: Promise<DiscoverReport> | null = null
  let controller: AbortController | null = null
  let acting = false
  const emitProgress = throttledEmitter('discover:progress', 150)
  const progress = (percent: number, message: string, phase = 'scan'): void => {
    const p: TaskProgress = { task: 'discover:scan', phase, message, percent: Math.max(0, Math.min(100, Math.round(percent))) }
    emitProgress(p, percent >= 100 || percent <= 2)
  }

  async function scan(opts?: { deep?: boolean }): Promise<DiscoverReport> {
    if (running) return running
    const deep = Boolean(opts && typeof opts === 'object' && opts.deep)
    controller = new AbortController()
    const ctl = controller
    running = runScan({ deep, signal: ctl.signal, progress })
      .then(async (report) => {
        if (!report.cancelled) await setLatest('discover', report)
        return report
      })
      .finally(() => {
        running = null
        if (controller === ctl) controller = null
      })
    return running
  }

  /** Uma ação por vez (evita duas exclusões/UACs simultâneas). */
  async function exclusive<T>(fn: () => Promise<T>): Promise<T> {
    if (acting) throw new Error('Já existe uma ação da Busca Profunda em andamento. Aguarde terminar.')
    acting = true
    try {
      return await fn()
    } finally {
      acting = false
    }
  }

  return {
    scan,
    async getLastReport() {
      return getLatest('discover')
    },
    async cancel() {
      controller?.abort()
    },
    act: (req) =>
      exclusive<ActionResult>(async () => {
        const r = await performAct(req)
        if (r.ok && req && ['recycle', 'deleteLeftovers', 'forceRemove', 'removeBrokenEntry', 'disableStartup', 'runUninstaller'].includes(req.action)) {
          await applyActToReport(req.findingId, req.action, r).catch(() => undefined)
        }
        return r
      }),
    deleteLeftovers: (paths) =>
      exclusive(async () => {
        const r = await deleteLeftovers(paths, 'Sobras escolhidas pelo usuário')
        // o que saiu também sai do último relatório da Busca Profunda (se aparecia lá)
        if (r.deleted.length) await applyActToReport('', 'deleteLeftovers', { ok: true, message: '', details: { steps: r.deleted.map((p) => ({ op: 'recycle', ok: true, target: p })) } }).catch(() => undefined)
        return r
      }),
    checkLeftovers: (paths) => checkLeftovers(paths),
    undo: (logId) => exclusive(() => undo(logId))
  }
}
