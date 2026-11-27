// Percorre uma árvore de pastas em Node puro (fallback quando o helper nativo não existe). SOMENTE LEITURA.
// - Concorrência limitada (várias pastas ao mesmo tempo, lstat em lotes).
// - NUNCA segue junctions/symlinks: no Windows o libuv marca todo reparse point como "link" no readdir;
//   o lstat diferencia link de verdade (junction/symlink → isSymbolicLink) de pasta/arquivo de nuvem (OneDrive).
import { promises as fs, type Stats } from 'node:fs'
import path from 'node:path'
import { CancelledError } from './native'

export interface WalkFile {
  path: string
  name: string
  size: number
  mtimeMs: number
  atimeMs: number
  /** É um reparse point (ex.: arquivo do OneDrive). Ler o conteúdo pode baixá-lo da nuvem. */
  reparse: boolean
}

export interface WalkHooks<D> {
  /** Subpasta encontrada: devolve o contexto dela, ou null para NÃO entrar. depth 1 = filha da raiz. */
  enterDir(parent: D, name: string, fullPath: string, depth: number): D | null
  onFile(dir: D, file: WalkFile): void
  /** Pasta concluída. failed = sem permissão de leitura. */
  onDirDone?(dir: D, dirPath: string, failed: boolean): void
  onLinkSkipped?(fullPath: string): void
}

export interface WalkOptions {
  /** Pastas lidas ao mesmo tempo */
  concurrency: number
  signal?: AbortSignal
  /** Arquivos menores que isto não recebem lstat (economiza tempo quando só interessam arquivos grandes). */
  statFilter?: (name: string) => boolean
}

const STAT_BATCH = 48

/**
 * Pastas que são reparse points mas NÃO são link (o lstat não diz "symlink") só são seguidas dentro de pastas de
 * sincronização na nuvem (OneDrive & cia., onde toda pasta é reparse point). Fora delas são, por exemplo, camadas
 * de contêiner do Windows (WCI) que apontam para arquivos do sistema e seriam contadas em dobro.
 */
const CLOUD_ROOT = /\\(onedrive[^\\]*|dropbox[^\\]*|icloud ?drive|google drive|box|mega[^\\]*)\\/i

interface Item<D> {
  ctx: D
  path: string
  depth: number
}

export async function walk<D>(rootPath: string, rootCtx: D, hooks: WalkHooks<D>, opts: WalkOptions): Promise<void> {
  const stack: Item<D>[] = [{ ctx: rootCtx, path: rootPath, depth: 0 }]
  let active = 0
  let waiters: (() => void)[] = []
  const wake = (): void => {
    const w = waiters
    waiters = []
    for (const f of w) f()
  }

  const processDir = async (item: Item<D>): Promise<void> => {
    const files: { full: string; name: string; reparse?: boolean }[] = []
    const links: { full: string; name: string }[] = []
    let failed = false
    try {
      const dir = await fs.opendir(item.path, { bufferSize: 256 })
      for await (const d of dir) {
        const full = path.join(item.path, d.name)
        if (d.isSymbolicLink()) links.push({ full, name: d.name })
        else if (d.isDirectory()) pushDir(item, d.name, full)
        else if (d.isFile()) files.push({ full, name: d.name })
      }
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') failed = true
    }

    // Reparse points: link de verdade é ignorado; pasta/arquivo de nuvem é tratado normalmente.
    for (const l of links) {
      if (opts.signal?.aborted) break
      let st: Stats
      try {
        st = await fs.lstat(l.full)
      } catch {
        continue
      }
      if (st.isSymbolicLink()) hooks.onLinkSkipped?.(l.full)
      else if (st.isDirectory()) {
        if (CLOUD_ROOT.test(l.full + '\\')) pushDir(item, l.name, l.full)
        else hooks.onLinkSkipped?.(l.full)
      } else if (st.isFile()) files.push({ ...l, reparse: true })
    }

    const wanted = opts.statFilter ? files.filter((f) => opts.statFilter!(f.name)) : files
    for (let i = 0; i < wanted.length; i += STAT_BATCH) {
      if (opts.signal?.aborted) break
      const batch = wanted.slice(i, i + STAT_BATCH)
      const stats = await Promise.all(batch.map((f) => fs.lstat(f.full).catch(() => null)))
      stats.forEach((st, j) => {
        if (st && st.isFile()) {
          hooks.onFile(item.ctx, {
            path: batch[j].full,
            name: batch[j].name,
            size: st.size,
            mtimeMs: st.mtimeMs,
            atimeMs: st.atimeMs,
            reparse: Boolean(batch[j].reparse)
          })
        }
      })
    }
    hooks.onDirDone?.(item.ctx, item.path, failed)
  }

  const pushDir = (parent: Item<D>, name: string, full: string): void => {
    const ctx = hooks.enterDir(parent.ctx, name, full, parent.depth + 1)
    if (ctx === null) return
    stack.push({ ctx, path: full, depth: parent.depth + 1 })
    wake()
  }

  const worker = async (): Promise<void> => {
    for (;;) {
      if (opts.signal?.aborted) return
      const item = stack.pop()
      if (!item) {
        if (active === 0) return
        await new Promise<void>((r) => waiters.push(r))
        continue
      }
      active++
      try {
        await processDir(item)
      } finally {
        active--
        if (active === 0 && stack.length === 0) wake()
      }
    }
  }

  opts.signal?.addEventListener('abort', wake, { once: true })
  try {
    await Promise.all(Array.from({ length: Math.max(1, opts.concurrency) }, () => worker()))
  } finally {
    opts.signal?.removeEventListener('abort', wake)
  }
  if (opts.signal?.aborted) throw new CancelledError()
}
