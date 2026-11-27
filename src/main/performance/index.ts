// Domínio Desempenho: descobre o que REALMENTE deixa o PC lento e oferece correções reversíveis.
import type { ActionResult } from '@shared/types/common'
import type { BoostBatchRequest, OptimizationAction, PerformanceApi, PerformanceSnapshot } from '@shared/types/performance'
import { getAction, logAction, markUndone } from '../core/actionLog'
import { getDrives } from '../core/drives'
import { throttledEmitter } from '../core/events'
import { getLatest, setLatest } from '../core/state'
import { buildActions, findDef, runUndo, type ActionContext } from './actions'
import { applyBoostBatch, buildBoostPlan, undoBoostBatch } from './boost'
import { collectRaw, isLaptopState, readState } from './collect'
import { getLastDnsBenchmark, runDnsBenchmark } from './dns'
import { buildFindings, computeScore, gpuPowerBrakeFrom } from './findings'
import { getMeasurements, measureSpeed } from './measure'
import { createRestorePoint } from './restorePoint'
import { setStartupItem } from './startup'
import { errText } from './util'

const progressEmit = throttledEmitter('perf:progress', 120)

function progress(phase: string, message: string, percent: number, force = false, task = 'perf:collect'): void {
  progressEmit({ task, phase, message, percent }, force)
}

let running: Promise<PerformanceSnapshot> | null = null

type Progress = (phase: string, message: string, percent: number) => void

/** Coleta completa (somente leitura) + achados + catálogo + nota. */
export async function collectPerformance(onProgress?: Progress): Promise<PerformanceSnapshot> {
  const report: Progress = onProgress ?? ((phase, message, percent) => progress(phase, message, percent))
  if (!onProgress) progress('start', 'Iniciando a análise...', 0, true)
  const { base, extras } = await collectRaw((phase, message, percent) => report(phase, message, percent))
  // Cruza com a última análise de hardware salva (somente leitura): "freio de energia" da GPU x desligamentos.
  const hw = await getLatest('hardware').catch(() => null)
  extras.hardwareChecked = Boolean(hw)
  extras.gpuPowerBrake = gpuPowerBrakeFrom(hw)
  const ctx: ActionContext = { state: extras.state, drives: base.drives, totalRamBytes: base.memory.totalBytes, isLaptop: Boolean(base.isLaptop) }
  const actions = buildActions(ctx)
  const findings = buildFindings(base, extras, actions)
  const snapshot: PerformanceSnapshot = { ...base, findings, score: computeScore(findings), actions }
  await setLatest('performance', snapshot)
  if (!onProgress) progress('done', 'Análise concluída', 100, true)
  return snapshot
}

/** Uma coleta por vez (pedidos simultâneos recebem a mesma). */
function collectOnce(onProgress?: Progress): Promise<PerformanceSnapshot> {
  if (!running) {
    running = collectPerformance(onProgress).finally(() => {
      running = null
    })
  }
  return running
}

export async function loadContext(): Promise<ActionContext> {
  const [st, drives, last] = await Promise.all([readState(), getDrives().catch(() => []), getLatest('performance')])
  return {
    state: st.state,
    drives: drives.length ? drives : (last?.drives ?? []),
    totalRamBytes: last?.memory.totalBytes ?? 0,
    // Sem análise salva, deduz pelo tipo de PC/bateria lidos agora (avisos de notebook não podem sumir).
    isLaptop: Boolean(last?.isLaptop) || isLaptopState(st.state)
  }
}

/** Atualiza o estado das ações no último snapshot salvo (após aplicar/desfazer). */
async function refreshSnapshotActions(actions?: OptimizationAction[], startupPatch?: Map<string, boolean>): Promise<void> {
  try {
    if (running) return // uma coleta nova vai gravar o snapshot completo
    const before = await getLatest('performance')
    if (!before) return
    const list = actions ?? buildActions(await loadContext())
    const last = await getLatest('performance')
    if (!last || last.collectedAt !== before.collectedAt || running) return
    await setLatest('performance', {
      ...last,
      actions: list,
      startupItems: startupPatch?.size ? last.startupItems.map((i) => (startupPatch.has(i.id) ? { ...i, enabled: startupPatch.get(i.id)! } : i)) : last.startupItems
    })
  } catch {
    // não crítico
  }
}

let batchRunning = false

export function createPerformanceApi(): PerformanceApi {
  return {
    collect: () => collectOnce(),

    getLastSnapshot: () => getLatest('performance'),

    async listActions() {
      try {
        const actions = buildActions(await loadContext())
        void refreshSnapshotActions(actions)
        return actions
      } catch (e) {
        const last = await getLatest('performance')
        if (last) return last.actions
        throw new Error(`Não foi possível ler o estado das otimizações: ${errText(e)}`)
      }
    },

    async applyAction(id: string): Promise<ActionResult> {
      const ctx = await loadContext()
      const def = findDef(id, ctx)
      if (!def) return { ok: false, message: `Otimização desconhecida: ${id}` }
      const ev = def.evaluate(ctx)
      if (ev.state === 'notApplicable') return { ok: false, message: ev.note ?? 'Esta otimização não se aplica a este PC.' }
      if (ev.state === 'applied' && !def.longRunning) return { ok: true, message: `"${def.title}" já está aplicado. Nada foi alterado.` }

      let out
      try {
        out = await def.run(ctx)
      } catch (e) {
        out = { ok: false, message: `Erro ao aplicar "${def.title}": ${errText(e)}` }
      }
      if (out.cancelled) return { ok: false, cancelled: true, message: out.message }
      // UAC sem resposta/expirado = negado: nada rodou, nada vai ao Histórico.
      if (out.notStarted) return { ok: false, message: out.message }
      const entry = await logAction({
        domain: 'performance',
        action: def.id,
        title: def.title,
        success: out.ok,
        error: out.ok ? undefined : out.message,
        details: { message: out.message, ...(out.details ?? {}), requiresRestart: def.requiresRestart ?? false },
        // Só há desfazer quando a execução leu o estado anterior real e devolveu como voltar a ele.
        undo: out.ok ? out.undo : undefined
      })
      await refreshSnapshotActions()
      return {
        ok: out.ok,
        message: out.message,
        logId: entry.id,
        details: { requiresRestart: Boolean(def.requiresRestart), reversible: Boolean(out.ok && out.undo), partial: Boolean(out.ok && out.partial) }
      }
    },

    async undo(logId: string): Promise<ActionResult> {
      const entry = await getAction(logId)
      if (!entry) return { ok: false, message: 'Ação não encontrada no histórico.' }
      if (entry.domain !== 'performance') return { ok: false, message: 'Esta ação não pertence ao módulo de desempenho.' }
      if (!entry.undo) return { ok: false, message: 'Esta ação não pode ser desfeita.' }
      if (entry.undone) return { ok: false, message: 'Esta ação já foi desfeita.' }
      let out
      try {
        out = await runUndo(entry.undo)
      } catch (e) {
        out = { ok: false, message: `Erro ao desfazer: ${errText(e)}` }
      }
      if (out.cancelled) return { ok: false, cancelled: true, message: out.message }
      if (out.notStarted) return { ok: false, message: out.message }
      if (out.ok) await markUndone(logId)
      const log = await logAction({
        domain: 'performance',
        action: `undo:${entry.action}`,
        title: `Desfeito: ${entry.title}`,
        success: out.ok,
        error: out.ok ? undefined : out.message,
        details: { undoOf: logId }
      })
      if (entry.action === 'startup.toggle' && out.ok) await patchStartupInSnapshot(entry.details)
      await refreshSnapshotActions()
      return { ok: out.ok, message: out.ok ? `Desfeito: ${entry.title}` : out.message, logId: log.id }
    },

    async setStartupItem(id: string, enabled: boolean): Promise<ActionResult> {
      const last = await getLatest('performance')
      const known = last?.startupItems.find((i) => i.id === id)
      // Só altera itens que a análise realmente encontrou (nunca tarefas/valores arbitrários).
      if (!known) return { ok: false, message: 'Este item não está na última análise. Clique em "Analisar de novo" e tente outra vez.' }
      if (!known.canToggle) return { ok: false, message: `"${known.name}" não pode ser alterado pelo app.` }
      const res = await setStartupItem(id, enabled, known)
      if (res.ok && last) {
        await setLatest('performance', {
          ...last,
          startupItems: last.startupItems.map((i) => (i.id === id ? { ...i, enabled } : i))
        })
      }
      return res
    },

    createRestorePoint,

    async measure(label?: string) {
      const report: Progress = (phase, message, percent) => progress(phase, message, percent, phase === 'done', 'perf:measure')
      return measureSpeed({
        label: typeof label === 'string' ? label : undefined,
        collect: (p) => collectOnce(p),
        progress: report,
        tempDir: testTempDir()
      })
    },

    getMeasurements,

    async getBoostPlan() {
      progress('plan', 'Montando o plano sob medida para este PC...', 5, true, 'perf:plan')
      const snapshot = (await getLatest('performance')) ?? (await collectOnce())
      const ctx = await loadContext()
      const actions = buildActions(ctx)
      void refreshSnapshotActions(actions)
      const plan = buildBoostPlan({ ...snapshot, actions }, ctx, actions, await getLastDnsBenchmark())
      progress('plan', 'Plano pronto', 100, true, 'perf:plan')
      return plan
    },

    async applyBatch(req: BoostBatchRequest) {
      if (batchRunning) throw new Error('Já existe uma otimização em andamento. Aguarde terminar.')
      batchRunning = true
      try {
        const ctx = await loadContext()
        const snapshot = await getLatest('performance')
        const out = await applyBoostBatch(req ?? { actionIds: [] }, {
          ctx,
          snapshot,
          progress: (message, percent) => progress('apply', message, percent, percent >= 100, 'perf:boost')
        })
        await refreshSnapshotActions(undefined, new Map(out.disabledStartupIds.map((id) => [id, false])))
        const { disabledStartupIds: _d, scripts: _s, ...result } = out
        return result
      } finally {
        batchRunning = false
      }
    },

    async undoBatch(logIds: string[]) {
      if (batchRunning) throw new Error('Já existe uma otimização em andamento. Aguarde terminar.')
      batchRunning = true
      try {
        const out = await undoBoostBatch(Array.isArray(logIds) ? logIds : [], (message, percent) => progress('undo', message, percent, percent >= 100, 'perf:undo'))
        const patch = new Map<string, boolean>()
        for (const e of out.undone) {
          const d = e.details as { id?: string; enabled?: boolean } | undefined
          if (e.action === 'startup.toggle' && d?.id && typeof d.enabled === 'boolean') patch.set(d.id, !d.enabled)
        }
        await refreshSnapshotActions(undefined, patch)
        const { undone: _u, scripts: _s, ...result } = out
        return result
      } finally {
        batchRunning = false
      }
    },

    async dnsBenchmark() {
      const st = await readState()
      return runDnsBenchmark(st, (message, percent) => progress('dns', message, percent, percent >= 100, 'perf:dns'))
    },

    getLastDnsBenchmark
  }
}

/**
 * SOMENTE TESTES DE INTERFACE: com IACLEANER_TEST=1 e IACLEANER_PERF_TMP, o arquivo de 256 MB da medição vai para a
 * pasta de teste (nunca para o %TEMP% comum). Fora disso: undefined (usa %TEMP%).
 */
function testTempDir(): string | undefined {
  const dir = process.env.IACLEANER_PERF_TMP
  return process.env.IACLEANER_TEST === '1' && dir && /iacleaner/i.test(dir) ? dir : undefined
}

/** Depois de desfazer um toggle de inicialização, inverte o estado salvo do item. */
async function patchStartupInSnapshot(details: unknown): Promise<void> {
  const d = details as { id?: string; enabled?: boolean } | undefined
  if (!d?.id || typeof d.enabled !== 'boolean') return
  const last = await getLatest('performance')
  if (!last) return
  await setLatest('performance', {
    ...last,
    startupItems: last.startupItems.map((i) => (i.id === d.id ? { ...i, enabled: !d.enabled } : i))
  })
}
