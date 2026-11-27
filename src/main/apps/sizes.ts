// Tamanho de pastas: (1) árvore da última Análise de Discos, (2) cache de medições do app,
// (3) medição em Node com concorrência limitada, SEM seguir junctions/links simbólicos.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { DirNode, ScanResult } from '@shared/types/disk'
import { readJson, writeJson } from '../core/store'
import { isInside, normPath } from './util'

// ---------------------------------------------------------------- árvore da varredura

export interface TreeHit {
  bytes: number
  lastWrite?: number
  /** ISO da varredura */
  scannedAt: string
}

/** Procura uma pasta exata na árvore da última varredura (a árvore pode estar podada: aí não acha). */
export function makeScanLookup(scan: ScanResult | null | undefined): (p: string) => TreeHit | undefined {
  const drives = scan?.drives ?? []
  return (target) => {
    const t = normPath(target)
    if (!t) return undefined
    for (const d of drives) {
      let node: DirNode | undefined = d.tree
      if (!node || !isInside(t, node.path)) continue
      for (let guard = 0; node && guard < 64; guard++) {
        if (normPath(node.path) === t) {
          if (node.inaccessible) return undefined
          return { bytes: node.bytes, lastWrite: node.lastWrite, scannedAt: d.scannedAt }
        }
        node = node.children?.find((c: DirNode) => isInside(t, c.path))
      }
    }
    return undefined
  }
}

// ---------------------------------------------------------------- cache de medições

interface CacheEntry {
  bytes: number
  files: number
  /** epoch ms */
  at: number
  lastWrite?: number
}

const CACHE_FILE = 'apps/size-cache.json'
const CACHE_MAX_ENTRIES = 3000

export class SizeCache {
  private data: Record<string, CacheEntry> = {}
  private dirty = false

  async load(): Promise<void> {
    const raw = await readJson<Record<string, CacheEntry>>(CACHE_FILE, {})
    this.data = raw && typeof raw === 'object' ? raw : {}
  }

  get(p: string, maxAgeMs: number): CacheEntry | undefined {
    const e = this.data[normPath(p)]
    if (!e || !Number.isFinite(e.bytes) || Date.now() - e.at > maxAgeMs) return undefined
    return e
  }

  set(p: string, e: CacheEntry): void {
    this.data[normPath(p)] = e
    this.dirty = true
  }

  async save(): Promise<void> {
    if (!this.dirty) return
    const entries = Object.entries(this.data).sort((a, b) => b[1].at - a[1].at)
    this.data = Object.fromEntries(entries.slice(0, CACHE_MAX_ENTRIES))
    await writeJson(CACHE_FILE, this.data).catch(() => undefined)
    this.dirty = false
  }
}

// ---------------------------------------------------------------- medição

export interface MeasureResult {
  bytes: number
  files: number
  /** false = parou no tempo limite (valor parcial) */
  complete: boolean
  lastWrite: number
}

export interface MeasureControl {
  /** epoch ms: para de medir depois disto */
  deadline: number
  /** chamado de tempos em tempos com o total de arquivos já contados (nesta pasta) */
  onProgress?: (files: number) => void
}

const STAT_BATCH = 48

/** Soma o tamanho lógico dos arquivos da pasta. Ignora junctions/links (não segue reparse points). */
export async function measureDir(root: string, ctl: MeasureControl): Promise<MeasureResult> {
  let bytes = 0
  let files = 0
  let lastWrite = 0
  let complete = true
  let lastReport = 0
  const stack: string[] = [root]
  while (stack.length) {
    if (Date.now() > ctl.deadline) {
      complete = false
      break
    }
    const dir = stack.pop()!
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      continue // sem permissão / sumiu
    }
    const filePaths: string[] = []
    for (const e of entries) {
      if (e.isSymbolicLink()) continue // junctions, links e marcadores de nuvem
      const full = path.win32.join(dir, e.name)
      if (e.isDirectory()) stack.push(full)
      else if (e.isFile()) filePaths.push(full)
    }
    for (let i = 0; i < filePaths.length; i += STAT_BATCH) {
      const stats = await Promise.all(filePaths.slice(i, i + STAT_BATCH).map((f) => fs.lstat(f).catch(() => null)))
      for (const s of stats) {
        if (!s || !s.isFile()) continue
        bytes += s.size
        files++
        if (s.mtimeMs > lastWrite) lastWrite = s.mtimeMs
      }
    }
    if (ctl.onProgress && files - lastReport >= 2000) {
      lastReport = files
      ctl.onProgress(files)
    }
  }
  return { bytes, files, complete, lastWrite }
}
