// Motor de exclusão seguro. Caminha com lstat e:
//  - NUNCA entra em junctions/links simbólicos (remove só o próprio link, nunca o alvo);
//  - nunca apaga a pasta raiz (só o conteúdo);
//  - pula arquivos em uso / sem permissão (contados em `skipped`);
//  - respeita filtros (idade, nomes, profundidade), cancelamento e limite de tempo;
//  - consulta o guard para CADA item antes de apagar; pastas bloqueadas não são percorridas;
//  - remove subpastas que ficaram vazias (e que também passam no filtro de idade).
// Com dryRun=true faz exatamente o mesmo caminho sem apagar nada (usado na estimativa de tamanho).
import { promises as fsp, type Dirent, type Stats } from 'node:fs'
import path from 'node:path'
import type { CleanupSampleFile, GuardDecision } from '@shared/types/cleanup'
import { reparsePointIn } from '../safety/guard'
import { createLimiter, errCode, fsErrorText, globMatcher } from './util'

export interface EngineProgress {
  files: number
  bytes: number
  skipped: number
  currentPath: string
}

export interface DeleteContentsOptions {
  /** Só arquivos/pastas cuja data (modificação ou criação, a mais recente) é mais antiga que N dias. */
  olderThanDays?: number
  /** Só arquivos cujo nome casa com um destes padrões ('*.exe'). Com filtro, pastas vazias não são removidas. */
  include?: string[]
  /** 0 = só os arquivos direto na raiz. Sem valor = todas as subpastas. */
  maxDepth?: number
  /** Envia para a Lixeira (trash) em vez de apagar de vez. */
  recycle?: boolean
  /** Não apaga nada: só conta o que seria apagado. */
  dryRun?: boolean
  /** Padrão: true (exceto com include/recycle) */
  removeEmptyDirs?: boolean
  /** Decide se cada item pode ser apagado. Itens bloqueados são pulados; pastas bloqueadas não são percorridas. */
  guard: (p: string) => GuardDecision | boolean
  signal?: AbortSignal
  onProgress?: (p: EngineProgress) => void
  progressIntervalMs?: number
  /** dryRun: guarda os N maiores arquivos encontrados (para o usuário conferir). */
  collectTop?: number
  /** Para depois deste tempo (ms) e marca truncated. */
  timeBudgetMs?: number
  /** Função de Lixeira (obrigatória com recycle). */
  trash?: (p: string) => Promise<void>
  /** Relógio (testes). */
  now?: number
  /** Operações de disco simultâneas. Padrão 24. */
  concurrency?: number
}

export interface EngineStats {
  root: string
  /** Arquivos apagados (ou que seriam, em dryRun) */
  files: number
  bytes: number
  /** Em uso / sem permissão / protegidos pelo guard */
  skipped: number
  /** Parte de `skipped` bloqueada pelo guard */
  protectedSkipped: number
  linksRemoved: number
  dirsRemoved: number
  /** Pastas que não puderam ser lidas */
  inaccessible: number
  errors: string[]
  cancelled: boolean
  truncated: boolean
  rootMissing: boolean
  /** A própria raiz não pôde ser lida (ex.: pasta do sistema sem administrador) */
  rootUnreadable: boolean
  top: CleanupSampleFile[]
}

const DAY = 86_400_000

function emptyStats(root: string): EngineStats {
  return {
    root,
    files: 0,
    bytes: 0,
    skipped: 0,
    protectedSkipped: 0,
    linksRemoved: 0,
    dirsRemoved: 0,
    inaccessible: 0,
    errors: [],
    cancelled: false,
    truncated: false,
    rootMissing: false,
    rootUnreadable: false,
    top: []
  }
}

/** Apaga um arquivo comum; se for somente-leitura, tira o atributo e tenta de novo (restaura se falhar). */
export async function unlinkFile(p: string, st?: Stats): Promise<void> {
  try {
    await fsp.unlink(p)
  } catch (e) {
    const code = errCode(e)
    const readOnly = st ? (st.mode & 0o200) === 0 : true
    if ((code === 'EPERM' || code === 'EACCES') && readOnly) {
      try {
        await fsp.chmod(p, 0o666)
      } catch {
        throw e
      }
      try {
        await fsp.unlink(p)
      } catch (e2) {
        await fsp.chmod(p, 0o444).catch(() => undefined)
        throw e2
      }
      return
    }
    throw e
  }
}

/** Apaga o CONTEÚDO de `root` com segurança (ver cabeçalho). Nunca lança por arquivo individual. */
export async function deleteContents(root: string, opts: DeleteContentsOptions): Promise<EngineStats> {
  const resolvedRoot = path.win32.resolve(root)
  if (!/^[A-Za-z]:\\./.test(resolvedRoot)) throw new Error(`Pasta raiz inválida para limpeza: ${root}`)
  const stats = emptyStats(resolvedRoot)
  const limit = createLimiter(Math.max(1, opts.concurrency ?? 24))
  const matcher = globMatcher(opts.include)
  const cutoff = opts.olderThanDays && opts.olderThanDays > 0 ? (opts.now ?? Date.now()) - opts.olderThanDays * DAY : null
  const removeEmpty = (opts.removeEmptyDirs ?? true) && !matcher && !opts.recycle
  const started = Date.now()
  const interval = opts.progressIntervalMs ?? 200
  let lastProgress = 0

  const progress = (current: string, force = false): void => {
    if (!opts.onProgress) return
    const now = Date.now()
    if (!force && now - lastProgress < interval) return
    lastProgress = now
    opts.onProgress({ files: stats.files, bytes: stats.bytes, skipped: stats.skipped, currentPath: current })
  }
  const stop = (): boolean => {
    if (stats.cancelled || stats.truncated) return true
    if (opts.signal?.aborted) {
      stats.cancelled = true
      return true
    }
    if (opts.timeBudgetMs && Date.now() - started > opts.timeBudgetMs) {
      stats.truncated = true
      return true
    }
    return false
  }
  const allowed = (p: string): boolean => {
    try {
      const d = opts.guard(p)
      return typeof d === 'boolean' ? d : d.allowed
    } catch {
      return false
    }
  }
  // Data mais recente entre modificação e criação: um arquivo extraído agora (com data antiga preservada) é "novo".
  const tooNew = (st: Stats): boolean => cutoff !== null && Math.max(st.mtimeMs, st.birthtimeMs || 0) > cutoff
  const addError = (msg: string): void => {
    if (stats.errors.length < 30) stats.errors.push(msg)
  }
  const addTop = (p: string, st: Stats): void => {
    if (!opts.collectTop) return
    stats.top.push({ path: p, bytes: st.size, lastWrite: st.mtimeMs })
    if (stats.top.length > opts.collectTop * 2) {
      stats.top.sort((a, b) => b.bytes - a.bytes)
      stats.top.length = opts.collectTop
    }
  }

  let rootStat: Stats
  try {
    rootStat = await fsp.lstat(resolvedRoot)
  } catch (e) {
    if (errCode(e) === 'ENOENT' || errCode(e) === 'ENOTDIR') stats.rootMissing = true
    else {
      stats.inaccessible++
      addError(`${resolvedRoot}: ${fsErrorText(e)}`)
    }
    return stats
  }
  if (rootStat.isSymbolicLink()) {
    addError(`${resolvedRoot}: a pasta é um atalho (junction/link) e não será limpa.`)
    return stats
  }
  if (!rootStat.isDirectory()) {
    addError(`${resolvedRoot}: não é uma pasta.`)
    return stats
  }
  // O lstat não vê junctions para "\??\Volume{GUID}\..." nem pontos de montagem (segue o destino): confere a
  // raiz e cada pasta do caminho dela pelo caminho real.
  const reparseAt = reparsePointIn(resolvedRoot)
  if (reparseAt) {
    addError(`${resolvedRoot}: a pasta é um atalho (junction/ponto de montagem em "${reparseAt}") e não será limpa.`)
    return stats
  }

  /** 'removed' | 'gone' (já não existia) | 'failed' */
  async function removeFile(p: string, st: Stats): Promise<'removed' | 'gone' | 'failed'> {
    try {
      if (opts.recycle) {
        if (!opts.trash) throw new Error('Lixeira indisponível')
        await opts.trash(p)
      } else {
        await unlinkFile(p, st)
      }
      return 'removed'
    } catch (e) {
      if (errCode(e) === 'ENOENT') return 'gone'
      stats.skipped++
      const code = errCode(e)
      // Arquivos em uso são esperados (programas abertos): não poluem a lista de erros.
      if (code !== 'EBUSY' && code !== 'EPERM' && code !== 'EACCES') addError(`${p}: ${fsErrorText(e)}`)
      return 'failed'
    }
  }

  /** Processa uma pasta; devolve true se ela ficou vazia. */
  async function walk(dir: string, depth: number): Promise<boolean> {
    if (stop()) return false
    let entries: Dirent[]
    try {
      entries = await limit(() => fsp.readdir(dir, { withFileTypes: true }))
    } catch (e) {
      if (errCode(e) !== 'ENOENT') {
        stats.inaccessible++
        if (depth === 0) stats.rootUnreadable = true
      }
      return false
    }
    progress(dir)
    let remaining = entries.length
    const subdirs: { full: string; st: Stats }[] = []

    await Promise.all(
      entries.map((ent) =>
        limit(async () => {
          if (stop()) return
          const full = `${dir}\\${ent.name}`
          let st: Stats
          try {
            st = await fsp.lstat(full)
          } catch (e) {
            if (errCode(e) === 'ENOENT') remaining--
            else stats.skipped++
            return
          }
          // Atalho (junction / link simbólico / outro ponto de nova análise de pasta): NUNCA é seguido.
          if (st.isSymbolicLink() || (ent.isSymbolicLink() && st.isDirectory())) {
            if (!st.isSymbolicLink()) {
              stats.skipped++
              return
            }
            if (matcher || opts.recycle || tooNew(st)) return
            if (!allowed(full)) {
              stats.protectedSkipped++
              stats.skipped++
              return
            }
            if (!opts.dryRun) {
              try {
                // Em pasta-junction, unlink remove SÓ o link (o conteúdo do destino fica intacto).
                await fsp.unlink(full)
                stats.linksRemoved++
              } catch (e) {
                if (errCode(e) !== 'ENOENT') {
                  stats.skipped++
                  return
                }
              }
            }
            remaining--
            return
          }
          if (st.isDirectory()) {
            subdirs.push({ full, st })
            return
          }
          // Arquivo
          if (matcher && !matcher(ent.name)) return
          if (tooNew(st)) return
          if (!allowed(full)) {
            stats.protectedSkipped++
            stats.skipped++
            return
          }
          if (opts.dryRun) {
            stats.files++
            stats.bytes += st.size
            addTop(full, st)
            remaining--
            return
          }
          const res = await removeFile(full, st)
          if (res === 'removed') {
            stats.files++
            stats.bytes += st.size
            remaining--
            progress(full)
          } else if (res === 'gone') remaining--
        })
      )
    )

    await Promise.all(
      subdirs.map(async ({ full, st }) => {
        if (stop()) return
        if (opts.maxDepth !== undefined && depth >= opts.maxDepth) return
        if (!allowed(full)) {
          stats.protectedSkipped++
          stats.skipped++
          return
        }
        const empty = await walk(full, depth + 1)
        if (!empty || !removeEmpty || tooNew(st) || stop()) return
        if (opts.dryRun) {
          remaining--
          return
        }
        try {
          await limit(() => fsp.rmdir(full))
          stats.dirsRemoved++
          remaining--
        } catch (e) {
          if (errCode(e) === 'ENOENT') remaining--
        }
      })
    )
    return remaining === 0
  }

  await walk(resolvedRoot, 0)
  if (opts.collectTop) {
    stats.top.sort((a, b) => b.bytes - a.bytes)
    if (stats.top.length > opts.collectTop) stats.top.length = opts.collectTop
  }
  progress(resolvedRoot, true)
  return stats
}

/** Soma dos stats de várias raízes. */
export function mergeStats(list: EngineStats[]): Omit<EngineStats, 'root'> {
  const out = emptyStats('')
  for (const s of list) {
    out.files += s.files
    out.bytes += s.bytes
    out.skipped += s.skipped
    out.protectedSkipped += s.protectedSkipped
    out.linksRemoved += s.linksRemoved
    out.dirsRemoved += s.dirsRemoved
    out.inaccessible += s.inaccessible
    out.errors.push(...s.errors)
    out.cancelled ||= s.cancelled
    out.truncated ||= s.truncated
    out.top.push(...s.top)
  }
  out.top.sort((a, b) => b.bytes - a.bytes)
  out.rootMissing = list.every((s) => s.rootMissing)
  out.rootUnreadable = list.length > 0 && list.every((s) => s.rootUnreadable || s.rootMissing) && list.some((s) => s.rootUnreadable)
  const { root: _root, ...rest } = out
  return rest
}
