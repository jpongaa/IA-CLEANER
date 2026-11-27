// Orquestra a Busca Profunda (SOMENTE LEITURA): coleta em paralelo (inventário, registro, sinais do Windows),
// Hydra/launchers alternativos, jogos fora dos launchers, pastas de download, sobras de programas e programas com
// problema. Meta: < 90 s na busca normal.
import type { DiscoverReport, Finding, FindingKind } from '@shared/types/discover'
import { emptyRegistry } from '../apps/collect'
import { buildInstalledIndex, envBroad, providers, pruneInventory, safeRegistry, safeSignals, usageIndexOf, type ScanCtx } from './context'
import { scanDownloads } from './downloads'
import { scanOrphanGames } from './games'
import { hydraGameRoots, readHydra, type HydraData } from './hydra'
import { refreshHydraItems, scanAltLaunchers } from './launchers'
import { scanLeftovers } from './leftovers'
import { addComponentNames, buildOwnershipData } from './ownership'
import { scanPrograms } from './programs'

const KIND_ORDER: FindingKind[] = ['downloadedInstaller', 'gameRepack', 'archiveExtracted', 'diskImage', 'orphanGame', 'altLauncher', 'leftoverFolder', 'brokenUninstall', 'noUninstaller', 'unwanted']
const VERDICT_ORDER = { safe: 0, review: 1, keep: 2 } as const

export interface ScanOptions {
  deep?: boolean
  signal: AbortSignal
  progress: (percent: number, message: string, phase?: string) => void
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export async function runScan(opts: ScanOptions): Promise<DiscoverReport> {
  const t0 = Date.now()
  const deep = Boolean(opts.deep)
  const warnings: string[] = []
  const pv = providers()
  opts.progress(2, 'Lendo a lista de programas, serviços e tarefas do Windows...', 'collect')
  const [invR, regR, sigR] = await Promise.allSettled([pv.inventory(), safeRegistry(), safeSignals()])
  if (invR.status === 'rejected') warnings.push(`Não foi possível montar a lista de jogos e programas (${errText(invR.reason)}).`)
  const reg = regR.status === 'fulfilled' ? regR.value.reg : emptyRegistry('registry')
  const inventory = pruneInventory(invR.status === 'fulfilled' ? invR.value : null, reg.uninstall)
  if (regR.status === 'fulfilled' && regR.value.warning) warnings.push(regR.value.warning)
  const sig = sigR.status === 'fulfilled' ? sigR.value.signals : null
  if (sigR.status === 'fulfilled' && sigR.value.warning) warnings.push(sigR.value.warning)
  const signals = sig ?? { services: [], tasks: [], startup: [], processes: [], appPaths: [], pathDirs: [], msiProducts: [], folders: {}, isAdmin: false, warnings: [] }
  if (signals.warnings.length) warnings.push(...signals.warnings.map((w) => `Leitura parcial do Windows: ${w}`))
  const env = await pv.env(signals)
  if (opts.signal.aborted) return cancelled(t0, deep, warnings)

  opts.progress(18, 'Lendo o Hydra Launcher e outros launchers alternativos...', 'launchers')
  let hydra: HydraData | null = null
  try {
    hydra = await readHydra({ dataDir: env.hydraData, registry: reg.uninstall, localPrograms: env.localPrograms, gameRoots: hydraGameRoots(env) })
    warnings.push(...hydra.warnings)
  } catch (e) {
    warnings.push(`Não foi possível ler o Hydra Launcher (${errText(e)}).`)
  }
  const ownership = buildOwnershipData({
    inventory,
    registry: reg.uninstall,
    signals,
    broadExtra: envBroad(env),
    hydraGames: (hydra?.games ?? []).filter((g) => g.exeExists).map((g) => ({ title: g.title, dir: g.dir, exe: g.exe }))
  })
  // componentes dos programas instalados (nomes dos .exe dentro das pastas deles: Link2EA, ludusavi...)
  await addComponentNames(ownership, { signal: opts.signal }).catch(() => 0)
  const ctx: ScanCtx = {
    deep,
    signal: opts.signal,
    env,
    inventory,
    registry: reg,
    signals,
    ownership,
    usage: usageIndexOf(reg),
    hydra,
    installed: buildInstalledIndex(inventory, reg.uninstall, hydra),
    findings: [],
    warnings,
    locations: new Set<string>(),
    claimed: new Set<string>(),
    progress: (p, m) => opts.progress(p, m),
    now: Date.now()
  }
  const phases: [number, string, (c: ScanCtx) => Promise<void>][] = [
    [20, 'Hydra e launchers alternativos', scanAltLaunchers],
    [26, 'Jogos fora dos launchers', scanOrphanGames],
    [35, 'Downloads, instaladores e arquivos compactados', scanDownloads],
    [70, 'Sobras de programas desinstalados', scanLeftovers],
    [90, 'Programas sem desinstalador e indesejados', scanPrograms]
  ]
  for (const [pct, label, fn] of phases) {
    if (opts.signal.aborted) break
    opts.progress(pct, `${label}...`, label)
    try {
      await fn(ctx)
    } catch (e) {
      warnings.push(`Falha em "${label}": ${errText(e)}`)
    }
  }
  try {
    refreshHydraItems(ctx)
  } catch {
    // só melhora os textos
  }
  const findings = sortFindings(ctx.findings)
  const totals: DiscoverReport['totals'] = {}
  for (const f of findings) {
    const t = (totals[f.kind] ??= { count: 0, bytes: 0 })
    t.count++
    t.bytes += f.bytes || 0
  }
  opts.progress(100, `Pronto: ${findings.length} achado(s).`, 'done')
  return {
    scannedAt: new Date().toISOString(),
    durationMs: Date.now() - t0,
    findings,
    totals,
    locationsScanned: [...ctx.locations],
    warnings: [...new Set(warnings)],
    cancelled: opts.signal.aborted || undefined,
    deep,
    isAdmin: signals.isAdmin
  }
}

export function sortFindings(list: Finding[]): Finding[] {
  return [...list].sort((a, b) => {
    const k = KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind)
    if (k) return k
    const v = VERDICT_ORDER[a.verdict] - VERDICT_ORDER[b.verdict]
    if (v) return v
    return (b.bytes || 0) - (a.bytes || 0)
  })
}

function cancelled(t0: number, deep: boolean, warnings: string[]): DiscoverReport {
  return { scannedAt: new Date().toISOString(), durationMs: Date.now() - t0, findings: [], totals: {}, locationsScanned: [], warnings, cancelled: true, deep }
}
