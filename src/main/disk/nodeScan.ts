// Varredura em Node puro (fallback do helper nativo). Mesmo formato de saída (DriveScanResult), engine 'node'.
// Limitação: sem acesso aos atributos do Windows, não detecta arquivos só-na-nuvem (cloudOnlyBytes = 0).
import { promises as fs } from 'node:fs'
import type { CategoryStat, DirNode, DriveScanResult, ExtensionStat, FileCategory, FileEntry } from '@shared/types/disk'
import { categoryOfExt, dirContext, extOf } from './categories'
import { walk } from './walk'

export interface NodeScanOptions {
  root: string
  topFiles: number
  minNodeBytes: number
  maxDepth: number
  excludes: string[]
  concurrency: number
  signal?: AbortSignal
  onProgress?: (p: { files: number; dirs: number; bytes: number; current: string }) => void
}

interface TNode {
  name: string
  parent: TNode | null
  ctx: FileCategory | null
  depth: number
  bytes: number
  fileBytes: number
  files: number
  dirs: number
  lastWrite: number
  children: TNode[] | null
  inaccessible: boolean
  subInaccessible: boolean
}

const OLD_MIN_BYTES = 100 * 1024 * 1024
const OLD_DAYS = 180
const OLD_MAX = 200
const MAX_CHILDREN = 120

/** Mantém os K maiores (amortizado: ordena e corta quando passa de 2K). */
class TopK {
  private items: FileEntry[] = []
  private threshold = 0
  constructor(private readonly k: number) {}
  offer(size: number, make: () => FileEntry): void {
    if (size <= this.threshold) return
    this.items.push(make())
    if (this.items.length >= this.k * 2) this.compact()
  }
  private compact(): void {
    this.items.sort((a, b) => b.bytes - a.bytes)
    this.items.length = Math.min(this.items.length, this.k)
    if (this.items.length === this.k) this.threshold = this.items[this.k - 1].bytes
  }
  result(): FileEntry[] {
    this.compact()
    return this.items
  }
}

function newNode(name: string, parent: TNode | null, ctx: FileCategory | null, depth: number): TNode {
  return { name, parent, ctx, depth, bytes: 0, fileBytes: 0, files: 0, dirs: 0, lastWrite: 0, children: null, inaccessible: false, subInaccessible: false }
}

function joinPath(parent: string, name: string): string {
  return parent.endsWith('\\') ? parent + name : `${parent}\\${name}`
}

export async function nodeScanRoot(opts: NodeScanOptions): Promise<DriveScanResult> {
  const started = Date.now()
  const root = newNode(opts.root, null, null, 0)
  const excludes = new Set(opts.excludes.map((e) => e.replace(/\\+$/, '').toLowerCase()))
  const top = new TopK(opts.topFiles)
  const old = new TopK(OLD_MAX)
  const oldCutoff = Date.now() - OLD_DAYS * 86_400_000
  const cat = new Map<FileCategory, { bytes: number; files: number }>()
  const ext = new Map<string, { bytes: number; files: number }>()
  const samples: string[] = []
  let files = 0
  let dirs = 0
  let bytes = 0
  let inaccessible = 0
  let links = 0
  let lastReport = 0

  try {
    await fs.access(opts.root)
  } catch {
    return {
      root: opts.root,
      scannedAt: new Date(started).toISOString(),
      durationMs: 0,
      totalBytes: 0,
      files: 0,
      dirs: 0,
      cloudOnlyBytes: 0,
      inaccessibleDirs: 0,
      tree: { name: opts.root, path: opts.root, bytes: 0, files: 0, dirs: 0 },
      topFiles: [],
      oldLargeFiles: [],
      categories: [],
      engine: 'node',
      error: 'Unidade ou pasta não encontrada: ' + opts.root
    }
  }

  await walk<TNode>(
    opts.root,
    root,
    {
      enterDir(parent, name, full, depth) {
        if (excludes.size && excludes.has(full.toLowerCase())) return null
        const child = newNode(name, parent, dirContext(name, depth, parent.ctx), depth)
        ;(parent.children ??= []).push(child)
        parent.dirs++
        dirs++
        return child
      },
      onFile(dir, f) {
        files++
        bytes += f.size
        dir.files++
        dir.bytes += f.size
        dir.fileBytes += f.size
        if (f.mtimeMs > dir.lastWrite) dir.lastWrite = f.mtimeMs
        const e = extOf(f.name)
        const category = dir.ctx ?? categoryOfExt(e)
        const c = cat.get(category) ?? { bytes: 0, files: 0 }
        c.bytes += f.size
        c.files++
        cat.set(category, c)
        const x = ext.get(e) ?? { bytes: 0, files: 0 }
        x.bytes += f.size
        x.files++
        ext.set(e, x)
        const make = (): FileEntry => ({
          path: f.path,
          bytes: f.size,
          lastWrite: Math.round(f.mtimeMs),
          lastAccess: f.atimeMs > 0 ? Math.round(f.atimeMs) : undefined,
          ext: e,
          category
        })
        top.offer(f.size, make)
        if (f.size >= OLD_MIN_BYTES && f.mtimeMs <= oldCutoff) old.offer(f.size, make)
      },
      onDirDone(dir, dirPath, failed) {
        if (failed) {
          dir.inaccessible = true
          inaccessible++
          if (samples.length < 40) samples.push(dirPath)
        }
        const now = Date.now()
        if (opts.onProgress && now - lastReport > 200) {
          lastReport = now
          opts.onProgress({ files, dirs, bytes, current: dirPath })
        }
      },
      onLinkSkipped() {
        links++
      }
    },
    { concurrency: opts.concurrency, signal: opts.signal }
  )

  aggregate(root)
  const tree = buildDto(root, opts.root, opts)
  const categories: CategoryStat[] = [...cat.entries()]
    .map(([category, v]) => ({ category, bytes: v.bytes, files: v.files }))
    .sort((a, b) => b.bytes - a.bytes)
  const extensions: ExtensionStat[] = [...ext.entries()]
    .sort((a, b) => b[1].bytes - a[1].bytes)
    .slice(0, 40)
    .map(([e, v]) => ({ ext: e, category: categoryOfExt(e), bytes: v.bytes, files: v.files }))

  opts.onProgress?.({ files, dirs, bytes, current: '' })
  return {
    root: opts.root,
    scannedAt: new Date(started).toISOString(),
    durationMs: Date.now() - started,
    totalBytes: root.bytes,
    files: root.files,
    dirs: root.dirs,
    cloudOnlyBytes: 0,
    inaccessibleDirs: inaccessible,
    tree,
    topFiles: top.result(),
    oldLargeFiles: old.result(),
    categories,
    engine: 'node',
    skippedLinks: links,
    inaccessibleSamples: samples.length ? samples : undefined,
    extensions
  }
}

function aggregate(root: TNode): void {
  const order: TNode[] = [root]
  for (let i = 0; i < order.length; i++) {
    const ch = order[i].children
    if (ch) for (const c of ch) order.push(c)
  }
  for (let i = order.length - 1; i >= 0; i--) {
    const n = order[i]
    n.subInaccessible ||= n.inaccessible
    const p = n.parent
    if (!p) continue
    p.bytes += n.bytes
    p.files += n.files
    p.dirs += n.dirs
    if (n.lastWrite > p.lastWrite) p.lastWrite = n.lastWrite
    if (n.subInaccessible) p.subInaccessible = true
  }
}

function buildDto(n: TNode, p: string, opts: NodeScanOptions): DirNode {
  const dto: DirNode = {
    name: n.name,
    path: p,
    bytes: n.bytes,
    files: n.files,
    dirs: n.dirs,
    lastWrite: n.lastWrite > 0 ? Math.round(n.lastWrite) : undefined,
    fileBytes: n.fileBytes > 0 ? n.fileBytes : undefined
  }
  let inaccessible = n.inaccessible
  let shown = 0
  if (n.children?.length) {
    const kept: DirNode[] = []
    if (n.depth < opts.maxDepth) {
      n.children.sort((a, b) => b.bytes - a.bytes)
      for (const c of n.children) {
        if (kept.length < MAX_CHILDREN && c.bytes >= opts.minNodeBytes) {
          kept.push(buildDto(c, joinPath(p, c.name), opts))
          shown += c.bytes
        } else if (c.subInaccessible) {
          inaccessible = true
        }
      }
    } else if (n.subInaccessible) {
      inaccessible = true
    }
    if (kept.length) dto.children = kept
  }
  const other = n.bytes - shown
  if (other > 0) dto.otherBytes = other
  if (inaccessible) dto.inaccessible = true
  return dto
}
