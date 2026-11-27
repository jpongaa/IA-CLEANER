// Como saber se um jogo/programa AINDA está instalado (somente leitura):
//  - marcadores por tipo de instalação: chave de desinstalação no registro (todas as hives) + registro do MSI,
//    pacote da Microsoft Store, manifesto do launcher (Steam appmanifest_<id>.acf, Epic .item), pasta com executável;
//  - sondagem real do sistema num ÚNICO PowerShell por rodada: registro + pacotes + processos (com ParentProcessId,
//    para seguir o desinstalador e os filhos dele, inclusive os que se copiam para %TEMP%).
// Nada aqui altera o PC.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { AppsInventory, GameInfo, ProgramInfo } from '@shared/types/apps'
import { known } from '../core/paths'
import { psQuote, runPowerShellJson } from '../core/powershell'
import { cleanPath, isTooBroadPath, listDir, normPath, readJsonFile } from './util'

export type RegRoot = 'HKLM' | 'HKCU'

/** Algo que existe enquanto o item está instalado. O item está instalado se QUALQUER marcador existir. */
export type Marker =
  | { type: 'reg'; root: RegRoot; path: string }
  | { type: 'appx'; name: string; pfn: string }
  | { type: 'file'; path: string }
  /** Pasta que ainda tem algum executável (até 2 níveis), sem contar desinstaladores */
  | { type: 'exeDir'; path: string }

export type TrackItem = { kind: 'game'; game: GameInfo } | { kind: 'program'; program: ProgramInfo }

/** As 4 listas de "Aplicativos instalados" do Windows (64/32 bits, máquina/usuário). */
export const UNINSTALL_ROOTS: readonly [RegRoot, string][] = [
  ['HKLM', 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall'],
  ['HKLM', 'SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall'],
  ['HKCU', 'Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall'],
  ['HKCU', 'Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall']
]

const GUID = /^\{?([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})\}?$/i

/** Nome de subchave aceitável (sem '\', sem controle, tamanho do registro). */
function validSubkey(k: string): boolean {
  // eslint-disable-next-line no-control-regex
  return k.length > 0 && k.length <= 255 && !/[\\\u0000-\u001f]/.test(k)
}

/** 'reg:HKLM32:{GUID}' -> { hive: 'HKLM32', key: '{GUID}' } */
export function parseProgramRegId(id: string): { hive: string; key: string } | undefined {
  const m = /^reg:(HKLM32|HKLM|HKCU32|HKCU):(.+)$/.exec(id)
  if (!m || !validSubkey(m[2])) return undefined
  return { hive: m[1], key: m[2] }
}

/** A chave de desinstalação com este nome, em todas as hives. */
export function uninstallKeyMarkers(key: string): Marker[] {
  if (!validSubkey(key)) return []
  return UNINSTALL_ROOTS.map(([root, base]) => ({ type: 'reg' as const, root, path: `${base}\\${key}` }))
}

/** GUID "compactado" do Windows Installer ({12345678-ABCD-...} -> 87654321DCBA...). */
export function packGuid(guid: string): string | undefined {
  const m = GUID.exec(guid.trim())
  if (!m) return undefined
  const rev = (s: string): string => s.split('').reverse().join('')
  const swap = (s: string): string => s.replace(/(.)(.)/g, '$2$1')
  return (rev(m[1]) + rev(m[2]) + rev(m[3]) + swap(m[4]) + swap(m[5])).toUpperCase()
}

/** Código do produto MSI de uma entrada de desinstalação (chave {GUID} com msiexec, ou /X{GUID} no comando). */
export function productCodeOf(key: string | undefined, uninstallValue: string | undefined): string | undefined {
  const value = uninstallValue ?? ''
  if (!/msiexec/i.test(value)) return undefined
  const fromCmd = /\/[xi]\s*(\{[0-9a-f-]{36}\})/i.exec(value)?.[1]
  const code = fromCmd ?? (key && GUID.test(key) ? key : undefined)
  if (!code) return undefined
  const m = GUID.exec(code)
  return m ? `{${m[1]}-${m[2]}-${m[3]}-${m[4]}-${m[5]}}`.toUpperCase() : undefined
}

/** Registro do produto no Windows Installer (máquina e usuário). */
export function msiMarkers(productCode: string): Marker[] {
  const packed = packGuid(productCode)
  if (!packed) return []
  return [
    { type: 'reg', root: 'HKLM', path: `SOFTWARE\\Classes\\Installer\\Products\\${packed}` },
    { type: 'reg', root: 'HKCU', path: `Software\\Microsoft\\Installer\\Products\\${packed}` }
  ]
}

/** 'Nome_publisherid' -> marcador do pacote da Store. */
export function appxMarker(pfn: string): Marker | undefined {
  const m = /^([A-Za-z0-9.-]{3,})_([a-z0-9]{8,20})$/i.exec(pfn.trim())
  return m ? { type: 'appx', name: m[1], pfn: pfn.trim() } : undefined
}

/** '...\steamapps\common\Jogo' -> '...\steamapps' */
export function steamappsOf(installPath: string | undefined): string | undefined {
  const p = cleanPath(installPath)
  const m = /^(.*\\steamapps)(\\|$)/i.exec(p)
  return m ? m[1] : undefined
}

function isMissing(e: unknown): boolean {
  const c = (e as NodeJS.ErrnoException)?.code
  return c === 'ENOENT' || c === 'ENOTDIR'
}

/** true/false; null = não deu para saber (sem permissão etc.). */
export async function fileExists(p: string): Promise<boolean | null> {
  try {
    await fs.stat(p)
    return true
  } catch (e) {
    return isMissing(e) ? false : null
  }
}

const UNINSTALLER_EXE = /^(unins|uninst|uninstall|au_|un_a)/i

/** A pasta ainda tem algum executável (até 2 níveis; desinstaladores não contam)? */
export async function exeDirPresent(dir: string): Promise<boolean | null> {
  try {
    if (!(await fs.stat(dir)).isDirectory()) return false
  } catch (e) {
    return isMissing(e) ? false : null
  }
  const stack: [string, number][] = [[dir, 0]]
  let visited = 0
  while (stack.length && visited < 400) {
    const [d, depth] = stack.pop()!
    visited++
    let ents: import('node:fs').Dirent[]
    try {
      ents = await fs.readdir(d, { withFileTypes: true })
    } catch (e) {
      // A própria pasta sem permissão de leitura (ex.: WindowsApps): não dá para saber. Nunca vira "removido".
      if (depth === 0) return isMissing(e) ? false : null
      continue
    }
    for (const e of ents) {
      if (e.isSymbolicLink()) continue
      if (e.isFile() && /\.exe$/i.test(e.name) && !UNINSTALLER_EXE.test(e.name)) return true
      if (e.isDirectory() && depth < 2) stack.push([path.win32.join(d, e.name), depth + 1])
    }
  }
  return false
}

export interface ResolveOptions {
  /** Pasta dos manifestos da Epic (padrão: %ProgramData%\Epic\EpicGamesLauncher\Data\Manifests) */
  epicManifestsDir?: string
}

async function exists(p: string): Promise<boolean> {
  return (await fileExists(p)) === true
}

function programMarkers(p: ProgramInfo): Marker[] {
  if (p.source === 'store' || p.id.startsWith('store:')) {
    const m = appxMarker(p.id.slice('store:'.length))
    return m ? [m] : []
  }
  const reg = parseProgramRegId(p.id)
  if (!reg) return []
  const out = uninstallKeyMarkers(reg.key)
  const code = productCodeOf(reg.key, p.uninstall?.value)
  if (code) out.push(...msiMarkers(code))
  return out
}

async function fallbackMarkers(installPath: string | undefined, mainExe: string | undefined): Promise<Marker[]> {
  if (mainExe && (await exists(mainExe))) return [{ type: 'file', path: cleanPath(mainExe) }]
  if (installPath && !isTooBroadPath(installPath)) return [{ type: 'exeDir', path: cleanPath(installPath) }]
  return []
}

async function gameMarkers(g: GameInfo, inv: AppsInventory, opts: ResolveOptions): Promise<Marker[]> {
  const out: Marker[] = []
  let useLinkedPrograms = true
  switch (g.launcher) {
    case 'steam': {
      // O manifesto some quando a Steam desinstala. A entrada "Steam App N" do registro pode ficar para trás: não conta.
      useLinkedPrograms = false
      const appid = /^steam:(\d+)$/.exec(g.id)?.[1]
      if (!appid) break
      const libs = inv.launchers.find((l) => l.launcher === 'steam')?.libraries ?? []
      const dirs = new Map<string, string>()
      for (const d of [steamappsOf(g.installPath), ...libs.map((l) => path.win32.join(l, 'steamapps'))]) if (d) dirs.set(normPath(d), d)
      const manifests = [...dirs.values()].map((d) => path.win32.join(d, `appmanifest_${appid}.acf`))
      const found: string[] = []
      for (const m of manifests) if (await exists(m)) found.push(m)
      for (const m of found.length ? found : manifests.slice(0, 1)) out.push({ type: 'file', path: m })
      break
    }
    case 'epic': {
      useLinkedPrograms = false
      const appName = g.id.slice('epic:'.length).toLowerCase()
      const dir = opts.epicManifestsDir ?? path.win32.join(known.programData, 'Epic', 'EpicGamesLauncher', 'Data', 'Manifests')
      for (const d of await listDir(dir)) {
        if (!d.isFile() || !/\.item$/i.test(d.name)) continue
        const file = path.win32.join(dir, d.name)
        const it = await readJsonFile<{ AppName?: string }>(file)
        if (it?.AppName && it.AppName.toLowerCase() === appName) out.push({ type: 'file', path: file })
      }
      break
    }
    case 'xbox': {
      for (const f of ['MicrosoftGame.Config', 'appxmanifest.xml']) {
        const p = path.win32.join(g.installPath, 'Content', f)
        if (await exists(p)) out.push({ type: 'file', path: p })
      }
      break
    }
    case 'ubisoft': {
      const id = g.id.slice('ubisoft:'.length)
      if (/^\d+$/.test(id)) out.push({ type: 'reg', root: 'HKLM', path: `SOFTWARE\\WOW6432Node\\Ubisoft\\Launcher\\Installs\\${id}` })
      break
    }
    case 'gog': {
      const id = g.id.slice('gog:'.length)
      if (/^\d+$/.test(id)) out.push({ type: 'reg', root: 'HKLM', path: `SOFTWARE\\WOW6432Node\\GOG.com\\Games\\${id}` })
      break
    }
    default:
      break
  }
  if (useLinkedPrograms) {
    const ids = new Set([g.programId, ...inv.programs.filter((p) => p.gameId === g.id).map((p) => p.id)].filter((x): x is string => Boolean(x)))
    for (const id of ids) {
      const p = inv.programs.find((x) => x.id === id)
      out.push(...(p ? programMarkers(p) : (parseProgramRegId(id) ? uninstallKeyMarkers(parseProgramRegId(id)!.key) : [])))
    }
  }
  if (!out.length) out.push(...(await fallbackMarkers(g.installPath, g.mainExe)))
  return dedupeMarkers(out)
}

function markerKey(m: Marker): string {
  switch (m.type) {
    case 'reg':
      return `reg|${m.root}|${m.path.toLowerCase()}`
    case 'appx':
      return `appx|${m.pfn.toLowerCase()}`
    default:
      return `${m.type}|${normPath(m.path)}`
  }
}

export function dedupeMarkers(list: Marker[]): Marker[] {
  const seen = new Set<string>()
  return list.filter((m) => {
    const k = markerKey(m)
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

/** Marcadores de presença de um jogo ou programa do inventário (somente leitura). */
export async function resolveMarkers(item: TrackItem, inv: AppsInventory, opts: ResolveOptions = {}): Promise<Marker[]> {
  if (item.kind === 'game') return gameMarkers(item.game, inv, opts)
  const p = item.program
  // Programa que é um jogo de launcher: os marcadores do launcher são melhores (ex.: manifesto da Steam).
  const game = p.gameId ? inv.games.find((g) => g.id === p.gameId) : undefined
  if (game) return gameMarkers(game, inv, opts)
  const out = programMarkers(p)
  if (!out.length) out.push(...(await fallbackMarkers(p.installPath, p.mainExe)))
  return dedupeMarkers(out)
}

/** Junta os resultados dos marcadores: algum existe -> true; nenhum existe -> false; senão (ou sem marcadores) null. */
export function combinePresence(values: (boolean | null | undefined)[]): boolean | null {
  if (!values.length) return null
  if (values.some((v) => v === true)) return true
  if (values.every((v) => v === false)) return false
  return null
}

// ---------------------------------------------------------------- sondagem real (registro, Store, processos)

export interface ProcInfo {
  pid: number
  ppid: number
  /** 'unins000.exe' */
  name: string
  /** epoch ms da criação */
  created?: number
  path?: string
  /** Só para msiexec.exe (para achar o código do produto) */
  cmd?: string
}

export interface SystemProbeRequest {
  reg: { root: RegRoot; path: string }[]
  appx: { name: string; pfn: string }[]
  processes: boolean
}

export interface SystemProbeResult {
  /** Mesma ordem do pedido. null = não deu para ler */
  reg: (boolean | null)[]
  appx: (boolean | null)[]
  /** null = não pedido ou não deu para listar */
  processes: ProcInfo[] | null
}

/** Script da sondagem (exportado para testes). Os dados vão como JSON literal, nunca como código. */
export function buildProbeScript(req: SystemProbeRequest): string {
  return `
$req = ConvertFrom-Json -InputObject ${psQuote(JSON.stringify(req))}
$hk = @{}
function BaseKey([string]$r) {
  if (-not $hk.ContainsKey($r)) {
    $h = 'LocalMachine'
    if ($r -eq 'HKCU') { $h = 'CurrentUser' }
    $hk[$r] = [Microsoft.Win32.RegistryKey]::OpenBaseKey($h, 'Registry64')
  }
  return $hk[$r]
}
$reg = New-Object System.Collections.ArrayList
foreach ($q in @($req.reg)) {
  $v = $null
  try {
    $k = (BaseKey ([string]$q.root)).OpenSubKey([string]$q.path, $false)
    if ($k) { $v = $true; $k.Close() } else { $v = $false }
  } catch { $v = $null }
  [void]$reg.Add($v)
}
$appx = New-Object System.Collections.ArrayList
foreach ($a in @($req.appx)) {
  $v = $null
  try {
    $found = @(Get-AppxPackage -Name ([string]$a.name) -ErrorAction Stop | Where-Object { $_.PackageFamilyName -eq [string]$a.pfn })
    $v = ($found.Count -gt 0)
  } catch { $v = $null }
  [void]$appx.Add($v)
}
$procs = $null
if ($req.processes) {
  try {
    $pl = New-Object System.Collections.ArrayList
    foreach ($p in @(Get-CimInstance -ClassName Win32_Process -Property ProcessId,ParentProcessId,Name,CreationDate,ExecutablePath,CommandLine -ErrorAction Stop)) {
      $t = $null
      try { if ($p.CreationDate) { $t = ([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds() } } catch { }
      $cmd = $null
      if ([string]$p.Name -eq 'msiexec.exe') { $cmd = [string]$p.CommandLine }
      [void]$pl.Add([ordered]@{ pid = [int64]$p.ProcessId; ppid = [int64]$p.ParentProcessId; name = [string]$p.Name; t = $t; path = [string]$p.ExecutablePath; cmd = $cmd })
    }
    $procs = @($pl)
  } catch { $procs = $null }
}
foreach ($b in @($hk.Values)) { try { $b.Close() } catch { } }
ConvertTo-Json -InputObject ([ordered]@{ reg = @($reg); appx = @($appx); procs = $procs }) -Depth 4 -Compress
`
}

function arr<T>(v: T[] | T | null | undefined): T[] {
  return Array.isArray(v) ? v : v !== null && v !== undefined ? [v] : []
}

function triState(v: unknown): boolean | null {
  return v === true ? true : v === false ? false : null
}

/** Sondagem real, somente leitura (um PowerShell). Lança erro se o PowerShell falhar. */
export async function probeSystem(req: SystemProbeRequest): Promise<SystemProbeResult> {
  if (!req.reg.length && !req.appx.length && !req.processes) return { reg: [], appx: [], processes: null }
  const raw = await runPowerShellJson<{
    reg?: unknown
    appx?: unknown
    procs?: { pid?: number; ppid?: number; name?: string; t?: number | null; path?: string | null; cmd?: string | null }[] | null
  }>(buildProbeScript(req), { timeoutMs: 45_000 })
  const reg = arr(raw.reg as unknown[]).map(triState)
  const appx = arr(raw.appx as unknown[]).map(triState)
  let processes: ProcInfo[] | null = null
  if (req.processes && raw.procs !== null && raw.procs !== undefined) {
    processes = arr(raw.procs)
      .filter((p) => Number.isFinite(p?.pid) && typeof p?.name === 'string')
      .map((p) => ({
        pid: Number(p.pid),
        ppid: Number(p.ppid ?? 0),
        name: String(p.name),
        created: typeof p.t === 'number' && Number.isFinite(p.t) ? p.t : undefined,
        path: p.path ? String(p.path) : undefined,
        cmd: p.cmd ? String(p.cmd) : undefined
      }))
  }
  return {
    reg: req.reg.map((_, i) => reg[i] ?? null),
    appx: req.appx.map((_, i) => appx[i] ?? null),
    processes
  }
}

// ---------------------------------------------------------------- processos do desinstalador

export interface WatchedProc {
  pid: number
  /** epoch ms da criação (para não confundir com um PID reaproveitado) */
  created?: number
  /** a raiz já não existia na primeira olhada: só serve como "pai" */
  gone?: boolean
}

export interface ProcWatch {
  /** epoch ms antes de abrir o desinstalador */
  startedAt: number
  rootPid?: number
  /** Executável aberto (caminho completo) */
  rootExe?: string
  /** Código do produto MSI (para reconhecer o msiexec dele) */
  productCode?: string
  known: WatchedProc[]
}

/** Programas que podem ser abertos pelo desinstalador mas não são ele (página "sentimos sua falta", console...). */
const NOT_UNINSTALLER =
  /^(conhost|explorer|werfault|wermgr|chrome|msedge|msedgewebview2|firefox|opera|opera_gx|brave|iexplore|vivaldi|steam|steamwebhelper|searchprotocolhost|searchfilterhost|notepad)\.exe$/i
/** Desinstaladores NSIS/Inno que se copiam para %TEMP% e continuam por lá depois que o original sai. */
const UNINSTALLER_NAME = /^(au_|un_a|un_b|un_c|un)\.exe$|^_iu[^\\]*\.tmp$|^unins\d*\.tmp$|^(unins|uninst|uninstall)[^\\]*\.exe$/i
/** Executáveis genéricos: o nome sozinho não identifica o desinstalador. */
const GENERIC_EXE = /^(rundll32|msiexec|cmd|powershell|pwsh|wscript|cscript|explorer|conhost)\.exe$/i
const MAX_KNOWN = 200

function sameProc(k: WatchedProc, p: ProcInfo): boolean {
  if (k.pid !== p.pid || k.gone) return false
  if (k.created === undefined || p.created === undefined) return true
  return Math.abs(k.created - p.created) < 1500
}

/**
 * Processos do desinstalador que estão rodando agora: a raiz aberta pelo app, os descendentes dela (ParentProcessId,
 * mesmo depois que o pai saiu) e cópias conhecidas em %TEMP% (Au_.exe, Un_A.exe, _iu*.tmp, unins*.tmp) ou o msiexec
 * do produto, criadas depois do início. Atualiza w.known (persistido no acompanhamento).
 */
export function findUninstallerProcesses(w: ProcWatch, procs: ProcInfo[], slackMs = 2000): ProcInfo[] {
  const minT = w.startedAt - slackMs
  if (w.rootPid && !w.known.some((k) => k.pid === w.rootPid)) {
    const root = procs.find((p) => p.pid === w.rootPid && (p.created === undefined || p.created >= minT))
    w.known.push(root ? { pid: root.pid, created: root.created } : { pid: w.rootPid, gone: true })
  }
  // descendentes (vários níveis); um filho precisa ter nascido depois do pai conhecido
  for (let changed = true, guard = 0; changed && guard < 16 && w.known.length < MAX_KNOWN; guard++) {
    changed = false
    for (const p of procs) {
      if (p.created === undefined || p.created < minT) continue
      if (w.known.some((k) => sameProc(k, p))) continue
      const parent = w.known.find((k) => k.pid === p.ppid && p.created! >= (k.created ?? minT) - 1000)
      if (!parent) continue
      // PID do pai reaproveitado por outro processo: filhos nascidos depois disso são do outro processo.
      const reuser = procs.find((q) => q.pid === parent.pid && !sameProc(parent, q) && q.created !== undefined)
      if (reuser && p.created! >= reuser.created!) continue
      w.known.push({ pid: p.pid, created: p.created })
      changed = true
      if (w.known.length >= MAX_KNOWN) break
    }
  }
  const rootBase = w.rootExe ? path.win32.basename(w.rootExe).toLowerCase() : ''
  const rootNameCounts = rootBase && !GENERIC_EXE.test(rootBase)
  const code = w.productCode?.toLowerCase()
  return procs.filter((p) => {
    if (NOT_UNINSTALLER.test(p.name)) return false
    if (w.known.some((k) => sameProc(k, p))) return true
    if (p.created === undefined || p.created < minT) return false
    const name = p.name.toLowerCase()
    if (UNINSTALLER_NAME.test(name)) return true
    if (rootNameCounts && name === rootBase) return true
    if (code && name === 'msiexec.exe' && (p.cmd ?? '').toLowerCase().includes(code)) return true
    return false
  })
}
