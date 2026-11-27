// Estimativa (somente leitura): resolve o catálogo na máquina e mede cada alvo com o MESMO motor da limpeza
// em modo dryRun (mesmos filtros e mesmo guard), para que o número mostrado seja o que de fato sai.
import fs, { promises as fsp } from 'node:fs'
import type { CleanupEstimate, CleanupTarget } from '@shared/types/cleanup'
import type { TaskProgress } from '@shared/types/common'
import { formatBytes } from '@shared/format'
import { isAdmin, runPowerShellJson } from '../core/powershell'
import { checkPath, checkPathLexical, checkTargetRoot, setCleanupRoots } from '../safety/guard'
import { deleteContents, mergeStats, type EngineStats } from './engine'
import { getBinState } from './recycle'
import { buildTargetSpecs, type Measured, type TargetSpec } from './targets'
import { hasNameFilter, listRunningProcesses, mapLimit } from './util'
import { refreshKnownAppDirs } from './appDirs'

export interface EstimateOptions {
  signal?: AbortSignal
  onProgress?: (p: TaskProgress, force?: boolean) => void
  /** Inclui os itens da Busca extrema */
  extreme?: boolean
}

const VERDICT_ORDER = { safe: 0, review: 1, keep: 2 } as const

export function isFileSync(p: string): boolean {
  try {
    return fs.lstatSync(p).isFile()
  } catch {
    return false
  }
}

async function isFilePath(p: string): Promise<boolean> {
  try {
    return (await fsp.lstat(p)).isFile()
  } catch {
    return false
  }
}

/** Mede uma lista de pastas/arquivos com o motor em dryRun. */
export async function measurePaths(spec: Pick<TargetSpec, 'paths' | 'olderThanDays' | 'include' | 'maxDepth' | 'collectTop' | 'timeBudgetMs' | 'infoOnly'>, signal?: AbortSignal): Promise<Measured> {
  const stats: EngineStats[] = []
  let fileBytes = 0
  let fileCount = 0
  for (const root of spec.paths) {
    if (signal?.aborted) break
    if (await isFilePath(root)) {
      try {
        const st = await fsp.lstat(root)
        fileBytes += st.size
        fileCount++
      } catch {
        // sumiu
      }
      continue
    }
    stats.push(
      await deleteContents(root, {
        dryRun: true,
        olderThanDays: spec.olderThanDays,
        include: spec.include,
        maxDepth: spec.maxDepth,
        collectTop: spec.collectTop,
        timeBudgetMs: spec.timeBudgetMs ?? 45_000,
        signal,
        concurrency: 16,
        // Itens "manter" só são medidos (nunca limpos); o resto usa o mesmo guard da limpeza.
        // Mesmo "filtered" da validação da raiz (validateSpecPaths): Downloads só vale com filtro de nomes.
        guard: spec.infoOnly ? () => true : (p) => checkPathLexical(p, 'cleanupTarget', [root], hasNameFilter(spec.include))
      })
    )
  }
  const m = mergeStats(stats)
  return {
    bytes: m.bytes + fileBytes,
    files: m.files + fileCount,
    sizeUnknown: fileCount === 0 && m.rootUnreadable && m.files === 0,
    approximate: m.inaccessible > 0 || m.truncated,
    sampleFiles: spec.collectTop ? m.top.slice(0, spec.collectTop) : undefined
  }
}

/** Lixeira do usuário atual em cada unidade (X:\$Recycle.Bin\<SID>), com o limite de cada uma. */
async function measureRecycleBin(): Promise<Measured> {
  const bins = await getBinState(true)
  const withBin = bins.filter((b) => b.path)
  const breakdown: NonNullable<CleanupTarget['breakdown']> = withBin.map((b) => ({ label: b.drive, bytes: b.bytes, files: b.items }))
  return {
    bytes: withBin.reduce((s, b) => s + b.bytes, 0),
    files: withBin.reduce((s, b) => s + b.items, 0),
    breakdown,
    paths: withBin.map((b) => b.path!),
    sizeUnknown: withBin.length === 0 && bins.some((b) => b.unreadable)
  }
}

async function measureDeliveryOptimization(): Promise<Measured> {
  try {
    const r = await runPowerShellJson<{ ok: boolean; bytes: number | null }>(
      `$o = [ordered]@{ ok = $false; bytes = $null }
try {
  $s = Get-DeliveryOptimizationPerfSnap -WarningAction SilentlyContinue -ErrorAction Stop
  $o.ok = $true
  $o.bytes = [double]$s.CacheSizeBytes
} catch {}
ConvertTo-Json -InputObject $o -Compress`,
      { timeoutMs: 30_000 }
    )
    if (!r.ok) return { bytes: 0, files: 0, drop: true }
    return { bytes: Math.max(0, Number(r.bytes) || 0), files: 0 }
  } catch {
    return { bytes: 0, files: 0, drop: true }
  }
}

/** Converte a especificação medida no tipo público. */
function toTarget(spec: TargetSpec, m: Measured, running: Set<string>): CleanupTarget {
  const blockedBy = (spec.requiresClosed ?? []).filter((exe) => running.has(exe.toLowerCase()))
  const paths = m.paths ?? spec.paths
  const t: CleanupTarget = {
    id: spec.id,
    kind: spec.kind,
    title: spec.title,
    description: spec.description,
    paths,
    bytes: m.bytes,
    files: m.files,
    requiresAdmin: spec.requiresAdmin,
    verdict: spec.verdict,
    risk: spec.risk,
    method: spec.method,
    selectedByDefault: false,
    blockedBy
  }
  if (spec.olderThanDays) t.olderThanDays = spec.olderThanDays
  if (spec.requiresClosed?.length) t.requiresClosed = spec.requiresClosed
  if (spec.note) t.note = spec.note
  if (spec.include) t.include = spec.include
  if (spec.maxDepth !== undefined) t.maxDepth = spec.maxDepth
  if (spec.recycle) t.recycle = true
  if (spec.manual) t.manual = spec.manual
  if (spec.extreme) t.extreme = true
  if (m.note) t.note = m.note
  if (m.sizeUnknown) t.sizeUnknown = true
  if (m.approximate) t.approximate = true
  if (m.breakdown?.length) t.breakdown = m.breakdown
  if (m.sampleFiles?.length) t.sampleFiles = m.sampleFiles
  // Itens da Busca extrema nunca vêm marcados: o usuário escolhe um por um.
  t.selectedByDefault = t.verdict === 'safe' && !t.manual && !spec.infoOnly && !spec.extreme && t.bytes > 0 && blockedBy.length === 0 && !t.sizeUnknown
  return t
}

/** Valida as raízes de cada alvo no guard (descarta as perigosas, com aviso). */
function validateSpecPaths(spec: TargetSpec, warnings: string[]): string[] {
  if (spec.infoOnly || spec.manual || spec.pathsInfoOnly || spec.measure !== 'walk') return spec.paths
  const ok: string[] = []
  for (const p of spec.paths) {
    // Arquivos soltos (ex.: MEMORY.DMP) passam pela regra de arquivo; pastas, pela regra de raiz de limpeza.
    const d = isFileSync(p) ? checkPath(p, 'userSelected') : checkTargetRoot(p, { filtered: hasNameFilter(spec.include) })
    if (d.allowed) ok.push(p)
    else warnings.push(`${spec.title}: "${p}" foi ignorado pela proteção (${d.reason})`)
  }
  return ok
}

/** Analisa tudo. Nunca apaga nada. */
export async function estimateAll(opts: EstimateOptions = {}): Promise<CleanupEstimate> {
  const started = Date.now()
  const warnings: string[] = []
  const progress = (p: Omit<TaskProgress, 'task'>, force = false): void => opts.onProgress?.({ task: 'cleanup:estimate', ...p }, force)
  progress({ phase: 'preparing', message: 'Procurando caches, temporários e sobras no seu PC...', percent: 2 }, true)

  await refreshKnownAppDirs()
  const [specs, running, admin] = await Promise.all([
    buildTargetSpecs(warnings, { extreme: opts.extreme }),
    listRunningProcesses(),
    isAdmin().catch(() => false)
  ])
  for (const s of specs) s.paths = validateSpecPaths(s, warnings)
  const active = specs.filter((s) => s.paths.length > 0 || s.measure === 'recycleBin' || s.measure === 'deliveryOptimization' || s.measure === 'custom')

  let done = 0
  const total = active.length
  const measured = await mapLimit(active, 4, async (spec) => {
    if (opts.signal?.aborted) return null
    progress({ phase: 'measuring', message: `Medindo: ${spec.title}`, current: done, total, percent: 5 + Math.round((done / Math.max(1, total)) * 93) })
    let m: Measured
    try {
      if (spec.measure === 'recycleBin') m = await measureRecycleBin()
      else if (spec.measure === 'deliveryOptimization') m = await measureDeliveryOptimization()
      else if (spec.measure === 'custom' && spec.measureFn) m = await spec.measureFn({ signal: opts.signal, isAdmin: admin, measurePaths: (sp) => measurePaths(sp, opts.signal) })
      else m = await measurePaths(spec, opts.signal)
    } catch (e) {
      warnings.push(`${spec.title}: não foi possível medir (${(e as Error).message})`)
      m = { bytes: 0, files: 0, sizeUnknown: true }
    }
    done++
    progress(
      { phase: 'measuring', message: `${spec.title}: ${m.sizeUnknown ? 'tamanho desconhecido' : formatBytes(m.bytes)}`, current: done, total, percent: 5 + Math.round((done / Math.max(1, total)) * 93) },
      true
    )
    if (m.drop) return null
    return toTarget(spec, m, running)
  })
  if (opts.signal?.aborted) throw new Error('Análise cancelada.')

  let targets = measured.filter((t): t is CleanupTarget => t !== null)
  // A Otimização de Entrega pela Limpeza de Disco só aparece se o comando próprio dela não estiver disponível.
  if (targets.some((t) => t.id === 'delivery-optimization')) targets = targets.filter((t) => t.id !== 'extreme-cleanmgr-delivery')
  // Recycle bin sem nada e alvos "manter" vazios não interessam
  const visible = targets.filter((t) => !(t.kind === 'recycleBin' && t.paths.length === 0 && !t.sizeUnknown))
  visible.sort((a, b) => VERDICT_ORDER[a.verdict] - VERDICT_ORDER[b.verdict] || b.bytes - a.bytes || a.title.localeCompare(b.title, 'pt-BR'))

  // Registra as raízes no guard (checkPath(p, 'cleanupTarget') sem roots passa a conhecer estas áreas)
  const infoPaths = new Set(specs.filter((s) => s.pathsInfoOnly || s.infoOnly).map((s) => s.id))
  const rejected = setCleanupRoots(
    visible
      .filter((t) => t.verdict !== 'keep' && !t.manual && t.method !== 'recycleBin' && !infoPaths.has(t.id))
      .flatMap((t) => t.paths.filter((p) => !isFileSync(p)).map((p) => ({ path: p, filtered: hasNameFilter(t.include) })))
  )
  for (const r of rejected) warnings.push(`Proteção: a pasta "${r}" não foi registrada como área de limpeza.`)

  const estimate: CleanupEstimate = {
    scannedAt: new Date().toISOString(),
    targets: visible,
    totalBytes: visible.filter((t) => t.verdict !== 'keep').reduce((s, t) => s + t.bytes, 0),
    safeBytes: visible.filter((t) => t.verdict === 'safe').reduce((s, t) => s + t.bytes, 0),
    durationMs: Date.now() - started,
    isAdmin: admin,
    warnings
  }
  progress({ phase: 'done', message: `Análise concluída: ${formatBytes(estimate.totalBytes)} podem ser liberados.`, percent: 100 }, true)
  return estimate
}
