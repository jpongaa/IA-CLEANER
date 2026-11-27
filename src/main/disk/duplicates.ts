// Busca de arquivos duplicados (uma por vez). Helper nativo com fallback em Node.
import type { DriveInfo } from '@shared/types/common'
import type { DiskStatus, DuplicateGroup, DuplicatesOptions, DuplicatesProgress, DuplicatesReport } from '@shared/types/disk'
import { getDrives } from '../core/drives'
import { throttledEmitter } from '../core/events'
import { getSettings } from '../core/settings'
import { getLatest, setLatest } from '../core/state'
import { readJson, writeJson } from '../core/store'
import { CancelledError, nativeAvailable, runHelper } from './native'
import { nodeFindDuplicates } from './nodeDupes'
import { driveFor, normalizeRoots } from './scan'

const MB = 1024 * 1024
const META_FILE = 'disk-duplicates-meta.json'

type Meta = Omit<DuplicatesReport, 'groups'>

interface RunningDupes {
  roots: string[]
  abort: AbortController
  progress?: DuplicatesProgress
}

let running: RunningDupes | null = null

export function dupesStatus(): DiskStatus['duplicates'] {
  if (!running) return { running: false, roots: [] }
  return { running: true, roots: running.roots, progress: running.progress }
}

export function cancelDuplicates(): void {
  running?.abort.abort()
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

function fromLine(line: Record<string, unknown>): DuplicatesProgress {
  const phase = line.phase === 'hashing' || line.phase === 'done' ? line.phase : 'listing'
  const p: DuplicatesProgress = {
    phase,
    filesConsidered: num(line.filesConsidered),
    hashed: num(line.hashed),
    totalToHash: num(line.totalToHash),
    currentPath: typeof line.current === 'string' ? line.current : undefined
  }
  if (line.step === 'partial' || line.step === 'full') p.step = line.step
  if (typeof line.bytesHashed === 'number') p.bytesHashed = line.bytesHashed
  if (typeof line.bytesToHash === 'number') p.bytesToHash = line.bytesToHash
  return p
}

/** HDD sofre com leituras paralelas: 1 thread se só HDD, 2 se misturado, 4 em SSD. */
function hashThreads(roots: string[], drives: DriveInfo[]): number {
  const kinds = roots.map((r) => driveFor(r, drives)?.mediaType ?? 'Unknown')
  if (kinds.every((k) => k === 'HDD')) return 1
  if (kinds.some((k) => k === 'HDD' || k === 'Unknown')) return 2
  return 4
}

export async function findDuplicates(opts: DuplicatesOptions): Promise<DuplicateGroup[]> {
  if (running) throw new Error('Já existe uma busca de duplicados em andamento.')
  const roots = normalizeRoots(opts?.roots)
  if (!roots.length) throw new Error('Escolha ao menos uma unidade para procurar duplicados.')
  const minBytes = Math.max(MB, Math.round(typeof opts.minBytes === 'number' && opts.minBytes > 0 ? opts.minBytes : 10 * MB))
  const run: RunningDupes = { roots, abort: new AbortController() }
  running = run
  const t0 = Date.now()
  const emitProgress = throttledEmitter('disk:dupesProgress', 200)
  // A fase 'done' só é anunciada pelo próprio backend, DEPOIS de salvar (a página recarrega o resultado ao recebê-la).
  const onProgress = (p: DuplicatesProgress, final = false): void => {
    const full = { ...p, phase: p.phase === 'done' && !final ? ('hashing' as const) : p.phase, elapsedMs: Date.now() - t0 }
    run.progress = full
    emitProgress(full, final)
  }
  onProgress({ phase: 'listing', filesConsidered: 0, hashed: 0, totalToHash: 0 })

  try {
    const [drives, settings] = await Promise.all([
      getDrives().catch(() => [] as DriveInfo[]),
      getSettings().catch(() => ({ scanExclusions: [] as string[] }))
    ])
    const excludes = (settings.scanExclusions ?? []).filter((e) => typeof e === 'string' && e.trim())
    const threads = hashThreads(roots, drives)
    let groups: DuplicateGroup[] | null = null
    let engine: DuplicatesReport['engine'] = 'native'

    if (nativeAvailable()) {
      try {
        groups = await runHelper<DuplicateGroup[]>(
          'dupes',
          [
            ...roots.flatMap((r) => ['--root', r]),
            '--min-mb', String(Math.max(1, Math.round(minBytes / MB))),
            '--threads', String(threads),
            ...excludes.flatMap((e) => ['--exclude', e])
          ],
          (line) => {
            if (line.type === 'progress') onProgress(fromLine(line))
          },
          run.abort.signal
        )
        if (!Array.isArray(groups)) groups = null
      } catch (e) {
        if (e instanceof CancelledError || run.abort.signal.aborted) throw new CancelledError()
        groups = null // tenta em Node
      }
    }
    if (!groups) {
      engine = 'node'
      groups = await nodeFindDuplicates({ roots, minBytes, excludes, concurrency: threads, signal: run.abort.signal, onProgress: (p) => onProgress(p) })
    }

    const clean = groups.filter((g) => Array.isArray(g.files) && g.files.length > 1)
    const meta: Meta = { roots, minBytes, finishedAt: new Date().toISOString(), durationMs: Date.now() - t0, engine }
    await setLatest('duplicates', clean)
    await writeJson(META_FILE, meta)
    if (running === run) running = null
    onProgress({ ...(run.progress ?? { filesConsidered: 0, hashed: 0, totalToHash: 0 }), phase: 'done' }, true)
    return clean
  } catch (e) {
    if (running === run) running = null
    // avisa a interface (inclusive uma página reaberta, que não tem a promessa) que a busca terminou
    onProgress({ ...(run.progress ?? { filesConsidered: 0, hashed: 0, totalToHash: 0 }), phase: 'done' }, true)
    if (e instanceof CancelledError || run.abort.signal.aborted) throw new Error('Busca de duplicados cancelada.')
    throw e
  } finally {
    if (running === run) running = null
  }
}

export async function getLastDuplicates(): Promise<DuplicatesReport | null> {
  const groups = await getLatest('duplicates').catch(() => null)
  if (!groups) return null
  const meta = await readJson<Meta | null>(META_FILE, null)
  return {
    groups,
    roots: meta?.roots ?? [],
    minBytes: meta?.minBytes ?? 10 * MB,
    finishedAt: meta?.finishedAt ?? '',
    durationMs: meta?.durationMs ?? 0,
    engine: meta?.engine ?? 'native'
  }
}

export async function saveDuplicates(groups: DuplicateGroup[]): Promise<void> {
  await setLatest('duplicates', groups)
}
