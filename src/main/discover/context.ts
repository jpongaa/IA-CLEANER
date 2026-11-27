// Contexto da Busca Profunda: pastas do usuário/sistema, inventário de Jogos & Programas, registro, sinais do
// Windows e índice de nomes instalados. Tudo injetável para os testes (sandbox com caminhos/registro FALSOS).
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AppsInventory } from '@shared/types/apps'
import type { Finding } from '@shared/types/discover'
import { collectRegistry, emptyRegistry, type RegistryData, type RegUninstallEntry } from '../apps/collect'
import { buildInventory } from '../apps/inventory'
import { isListedProgram } from '../apps/programs'
import { UsageIndex } from '../apps/usage'
import { cleanPath } from '../apps/util'
import { getDrives } from '../core/drives'
import { known } from '../core/paths'
import { psQuote, runPowerShellJson } from '../core/powershell'
import { getLatest } from '../core/state'
import { compact, normName, tokens } from './catalog'
import { exists, isDir, pkey } from './fsx'
import type { HydraData } from './hydra'
import type { OwnershipData } from './ownership'
import { collectSignals, emptySignals, type SystemSignals } from './signals'

export interface DiscoverEnv {
  home: string
  /** Pastas Downloads (real do usuário + de outros discos + navegadores/torrent/Telegram) */
  downloads: string[]
  desktop: string[]
  documents?: string
  programFiles: string[]
  programData: string
  localAppData: string
  localPrograms: string
  appData: string
  localLow: string
  windir: string
  /** Raízes dos discos fixos ('C:\\', 'D:\\'...) */
  driveRoots: string[]
  /** Pasta de dados do Hydra (%APPDATA%\hydralauncher) */
  hydraData: string
  /** Pastas onde launchers alternativos guardam dados */
  altLauncherDirs: { name: string; dirs: string[]; gamesDirs?: string[] }[]
}

export interface MsiInfo {
  productName?: string
  manufacturer?: string
  productVersion?: string
  productCode?: string
}

export interface DiscoverProviders {
  env(signals: SystemSignals): Promise<DiscoverEnv>
  inventory(): Promise<AppsInventory | null>
  registry(): Promise<RegistryData>
  signals(): Promise<SystemSignals>
  msiInfo(paths: string[]): Promise<Map<string, MsiInfo>>
}

// ------------------------------------------------------------------------------------------- padrão (real)

async function browserDownloadDirs(): Promise<string[]> {
  const out: string[] = []
  const la = known.localAppData
  const ra = known.appData
  const chromium = [
    path.win32.join(la, 'Google', 'Chrome', 'User Data', 'Default', 'Preferences'),
    path.win32.join(la, 'Microsoft', 'Edge', 'User Data', 'Default', 'Preferences'),
    path.win32.join(la, 'BraveSoftware', 'Brave-Browser', 'User Data', 'Default', 'Preferences'),
    path.win32.join(la, 'Vivaldi', 'User Data', 'Default', 'Preferences'),
    path.win32.join(ra, 'Opera Software', 'Opera Stable', 'Preferences'),
    path.win32.join(ra, 'Opera Software', 'Opera Stable', 'Default', 'Preferences'),
    path.win32.join(ra, 'Opera Software', 'Opera GX Stable', 'Preferences'),
    path.win32.join(ra, 'Opera Software', 'Opera GX Stable', 'Default', 'Preferences')
  ]
  for (const f of chromium) {
    try {
      const st = await fs.stat(f)
      if (st.size > 32 * 1024 * 1024) continue
      const j = JSON.parse((await fs.readFile(f, 'utf8')).replace(/^\uFEFF/, '')) as { download?: { default_directory?: string }; savefile?: { default_directory?: string } }
      for (const d of [j.download?.default_directory, j.savefile?.default_directory]) if (typeof d === 'string' && /^[a-z]:\\/i.test(d)) out.push(d)
    } catch {
      // navegador não instalado / arquivo em uso
    }
  }
  // Firefox: prefs.js de cada perfil
  try {
    const profiles = path.win32.join(ra, 'Mozilla', 'Firefox', 'Profiles')
    for (const p of await fs.readdir(profiles)) {
      try {
        const txt = await fs.readFile(path.win32.join(profiles, p, 'prefs.js'), 'utf8')
        const m = /user_pref\("browser\.download\.dir",\s*"((?:[^"\\]|\\.)*)"\)/.exec(txt)
        if (m) out.push(m[1].replace(/\\\\/g, '\\'))
      } catch {
        // perfil sem prefs.js
      }
    }
  } catch {
    // sem Firefox
  }
  // qBittorrent
  try {
    const ini = await fs.readFile(path.win32.join(ra, 'qBittorrent', 'qBittorrent.ini'), 'utf8')
    for (const m of ini.matchAll(/^(?:Session\\DefaultSavePath|Downloads\\SavePath|Session\\TempPath)=(.+)$/gim)) {
      const v = m[1].trim().replace(/\//g, '\\')
      if (/^[a-z]:\\/i.test(v)) out.push(v)
    }
  } catch {
    // sem qBittorrent
  }
  return out
}

async function defaultEnv(signals: SystemSignals): Promise<DiscoverEnv> {
  const home = os.homedir()
  let driveRoots: string[] = []
  try {
    driveRoots = (await getDrives())
      .filter((d) => d.driveType === 'fixed')
      .map((d) => d.root)
  } catch {
    driveRoots = []
  }
  if (!driveRoots.length) {
    for (const l of 'CDEFGH') if (await exists(`${l}:\\`)) driveRoots.push(`${l}:\\`)
  }
  const downloads: string[] = []
  const add = (p: string | undefined | null): void => {
    if (p && /^[a-z]:\\/i.test(p)) downloads.push(cleanPath(p))
  }
  add(signals.folders.downloads)
  add(path.win32.join(home, 'Downloads'))
  for (const r of driveRoots) for (const n of ['Downloads', 'Download', 'Baixados']) add(path.win32.join(r, n))
  for (const d of await browserDownloadDirs()) add(d)
  add(path.win32.join(home, 'Documents', 'Telegram Desktop'))
  const desktop = [signals.folders.desktop, path.win32.join(home, 'Desktop')].filter((p): p is string => Boolean(p))
  const ra = known.appData
  const la = known.localAppData
  return {
    home,
    downloads: dedupeDirs(downloads),
    desktop: dedupeDirs(desktop),
    documents: signals.folders.documents ?? path.win32.join(home, 'Documents'),
    programFiles: [...new Set([known.programFiles, known.programFilesX86, process.env.ProgramW6432].filter((x): x is string => Boolean(x)).map(cleanPath))],
    programData: known.programData,
    localAppData: la,
    localPrograms: path.win32.join(la, 'Programs'),
    appData: ra,
    localLow: path.win32.join(home, 'AppData', 'LocalLow'),
    windir: known.windir,
    driveRoots,
    hydraData: path.win32.join(ra, 'hydralauncher'),
    altLauncherDirs: [
      { name: 'Playnite', dirs: [path.win32.join(ra, 'Playnite'), path.win32.join(la, 'Playnite')] },
      { name: 'itch', dirs: [path.win32.join(ra, 'itch')], gamesDirs: [path.win32.join(ra, 'itch', 'apps')] },
      { name: 'Heroic Games Launcher', dirs: [path.win32.join(ra, 'heroic'), path.win32.join(la, 'Programs', 'heroic')], gamesDirs: [path.win32.join(home, 'Games', 'Heroic')] },
      { name: 'Game Jolt', dirs: [path.win32.join(la, 'game-jolt-client')] },
      { name: 'Amazon Games', dirs: [path.win32.join(la, 'Amazon Games')], gamesDirs: [path.win32.join(la, 'Amazon Games', 'Library')] },
      { name: 'Lunar Client', dirs: [path.win32.join(la, 'Programs', 'lunarclient')] }
    ]
  }
}

function dedupeDirs(list: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const p of list) {
    const k = pkey(p)
    if (!k || seen.has(k)) continue
    seen.add(k)
    out.push(p)
  }
  return out
}

/** Inventário: o salvo (se recente) ou a coleta rápida (sem medir tamanhos). */
async function defaultInventory(): Promise<AppsInventory | null> {
  try {
    const last = await getLatest('apps')
    if (last && Date.now() - Date.parse(last.collectedAt) < 10 * 60_000) return last
  } catch {
    // sem inventário salvo
  }
  return buildInventory({ computeSizes: false })
}

/** Lê ProductName/Manufacturer/ProductCode de .msi (Windows Installer, SOMENTE LEITURA). */
async function defaultMsiInfo(paths: string[]): Promise<Map<string, MsiInfo>> {
  const out = new Map<string, MsiInfo>()
  const list = paths.slice(0, 40)
  if (!list.length) return out
  const script = `
$res = @{}
try { $inst = New-Object -ComObject WindowsInstaller.Installer } catch { ConvertTo-Json -InputObject $res -Compress; return }
foreach ($p in @(${list.map(psQuote).join(',')})) {
  try {
    $db = $inst.GetType().InvokeMember('OpenDatabase', 'InvokeMethod', $null, $inst, @($p, 0))
    $view = $db.GetType().InvokeMember('OpenView', 'InvokeMethod', $null, $db, @("SELECT Property, Value FROM Property WHERE Property='ProductName' OR Property='Manufacturer' OR Property='ProductVersion' OR Property='ProductCode'"))
    [void]$view.GetType().InvokeMember('Execute', 'InvokeMethod', $null, $view, $null)
    $o = @{}
    for ($i = 0; $i -lt 10; $i++) {
      $rec = $view.GetType().InvokeMember('Fetch', 'InvokeMethod', $null, $view, $null)
      if ($null -eq $rec) { break }
      $k = $rec.GetType().InvokeMember('StringData', 'GetProperty', $null, $rec, 1)
      $v = $rec.GetType().InvokeMember('StringData', 'GetProperty', $null, $rec, 2)
      $o[[string]$k] = [string]$v
    }
    [void]$view.GetType().InvokeMember('Close', 'InvokeMethod', $null, $view, $null)
    [void][Runtime.InteropServices.Marshal]::ReleaseComObject($view)
    [void][Runtime.InteropServices.Marshal]::ReleaseComObject($db)
    $res[$p] = $o
  } catch { }
}
ConvertTo-Json -InputObject $res -Depth 4 -Compress
`
  try {
    const raw = await runPowerShellJson<Record<string, { ProductName?: string; Manufacturer?: string; ProductVersion?: string; ProductCode?: string }>>(script, { timeoutMs: 60_000 })
    for (const [p, v] of Object.entries(raw ?? {})) {
      out.set(pkey(p), { productName: v.ProductName, manufacturer: v.Manufacturer, productVersion: v.ProductVersion, productCode: v.ProductCode?.toUpperCase() })
    }
  } catch {
    // Windows Installer indisponível: segue pelo nome do arquivo
  }
  return out
}

const defaults: DiscoverProviders = {
  env: defaultEnv,
  inventory: defaultInventory,
  registry: collectRegistry,
  signals: collectSignals,
  msiInfo: defaultMsiInfo
}

let testProviders: Partial<DiscoverProviders> | null = null

/** SOMENTE TESTES: troca as fontes de dados (pastas, inventário, registro, sinais) por versões falsas. */
export function setDiscoverProvidersForTests(p: Partial<DiscoverProviders> | null): void {
  testProviders = p
}

export function providers(): DiscoverProviders {
  return { ...defaults, ...(testProviders ?? {}) }
}

/**
 * O inventário salvo pode ter alguns minutos: programas que já saíram do registro (acabaram de ser desinstalados)
 * não contam mais como "dono" (senão as sobras deles não poderiam ser apagadas logo depois da desinstalação).
 * Só remove entradas 'reg:' ausentes do registro LIDO AGORA; jogos de launchers e apps da Store ficam.
 */
export function pruneInventory(inv: AppsInventory | null, registry: RegUninstallEntry[]): AppsInventory | null {
  if (!inv || !registry.length) return inv
  const ids = new Set(registry.map((e) => `reg:${e.hive}:${e.key}`))
  return { ...inv, programs: (inv.programs ?? []).filter((p) => !p.id.startsWith('reg:') || ids.has(p.id)) }
}

/** Pastas amplas do ambiente (áreas de programas, perfil, discos): nunca contam como "pasta de um programa". */
export function envBroad(env: DiscoverEnv): string[] {
  return [...env.programFiles, env.programData, env.localAppData, env.localPrograms, env.appData, env.localLow, env.home, env.windir, ...env.downloads, ...env.desktop, ...(env.documents ? [env.documents] : []), ...env.driveRoots]
}

// ------------------------------------------------------------------------------------------- índice de nomes

export interface InstalledName {
  name: string
  kind: 'program' | 'game' | 'store' | 'hydra'
  id?: string
  compact: string
  tokens: string[]
  publisher?: string
  /** GUID da entrada MSI (chave do registro) */
  msiCode?: string
  installPath?: string
}

export class InstalledIndex {
  readonly list: InstalledName[] = []

  add(n: Omit<InstalledName, 'compact' | 'tokens'>): void {
    const c = compact(n.name)
    if (c.length < 2) return
    this.list.push({ ...n, compact: c, tokens: tokens(n.name) })
  }

  /** Procura algo instalado com nome compatível (comparação conservadora). */
  match(candidate: string | undefined | null, opts: { msiCode?: string } = {}): InstalledName | undefined {
    if (opts.msiCode) {
      const code = opts.msiCode.toUpperCase()
      const byCode = this.list.find((x) => x.msiCode === code)
      if (byCode) return byCode
    }
    const c = compact(candidate)
    if (c.length < 3) return undefined
    const t = tokens(candidate)
    let best: { item: InstalledName; score: number } | undefined
    for (const item of this.list) {
      let score = 0
      if (item.compact === c) score = 100
      else if (c.length >= 4 && item.compact.length >= 4 && (item.compact.startsWith(c) || c.startsWith(item.compact))) score = 80
      else if (
        Math.min(c.length, item.compact.length) >= 6 &&
        Math.min(c.length, item.compact.length) / Math.max(c.length, item.compact.length) >= 0.5 &&
        (item.compact.includes(c) || c.includes(item.compact))
      )
        score = 60
      // todas as palavras do nome do instalador aparecem no nome do programa (meia coincidência não conta:
      // "Photo Image Viewer" não é "HEIC Image Viewer")
      else if (t.length && t.every((x) => item.tokens.includes(x))) score = 50
      if (score && (!best || score > best.score)) best = { item, score }
    }
    return best?.item
  }
}

export function buildInstalledIndex(inv: AppsInventory | null, entries: RegUninstallEntry[], hydra: HydraData | null): InstalledIndex {
  const idx = new InstalledIndex()
  for (const p of inv?.programs ?? []) idx.add({ name: p.name, kind: p.source === 'store' ? 'store' : 'program', id: p.id, publisher: p.publisher, installPath: p.installPath })
  for (const g of inv?.games ?? []) if (g.exists !== false) idx.add({ name: g.name, kind: 'game', id: g.id, installPath: g.installPath })
  for (const e of entries) {
    if (!isListedProgram(e)) continue
    const code = /^\{[0-9a-f-]{36}\}$/i.test(e.key) ? e.key.toUpperCase() : undefined
    idx.add({ name: e.name, kind: 'program', id: `reg:${e.hive}:${e.key}`, publisher: e.publisher ?? undefined, msiCode: code })
  }
  for (const g of hydra?.games ?? []) if (g.exeExists) idx.add({ name: g.title, kind: 'hydra', id: `hydra:${g.id}`, installPath: g.dir })
  return idx
}

// ------------------------------------------------------------------------------------------- contexto

export interface ScanCtx {
  deep: boolean
  signal: AbortSignal
  env: DiscoverEnv
  inventory: AppsInventory | null
  registry: RegistryData
  signals: SystemSignals
  ownership: OwnershipData
  usage: UsageIndex | null
  hydra: HydraData | null
  installed: InstalledIndex
  findings: Finding[]
  warnings: string[]
  locations: Set<string>
  /** Caminhos (chaves) já cobertos por algum achado: evita o mesmo item em dois achados */
  claimed: Set<string>
  progress: (percent: number, message: string) => void
  now: number
}

export function claim(ctx: ScanCtx, p: string): boolean {
  const k = pkey(p)
  if (ctx.claimed.has(k)) return false
  ctx.claimed.add(k)
  return true
}

export function isClaimed(ctx: ScanCtx, p: string): boolean {
  const k = pkey(p)
  for (const c of ctx.claimed) if (k === c || k.startsWith(c + '\\')) return true
  return false
}

export function usageIndexOf(reg: RegistryData): UsageIndex | null {
  try {
    return new UsageIndex(reg)
  } catch {
    return null
  }
}

export async function safeRegistry(): Promise<{ reg: RegistryData; warning?: string }> {
  try {
    return { reg: await providers().registry() }
  } catch (e) {
    return { reg: emptyRegistry('registry'), warning: `Não foi possível ler a lista de programas do Windows (${(e as Error).message}). Alguns achados podem faltar.` }
  }
}

export async function safeSignals(): Promise<{ signals: SystemSignals; warning?: string }> {
  try {
    return { signals: await providers().signals() }
  } catch (e) {
    return { signals: emptySignals(), warning: `Não foi possível ler serviços/tarefas/inicialização (${(e as Error).message}). A proteção de pastas em uso fica mais restrita.` }
  }
}

export { isDir, normName }
