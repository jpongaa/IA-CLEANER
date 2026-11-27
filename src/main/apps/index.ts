// Domínio Jogos & Programas: inventário (somente leitura), desinstalação OFICIAL com acompanhamento e abrir pasta.
import path from 'node:path'
import type { AppsApi, AppsInventory } from '@shared/types/apps'
import { platform } from '../core/platform'
import { loadInventory, saveInventory, setCachedInventory } from './invCache'
import { buildInventory, programFolder } from './inventory'
import { getUninstallTracker } from './track'
import { isDirectory, pathExists } from './util'

let running: Promise<AppsInventory> | null = null
/** A coleta em andamento mede também as pastas de programas? */
let runningFull = false
let resumeScheduled = false

function checkId(id: unknown): string {
  if (typeof id !== 'string' || !id.trim() || id.length > 4000) throw new Error('Identificador inválido.')
  return id
}

/** Ao abrir o app, confere uma vez as desinstalações que estavam sendo acompanhadas (sem atrasar a abertura). */
function scheduleResume(): void {
  if (resumeScheduled) return
  resumeScheduled = true
  const h = setTimeout(() => {
    void getUninstallTracker()
      .resume()
      .catch(() => undefined)
  }, 4_000)
  h.unref?.()
}

export function createAppsApi(): AppsApi {
  scheduleResume()
  const tracker = getUninstallTracker()
  return {
    async getInventory(opts) {
      const o = opts && typeof opts === 'object' ? opts : {}
      if (o.refresh === false) {
        const last = await loadInventory()
        if (last && Date.now() - Date.parse(last.collectedAt) < 120_000) return last
      }
      const computeSizes = typeof o.computeSizes === 'boolean' ? o.computeSizes : undefined
      const start = (prev?: Promise<unknown>): Promise<AppsInventory> => {
        runningFull = computeSizes === true
        const p: Promise<AppsInventory> = (prev ? prev.catch(() => undefined) : Promise.resolve())
          .then(() => buildInventory({ computeSizes }))
          .then(async (inv) => {
            // Uma desinstalação confirmada no meio da coleta: a coleta pode ter lido o registro antes.
            const clean = tracker.filterRemoved(inv)
            if (clean !== inv) await saveInventory(clean)
            else setCachedInventory(inv)
            return clean
          })
          .finally(() => {
            if (running === p) {
              running = null
              runningFull = false
            }
          })
        running = p
        return p
      }
      if (!running) return start()
      // Já há uma coleta rápida rodando (ex.: check-up do Painel) e pediram a completa: encadeia.
      if (computeSizes === true && !runningFull) return start(running)
      return running
    },

    getLastInventory: () => loadInventory(),

    async uninstall(rawId, opts) {
      const id = checkId(rawId)
      const elevated = Boolean(opts && typeof opts === 'object' && (opts as { elevated?: unknown }).elevated === true)
      return tracker.start(id, { elevated })
    },

    async openLocation(rawId) {
      const id = checkId(rawId)
      const inv = await loadInventory()
      if (!inv) throw new Error('Carregue a lista de jogos e programas primeiro.')
      let target: string | undefined
      const game = inv.games.find((g) => g.id === id)
      if (game) target = game.installPath
      else {
        const program = inv.programs.find((p) => p.id === id)
        if (program) target = programFolder(program)
        else target = inv.leftovers?.find((l) => l.id === id)?.path
      }
      if (!target) throw new Error('Este item não tem uma pasta conhecida.')
      if (await isDirectory(target)) return platform.openPath(target)
      if (await pathExists(target)) return platform.showInExplorer(target)
      const parent = path.win32.dirname(target)
      if (parent !== target && (await isDirectory(parent))) {
        await platform.openPath(parent)
        return
      }
      throw new Error(`A pasta não existe mais: ${target}`)
    },

    getUninstallTracks: () => tracker.list(),

    async recheckUninstall(rawId) {
      return tracker.recheck(checkId(rawId))
    },

    async dismissUninstallTrack(rawId) {
      await tracker.dismiss(checkId(rawId))
    }
  }
}

/** Para outros domínios (Busca Profunda): abre um desinstalador oficial fora do inventário e acompanha. */
export { getUninstallTracker } from './track'
export type { CustomTrackSpec } from './track'
