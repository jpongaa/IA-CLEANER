// API do domínio Limpeza Inteligente. Toda exclusão passa pelo guard (src/main/safety/guard.ts).
import { createHash } from 'node:crypto'
import { promises as fsp, type Stats } from 'node:fs'
import type {
  CleanupApi,
  CleanupEstimate,
  CleanupRunReport,
  CleanupStatus,
  CleanupTarget,
  CleanupTargetResult,
  DeleteDuplicatesGroup,
  DeleteDuplicatesRequest,
  DeleteFilesReport,
  DeleteFilesRequest,
  GuardDecision,
  RecycleBinInfo,
  SkipCode
} from '@shared/types/cleanup'
import { cleanupAppName } from '@shared/types/cleanup'
import type { ActionResult, TaskProgress } from '@shared/types/common'
import { formatBytes } from '@shared/format'
import { logAction } from '../core/actionLog'
import { emit, throttledEmitter } from '../core/events'
import { platform } from '../core/platform'
import { getLatest, setLatest } from '../core/state'
import { checkPath, checkPathLexical, checkTargetRoot, normalizeWinPath, pathForDeletion, reparsePointIn } from '../safety/guard'
import { runAdminTasks, type AdminTask, type AdminTaskResult } from './admin'
import { refreshKnownAppDirs } from './appDirs'
import { deleteContents, unlinkFile } from './engine'
import { estimateAll, isFileSync, measurePaths } from './estimate'
import {
  CLEANMGR_CATEGORIES,
  DISM_RESETBASE_ID,
  DRIVERSTORE_ID,
  dockerBuilderPrune,
  extremeCommandOf,
  findDockerCli,
  isGpuPackage,
  oldDriverCandidates,
  probeDriverStore
} from './extreme'
import { getBinState, invalidateBinState, normalizeDrive, RecycleBudget, runEmptyBin } from './recycle'
import { errCode, fsErrorText, hasNameFilter, listRunningProcesses } from './util'

const MAX_PATHS = 5000
/** Diferença aceita entre a data do relatório de duplicados e a do disco (FAT/exFAT gravam com 2 s de resolução). */
const MTIME_TOLERANCE_MS = 2000
const STALE_DUPLICATES = 'O relatório de duplicados está desatualizado; procure de novo.'
const PERMANENT_ONLY_LISTED =
  'Apagar definitivamente só vale para itens listados numa análise do app (última Análise de Discos, última busca de duplicados ou última Busca Profunda) ou que acabaram de voltar como "grande demais para a Lixeira". Use a Lixeira ou analise de novo.'
/** Pasta com muitos arquivos: tempo máximo da conferência antes de mandar para a Lixeira. */
const DIR_CHECK_BUDGET_MS = 120_000
/** Itens que voltaram como "grande demais para a Lixeira" podem ser apagados de vez por este tempo. */
const TOO_BIG_TTL_MS = 30 * 60_000

type Busy = 'estimate' | 'run' | null

/** Itens recusados pela Lixeira (grandes demais / não cabem): a interface oferece "Apagar de vez" (digitar APAGAR). */
const recentTooBig = new Map<string, number>()

function rememberTooBig(p: string): void {
  const k = pathKey(p)
  if (!k) return
  recentTooBig.set(k, Date.now() + TOO_BIG_TTL_MS)
  if (recentTooBig.size > 20_000) {
    const now = Date.now()
    for (const [key, exp] of recentTooBig) if (exp < now) recentTooBig.delete(key)
  }
}

/** Código do motivo a partir de um erro do sistema de arquivos / da Lixeira. */
function codeOfError(e: unknown): SkipCode {
  const c = errCode(e)
  if (c === 'ETOOBIGFORRECYCLE') return 'tooBigForRecycle'
  if (c === 'ENOENT') return 'missing'
  if (c === 'EBUSY' || c === 'EPERM' || c === 'EACCES') return 'inUse'
  // shell.trashItem do Electron cancela (E_ABORT) quando o Windows apagaria de vez
  if (/0x80004004|E_ABORT|abort|TOO_BIG_FOR_RECYCLE/i.test((e as Error)?.message ?? '')) return 'tooBigForRecycle'
  return 'error'
}

/** SOMENTE TESTES: trocam o que exigiria administrador/Docker/pnputil reais no run(). */
interface CleanupTestHooks {
  adminRunner: (tasks: AdminTask[], signal?: AbortSignal) => ReturnType<typeof runAdminTasks>
  driverProbe: typeof probeDriverStore
  dockerPrune: typeof dockerBuilderPrune
  dockerCli: () => Promise<string | null>
}
const realHooks: CleanupTestHooks = { adminRunner: runAdminTasks, driverProbe: probeDriverStore, dockerPrune: dockerBuilderPrune, dockerCli: findDockerCli }
let hooks: CleanupTestHooks = realHooks

export function setCleanupTestHooks(h: Partial<CleanupTestHooks> | null): void {
  hooks = h ? { ...realHooks, ...h } : realHooks
}

/** Chave de comparação de caminhos (normalizada, sem diferenciar maiúsculas). */
function pathKey(p: unknown): string | null {
  const n = normalizeWinPath(p)
  return n.ok ? n.key : null
}

/**
 * Caminhos que podem ser apagados DEFINITIVAMENTE: só os que o próprio app listou — última varredura de disco
 * (maiores, antigos e as PASTAS da árvore), último relatório de duplicados, último relatório da Busca Profunda — e
 * os que acabaram de voltar como "grande demais para a Lixeira". Um caminho qualquer vindo da interface vai para a
 * Lixeira. (O guard continua valendo para todos: listar não libera área protegida.)
 */
async function permanentAllowList(): Promise<Set<string>> {
  const keys = new Set<string>()
  const add = (p: unknown): void => {
    const k = pathKey(p)
    if (k) keys.add(k)
  }
  try {
    const scan = await getLatest('scan')
    for (const d of Array.isArray(scan?.drives) ? scan.drives : []) {
      for (const f of Array.isArray(d?.topFiles) ? d.topFiles : []) add(f?.path)
      for (const f of Array.isArray(d?.oldLargeFiles) ? d.oldLargeFiles : []) add(f?.path)
      // Pastas da árvore (Mapa de pastas). A raiz da unidade nunca entra (o guard também a bloqueia).
      const stack = d?.tree && typeof d.tree === 'object' ? [d.tree] : []
      let n = 0
      while (stack.length && n < 200_000) {
        const node = stack.pop()!
        n++
        if (typeof node?.path === 'string' && !/^[A-Za-z]:\\?$/.test(node.path)) add(node.path)
        if (Array.isArray(node?.children)) for (const c of node.children) if (c && typeof c === 'object') stack.push(c)
      }
    }
  } catch {
    // sem varredura salva
  }
  try {
    const rep = await getLatest('discover')
    for (const f of Array.isArray(rep?.findings) ? rep.findings : []) {
      for (const p of Array.isArray(f?.paths) ? f.paths : []) add(p)
      for (const it of Array.isArray(f?.items) ? f.items : []) add(it?.path)
      add(f?.meta?.folder)
    }
  } catch {
    // sem Busca Profunda salva
  }
  const now = Date.now()
  for (const [k, exp] of recentTooBig) {
    if (exp >= now) keys.add(k)
    else recentTooBig.delete(k)
  }
  try {
    const groups = await getLatest('duplicates')
    for (const g of Array.isArray(groups) ? groups : []) for (const f of Array.isArray(g?.files) ? g.files : []) add(f?.path)
  } catch {
    // sem relatório de duplicados
  }
  return keys
}

function result(t: Pick<CleanupTarget, 'id' | 'title'>, patch: Partial<CleanupTargetResult> = {}): CleanupTargetResult {
  return { targetId: t.id, title: t.title, bytesFreed: 0, filesDeleted: 0, skipped: 0, errors: [], ...patch }
}

function statusOf(r: CleanupTargetResult): CleanupTargetResult['status'] {
  if (r.status) return r.status
  if (r.bytesFreed === 0 && r.filesDeleted === 0 && r.errors.length > 0) return 'failed'
  if (r.skipped > 0 || r.errors.length > 0) return 'partial'
  return 'ok'
}

/**
 * SHA-256 COMPLETO de um arquivo (mesmo algoritmo e formato hex da busca de duplicados, nativa ou Node). Falha se o
 * arquivo mudar (tamanho/data) durante a leitura. Devolve também o tamanho/data lidos.
 */
async function sha256File(p: string, signal: AbortSignal): Promise<{ hash: string; size: number; mtimeMs: number }> {
  const fh = await fsp.open(p, 'r')
  try {
    const before = await fh.stat()
    const h = createHash('sha256')
    const buf = Buffer.allocUnsafe(4 * 1024 * 1024)
    let pos = 0
    for (;;) {
      if (signal.aborted) throw new Error('Cancelado.')
      const { bytesRead } = await fh.read(buf, 0, buf.length, pos)
      if (bytesRead === 0) break
      h.update(buf.subarray(0, bytesRead))
      pos += bytesRead
    }
    const after = await fh.stat()
    if (pos !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error('o arquivo mudou durante a conferência')
    return { hash: h.digest('hex'), size: pos, mtimeMs: after.mtimeMs }
  } finally {
    await fh.close()
  }
}

/** Mede a Lixeira (bytes por unidade) para calcular quanto o esvaziamento liberou. */
async function recycleBinBytes(paths: string[]): Promise<number> {
  const m = await measurePaths({ paths, infoOnly: true, timeBudgetMs: 20_000 })
  return m.bytes
}

/**
 * Tarefas de administrador dos comandos OFICIAIS da Busca extrema. O DriverStore é conferido de novo AGORA (somente
 * leitura): só entram as versões escolhidas na análise que continuam antigas e sem uso (o script elevado confere mais
 * uma vez antes de cada pnputil). A Limpeza de Disco recebe SÓ as categorias escolhidas.
 */
async function buildExtremeAdminTasks(targets: CleanupTarget[], push: (r: CleanupTargetResult) => void): Promise<{ tasks: AdminTask[]; included: Set<string> }> {
  const tasks: AdminTask[] = []
  const included = new Set<string>()
  const ds = targets.find((t) => t.id === DRIVERSTORE_ID)
  if (ds) {
    const chosen = new Set((ds.breakdown ?? []).map((b) => b.key?.toLowerCase()).filter((k): k is string => Boolean(k)))
    const probe = await hooks.driverProbe()
    const now = oldDriverCandidates(probe.packages, probe.svcRefs).filter((c) => isGpuPackage(c.pkg) && chosen.has(c.pkg.inf.toLowerCase()))
    if (now.length) {
      tasks.push({ id: DRIVERSTORE_ID, op: 'driverStore', roots: [], drivers: now.map((c) => ({ inf: c.pkg.inf, folder: c.pkg.folder ?? '', bytes: c.pkg.bytes ?? 0 })) })
      included.add(ds.id)
    } else {
      push(
        result(ds, {
          status: 'skipped',
          errors: [
            probe.error && probe.packages.length === 0
              ? `Não foi possível conferir os drivers agora (${probe.error}). Nada foi removido.`
              : 'Nenhuma das versões antigas escolhidas pode ser removida agora (já saíram ou passaram a ser usadas). Analise de novo.'
          ]
        })
      )
    }
  }
  const cm = targets.filter((t) => extremeCommandOf(t.id) === 'cleanmgr')
  if (cm.length) {
    tasks.push({ id: 'cleanmgr', op: 'cleanmgr', roots: [], categories: cm.map((t) => CLEANMGR_CATEGORIES[t.id]) })
    for (const t of cm) included.add(t.id)
  }
  const dism = targets.filter((t) => extremeCommandOf(t.id) === 'dism' || extremeCommandOf(t.id) === 'dismResetBase')
  if (dism.length) {
    // /ResetBase já inclui o StartComponentCleanup: um comando só.
    tasks.push({ id: 'dism', op: 'dism', roots: [], resetBase: dism.some((t) => t.id === DISM_RESETBASE_ID) })
    for (const t of dism) included.add(t.id)
  }
  return { tasks, included }
}

/** Distribui o resultado dos comandos oficiais entre os itens escolhidos (espaço medido pelo espaço livre do disco). */
function attributeExtremeResults(targets: CleanupTarget[], data: AdminTaskResult[]): CleanupTargetResult[] {
  const out: CleanupTargetResult[] = []
  const first = (id: string): AdminTaskResult | undefined => data.find((r) => r.id === id)
  const ds = targets.find((t) => t.id === DRIVERSTORE_ID)
  if (ds) {
    const r = first(DRIVERSTORE_ID)
    out.push(
      r
        ? result(ds, { bytesFreed: r.bytes, filesDeleted: r.files, skipped: r.skipped, errors: r.errors.slice(0, 10) })
        : result(ds, { status: 'failed', errors: ['O comando não devolveu resultado.'] })
    )
  }
  const cm = targets.filter((t) => extremeCommandOf(t.id) === 'cleanmgr')
  if (cm.length) {
    const r = first('cleanmgr')
    const total = r?.bytes ?? 0
    const weights = cm.map((t) => (t.bytes > 0 ? t.bytes : 1024 * 1024))
    const wsum = weights.reduce((a, b) => a + b, 0)
    let given = 0
    cm.forEach((t, i) => {
      // Proporcional à estimativa de cada item; o último fica com o resto (a soma bate com o medido).
      const share = i === cm.length - 1 ? Math.max(0, total - given) : Math.round((total * weights[i]) / wsum)
      given += share
      if (!r) out.push(result(t, { status: 'failed', errors: i === 0 ? ['A Limpeza de Disco não devolveu resultado.'] : [] }))
      else
        out.push(
          result(t, {
            bytesFreed: share,
            errors: i === 0 ? r.errors.slice(0, 5) : [],
            status: r.errors.length ? (total > 0 ? 'partial' : 'failed') : 'ok'
          })
        )
    })
  }
  const dism = targets.filter((t) => extremeCommandOf(t.id) === 'dism' || extremeCommandOf(t.id) === 'dismResetBase')
  if (dism.length) {
    const r = first('dism')
    const owner = dism.find((t) => t.id === DISM_RESETBASE_ID) ?? dism[0]
    const failed = !r || r.errors.some((e) => /terminou com o código|^DISM:/.test(e))
    for (const t of dism) {
      if (t === owner) out.push(result(t, { bytesFreed: r?.bytes ?? 0, errors: r ? r.errors.slice(0, 5) : ['O DISM não devolveu resultado.'], status: failed ? 'failed' : 'ok' }))
      else out.push(result(t, { status: failed ? 'failed' : 'ok', errors: ['Feito junto com a limpeza profunda (/ResetBase).'] }))
    }
  }
  return out
}

export function createCleanupApi(): CleanupApi {
  let busy: Busy = null
  let controller: AbortController | null = null
  // Exclusões escolhidas pelo usuário (Análise de Discos) têm trava e cancelamento próprios: não esperam a
  // análise de limpeza e não são interrompidas pelo cancelar da análise/limpeza (e vice-versa).
  let deleteController: AbortController | null = null
  // Último progresso (para uma página reaberta retomar a barra de progresso: getStatus)
  let lastProgress: TaskProgress | null = null
  let lastDeleteProgress: TaskProgress | null = null
  const progressEmitter = throttledEmitter('cleanup:progress', 150)
  const sendProgress = (p: TaskProgress, force = false): void => {
    lastProgress = p
    progressEmitter(p, force)
  }

  function begin(kind: Exclude<Busy, null>): AbortController {
    if (busy) {
      const what = busy === 'estimate' ? 'uma análise' : 'uma limpeza'
      throw new Error(`Já existe ${what} em andamento. Aguarde terminar.`)
    }
    busy = kind
    controller = new AbortController()
    lastProgress = null
    return controller
  }
  function end(): void {
    busy = null
    controller = null
  }

  /** Evento final (done/error/cancelled): enviado DEPOIS de liberar a trava e salvar o resultado. */
  function finalEvent(task: string, ctl: AbortController, e: unknown): TaskProgress {
    const cancelled = ctl.signal.aborted
    return { task, phase: cancelled ? 'cancelled' : 'error', message: cancelled ? 'Cancelado.' : `Falhou: ${(e as Error)?.message ?? String(e)}` }
  }

  async function estimate(opts?: { extreme?: boolean }): Promise<CleanupEstimate> {
    const ctl = begin('estimate')
    let final: TaskProgress | null = null
    try {
      const est = await estimateAll({
        signal: ctl.signal,
        extreme: opts?.extreme === true,
        // O "concluído" só sai depois de salvar: quem reagir a ele (ex.: a página reaberta) já lê o resultado novo.
        onProgress: (p, force) => {
          if (p.phase === 'done') final = p
          else sendProgress(p, force)
        }
      })
      await setLatest('cleanupEstimate', est)
      return est
    } catch (e) {
      final = finalEvent('cleanup:estimate', ctl, e)
      throw e
    } finally {
      end()
      if (final) sendProgress(final, true)
    }
  }

  async function run(req: { targetIds: string[] }): Promise<CleanupRunReport> {
    const ids = Array.isArray(req?.targetIds) ? [...new Set(req.targetIds.filter((x): x is string => typeof x === 'string'))] : []
    if (ids.length === 0) throw new Error('Nenhum item selecionado para limpar.')
    const last = await getLatest('cleanupEstimate')
    if (!last) throw new Error('Faça a análise primeiro ("Analisar o que pode ser limpo").')

    const ctl = begin('run')
    const startedAt = new Date().toISOString()
    const results: CleanupTargetResult[] = []
    let adminDenied = false
    let final: TaskProgress | null = null
    const prog = (p: Omit<TaskProgress, 'task'>, force = false): void => sendProgress({ task: 'cleanup:run', ...p }, force)
    try {
      prog({ phase: 'preparing', message: 'Conferindo os itens escolhidos...', percent: 1 }, true)
      await refreshKnownAppDirs()
      const running = await listRunningProcesses()

      // 1) Só ids que existem na última análise; nunca "manter" nem ações manuais.
      const runnable: CleanupTarget[] = []
      for (const id of ids) {
        const t = last.targets.find((x) => x.id === id)
        if (!t) {
          results.push(result({ id, title: id }, { status: 'skipped', errors: ['Item não encontrado na última análise. Analise de novo.'] }))
          continue
        }
        if (t.verdict === 'keep') {
          results.push(result(t, { status: 'skipped', errors: ['Este item é marcado como "Manter" e nunca é limpo.'] }))
          continue
        }
        if (t.manual) {
          results.push(result(t, { status: 'skipped', errors: [`Este item é removido pelo próprio Windows: ${t.manual.label}.`] }))
          continue
        }
        const open = (t.requiresClosed ?? []).filter((exe) => running.has(exe.toLowerCase()))
        if (open.length) {
          const names = [...new Set(open.map(cleanupAppName))].join(', ')
          results.push(result(t, { status: 'skipped', errors: [`Feche ${names} e tente de novo (os arquivos estão em uso).`] }))
          continue
        }
        runnable.push(t)
      }

      // 2) Revalida as raízes no guard (nada fora das áreas conhecidas). Comandos oficiais (Busca extrema) não apagam
      //    caminhos: os caminhos deles só informam.
      const validPaths = new Map<string, string[]>()
      for (const t of runnable) {
        if (t.method === 'recycleBin' || t.kind === 'deliveryOptimization' || extremeCommandOf(t.id)) {
          validPaths.set(t.id, t.paths)
          continue
        }
        const ok: string[] = []
        const errs: string[] = []
        for (const p of t.paths) {
          const d = isFileSync(p) ? checkPath(p, 'userSelected') : checkTargetRoot(p, { filtered: hasNameFilter(t.include) })
          if (d.allowed) ok.push(p)
          else errs.push(`Ignorado pela proteção: ${p} (${d.reason})`)
        }
        validPaths.set(t.id, ok)
        if (errs.length) results.push(result(t, { status: ok.length ? 'partial' : 'skipped', errors: errs }))
      }
      const mergeResult = (r: CleanupTargetResult): void => {
        const prev = results.find((x) => x.targetId === r.targetId)
        if (!prev) {
          results.push(r)
          return
        }
        prev.bytesFreed += r.bytesFreed
        prev.filesDeleted += r.filesDeleted
        prev.skipped += r.skipped
        prev.errors.push(...r.errors)
        prev.recycled ||= r.recycled
        prev.status = undefined
      }

      const isCmd = (t: CleanupTarget): boolean => extremeCommandOf(t.id) !== null
      const recycle = runnable.filter((t) => t.method === 'recycleBin')
      const user = runnable.filter((t) => t.method !== 'recycleBin' && !isCmd(t) && !t.requiresAdmin && (validPaths.get(t.id)?.length ?? 0) > 0)
      const admin = runnable.filter((t) => t.method !== 'recycleBin' && !isCmd(t) && t.requiresAdmin && ((validPaths.get(t.id)?.length ?? 0) > 0 || t.kind === 'deliveryOptimization'))
      // Busca extrema: comandos oficiais (Limpeza de Disco, DISM, pnputil: administrador; Docker: usuário)
      const adminCmd = runnable.filter((t) => isCmd(t) && extremeCommandOf(t.id) !== 'docker')
      const dockerT = runnable.filter((t) => extremeCommandOf(t.id) === 'docker')
      const totalSteps = recycle.length + user.length + dockerT.length + (admin.length || adminCmd.length ? 1 : 0)
      let step = 0
      const pct = (): number => Math.min(99, 2 + Math.round((step / Math.max(1, totalSteps)) * 97))
      // Orçamento da Lixeira (itens que vão para a Lixeira só são movidos se couberem nela)
      let budget: RecycleBudget | null = null
      const getBudget = async (): Promise<RecycleBudget> => (budget ??= await RecycleBudget.create())

      // 3) Lixeira PRIMEIRO (os instaladores de Downloads vão para a Lixeira depois e não podem ser apagados junto).
      for (const t of recycle) {
        if (ctl.signal.aborted) break
        prog({ phase: 'running', message: 'Esvaziando a Lixeira...', current: step, total: totalSteps, percent: pct() }, true)
        const before = await recycleBinBytes(t.paths)
        if (before === 0 && t.files === 0) {
          mergeResult(result(t, { status: 'ok' }))
          step++
          continue
        }
        // Comando oficial do Windows (Lixeira do usuário atual, todas as unidades).
        const err = await runEmptyBin(null)
        const after = await recycleBinBytes(t.paths)
        const freed = Math.max(0, before - after)
        const errors = !err || freed > 0 ? [] : [`Não foi possível esvaziar a Lixeira: ${err}`]
        mergeResult(result(t, { bytesFreed: freed, filesDeleted: t.files, errors }))
        step++
      }

      // 4) Alvos do usuário (motor Node, sem administrador)
      for (const t of user) {
        if (ctl.signal.aborted) break
        const roots = validPaths.get(t.id) ?? []
        let freed = 0
        let files = 0
        let skipped = 0
        const errors: string[] = []
        prog({ phase: 'running', message: `Limpando: ${t.title}`, current: step, total: totalSteps, percent: pct() }, true)
        // Itens que não couberam na Lixeira (nada deles foi movido): resumidos numa linha só.
        let tooBig = 0
        let tooBigBytes = 0
        let tooBigReason = ''
        for (const root of roots) {
          if (ctl.signal.aborted) break
          if (isFileSync(root)) {
            let size = 0
            try {
              const st = await fsp.lstat(root)
              size = st.size
              if (t.recycle) {
                const fit = (await getBudget()).take(root, st.size)
                if (!fit.ok) {
                  tooBig++
                  tooBigBytes += st.size
                  tooBigReason ||= fit.reason
                  continue
                }
                try {
                  await platform.trashItem(root)
                } catch (e) {
                  ;(await getBudget()).giveBack(root, st.size)
                  throw e
                }
              } else await unlinkFile(root, st)
              freed += st.size
              files++
            } catch (e) {
              if (codeOfError(e) === 'tooBigForRecycle') {
                tooBig++
                tooBigBytes += size
                tooBigReason ||= 'O Windows recusou mandar para a Lixeira (apagaria de vez).'
              } else if (errCode(e) !== 'ENOENT') {
                skipped++
                if (errors.length < 10) errors.push(`${root}: ${fsErrorText(e)}`)
              }
            }
            continue
          }
          if (t.recycle) {
            // Pasta com filtro (ex.: instaladores em Downloads): o total precisa caber na Lixeira daquela unidade.
            const m = await measurePaths({ paths: [root], olderThanDays: t.olderThanDays, include: t.include, maxDepth: t.maxDepth, timeBudgetMs: 20_000 })
            const fit = (await getBudget()).take(root, m.bytes)
            if (!fit.ok) {
              tooBig += m.files
              tooBigBytes += m.bytes
              tooBigReason ||= fit.reason
              continue
            }
          }
          const st = await deleteContents(root, {
            olderThanDays: t.olderThanDays,
            include: t.include,
            maxDepth: t.maxDepth,
            recycle: t.recycle,
            trash: (p) => platform.trashItem(p),
            // Mesmo "filtered" da validação da raiz acima (Downloads só vale com filtro de nomes).
            guard: (p) => checkPathLexical(p, 'cleanupTarget', [root], hasNameFilter(t.include)),
            signal: ctl.signal,
            onProgress: (e) =>
              prog({
                phase: 'running',
                message: `${t.title}: ${formatBytes(freed + e.bytes)} ${t.recycle ? 'enviados para a Lixeira' : 'liberados'}`,
                current: step,
                total: totalSteps,
                percent: pct()
              })
          })
          freed += st.bytes
          files += st.files
          skipped += st.skipped
          errors.push(...st.errors.slice(0, 10))
          if (st.rootUnreadable) errors.push(`${root}: sem permissão para ler a pasta.`)
        }
        if (tooBig > 0) {
          skipped += tooBig
          errors.unshift(`${tooBig} arquivo(s) (${formatBytes(tooBigBytes)}) NÃO foram movidos porque não cabem na Lixeira — nada deles foi apagado. ${tooBigReason}`)
        }
        mergeResult(result(t, { bytesFreed: freed, filesDeleted: files, skipped, errors, recycled: Boolean(t.recycle) }))
        step++
      }

      // 4b) Docker: comando oficial "docker builder prune" (usuário, sem administrador)
      for (const t of dockerT) {
        if (ctl.signal.aborted) break
        prog({ phase: 'running', message: `Limpando: ${t.title}`, current: step, total: totalSteps, percent: pct() }, true)
        const cli = await hooks.dockerCli()
        if (!cli) mergeResult(result(t, { status: 'skipped', errors: ['O Docker não foi encontrado neste PC.'] }))
        else {
          const r = await hooks.dockerPrune(cli)
          mergeResult(result(t, r.ok ? { bytesFreed: r.bytes, status: 'ok' } : { status: 'failed', errors: [`O Docker não limpou: ${r.error ?? 'erro desconhecido'}. Abra o Docker Desktop e tente de novo.`] }))
        }
        step++
      }

      // 5) Alvos de administrador (inclusive os comandos oficiais da Busca extrema): todos juntos, UM prompt de UAC
      if ((admin.length || adminCmd.length) && !ctl.signal.aborted) {
        prog(
          { phase: 'admin', message: 'Itens do sistema: o Windows vai pedir permissão de administrador (uma vez)...', current: step, total: totalSteps, percent: pct() },
          true
        )
        const cmdTasks = await buildExtremeAdminTasks(adminCmd, mergeResult)
        const tasks: AdminTask[] = []
        for (const t of admin) {
          const roots = validPaths.get(t.id) ?? []
          if (t.kind === 'deliveryOptimization') {
            tasks.push({ id: t.id, op: 'deliveryOptimization', roots: [] })
            continue
          }
          const files = roots.filter((p) => isFileSync(p))
          const dirs = roots.filter((p) => !files.includes(p))
          if (dirs.length) {
            tasks.push({
              id: t.id,
              op: t.kind === 'windowsUpdate' ? 'windowsUpdate' : 'contents',
              roots: dirs,
              olderThanDays: t.olderThanDays,
              include: t.include,
              maxDepth: t.maxDepth
            })
          }
          if (files.length) tasks.push({ id: t.id, op: 'file', roots: files })
        }
        // Os comandos oficiais (mais demorados) vêm depois das pastas comuns.
        tasks.push(...cmdTasks.tasks)
        const cmdTargets = adminCmd.filter((t) => cmdTasks.included.has(t.id))
        const res = tasks.length ? await hooks.adminRunner(tasks, ctl.signal) : { ok: true, cancelled: false, data: [] as AdminTaskResult[] }
        if (!res.ok) {
          adminDenied = res.cancelled
          for (const t of [...admin, ...cmdTargets]) {
            mergeResult(
              result(t, {
                status: 'skipped',
                errors: [res.cancelled ? 'Permissão de administrador negada (UAC). Nada foi alterado neste item.' : `Falha ao executar como administrador: ${res.error ?? 'erro desconhecido'}`]
              })
            )
          }
        } else {
          for (const t of admin) {
            const parts = (res.data ?? []).filter((r) => r.id === t.id)
            mergeResult(
              result(t, {
                bytesFreed: parts.reduce((s, r) => s + r.bytes, 0),
                filesDeleted: parts.reduce((s, r) => s + r.files, 0),
                skipped: parts.reduce((s, r) => s + r.skipped, 0),
                errors: parts.flatMap((r) => r.errors).slice(0, 10)
              })
            )
          }
          for (const r of attributeExtremeResults(cmdTargets, res.data ?? [])) mergeResult(r)
        }
        step++
      }

      // Itens que não chegaram a ser processados (cancelamento no meio)
      for (const t of runnable) {
        if (!results.some((r) => r.targetId === t.id)) {
          results.push(result(t, { status: 'skipped', errors: [ctl.signal.aborted ? 'Cancelado antes de chegar neste item.' : 'Nada a limpar neste item.'] }))
        }
      }
      for (const r of results) r.status = statusOf(r)
      const totalFreed = results.reduce((s, r) => s + r.bytesFreed, 0)
      const cancelled = ctl.signal.aborted
      const report: CleanupRunReport = { startedAt, finishedAt: new Date().toISOString(), results, totalFreed, cancelled: cancelled || undefined, adminDenied: adminDenied || undefined }

      // 6) Histórico
      try {
        const entry = await logAction({
          domain: 'cleanup',
          action: 'cleanup.run',
          title: `Limpeza Inteligente: ${formatBytes(totalFreed)} liberados (${results.filter((r) => r.status === 'ok' || r.status === 'partial').length} de ${results.length} itens)`,
          success: results.some((r) => r.status === 'ok' || r.status === 'partial') && !results.every((r) => r.status === 'failed'),
          bytesFreed: totalFreed,
          details: {
            cancelled,
            adminDenied,
            results: results.map((r) => ({ id: r.targetId, title: r.title, bytesFreed: r.bytesFreed, files: r.filesDeleted, skipped: r.skipped, status: r.status, recycled: r.recycled, errors: r.errors.slice(0, 3) }))
          }
        })
        report.logId = entry.id
      } catch {
        // histórico indisponível não invalida a limpeza
      }

      // 7) Atualiza a última análise com o que sobrou (re-mede só os itens limpos)
      prog({ phase: 'remeasure', message: 'Atualizando os tamanhos...', percent: 99 }, true)
      await refreshEstimateAfterRun(last, results)
      final = { task: 'cleanup:run', phase: 'done', message: `Limpeza concluída: ${formatBytes(totalFreed)} liberados.`, percent: 100 }
      return report
    } catch (e) {
      final = finalEvent('cleanup:run', ctl, e)
      throw e
    } finally {
      end()
      if (final) sendProgress(final, true)
    }
  }

  async function refreshEstimateAfterRun(last: CleanupEstimate, results: CleanupTargetResult[]): Promise<void> {
    try {
      const touched = new Set(results.filter((r) => r.bytesFreed > 0 || r.filesDeleted > 0).map((r) => r.targetId))
      if (touched.size === 0) return
      const targets: CleanupTarget[] = []
      for (const t of last.targets) {
        if (!touched.has(t.id)) {
          targets.push(t)
          continue
        }
        const freed = results.find((r) => r.targetId === t.id)?.bytesFreed ?? 0
        if (t.kind === 'deliveryOptimization' || t.method === 'recycleBin' || t.requiresAdmin) {
          // Sem medir de novo (exigiria administrador / comando): desconta o que foi liberado.
          targets.push({ ...t, bytes: Math.max(0, t.bytes - freed), files: t.method === 'recycleBin' ? 0 : t.files, selectedByDefault: false, breakdown: t.method === 'recycleBin' ? [] : t.breakdown })
          continue
        }
        const m = await measurePaths({ paths: t.paths, olderThanDays: t.olderThanDays, include: t.include, maxDepth: t.maxDepth, collectTop: t.sampleFiles ? 40 : undefined, timeBudgetMs: 20_000 })
        targets.push({ ...t, bytes: m.bytes, files: m.files, approximate: m.approximate || undefined, sampleFiles: m.sampleFiles, selectedByDefault: false })
      }
      const updated: CleanupEstimate = {
        ...last,
        targets,
        totalBytes: targets.filter((t) => t.verdict !== 'keep').reduce((s, t) => s + t.bytes, 0),
        safeBytes: targets.filter((t) => t.verdict === 'safe').reduce((s, t) => s + t.bytes, 0)
      }
      await setLatest('cleanupEstimate', updated)
    } catch {
      // não crítico
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Exclusão de itens escolhidos pelo usuário (Análise de Discos: maiores/antigos e duplicados)
  // ---------------------------------------------------------------------------------------------

  function beginDelete(): AbortController {
    if (deleteController) throw new Error('Já existe uma exclusão em andamento. Aguarde terminar.')
    deleteController = new AbortController()
    lastDeleteProgress = null
    return deleteController
  }

  function deleteProgress(p: TaskProgress): void {
    lastDeleteProgress = p
    emit('cleanup:progress', p)
  }

  /**
   * Apaga UM item escolhido pelo usuário: guard (userSelected), caminho real sem atalhos, sem repetir o mesmo
   * arquivo e, no modo definitivo, só o que o app listou (allow). Registra o resultado em `report`.
   */
  async function deleteOne(
    original: string,
    mode: 'recycle' | 'permanent',
    signal: AbortSignal,
    seen: Set<string>,
    report: DeleteFilesReport,
    allow: Set<string> | null,
    filesOnly = false,
    /** Tamanho/data conferidos junto com o SHA-256 completo: se mudou desde então, não apaga. */
    expectStat?: { size: number; mtimeMs: number },
    /** Modo Lixeira: o que ainda cabe na Lixeira de cada unidade (quem não couber não é movido) */
    budget?: RecycleBudget | null
  ): Promise<void> {
    const skip = (reason: string, code: SkipCode): void => {
      report.skipped.push({ path: original, reason, code })
    }
    const decision = checkPath(original, 'userSelected')
    if (!decision.allowed) return skip(decision.reason, 'blocked')
    const target = pathForDeletion(original)
    if (!target) return skip('Caminho inválido ou passa por um atalho (junction).', 'blocked')
    if (allow && !allow.has(pathKey(original) ?? '') && !allow.has(pathKey(target) ?? '')) return skip(PERMANENT_ONLY_LISTED, 'notListed')
    const key = target.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)

    let st: Stats
    try {
      st = await fsp.lstat(target)
    } catch (e) {
      return skip(errCode(e) === 'ENOENT' ? 'O item não existe mais.' : fsErrorText(e), codeOfError(e))
    }
    if (st.isSymbolicLink()) return skip('É um atalho de pasta (junction/link): não é apagado pelo app.', 'blocked')
    if (filesOnly && !st.isFile()) return skip('Não é mais um arquivo comum.', 'stale')
    if (expectStat && (st.size !== expectStat.size || st.mtimeMs !== expectStat.mtimeMs)) {
      return skip(`${STALE_DUPLICATES} (o arquivo mudou depois da conferência do conteúdo)`, 'stale')
    }
    let reserved = 0
    try {
      if (st.isDirectory()) {
        const freed = await deleteDirectory(target, mode, signal, budget)
        if (freed.error) skip(freed.error, freed.code ?? 'error')
        else report.deleted.push(original)
        report.bytesFreed += freed.bytes
      } else {
        if (mode === 'recycle') {
          if (budget) {
            const fit = budget.take(target, st.size)
            if (!fit.ok) return skip(fit.reason, 'tooBigForRecycle')
            reserved = st.size
          }
          await platform.trashItem(target)
        } else await unlinkFile(target, st)
        report.deleted.push(original)
        report.bytesFreed += st.size
      }
    } catch (e) {
      if (reserved) budget?.giveBack(target, reserved)
      const code = codeOfError(e)
      skip(
        code === 'tooBigForRecycle'
          ? 'O Windows não mandaria este item para a Lixeira (apagaria de vez): nada foi apagado. Use "Apagar de vez" se tiver certeza.'
          : `Não foi possível apagar: ${fsErrorText(e)}`,
        code
      )
    }
  }

  async function logDelete(report: DeleteFilesReport, mode: 'recycle' | 'permanent', kind: 'files' | 'duplicates', reason?: string): Promise<void> {
    try {
      const what = kind === 'duplicates' ? 'cópia(s) duplicada(s)' : 'item(ns)'
      const entry = await logAction({
        domain: 'cleanup',
        action: 'cleanup.deleteFiles',
        title: `${mode === 'recycle' ? 'Enviou para a Lixeira' : 'Apagou definitivamente'} ${report.deleted.length} ${what} · ${formatBytes(report.bytesFreed)}`,
        success: report.deleted.length > 0,
        bytesFreed: report.bytesFreed,
        error: report.deleted.length === 0 && report.skipped.length ? report.skipped[0].reason : undefined,
        details: { mode, kind, reason, deleted: report.deleted.slice(0, 300), skipped: report.skipped.slice(0, 300) }
      })
      report.logId = entry.id
    } catch {
      // histórico indisponível
    }
  }

  async function deleteFiles(req: DeleteFilesRequest): Promise<DeleteFilesReport> {
    const mode: 'recycle' | 'permanent' = req?.mode === 'permanent' ? 'permanent' : 'recycle'
    const input = Array.isArray(req?.paths) ? req.paths.filter((p): p is string => typeof p === 'string') : []
    if (input.length === 0) throw new Error('Nenhum arquivo informado.')
    if (input.length > MAX_PATHS) throw new Error(`Muitos itens de uma vez (máximo ${MAX_PATHS}).`)
    const ctl = beginDelete()
    const report: DeleteFilesReport = { deleted: [], skipped: [], bytesFreed: 0 }
    try {
      await refreshKnownAppDirs({ collectIfMissing: true })
      const allow = mode === 'permanent' ? await permanentAllowList() : null
      // Lixeira: confere antes quanto cabe em cada unidade (MaxCapacity - o que já está nela). Assim o Windows não
      // apaga de vez um item grande demais nem descarta sozinho itens antigos da Lixeira.
      const budget = mode === 'recycle' ? await RecycleBudget.create() : null
      const seen = new Set<string>()
      let i = 0
      for (const original of input) {
        i++
        if (ctl.signal.aborted) {
          report.skipped.push({ path: original, reason: 'Cancelado.', code: 'error' })
          continue
        }
        deleteProgress({ task: 'cleanup:delete', phase: 'deleting', message: original, current: i, total: input.length, percent: Math.round((i / input.length) * 100) })
        await deleteOne(original, mode, ctl.signal, seen, report, allow, false, undefined, budget)
      }
      // Quem voltou como "grande demais para a Lixeira" pode ser apagado de vez em seguida (a interface pede APAGAR).
      for (const s of report.skipped) if (s.code === 'tooBigForRecycle') rememberTooBig(s.path)
      if (mode === 'permanent') for (const d of report.deleted) recentTooBig.delete(pathKey(d) ?? '')
      if (mode === 'recycle' && report.deleted.length) invalidateBinState()
      await logDelete(report, mode, 'files', typeof req.reason === 'string' ? req.reason : undefined)
      return report
    } finally {
      deleteController = null
    }
  }

  type CopyCheck = { ok: true; target: string; key: string; dev: bigint; ino: bigint } | { ok: false; why: string }

  /** Confere no disco uma cópia do relatório de duplicados: arquivo comum, mesmo tamanho e mesma data. */
  async function checkCopy(f: { path: string; lastWrite: number } | undefined, bytes: number): Promise<CopyCheck> {
    if (!f || typeof f.path !== 'string') return { ok: false, why: 'item inválido no pedido' }
    const target = pathForDeletion(f.path)
    if (!target) return { ok: false, why: `"${f.path}" é inválido ou passa por um atalho` }
    let st: import('node:fs').BigIntStats
    try {
      st = await fsp.lstat(target, { bigint: true })
    } catch {
      return { ok: false, why: `"${f.path}" não existe mais` }
    }
    if (st.isSymbolicLink() || !st.isFile()) return { ok: false, why: `"${f.path}" não é mais um arquivo comum` }
    if (Number(st.size) !== bytes) return { ok: false, why: `"${f.path}" mudou de tamanho` }
    if (typeof f.lastWrite !== 'number' || !Number.isFinite(f.lastWrite) || Math.abs(Number(st.mtimeMs) - f.lastWrite) > MTIME_TOLERANCE_MS) {
      return { ok: false, why: `"${f.path}" foi modificado depois da busca` }
    }
    return { ok: true, target, key: target.toLowerCase(), dev: st.dev, ino: st.ino }
  }

  /**
   * Modo DEFINITIVO: confere o SHA-256 COMPLETO de cada cópia mantida (as que existem) e de cada cópia a apagar
   * contra o hash do grupo (as amostras de início/meio/fim não veem uma diferença no resto do arquivo, e aqui não há
   * Lixeira para desfazer). Devolve o tamanho/data de cada cópia a apagar no momento da conferência, para a
   * exclusão recusar o que mudar depois.
   */
  async function verifyFullHashes(
    g: DeleteDuplicatesGroup,
    signal: AbortSignal,
    progress: (message: string) => void
  ): Promise<{ ok: true; expected: Map<string, { size: number; mtimeMs: number }> } | { ok: false; why: string }> {
    const want = typeof g.hash === 'string' ? g.hash.trim().toLowerCase() : ''
    if (!/^[0-9a-f]{64}$/.test(want)) return { ok: false, why: 'o hash do grupo é inválido' }
    const bytes = Number(g.bytes)
    const hashOf = async (shown: string, target: string): Promise<{ ok: true; size: number; mtimeMs: number } | { ok: false; why: string }> => {
      progress(`Conferindo o conteúdo (SHA-256): ${shown}`)
      try {
        const h = await sha256File(target, signal)
        if (h.hash !== want || h.size !== bytes) return { ok: false, why: `o conteúdo de "${shown}" não confere com o relatório (SHA-256)` }
        return { ok: true, size: h.size, mtimeMs: h.mtimeMs }
      } catch (e) {
        if (signal.aborted) return { ok: false, why: 'Cancelado.' }
        return { ok: false, why: `não foi possível conferir "${shown}" (${(e as Error)?.message ?? fsErrorText(e)})` }
      }
    }
    let keptOk = 0
    for (const k of Array.isArray(g.keep) ? g.keep : []) {
      const c = await checkCopy(k, bytes)
      if (!c.ok) continue // cópia mantida que sumiu/mudou: staleReason já exige ao menos uma intacta
      const h = await hashOf(k.path, c.target)
      if (!h.ok) return h
      keptOk++
    }
    if (keptOk === 0) return { ok: false, why: 'nenhuma cópia mantida confere com o relatório' }
    const expected = new Map<string, { size: number; mtimeMs: number }>()
    for (const r of Array.isArray(g.remove) ? g.remove : []) {
      if (!r || typeof r.path !== 'string') continue
      const c = await checkCopy(r, bytes)
      if (!c.ok) return { ok: false, why: c.why }
      const h = await hashOf(r.path, c.target)
      if (!h.ok) return h
      expected.set(r.path, { size: h.size, mtimeMs: h.mtimeMs })
    }
    return { ok: true, expected }
  }

  /** Compara início, meio e fim de dois arquivos do mesmo tamanho (confirmação rápida de que ainda são iguais). */
  async function sameSamples(a: string, b: string, size: number): Promise<boolean> {
    const CHUNK = 64 * 1024
    const offsets = [...new Set([0, Math.max(0, Math.floor(size / 2) - CHUNK / 2), Math.max(0, size - CHUNK)])]
    const fa = await fsp.open(a, 'r')
    try {
      const fb = await fsp.open(b, 'r')
      try {
        for (const off of offsets) {
          const len = Math.min(CHUNK, size - off)
          if (len <= 0) continue
          const ba = Buffer.alloc(len)
          const bb = Buffer.alloc(len)
          const [ra, rb] = await Promise.all([fa.read(ba, 0, len, off), fb.read(bb, 0, len, off)])
          if (ra.bytesRead !== rb.bytesRead || !ba.subarray(0, ra.bytesRead).equals(bb.subarray(0, rb.bytesRead))) return false
        }
        return true
      } finally {
        await fb.close()
      }
    } finally {
      await fa.close()
    }
  }

  /**
   * Revalida um grupo de duplicados antes de apagar (o relatório pode ter dias). Devolve o motivo se o grupo
   * inteiro deve ser pulado: nenhuma cópia mantida intacta, alguma cópia a apagar mudou, ou é o mesmo arquivo.
   */
  async function staleReason(g: DeleteDuplicatesGroup): Promise<string | null> {
    const bytes = Number(g?.bytes)
    if (!Number.isFinite(bytes) || bytes <= 0) return 'tamanho do grupo inválido'
    const keep = Array.isArray(g.keep) ? g.keep : []
    const remove = Array.isArray(g.remove) ? g.remove : []
    if (keep.length === 0) return 'nenhuma cópia foi marcada para ficar'
    let kept: Extract<CopyCheck, { ok: true }> | null = null
    let keepPath = ''
    const keptIds: Extract<CopyCheck, { ok: true }>[] = []
    for (const k of keep) {
      const c = await checkCopy(k, bytes)
      if (c.ok) {
        keptIds.push(c)
        if (!kept) {
          kept = c
          keepPath = k.path
        }
      }
    }
    if (!kept) return 'a cópia que ficaria não existe mais ou mudou'
    for (const r of remove) {
      const c = await checkCopy(r, bytes)
      if (!c.ok) return c.why
      // Mesmo arquivo (outro nome/grafia ou link físico) de uma cópia mantida: apagar não libera nada e pode ser a única.
      if (keptIds.some((k) => k.key === c.key || (k.dev === c.dev && k.ino === c.ino))) return `"${r.path}" é o mesmo arquivo da cópia mantida`
      try {
        if (!(await sameSamples(pathForDeletion(keepPath) ?? keepPath, pathForDeletion(r.path) ?? r.path, bytes))) return `"${r.path}" não tem mais o mesmo conteúdo`
      } catch (e) {
        return `não foi possível ler "${r.path}" (${fsErrorText(e)})`
      }
    }
    return null
  }

  async function deleteDuplicates(req: DeleteDuplicatesRequest): Promise<DeleteFilesReport> {
    const mode: 'recycle' | 'permanent' = req?.mode === 'permanent' ? 'permanent' : 'recycle'
    const groups = (Array.isArray(req?.groups) ? req.groups : []).filter((g): g is DeleteDuplicatesGroup => Boolean(g) && typeof g === 'object')
    const total = groups.reduce((s, g) => s + (Array.isArray(g.remove) ? g.remove.length : 0), 0)
    if (total === 0) throw new Error('Nenhuma cópia informada.')
    if (total > MAX_PATHS) throw new Error(`Muitos itens de uma vez (máximo ${MAX_PATHS}).`)
    const ctl = beginDelete()
    const report: DeleteFilesReport = { deleted: [], skipped: [], bytesFreed: 0 }
    try {
      await refreshKnownAppDirs({ collectIfMissing: true })
      const allow = mode === 'permanent' ? await permanentAllowList() : null
      const budget = mode === 'recycle' ? await RecycleBudget.create() : null
      const seen = new Set<string>()
      let i = 0
      for (const g of groups) {
        const remove = (Array.isArray(g.remove) ? g.remove : []).filter((r) => r && typeof r.path === 'string')
        if (ctl.signal.aborted) {
          for (const r of remove) report.skipped.push({ path: r.path, reason: 'Cancelado.', code: 'error' })
          i += remove.length
          continue
        }
        const stale = await staleReason(g)
        if (stale) {
          for (const r of remove) report.skipped.push({ path: r.path, reason: `${STALE_DUPLICATES} (${stale})`, code: 'stale' })
          i += remove.length
          continue
        }
        // Definitivo (sem Lixeira para desfazer): SHA-256 completo de todas as cópias. Na Lixeira bastam as amostras.
        let expected: Map<string, { size: number; mtimeMs: number }> | null = null
        if (mode === 'permanent') {
          const v = await verifyFullHashes(g, ctl.signal, (message) =>
            deleteProgress({ task: 'cleanup:delete', phase: 'verifying', message, current: i, total, percent: Math.round((i / total) * 100) })
          )
          if (!v.ok) {
            const reason = ctl.signal.aborted ? 'Cancelado.' : `${STALE_DUPLICATES} (${v.why})`
            for (const r of remove) report.skipped.push({ path: r.path, reason, code: ctl.signal.aborted ? 'error' : 'stale' })
            i += remove.length
            continue
          }
          expected = v.expected
        }
        for (const r of remove) {
          i++
          if (ctl.signal.aborted) {
            report.skipped.push({ path: r.path, reason: 'Cancelado.', code: 'error' })
            continue
          }
          deleteProgress({ task: 'cleanup:delete', phase: 'deleting', message: r.path, current: i, total, percent: Math.round((i / total) * 100) })
          if (expected && !expected.has(r.path)) {
            report.skipped.push({ path: r.path, reason: `${STALE_DUPLICATES} (o conteúdo não foi conferido)`, code: 'stale' })
            continue
          }
          await deleteOne(r.path, mode, ctl.signal, seen, report, allow, true, expected?.get(r.path), budget)
        }
      }
      for (const sk of report.skipped) if (sk.code === 'tooBigForRecycle') rememberTooBig(sk.path)
      if (mode === 'recycle' && report.deleted.length) invalidateBinState()
      await logDelete(report, mode, 'duplicates', 'Duplicados')
      return report
    } finally {
      deleteController = null
    }
  }

  /**
   * Pasta escolhida pelo usuário. Lixeira: confere antes se não há nada protegido dentro e se a pasta INTEIRA cabe na
   * Lixeira da unidade (senão nada dela é movido: 'tooBigForRecycle'). Definitivo: apaga o conteúdo pelo motor
   * seguro (guard em cada item) e depois a pasta vazia.
   */
  async function deleteDirectory(
    dir: string,
    mode: 'recycle' | 'permanent',
    signal: AbortSignal,
    budget?: RecycleBudget | null
  ): Promise<{ bytes: number; error?: string; code?: SkipCode }> {
    // Defesa extra: a pasta (ou uma pasta do caminho) não pode ser atalho/ponto de montagem.
    const reparseAt = reparsePointIn(dir)
    if (reparseAt) return { bytes: 0, error: `A pasta passa por um atalho (junction/ponto de montagem) em "${reparseAt}": não é apagada pelo app.`, code: 'blocked' }
    const guard = (p: string): GuardDecision => checkPathLexical(p, 'userSelected')
    if (mode === 'recycle') {
      const scan = await deleteContents(dir, { dryRun: true, guard, signal, timeBudgetMs: DIR_CHECK_BUDGET_MS })
      if (scan.cancelled) return { bytes: 0, error: 'Cancelado.', code: 'error' }
      if (scan.protectedSkipped > 0) return { bytes: 0, error: 'A pasta contém itens protegidos (sistema, jogos ou programas). Apague os arquivos individualmente.', code: 'blocked' }
      if (scan.truncated) {
        return { bytes: 0, error: 'A pasta tem arquivos demais para conferir com segurança antes de mandar para a Lixeira (mais de 2 minutos). Apague por partes (subpastas).', code: 'error' }
      }
      if (budget) {
        const fit = budget.take(dir, scan.bytes)
        if (!fit.ok) return { bytes: 0, error: fit.reason, code: 'tooBigForRecycle' }
      }
      try {
        await platform.trashItem(dir)
      } catch (e) {
        budget?.giveBack(dir, scan.bytes)
        throw e
      }
      return { bytes: scan.bytes }
    }
    const st = await deleteContents(dir, { guard, signal, removeEmptyDirs: true })
    try {
      await fsp.rmdir(dir)
      return { bytes: st.bytes }
    } catch {
      const left = st.skipped > 0 ? `${st.skipped} arquivo(s) em uso ou protegido(s) ficaram na pasta.` : 'A pasta não pôde ser removida por completo.'
      return { bytes: st.bytes, error: `${formatBytes(st.bytes)} apagados, mas ${left}`, code: st.protectedSkipped > 0 ? 'blocked' : 'inUse' }
    }
  }

  async function checkPaths(paths: string[]): Promise<GuardDecision[]> {
    const list = Array.isArray(paths) ? paths.slice(0, MAX_PATHS) : []
    await refreshKnownAppDirs({ collectIfMissing: true })
    return list.map((p) => checkPath(p, 'userSelected'))
  }

  async function getStatus(): Promise<CleanupStatus> {
    if (busy) return { busy, progress: lastProgress }
    if (deleteController) return { busy: 'delete', progress: lastDeleteProgress }
    return { busy: null, progress: null }
  }

  return {
    estimate,
    getLastEstimate: () => getLatest('cleanupEstimate'),
    run,
    /** Cancela a análise ou a limpeza em andamento (nunca uma exclusão de arquivos: ver cancelDelete). */
    async cancel() {
      controller?.abort()
    },
    deleteFiles,
    checkPaths,
    deleteDuplicates,
    getStatus,
    async cancelDelete() {
      deleteController?.abort()
    },
    getRecycleBinInfo,
    emptyRecycleBin
  }
}

/** Lixeira do usuário atual: total, itens e, por unidade, o tamanho e o limite (somente leitura). */
async function getRecycleBinInfo(): Promise<RecycleBinInfo> {
  const bins = await getBinState(true)
  const perDrive = bins
    .filter((b) => b.fixed && (b.path || b.bytes > 0))
    .map((b) => ({ drive: b.drive, bytes: b.bytes, items: b.items, maxBytes: b.maxBytes || undefined, disabled: b.disabled || undefined }))
  return { bytes: perDrive.reduce((s, d) => s + d.bytes, 0), items: perDrive.reduce((s, d) => s + (d.items ?? 0), 0), perDrive }
}

/**
 * Esvazia a Lixeira (todas as unidades ou só uma, ex.: 'E:') com o comando oficial do Windows (Clear-RecycleBin).
 * A confirmação explícita é da interface; aqui mede antes/depois e registra no Histórico.
 */
async function emptyRecycleBin(drive?: string): Promise<ActionResult> {
  const d = drive === undefined || drive === null || drive === '' ? null : normalizeDrive(drive)
  if (drive && !d) return { ok: false, message: `Unidade inválida: ${String(drive).slice(0, 20)}` }
  const sumOf = (list: Awaited<ReturnType<typeof getBinState>>): number => list.filter((b) => !d || b.drive === d).reduce((s, b) => s + b.bytes, 0)
  const before = sumOf(await getBinState(true))
  if (before === 0) return { ok: true, message: d ? `A Lixeira do ${d} já está vazia.` : 'A Lixeira já está vazia.', bytesFreed: 0 }
  const err = await runEmptyBin(d)
  const after = sumOf(await getBinState(true))
  const freed = Math.max(0, before - after)
  const ok = !err || freed > 0
  let logId: string | undefined
  try {
    const entry = await logAction({
      domain: 'cleanup',
      action: 'cleanup.emptyRecycleBin',
      title: `Esvaziou a Lixeira ${d ? `do ${d}` : '(todas as unidades)'}: ${formatBytes(freed)} liberados`,
      success: ok,
      bytesFreed: freed,
      error: ok ? undefined : err,
      details: { drive: d ?? 'todas', before, after }
    })
    logId = entry.id
  } catch {
    // histórico indisponível
  }
  return ok
    ? { ok: true, message: `Lixeira ${d ? `do ${d} ` : ''}esvaziada: ${formatBytes(freed)} liberados no disco.`, bytesFreed: freed, logId }
    : { ok: false, message: `Não foi possível esvaziar a Lixeira: ${err}`, logId }
}
