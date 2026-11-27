// Domínio: Análise de Discos (varredura de todos os HDs/SSDs, sem IA). SOMENTE LEITURA:
// nada aqui apaga ou altera arquivos (a exclusão é feita pelo módulo de Limpeza, com o guard de segurança).
import type { DiskApi, ForgetOptions } from '@shared/types/disk'
import { getDrives } from '../core/drives'
import { getLatest, setLatest } from '../core/state'
import { cancelDuplicates, dupesStatus, findDuplicates, getLastDuplicates, saveDuplicates } from './duplicates'
import { forgetInDuplicates, forgetInScan, sizesFromDuplicates } from './forget'
import { checkFreshness } from './fresh'
import { nativeAvailable } from './native'
import { cancelScan, scanStatus, startScan } from './scan'

/** Até quantos caminhos forgetFiles aceita por chamada (vem da interface/IPC). */
const MAX_FORGET = 5000

function cleanForgetOptions(opts: unknown): ForgetOptions {
  const known = (opts as ForgetOptions | null | undefined)?.known
  if (!Array.isArray(known)) return {}
  return {
    known: known
      .slice(0, MAX_FORGET)
      .filter((k) => k && typeof k.path === 'string' && typeof k.bytes === 'number' && Number.isFinite(k.bytes) && k.bytes >= 0)
      .map((k) => ({ path: k.path, bytes: k.bytes, kind: k.kind === 'dir' || k.kind === 'file' ? k.kind : undefined }))
  }
}

// forgetFiles pode ser chamado ao mesmo tempo (Análise de Discos + desinstalação): uma fila evita que duas
// atualizações leiam/gravem o mesmo resultado salvo intercaladas.
let forgetQueue: Promise<void> = Promise.resolve()

export function createDiskApi(): DiskApi {
  return {
    listDrives: () => getDrives(true),
    startScan: (opts) => startScan(opts),
    async cancelScan() {
      cancelScan()
    },
    getLastScan: () => getLatest('scan'),
    findDuplicates: (opts) => findDuplicates(opts),
    async cancelDuplicates() {
      cancelDuplicates()
    },
    getLastDuplicates: () => getLastDuplicates(),
    async getStatus() {
      return { scan: scanStatus(), duplicates: dupesStatus(), nativeAvailable: nativeAvailable() }
    },
    forgetFiles(paths, opts) {
      const list = (Array.isArray(paths) ? paths : []).filter((p): p is string => typeof p === 'string' && p.length > 0).slice(0, MAX_FORGET)
      if (!list.length) return Promise.resolve()
      const options = cleanForgetOptions(opts)
      const job = forgetQueue.then(async () => {
        const [scan, dupes] = await Promise.all([getLatest('scan'), getLatest('duplicates')])
        if (scan && forgetInScan(scan, list, sizesFromDuplicates(dupes), options)) await setLatest('scan', scan)
        if (dupes) {
          const r = forgetInDuplicates(dupes, list)
          if (r.changed) await saveDuplicates(r.groups)
        }
      })
      forgetQueue = job.catch(() => undefined)
      return job
    },
    async checkScanFreshness() {
      return checkFreshness(await getLatest('scan'))
    }
  }
}
