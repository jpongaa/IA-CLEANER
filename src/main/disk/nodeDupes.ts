// Busca de duplicados em Node puro (fallback do helper nativo). SOMENTE LEITURA.
// Tamanho → hash parcial (início+meio+fim) → SHA-256 completo. Ignora pastas de sistema/programas/jogos
// e hardlinks (mesmo arquivo físico). Limitação: não detecta placeholders de nuvem.
import { createHash } from 'node:crypto'
import { createReadStream, promises as fs } from 'node:fs'
import type { DuplicateGroup, DuplicatesProgress } from '@shared/types/disk'
import { CancelledError } from './native'
import { walk } from './walk'

/** Pastas ignoradas em qualquer nível (mesma lista do helper nativo). */
export const DUPES_SKIP_ANY = new Set(
  [
    'AppData', '$Recycle.Bin', 'System Volume Information', 'steamapps', 'SteamLibrary', 'Steam', 'Epic Games', 'XboxGames',
    'EA Games', 'EA Desktop', 'Origin Games', 'Riot Games', 'Battle.net', 'Ubisoft', 'Ubisoft Game Launcher', 'GOG Games',
    'GOG Galaxy', 'Rockstar Games', 'Amazon Games', 'WindowsApps', 'ModifiableWindowsApps', 'node_modules', '.git', '.svn',
    '.nuget', '.gradle', '.m2', '.cargo', '.rustup', 'site-packages', '.venv', 'venv', 'Windows.old', '$WINDOWS.~BT',
    '$WinREAgent', '$SysReset', '$GetCurrent', 'MSOCache', 'Config.Msi', 'Recovery', 'OneDriveTemp'
  ].map((s) => s.toLowerCase())
)
/** Pastas ignoradas só na raiz da unidade. */
export const DUPES_SKIP_ROOT = new Set(
  ['Windows', 'ProgramData', 'PerfLogs', 'Intel', 'AMD', 'NVIDIA', 'Drivers', 'inetpub', 'Boot', 'EFI'].map((s) => s.toLowerCase())
)

export function skipDupesDir(name: string, depth: number): boolean {
  const n = name.toLowerCase()
  if (DUPES_SKIP_ANY.has(n)) return true
  return depth === 1 && (DUPES_SKIP_ROOT.has(n) || n.startsWith('program files'))
}

interface Candidate {
  path: string
  bytes: number
  lastWrite: number
}

const CHUNK = 64 * 1024

export interface NodeDupesOptions {
  roots: string[]
  minBytes: number
  excludes: string[]
  concurrency: number
  signal?: AbortSignal
  onProgress: (p: DuplicatesProgress) => void
}

async function partialHash(c: Candidate): Promise<{ hash: string; fileId: string } | null> {
  const fh = await fs.open(c.path, 'r')
  try {
    const st = await fh.stat({ bigint: true })
    if (Number(st.size) !== c.bytes) return null
    const h = createHash('sha256')
    const buf = Buffer.alloc(CHUNK)
    for (const offset of [0, Math.max(0, Math.floor(c.bytes / 2) - CHUNK / 2), Math.max(0, c.bytes - CHUNK)]) {
      const { bytesRead } = await fh.read(buf, 0, CHUNK, offset)
      h.update(buf.subarray(0, bytesRead))
    }
    // dev+ino identificam o arquivo físico (hardlinks têm o mesmo par)
    const fileId = st.ino > 0n ? `${st.dev}:${st.ino}` : c.path
    return { hash: h.digest('hex'), fileId }
  } finally {
    await fh.close()
  }
}

function fullHash(c: Candidate, signal: AbortSignal | undefined, onBytes: (n: number) => void): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256')
    let total = 0
    const s = createReadStream(c.path, { highWaterMark: 1 << 20 })
    const onAbort = (): void => {
      s.destroy()
      reject(new CancelledError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    s.on('data', (chunk) => {
      const b = chunk as Buffer
      total += b.length
      onBytes(b.length)
      h.update(b)
    })
    s.on('error', (e) => {
      signal?.removeEventListener('abort', onAbort)
      reject(e)
    })
    s.on('end', () => {
      signal?.removeEventListener('abort', onAbort)
      resolve(total === c.bytes ? h.digest('hex') : null)
    })
  })
}

async function mapLimit<T>(items: T[], limit: number, signal: AbortSignal | undefined, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0
  const run = async (): Promise<void> => {
    while (i < items.length) {
      if (signal?.aborted) throw new CancelledError()
      const item = items[i++]
      await fn(item)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, run))
}

export async function nodeFindDuplicates(opts: NodeDupesOptions): Promise<DuplicateGroup[]> {
  const excludes = new Set(opts.excludes.map((e) => e.replace(/\\+$/, '').toLowerCase()))
  const candidates: Candidate[] = []
  let current = ''
  const progress: DuplicatesProgress = { phase: 'listing', filesConsidered: 0, hashed: 0, totalToHash: 0 }
  let last = 0
  const report = (force = false): void => {
    const now = Date.now()
    if (force || now - last > 250) {
      last = now
      opts.onProgress({ ...progress, currentPath: current })
    }
  }

  // 1) Listagem
  for (const root of opts.roots) {
    try {
      await fs.access(root)
    } catch {
      continue
    }
    // contexto = profundidade (null = não entrar na pasta)
    await walk<number>(
      root,
      0,
      {
        enterDir(_p, name, full, depth) {
          if (skipDupesDir(name, depth)) return null
          if (excludes.size && excludes.has(full.toLowerCase())) return null
          return depth
        },
        onFile(_d, f) {
          if (f.size < opts.minBytes) return
          if (f.reparse) return // pode ser placeholder de nuvem: ler baixaria o arquivo
          candidates.push({ path: f.path, bytes: f.size, lastWrite: Math.round(f.mtimeMs) })
          progress.filesConsidered++
        },
        onDirDone(_d, p) {
          current = p
          report()
        }
      },
      { concurrency: opts.concurrency * 2, signal: opts.signal }
    )
  }

  // 2) Mesmo tamanho
  const bySize = new Map<number, Candidate[]>()
  for (const c of candidates) {
    const l = bySize.get(c.bytes)
    if (l) l.push(c)
    else bySize.set(c.bytes, [c])
  }
  const partialList = [...bySize.values()].filter((l) => l.length > 1).flat()

  // 3) Hash parcial
  progress.phase = 'hashing'
  progress.step = 'partial'
  progress.totalToHash = partialList.length
  const partial = new Map<string, { c: Candidate; fileId: string }[]>()
  await mapLimit(partialList, opts.concurrency, opts.signal, async (c) => {
    current = c.path
    try {
      const r = await partialHash(c)
      if (r) {
        const key = `${c.bytes}:${r.hash}`
        const l = partial.get(key)
        if (l) l.push({ c, fileId: r.fileId })
        else partial.set(key, [{ c, fileId: r.fileId }])
      }
    } catch {
      // em uso / sem permissão
    }
    progress.hashed++
    report()
  })

  const fullList: Candidate[] = []
  for (const l of partial.values()) {
    // um representante por arquivo físico (determinístico: menor caminho em ordem alfabética)
    const seen = new Set<string>()
    const unique = [...l]
      .sort((a, b) => a.c.path.localeCompare(b.c.path))
      .filter((x) => (seen.has(x.fileId) ? false : (seen.add(x.fileId), true)))
      .map((x) => x.c)
    if (unique.length > 1) fullList.push(...unique)
  }

  // 4) Hash completo
  progress.step = 'full'
  progress.hashed = 0
  progress.totalToHash = fullList.length
  progress.bytesHashed = 0
  progress.bytesToHash = fullList.reduce((s, c) => s + c.bytes, 0)
  fullList.sort((a, b) => b.bytes - a.bytes)
  const full = new Map<string, Candidate[]>()
  await mapLimit(fullList, opts.concurrency, opts.signal, async (c) => {
    current = c.path
    try {
      const hash = await fullHash(c, opts.signal, (n) => {
        progress.bytesHashed = (progress.bytesHashed ?? 0) + n
        report()
      })
      if (hash) {
        const key = `${c.bytes}:${hash}`
        const l = full.get(key)
        if (l) l.push(c)
        else full.set(key, [c])
      }
    } catch (e) {
      if (e instanceof CancelledError) throw e
    }
    progress.hashed++
    report()
  })

  progress.phase = 'done'
  report(true)
  return [...full.entries()]
    .filter(([, l]) => l.length > 1)
    .map(([key, l]) => {
      const files = [...l].sort((a, b) => a.lastWrite - b.lastWrite || a.path.localeCompare(b.path))
      const bytes = files[0].bytes
      return {
        hash: key.slice(key.indexOf(':') + 1),
        bytes,
        files: files.map((f) => ({ path: f.path, lastWrite: f.lastWrite })),
        wastedBytes: bytes * (files.length - 1)
      }
    })
    .sort((a, b) => b.wastedBytes - a.wastedBytes)
    .slice(0, 5000)
}
