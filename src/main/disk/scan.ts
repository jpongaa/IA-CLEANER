// Gerencia a varredura de discos em segundo plano (uma por vez).
// Usa o helper nativo (rápido) e cai para a varredura em Node se ele faltar/falhar.
// Unidades em discos físicos diferentes são varridas em paralelo; partições do mesmo disco, em sequência.
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import type { DriveInfo } from '@shared/types/common'
import type { EventMap } from '@shared/events'
import type { DiskStatus, DriveScanResult, ScanOptions, ScanProgress, ScanResult } from '@shared/types/disk'
import { getDrives } from '../core/drives'
import { emit, throttledEmitter } from '../core/events'
import { getSettings } from '../core/settings'
import { getLatest, setLatest } from '../core/state'
import { CancelledError, nativeAvailable, runHelper, type HelperLine } from './native'
import { nodeScanRoot } from './nodeScan'

const MB = 1024 * 1024

export const SCAN_DEFAULTS = { topFiles: 300, minNodeBytes: 64 * MB, maxDepth: 8 }

interface RunningScan {
  id: string
  roots: string[]
  startedAt: string
  abort: AbortController
  progress: Map<string, ScanProgress>
}

let running: RunningScan | null = null

/** 'c:' / 'C:\\' → 'C:\\'; pasta absoluta → normalizada sem barra final; inválido → null. */
export function normalizeRoot(input: unknown): string | null {
  if (typeof input !== 'string') return null
  const t = input.trim().replace(/^"+|"+$/g, '')
  if (/^[a-z]:\\?$/i.test(t)) return `${t[0].toUpperCase()}:\\`
  if (/^[a-z]:\\/i.test(t) || /^\\\\[^\\]+\\[^\\]+/.test(t)) {
    const n = path.win32.normalize(t).replace(/\\+$/, '')
    return /^[a-z]:$/i.test(n) ? `${n[0].toUpperCase()}:\\` : n
  }
  return null
}

export function normalizeRoots(input: unknown): string[] {
  const list = Array.isArray(input) ? input : []
  const out: string[] = []
  for (const r of list) {
    const n = normalizeRoot(r)
    if (n && !out.some((x) => x.toLowerCase() === n.toLowerCase())) out.push(n)
  }
  return out
}

export function driveFor(root: string, drives: DriveInfo[]): DriveInfo | undefined {
  const letter = root.slice(0, 2).toUpperCase()
  return drives.find((d) => d.letter.toUpperCase() === letter)
}

/** Threads de leitura conforme o tipo do disco: HDD sofre com acesso paralelo; NVMe aguenta muito. */
export function threadsFor(drive: DriveInfo | undefined): number {
  const cpu = Math.max(2, os.cpus().length || 4)
  if (!drive) return Math.min(4, cpu)
  if (drive.driveType === 'network') return 4
  if (drive.mediaType === 'HDD') return 2
  if (drive.driveType === 'removable' || /usb/i.test(drive.busType)) return 2
  if (drive.mediaType === 'SCM' || (drive.mediaType === 'SSD' && /nvme/i.test(drive.busType))) return Math.min(16, Math.max(4, cpu))
  if (drive.mediaType === 'SSD') return Math.min(8, Math.max(4, cpu))
  return Math.min(4, cpu)
}

const clamp = (v: unknown, def: number, min: number, max: number): number => {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : def
  return Math.min(max, Math.max(min, Math.round(n)))
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

export function scanStatus(): DiskStatus['scan'] {
  if (!running) return { running: false, roots: [], progress: [] }
  return {
    running: true,
    scanId: running.id,
    roots: running.roots,
    startedAt: running.startedAt,
    progress: [...running.progress.values()]
  }
}

export function cancelScan(): void {
  running?.abort.abort()
}

export async function startScan(opts: ScanOptions): Promise<{ scanId: string }> {
  if (running) throw new Error('Já existe uma análise em andamento. Aguarde terminar ou cancele.')
  const roots = normalizeRoots(opts?.roots)
  if (!roots.length) throw new Error('Escolha ao menos uma unidade para analisar.')
  const params = {
    topFiles: clamp(opts.topFiles, SCAN_DEFAULTS.topFiles, 10, 5000),
    minNodeBytes: clamp(opts.minNodeBytes, SCAN_DEFAULTS.minNodeBytes, MB, 1024 * 1024 * MB),
    maxDepth: clamp(opts.maxDepth, SCAN_DEFAULTS.maxDepth, 1, 32)
  }
  const run: RunningScan = {
    id: randomUUID(),
    roots,
    startedAt: new Date().toISOString(),
    abort: new AbortController(),
    progress: new Map()
  }
  running = run
  void execute(run, params)
  return { scanId: run.id }
}

type Params = { topFiles: number; minNodeBytes: number; maxDepth: number }

async function execute(run: RunningScan, params: Params): Promise<void> {
  // Libera o "em andamento" ANTES de avisar a interface (ela pode consultar getStatus ao receber disk:done).
  const finish = (payload: EventMap['disk:done']): void => {
    if (running === run) running = null
    emit('disk:done', payload)
  }
  try {
    const [drives, settings] = await Promise.all([
      getDrives().catch(() => [] as DriveInfo[]),
      getSettings().catch(() => ({ scanExclusions: [] as string[] }))
    ])
    const excludes = (settings.scanExclusions ?? []).filter((e) => typeof e === 'string' && e.trim())

    // Agrupa por disco físico: discos diferentes em paralelo, partições do mesmo disco em sequência.
    const groups = new Map<string, string[]>()
    for (const root of run.roots) {
      const d = driveFor(root, drives)
      const key = d?.physicalDiskNumber !== undefined ? `disk:${d.physicalDiskNumber}` : `root:${root}`
      groups.set(key, [...(groups.get(key) ?? []), root])
    }

    const results = new Map<string, DriveScanResult>()
    await Promise.all(
      [...groups.values()].map(async (roots) => {
        for (const root of roots) {
          if (run.abort.signal.aborted) return
          const r = await scanOne(run, root, threadsFor(driveFor(root, drives)), excludes, params)
          if (r) results.set(root, r)
        }
      })
    )

    const cancelled = run.abort.signal.aborted
    const fresh = run.roots.map((r) => results.get(r)).filter((r): r is DriveScanResult => Boolean(r))
    if (!fresh.length) {
      finish({ scanId: run.id, error: cancelled ? 'Análise cancelada.' : 'Não foi possível analisar as unidades escolhidas.' })
      return
    }
    const merged = await mergeIntoLatest(run, fresh)
    finish({ scanId: run.id, result: cancelled ? { ...merged, cancelled: true } : merged })
  } catch (e) {
    finish({ scanId: run.id, error: (e as Error).message || 'Falha na análise.' })
  }
}

async function scanOne(run: RunningScan, root: string, threads: number, excludes: string[], params: Params): Promise<DriveScanResult | null> {
  const t0 = Date.now()
  const emitProgress = throttledEmitter('disk:progress', 200)
  const report = (files: number, dirs: number, bytes: number, current: string, done = false): void => {
    const p: ScanProgress = { scanId: run.id, root, files, dirs, bytes, currentPath: current, elapsedMs: Date.now() - t0 }
    if (done) p.rootDone = true
    run.progress.set(root, p)
    emitProgress(p, done)
  }
  report(0, 0, 0, root)
  const signal = run.abort.signal

  if (nativeAvailable()) {
    try {
      const args = [
        '--root', root,
        '--top-files', String(params.topFiles),
        '--min-node-mb', String(Math.max(1, Math.round(params.minNodeBytes / MB))),
        '--max-depth', String(params.maxDepth),
        '--threads', String(threads),
        ...excludes.flatMap((e) => ['--exclude', e])
      ]
      const list = await runHelper<DriveScanResult[]>(
        'scan',
        args,
        (line: HelperLine) => {
          if (line.type === 'progress') report(num(line.files), num(line.dirs), num(line.bytes), String(line.current ?? ''))
        },
        signal
      )
      const r = Array.isArray(list) ? list[0] : undefined
      if (r && !r.error) {
        report(r.files, r.dirs, r.totalBytes, '', true)
        return normalizeResult(r)
      }
      if (r?.error && /não encontrad/i.test(r.error)) {
        report(0, 0, 0, '', true)
        return normalizeResult(r)
      }
      // resultado com erro: tenta o modo Node
    } catch (e) {
      if (e instanceof CancelledError || signal.aborted) return null
      // helper bloqueado/ausente/falhou: tenta o modo Node
    }
  }

  try {
    const r = await nodeScanRoot({
      root,
      topFiles: params.topFiles,
      minNodeBytes: params.minNodeBytes,
      maxDepth: params.maxDepth,
      excludes,
      concurrency: Math.max(4, threads * 4),
      signal,
      onProgress: (p) => report(p.files, p.dirs, p.bytes, p.current)
    })
    report(r.files, r.dirs, r.totalBytes, '', true)
    return r
  } catch (e) {
    if (e instanceof CancelledError || signal.aborted) return null
    report(0, 0, 0, '', true)
    return errorResult(root, (e as Error).message)
  }
}

function normalizeResult(r: DriveScanResult): DriveScanResult {
  return {
    ...r,
    topFiles: Array.isArray(r.topFiles) ? r.topFiles : [],
    oldLargeFiles: Array.isArray(r.oldLargeFiles) ? r.oldLargeFiles : [],
    categories: Array.isArray(r.categories) ? r.categories : [],
    tree: r.tree ?? { name: r.root, path: r.root, bytes: 0, files: 0, dirs: 0 },
    engine: r.engine ?? 'native'
  }
}

function errorResult(root: string, message: string): DriveScanResult {
  return {
    root,
    scannedAt: new Date().toISOString(),
    durationMs: 0,
    totalBytes: 0,
    files: 0,
    dirs: 0,
    cloudOnlyBytes: 0,
    inaccessibleDirs: 0,
    tree: { name: root, path: root, bytes: 0, files: 0, dirs: 0 },
    topFiles: [],
    oldLargeFiles: [],
    categories: [],
    engine: 'node',
    error: message || 'Falha ao analisar.'
  }
}

/**
 * O resultado salvo guarda a análise mais recente de CADA unidade: analisar só o D: não apaga o C: anterior.
 * Uma unidade que falhou agora não substitui um resultado bom anterior.
 */
async function mergeIntoLatest(run: RunningScan, fresh: DriveScanResult[]): Promise<ScanResult> {
  const prev = await getLatest('scan').catch(() => null)
  const map = new Map<string, DriveScanResult>()
  for (const d of prev?.drives ?? []) map.set(d.root.toUpperCase(), d)
  for (const d of fresh) {
    const key = d.root.toUpperCase()
    const old = map.get(key)
    if (d.error && old && !old.error) continue
    map.set(key, d)
  }
  const merged: ScanResult = {
    id: run.id,
    startedAt: run.startedAt,
    finishedAt: new Date().toISOString(),
    drives: [...map.values()].sort((a, b) => a.root.localeCompare(b.root))
  }
  await setLatest('scan', merged)
  return merged
}
