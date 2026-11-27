// Utilidades de disco da Busca Profunda: SOMENTE LEITURA, nunca seguem junctions/links, sempre com orçamento
// (tempo/entradas) para a busca não travar em pastas enormes.
import { promises as fs, type Dirent, type Stats } from 'node:fs'
import path from 'node:path'

export async function lstatSafe(p: string): Promise<Stats | null> {
  try {
    return await fs.lstat(p)
  } catch {
    return null
  }
}

export async function statSafe(p: string): Promise<Stats | null> {
  try {
    return await fs.stat(p)
  } catch {
    return null
  }
}

/** readdir tolerante (sem permissão / não existe = lista vazia). */
export async function readDirSafe(p: string): Promise<Dirent[]> {
  try {
    return await fs.readdir(p, { withFileTypes: true })
  } catch {
    return []
  }
}

export async function isDir(p: string): Promise<boolean> {
  const st = await lstatSafe(p)
  return Boolean(st && st.isDirectory() && !st.isSymbolicLink())
}

export async function isFile(p: string): Promise<boolean> {
  const st = await lstatSafe(p)
  return Boolean(st && st.isFile())
}

export async function exists(p: string | undefined | null): Promise<boolean> {
  if (!p) return false
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

export interface DirSizeResult {
  bytes: number
  files: number
  dirs: number
  /** epoch ms da modificação mais recente encontrada */
  newest: number
  /** Algum item dentro é atalho de pasta (junction/link simbólico): não foi seguido */
  reparse: string[]
  /** Orçamento estourado: o tamanho real pode ser maior */
  truncated: boolean
  /** .exe encontrados (até 50), para assinaturas/donos */
  exes: string[]
  /** Pastas sem permissão de leitura */
  denied: number
}

export interface DirSizeOptions {
  maxEntries?: number
  timeBudgetMs?: number
  signal?: AbortSignal
  /** Coletar caminhos de .exe (até 50) */
  collectExes?: boolean
  /** Profundidade máxima (padrão: sem limite) */
  maxDepth?: number
}

/**
 * Soma o tamanho de uma pasta sem seguir atalhos (junctions/links/pontos de montagem aparecem como link no
 * readdir do libuv e são só anotados). Orçamento padrão: 400 mil entradas / 20 s.
 */
export async function dirSize(root: string, opts: DirSizeOptions = {}): Promise<DirSizeResult> {
  const maxEntries = opts.maxEntries ?? 400_000
  const deadline = Date.now() + (opts.timeBudgetMs ?? 20_000)
  const res: DirSizeResult = { bytes: 0, files: 0, dirs: 0, newest: 0, reparse: [], truncated: false, exes: [], denied: 0 }
  const rootSt = await lstatSafe(root)
  if (!rootSt) return res
  if (rootSt.isSymbolicLink()) {
    res.reparse.push(root)
    return res
  }
  if (rootSt.isFile()) {
    res.bytes = rootSt.size
    res.files = 1
    res.newest = rootSt.mtimeMs
    return res
  }
  res.newest = rootSt.mtimeMs
  const stack: { p: string; depth: number }[] = [{ p: root, depth: 0 }]
  let seen = 0
  while (stack.length) {
    if (opts.signal?.aborted || Date.now() > deadline || seen > maxEntries) {
      res.truncated = true
      break
    }
    const { p, depth } = stack.pop()!
    let ents: Dirent[]
    try {
      ents = await fs.readdir(p, { withFileTypes: true })
    } catch {
      res.denied++
      continue
    }
    res.dirs++
    const files: string[] = []
    for (const e of ents) {
      seen++
      const full = path.win32.join(p, e.name)
      if (e.isSymbolicLink()) {
        if (res.reparse.length < 20) res.reparse.push(full)
        continue
      }
      if (e.isDirectory()) {
        if (opts.maxDepth === undefined || depth < opts.maxDepth) stack.push({ p: full, depth: depth + 1 })
        continue
      }
      if (e.isFile()) {
        files.push(full)
        if (opts.collectExes && res.exes.length < 50 && /\.exe$/i.test(e.name)) res.exes.push(full)
      }
    }
    // stat em lotes pequenos (paralelo) para pastas com muitos arquivos
    for (let i = 0; i < files.length; i += 64) {
      const batch = files.slice(i, i + 64)
      const sts = await Promise.all(batch.map((f) => lstatSafe(f)))
      for (const st of sts) {
        if (!st) continue
        res.files++
        res.bytes += st.size
        if (st.mtimeMs > res.newest) res.newest = st.mtimeMs
      }
    }
  }
  return res
}

/**
 * Procura atalhos de pasta (junction/link simbólico/ponto de montagem) dentro de uma árvore, sem segui-los.
 * Devolve { found } com até 10 caminhos e `complete: false` se o orçamento estourou (aí o chamador deve recusar:
 * fail-closed).
 */
export async function findReparseInside(root: string, opts: { maxEntries?: number; timeBudgetMs?: number } = {}): Promise<{ found: string[]; complete: boolean; denied: number }> {
  const r = await dirSize(root, { maxEntries: opts.maxEntries ?? 600_000, timeBudgetMs: opts.timeBudgetMs ?? 60_000 })
  return { found: r.reparse.slice(0, 10), complete: !r.truncated, denied: r.denied }
}

/** Mapeia com concorrência limitada (ordem preservada). */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i], i)
    }
  })
  await Promise.all(workers)
  return out
}

/** Lista arquivos de uma pasta até `maxDepth` (0 = só a pasta), sem seguir links, com limite de entradas. */
export async function listFilesDeep(
  root: string,
  opts: { maxDepth: number; maxEntries?: number; signal?: AbortSignal; skipDir?: (full: string, name: string, depth: number) => boolean }
): Promise<{ files: { path: string; name: string; depth: number }[]; dirs: { path: string; name: string; depth: number }[]; truncated: boolean }> {
  const maxEntries = opts.maxEntries ?? 50_000
  const files: { path: string; name: string; depth: number }[] = []
  const dirs: { path: string; name: string; depth: number }[] = []
  const queue: { p: string; depth: number }[] = [{ p: root, depth: 0 }]
  let seen = 0
  let truncated = false
  while (queue.length) {
    if (opts.signal?.aborted || seen > maxEntries) {
      truncated = true
      break
    }
    const { p, depth } = queue.shift()!
    for (const e of await readDirSafe(p)) {
      seen++
      if (e.isSymbolicLink()) continue
      const full = path.win32.join(p, e.name)
      if (e.isDirectory()) {
        dirs.push({ path: full, name: e.name, depth })
        if (depth < opts.maxDepth && !(opts.skipDir?.(full, e.name, depth) ?? false)) queue.push({ p: full, depth: depth + 1 })
      } else if (e.isFile()) {
        files.push({ path: full, name: e.name, depth })
      }
    }
  }
  return { files, dirs, truncated }
}

/** Compara caminhos do Windows (minúsculas, '\', sem barra final). */
export function pkey(p: string | undefined | null): string {
  if (!p) return ''
  let s = String(p).trim().replace(/^"+|"+$/g, '').replace(/\//g, '\\')
  s = s.replace(/^\\\\\?\\/, '')
  s = s.replace(/\\{2,}/g, '\\')
  if (s.length > 3) s = s.replace(/\\+$/, '')
  return s.toLowerCase()
}

/** a está dentro de b (ou é b). */
export function insideOrEqual(a: string, b: string): boolean {
  const x = pkey(a)
  const y = pkey(b)
  if (!x || !y) return false
  if (x === y) return true
  return x.startsWith(y.endsWith('\\') ? y : y + '\\')
}

export function strictlyInside(a: string, b: string): boolean {
  return pkey(a) !== pkey(b) && insideOrEqual(a, b)
}
