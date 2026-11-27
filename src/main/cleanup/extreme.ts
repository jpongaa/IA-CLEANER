// Busca extrema: itens PESADOS e mais avançados do Windows e de programas, que a limpeza normal não mexe.
// Aqui só se MEDE (somente leitura) e se descreve cada item com veredito/risco honestos. A execução usa mecanismos
// OFICIAIS para o sistema (Limpeza de Disco do Windows via cleanmgr /sagerun, DISM, pnputil sem /force), o motor
// seguro para caches de programas, e a Lixeira para dados do usuário (gravações de jogos). Itens "manuais" (pontos de
// restauração, hibernação, índice de pesquisa, discos virtuais) só informam o tamanho e levam ao lugar certo.
import { execFile } from 'node:child_process'
import fs, { promises as fsp, type Dirent } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { CleanupSampleFile, CleanupTarget } from '@shared/types/cleanup'
import { formatBytes } from '@shared/format'
import { known } from '../core/paths'
import { runPowerShellJson } from '../core/powershell'
import { checkPath } from '../safety/guard'
import { readRegistryStrings } from '../safety/knownFolders'
import { getBinState } from './recycle'
import { steamLibraries, type Measured, type MeasureCtx, type TargetSpec } from './targets'

const GB = 1024 ** 3
const MB = 1024 ** 2

// ---------------------------------------------------------------------------------------------
// Comandos oficiais (ids estáveis -> execução em index.ts/admin.ts)
// ---------------------------------------------------------------------------------------------

/** Itens executados pela Limpeza de Disco do Windows (cleanmgr /sagerun): id do alvo -> categoria em VolumeCaches. */
export const CLEANMGR_CATEGORIES: Record<string, string> = {
  'extreme-cleanmgr-previous': 'Previous Installations',
  'extreme-cleanmgr-setup': 'Temporary Setup Files',
  'extreme-cleanmgr-updates': 'Update Cleanup',
  'extreme-cleanmgr-esd': 'Windows ESD installation files',
  'extreme-cleanmgr-upgradelogs': 'Windows Upgrade Log Files',
  'extreme-cleanmgr-drivers': 'Device Driver Packages',
  'extreme-cleanmgr-delivery': 'Delivery Optimization Files'
}

export const DISM_COMPONENT_ID = 'extreme-dism-component'
export const DISM_RESETBASE_ID = 'extreme-dism-resetbase'
export const DRIVERSTORE_ID = 'extreme-driverstore-display'
export const DOCKER_ID = 'extreme-docker-buildcache'

export type ExtremeCommand = 'cleanmgr' | 'dism' | 'dismResetBase' | 'driverStore' | 'docker'

/** Alvo executado por comando oficial (sem apagar caminhos diretamente). */
export function extremeCommandOf(id: string): ExtremeCommand | null {
  if (Object.hasOwn(CLEANMGR_CATEGORIES, id)) return 'cleanmgr'
  if (id === DISM_COMPONENT_ID) return 'dism'
  if (id === DISM_RESETBASE_ID) return 'dismResetBase'
  if (id === DRIVERSTORE_ID) return 'driverStore'
  if (id === DOCKER_ID) return 'docker'
  return null
}

// ---------------------------------------------------------------------------------------------
// Utilitários
// ---------------------------------------------------------------------------------------------

function isDir(p: string): boolean {
  try {
    return fs.lstatSync(p).isDirectory()
  } catch {
    return false
  }
}

function listDirs(p: string): string[] {
  try {
    return fs
      .readdirSync(p, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.isSymbolicLink())
      .map((d) => d.name)
  } catch {
    return []
  }
}

function existing(list: string[]): string[] {
  const seen = new Set<string>()
  return list.filter((p) => {
    const k = p.toLowerCase()
    if (seen.has(k) || !isDir(p)) return false
    seen.add(k)
    return true
  })
}

interface FoundFile {
  path: string
  bytes: number
  lastWrite: number
}

/**
 * Procura arquivos (somente leitura). Nunca entra em atalhos (junction/link). depth 0 = arquivos direto em `base`.
 * Para quando passa do prazo (`deadline`) ou do limite de arquivos.
 */
async function findFiles(
  base: string,
  o: { maxDepth: number; match: (name: string) => boolean; minBytes?: number; deadline: number; skipDir?: (full: string, name: string) => boolean; limit?: number },
  out: FoundFile[] = []
): Promise<FoundFile[]> {
  const limit = o.limit ?? 3000
  async function walk(dir: string, depth: number): Promise<void> {
    if (Date.now() > o.deadline || out.length >= limit) return
    let entries: Dirent[]
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    const subdirs: string[] = []
    for (const e of entries) {
      if (e.isSymbolicLink()) continue
      const full = dir.endsWith('\\') ? `${dir}${e.name}` : `${dir}\\${e.name}`
      if (e.isDirectory()) {
        if (depth < o.maxDepth && !(o.skipDir?.(full, e.name) ?? false)) subdirs.push(full)
        continue
      }
      if (!e.isFile() || !o.match(e.name)) continue
      try {
        const st = await fsp.lstat(full)
        if (st.isFile() && st.size >= (o.minBytes ?? 0)) out.push({ path: full, bytes: st.size, lastWrite: st.mtimeMs })
      } catch {
        // sumiu / sem acesso
      }
      if (out.length >= limit) return
    }
    for (const s of subdirs) await walk(s, depth + 1)
  }
  await walk(base, 0)
  return out
}

function topSamples(files: FoundFile[], n = 40): CleanupSampleFile[] {
  return [...files].sort((a, b) => b.bytes - a.bytes).slice(0, n).map((f) => ({ path: f.path, bytes: f.bytes, lastWrite: f.lastWrite }))
}

function sumBytes(files: { bytes: number }[]): number {
  return files.reduce((s, f) => s + f.bytes, 0)
}

/** Pasta "Vídeos" do usuário (pode estar redirecionada). */
function videosDir(): string {
  const reg = readRegistryStrings('HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Shell Folders').get('my video')
  return reg && path.win32.isAbsolute(reg) ? reg : path.join(os.homedir(), 'Videos')
}

// ---------------------------------------------------------------------------------------------
// Coleta somente leitura (UM script PowerShell): ShadowPlay, hibernação, índice, pontos de restauração, WSL
// ---------------------------------------------------------------------------------------------

export interface SystemProbe {
  shadowPlay: string[]
  hiber: number | null
  index: number | null
  restore: number | null
  wsl: { name: string; base: string }[]
  dockerCli: string | null
}

export const SYSTEM_PROBE_SCRIPT = String.raw`$o = [ordered]@{ shadowPlay = @(); hiber = $null; index = $null; restore = $null; wsl = @(); dockerCli = $null }
try {
  $k = Get-ItemProperty -LiteralPath 'HKCU:\Software\NVIDIA Corporation\Global\ShadowPlay\NVSPCAPS' -ErrorAction Stop
  foreach ($n in 'DefaultPathW', 'HLTempPath') {
    $v = $k.$n
    if ($v -is [byte[]]) { $v = [System.Text.Encoding]::Unicode.GetString($v) }
    if ($v) { $v = ([string]$v).TrimEnd([char]0).Trim(); if ($v) { $o.shadowPlay += $v } }
  }
} catch { }
try {
  $h = Get-ChildItem -LiteralPath ($env:SystemDrive + '\') -Force -File -ErrorAction Stop | Where-Object { $_.Name -eq 'hiberfil.sys' } | Select-Object -First 1
  if ($h) { $o.hiber = [double]$h.Length }
} catch { }
try {
  $sum = [double]0; $found = $false
  foreach ($n in 'Windows.db', 'Windows.edb') {
    $f = Join-Path $env:ProgramData ('Microsoft\Search\Data\Applications\Windows\' + $n)
    $i = Get-Item -LiteralPath $f -Force -ErrorAction SilentlyContinue
    if ($i) { $sum += [double]$i.Length; $found = $true }
  }
  if ($found) { $o.index = $sum }
} catch { }
try {
  $s = @(Get-CimInstance Win32_ShadowStorage -ErrorAction Stop)
  $o.restore = [double](($s | Measure-Object UsedSpace -Sum).Sum)
} catch { }
try {
  foreach ($d in @(Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Lxss' -ErrorAction Stop)) {
    $p = Get-ItemProperty -LiteralPath $d.PSPath
    if ($p.BasePath) { $o.wsl += [ordered]@{ name = [string]$p.DistributionName; base = [string]$p.BasePath } }
  }
} catch { }
try { $c = Get-Command docker.exe -ErrorAction Stop | Select-Object -First 1; $o.dockerCli = [string]$c.Source } catch { }
ConvertTo-Json -InputObject $o -Depth 4 -Compress`

async function systemProbe(): Promise<SystemProbe> {
  const empty: SystemProbe = { shadowPlay: [], hiber: null, index: null, restore: null, wsl: [], dockerCli: null }
  try {
    const r = await runPowerShellJson<Partial<SystemProbe> & { shadowPlay?: string[] | string; wsl?: SystemProbe['wsl'] | SystemProbe['wsl'][number] }>(SYSTEM_PROBE_SCRIPT, { timeoutMs: 45_000 })
    const arr = <T>(v: T | T[] | undefined | null): T[] => (Array.isArray(v) ? v : v ? [v] : [])
    return {
      shadowPlay: arr(r.shadowPlay).map(String),
      hiber: typeof r.hiber === 'number' ? r.hiber : null,
      index: typeof r.index === 'number' ? r.index : null,
      restore: typeof r.restore === 'number' ? r.restore : null,
      wsl: arr(r.wsl).filter((w) => w && typeof w.base === 'string'),
      dockerCli: typeof r.dockerCli === 'string' && r.dockerCli ? r.dockerCli : null
    }
  } catch {
    return empty
  }
}

// ---------------------------------------------------------------------------------------------
// DriverStore (pnputil /enum-drivers em XML, somente leitura)
// ---------------------------------------------------------------------------------------------

export interface DriverPkg {
  /** oemNN.inf (nome publicado) */
  inf: string
  /** Nome original (nv_dispi.inf) */
  orig: string
  provider: string
  cls: string
  guid: string
  /** 'mm/dd/aaaa a.b.c.d' */
  ver: string
  /** Dispositivos usando o pacote (inclusive desconectados, quando o Windows lista) */
  devices: number
  /** Pasta em DriverStore\FileRepository */
  folder: string | null
  bytes: number | null
}

export const DRIVER_PROBE_SCRIPT = String.raw`$o = [ordered]@{ packages = @(); svcRefs = @(); error = $null }
try {
  $repo = Join-Path $env:windir 'System32\DriverStore\FileRepository'
  $raw = & (Join-Path $env:windir 'System32\pnputil.exe') /enum-drivers /devices /format xml
  $xml = [xml]($raw -join [string][char]10)
  $refs = New-Object 'System.Collections.Generic.HashSet[string]'
  foreach ($k in @(Get-ChildItem 'HKLM:\SYSTEM\CurrentControlSet\Services' -ErrorAction SilentlyContinue)) {
    $ip = ''
    try { $ip = [string]$k.GetValue('ImagePath', $null, 'DoNotExpandEnvironmentNames') } catch { }
    if ($ip -match 'FileRepository\\([^\\]+)\\') { [void]$refs.Add($Matches[1].ToLower()) }
  }
  $o.svcRefs = @($refs)
  $pk = New-Object System.Collections.ArrayList
  foreach ($d in @($xml.PnpUtil.Driver)) {
    $devs = 0
    if ($d.Devices -and $d.Devices.Device) { $devs = @($d.Devices.Device).Count }
    [void]$pk.Add([pscustomobject]@{ inf = [string]$d.DriverName; orig = [string]$d.OriginalName; provider = [string]$d.ProviderName; cls = [string]$d.ClassName; guid = [string]$d.ClassGuid; ver = [string]$d.DriverVersion; devices = $devs; folder = $null; bytes = $null })
  }
  foreach ($g in @($pk | Group-Object { $_.orig.ToLower() } | Where-Object { $_.Count -gt 1 })) {
    $map = @{}
    foreach ($dir in @(Get-ChildItem -LiteralPath $repo -Directory -Filter ($g.Name + '_*') -ErrorAction SilentlyContinue)) {
      $key = $null
      try {
        $n = 0
        foreach ($line in [System.IO.File]::ReadLines((Join-Path $dir.FullName $g.Name))) {
          if ($line -match '^\s*DriverVer\s*=\s*"?\s*(\d{1,2})/(\d{1,2})/(\d{4})\s*,\s*([\d.]+)') { $key = ('{0:00}/{1:00}/{2} {3}' -f [int]$Matches[1], [int]$Matches[2], $Matches[3], $Matches[4]); break }
          $n++
          if ($n -gt 400) { break }
        }
      } catch { }
      if ($key) { if ($map.ContainsKey($key)) { $map[$key] = '*' } else { $map[$key] = $dir.Name } }
    }
    foreach ($p in $g.Group) {
      $f = $map[[string]$p.ver]
      if ($f -and $f -ne '*') {
        $p.folder = $f
        try { $p.bytes = [double]((Get-ChildItem -LiteralPath (Join-Path $repo $f) -Recurse -File -Force -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum) } catch { }
      }
    }
  }
  $o.packages = @($pk)
} catch { $o.error = $_.Exception.Message }
ConvertTo-Json -InputObject $o -Depth 5 -Compress`

export async function probeDriverStore(): Promise<{ packages: DriverPkg[]; svcRefs: Set<string>; error?: string }> {
  try {
    const r = await runPowerShellJson<{ packages: DriverPkg[] | DriverPkg; svcRefs: string[] | string; error: string | null }>(DRIVER_PROBE_SCRIPT, { timeoutMs: 90_000 })
    const packages = (Array.isArray(r.packages) ? r.packages : r.packages ? [r.packages] : []).map((p) => ({
      inf: String(p.inf ?? ''),
      orig: String(p.orig ?? ''),
      provider: String(p.provider ?? ''),
      cls: String(p.cls ?? ''),
      guid: String(p.guid ?? ''),
      ver: String(p.ver ?? ''),
      devices: Number(p.devices) || 0,
      folder: typeof p.folder === 'string' && p.folder ? p.folder : null,
      bytes: typeof p.bytes === 'number' ? p.bytes : null
    }))
    const refs = Array.isArray(r.svcRefs) ? r.svcRefs : r.svcRefs ? [r.svcRefs] : []
    return { packages, svcRefs: new Set(refs.map((x) => String(x).toLowerCase())), error: r.error ?? undefined }
  } catch (e) {
    return { packages: [], svcRefs: new Set(), error: (e as Error).message }
  }
}

function parseDriverVersion(v: string): { nums: number[]; date: number } {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+([\d.]+)/.exec(v.trim())
  if (!m) return { nums: [], date: 0 }
  return { nums: m[4].split('.').map((x) => Number(x) || 0), date: Date.UTC(Number(m[3]), Number(m[1]) - 1, Number(m[2])) }
}

/** >0 se a é mais nova que b. */
export function compareDriverVersions(a: string, b: string): number {
  const va = parseDriverVersion(a)
  const vb = parseDriverVersion(b)
  for (let i = 0; i < Math.max(va.nums.length, vb.nums.length); i++) {
    const d = (va.nums[i] ?? 0) - (vb.nums[i] ?? 0)
    if (d !== 0) return d
  }
  return va.date - vb.date
}

const DISPLAY_GUID = '{4d36e968-e325-11ce-bfc1-08002be10318}'

/** Pacote de vídeo (classe Display) ou complemento NVIDIA/AMD (áudio HD, componentes). */
export function isGpuPackage(p: DriverPkg): boolean {
  if (p.guid.toLowerCase() === DISPLAY_GUID || /^display$/i.test(p.cls)) return true
  return /nvidia|advanced micro devices|\bamd\b/i.test(p.provider) && /^(media|softwarecomponent|extension)$/i.test(p.cls)
}

/**
 * Versões ANTIGAS que ninguém usa: o mesmo driver (nome original) tem uma versão mais nova; esta não está instalada em
 * nenhum dispositivo; nenhum serviço do Windows roda a partir da pasta dela; e a pasta foi identificada. Única versão
 * de um driver nunca entra (pode ser necessária para um dispositivo que for conectado depois).
 */
export function oldDriverCandidates(packages: DriverPkg[], svcRefs: Set<string>): { pkg: DriverPkg; newest: DriverPkg }[] {
  const groups = new Map<string, DriverPkg[]>()
  for (const p of packages) {
    if (!p.orig) continue
    const k = p.orig.toLowerCase()
    groups.set(k, [...(groups.get(k) ?? []), p])
  }
  const out: { pkg: DriverPkg; newest: DriverPkg }[] = []
  for (const list of groups.values()) {
    if (list.length < 2) continue
    const newest = list.reduce((a, b) => (compareDriverVersions(b.ver, a.ver) > 0 ? b : a))
    for (const p of list) {
      if (p === newest || p.devices > 0) continue
      if (!/^oem\d+\.inf$/i.test(p.inf)) continue
      if (!p.folder || !/^[\w.\-]+$/.test(p.folder) || svcRefs.has(p.folder.toLowerCase())) continue
      if (compareDriverVersions(p.ver, newest.ver) >= 0) continue
      if (!(p.bytes && p.bytes > 0)) continue
      out.push({ pkg: p, newest })
    }
  }
  return out
}

export function driverRepoFolder(folder: string): string {
  return path.join(known.windir, 'System32', 'DriverStore', 'FileRepository', folder)
}

// ---------------------------------------------------------------------------------------------
// Docker (comando oficial do próprio Docker)
// ---------------------------------------------------------------------------------------------

/** "1.234GB" / "512.5MB" / "0B" (unidades decimais do Docker) -> bytes */
export function parseDockerSize(s: string): number {
  const m = /^\s*([\d.]+)\s*([kKMGTP]?)(i?)B\s*$/.exec(s ?? '')
  if (!m) return 0
  const base = m[3] ? 1024 : 1000
  const pow = { '': 0, k: 1, K: 1, M: 2, G: 3, T: 4, P: 5 }[m[2]] ?? 0
  return Math.round(Number(m[1]) * base ** pow)
}

function execText(file: string, args: string[], timeoutMs: number): Promise<{ ok: boolean; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: timeoutMs, maxBuffer: 8 * MB }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: String(stdout ?? ''), err: String(stderr ?? (err as Error | null)?.message ?? '') })
    })
  })
}

/** Cache de build do Docker (bytes), ou null se o Docker não estiver aberto. */
export async function dockerBuildCacheBytes(cli: string): Promise<number | null> {
  const r = await execText(cli, ['system', 'df', '--format', '{{json .}}'], 20_000)
  if (!r.ok) return null
  for (const line of r.out.split(/\r?\n/)) {
    try {
      const j = JSON.parse(line) as { Type?: string; Size?: string }
      if (/build cache/i.test(j.Type ?? '')) return parseDockerSize(j.Size ?? '')
    } catch {
      // linha não-JSON
    }
  }
  return 0
}

/** Executa o comando OFICIAL do Docker que apaga só o cache de build. Devolve os bytes informados pelo Docker. */
export async function dockerBuilderPrune(cli: string): Promise<{ ok: boolean; bytes: number; error?: string }> {
  const r = await execText(cli, ['builder', 'prune', '-f'], 15 * 60_000)
  if (!r.ok) return { ok: false, bytes: 0, error: r.err.trim().split(/\r?\n/)[0] || 'o Docker não respondeu (está aberto?)' }
  const m = /Total(?:\s+reclaimed\s+space)?:\s*([\d.]+\s*[kKMGTP]?i?B)/i.exec(r.out)
  return { ok: true, bytes: m ? parseDockerSize(m[1]) : 0 }
}

export async function findDockerCli(): Promise<string | null> {
  const candidates = [path.join(known.programFiles, 'Docker', 'Docker', 'resources', 'bin', 'docker.exe')]
  for (const c of candidates) if (fs.existsSync(c)) return c
  return (await systemProbe()).dockerCli
}

// ---------------------------------------------------------------------------------------------
// Catálogo da Busca extrema
// ---------------------------------------------------------------------------------------------

const SLOW_NOTE = 'Comando oficial do Windows: pode levar de 5 a 30 minutos e usar bastante o disco. Não desligue o PC no meio.'
/** Nome dos vídeos do NVIDIA ShadowPlay/App: "Jogo 2025.03.28 - 23.30.38.02[.Tag].DVR.mp4" */
const SHADOWPLAY_NAME = /\s\d{4}\.\d{2}\.\d{2} - \d{2}\.\d{2}\.\d{2}\.\d{2,3}(?:\.[^\\/]*)?\.mp4$/i
const ROOT_SKIP = /^(\$.*|system volume information|windows|windows\.old|program files.*|programdata|users|recovery|boot|efi|perflogs|steamlibrary|xboxgames)$/i

/** Monta os alvos da Busca extrema (os caminhos já existem; o tamanho é medido em estimate.ts). */
export async function buildExtremeSpecs(warnings: string[]): Promise<TargetSpec[]> {
  const local = known.localAppData
  const roaming = known.appData
  const home = os.homedir()
  const localLow = path.join(home, 'AppData', 'LocalLow')
  const sys = known.systemDrive.replace(/\\$/, '')
  const windir = known.windir
  const programData = known.programData
  const probeP = systemProbe()
  const specs: TargetSpec[] = []
  const base = { requiresAdmin: false, extreme: true as const }

  // ===== Limpeza de Disco do Windows (cleanmgr /sagerun, só as categorias escolhidas) =====
  const cm = (id: string, title: string, description: string, paths: string[], extra: Partial<TargetSpec>): void => {
    specs.push({
      id,
      kind: 'windowsComponents',
      title,
      description,
      paths,
      requiresAdmin: true,
      verdict: 'review',
      risk: 'low',
      method: 'command',
      measure: 'custom',
      extreme: true,
      pathsInfoOnly: true,
      ...extra
    })
  }
  const walkInfo = (paths: string[], budget = 30_000) => async (ctx: MeasureCtx): Promise<Measured> => {
    if (paths.length === 0) return { bytes: 0, files: 0, drop: true }
    const m = await ctx.measurePaths({ paths, infoOnly: true, timeBudgetMs: budget })
    return { ...m, sizeUnknown: m.sizeUnknown || (m.bytes === 0 && m.approximate) || undefined }
  }

  const winOld = existing([path.join(`${sys}\\`, 'Windows.old')])
  if (winOld.length) {
    cm(
      'extreme-cleanmgr-previous',
      'Instalação anterior do Windows (Windows.old)',
      'Cópia do Windows antigo guardada depois de uma atualização grande, para você poder voltar atrás. Costuma ter de 10 a 30 GB. A remoção é feita pela própria Limpeza de Disco do Windows (o app não apaga essa pasta por conta própria).',
      winOld,
      { risk: 'medium', note: 'Depois disso não dá mais para voltar para a versão anterior do Windows.', measureFn: walkInfo(winOld, 20_000) }
    )
  }
  const setupDirs = existing([path.join(`${sys}\\`, '$WINDOWS.~BT'), path.join(`${sys}\\`, '$WINDOWS.~WS'), path.join(`${sys}\\`, '$GetCurrent')])
  if (setupDirs.length) {
    cm(
      'extreme-cleanmgr-setup',
      'Arquivos temporários de instalação do Windows',
      'Pastas que o instalador de atualizações grandes do Windows ($WINDOWS.~BT / ~WS) deixa para trás. Se nenhuma atualização grande estiver em andamento, não servem para mais nada.',
      setupDirs,
      { note: 'Se o Windows estiver no meio de uma atualização grande, ele baixa esses arquivos de novo.', measureFn: walkInfo(setupDirs) }
    )
  }
  cm(
    'extreme-cleanmgr-updates',
    'Limpeza de atualizações do Windows',
    'Versões antigas de arquivos do sistema que o Windows guarda depois de cada atualização (pasta WinSxS). A Limpeza de Disco oficial remove só as que foram substituídas por versões mais novas.',
    [],
    {
      note: `Depois disso, algumas atualizações antigas não poderão mais ser desinstaladas. O tamanho só é calculado pelo próprio Windows na hora. ${SLOW_NOTE}`,
      measureFn: async () => ({ bytes: 0, files: 0, sizeUnknown: true })
    }
  )
  const esd = existing([path.join(`${sys}\\`, 'ESD', 'Windows'), path.join(`${sys}\\`, 'ESD')]).slice(0, 1)
  if (esd.length) {
    cm(
      'extreme-cleanmgr-esd',
      'Arquivos de instalação do Windows (ESD)',
      'Imagem do Windows guardada no disco para o "Restaurar o PC" funcionar sem internet.',
      esd,
      { risk: 'medium', note: 'Sem eles, "Restaurar o PC" baixa o Windows da nuvem (precisa de internet).', measureFn: walkInfo(esd) }
    )
  }
  const upgradeLogs = existing([path.join(windir, 'Panther'), path.join(`${sys}\\`, '$WINDOWS.~BT', 'Sources', 'Panther'), path.join(`${sys}\\`, '$WINDOWS.~BT', 'Sources', 'Rollback')])
  if (upgradeLogs.length) {
    cm(
      'extreme-cleanmgr-upgradelogs',
      'Registros de atualização do Windows',
      'Arquivos de log que o Windows grava ao instalar atualizações grandes. Só servem para investigar uma atualização que deu errado.',
      upgradeLogs,
      { verdict: 'safe', measureFn: walkInfo(upgradeLogs, 15_000) }
    )
  }
  // DriverStore: uma única leitura (pnputil) alimenta os dois itens (vídeo NVIDIA/AMD pelo pnputil; o resto pela Limpeza de Disco).
  let driverInfo: Promise<{ gpu: { pkg: DriverPkg; newest: DriverPkg }[]; other: { pkg: DriverPkg; newest: DriverPkg }[]; error?: string }> | null = null
  const drivers = () =>
    (driverInfo ??= probeDriverStore().then((r) => {
      const all = oldDriverCandidates(r.packages, r.svcRefs)
      return { gpu: all.filter((c) => isGpuPackage(c.pkg)), other: all.filter((c) => !isGpuPackage(c.pkg)), error: r.error }
    }))
  const driverBreakdown = (list: { pkg: DriverPkg; newest: DriverPkg }[]): NonNullable<CleanupTarget['breakdown']> =>
    list
      .sort((a, b) => (b.pkg.bytes ?? 0) - (a.pkg.bytes ?? 0))
      .map((c) => ({ label: `${c.pkg.provider || c.pkg.orig} ${c.pkg.ver.split(' ')[1] ?? c.pkg.ver} (${c.pkg.inf}; em uso: ${c.newest.ver.split(' ')[1] ?? c.newest.ver})`, bytes: c.pkg.bytes ?? 0, key: c.pkg.inf.toLowerCase() }))
  cm(
    'extreme-cleanmgr-drivers',
    'Pacotes de drivers antigos (outros dispositivos)',
    'Versões antigas de drivers de chipset, áudio, rede, controles e outros que o Windows guarda depois de instalar versões novas. A Limpeza de Disco oficial remove só as que nenhum dispositivo usa e mantém sempre a versão mais nova.',
    [],
    {
      note: 'Depois disso não dá para "Reverter driver" para essas versões. Se marcar só este item, a Limpeza de Disco também remove as versões antigas de vídeo.',
      measureFn: async () => {
        const d = await drivers()
        if (d.error && d.other.length === 0) return { bytes: 0, files: 0, sizeUnknown: true, note: `Não foi possível listar os drivers (${d.error}).` }
        if (d.other.length === 0) return { bytes: 0, files: 0, drop: true }
        return { bytes: sumBytes(d.other.map((c) => ({ bytes: c.pkg.bytes ?? 0 }))), files: d.other.length, breakdown: driverBreakdown(d.other), paths: d.other.map((c) => driverRepoFolder(c.pkg.folder!)) }
      }
    }
  )
  cm(
    'extreme-cleanmgr-delivery',
    'Arquivos da Otimização de Entrega (Limpeza de Disco)',
    'Cópias de atualizações que o Windows guarda para compartilhar com outros PCs. Removidas pela Limpeza de Disco oficial.',
    [],
    { verdict: 'safe', measureFn: async () => ({ bytes: 0, files: 0, sizeUnknown: true }) }
  )

  // ===== DISM (componentes do Windows) =====
  specs.push({
    id: DISM_COMPONENT_ID,
    kind: 'windowsComponents',
    title: 'Limpeza de componentes do Windows (DISM)',
    description:
      'Comando oficial "DISM /StartComponentCleanup": remove versões substituídas de componentes do sistema. É a mesma manutenção que o Windows faz sozinho de tempos em tempos; as atualizações instaladas continuam podendo ser desinstaladas.',
    paths: [],
    requiresAdmin: true,
    verdict: 'safe',
    risk: 'low',
    method: 'command',
    measure: 'custom',
    extreme: true,
    pathsInfoOnly: true,
    note: `Faz o mesmo tipo de limpeza que "Limpeza de atualizações do Windows": não precisa marcar os dois. ${SLOW_NOTE}`,
    measureFn: async () => ({ bytes: 0, files: 0, sizeUnknown: true })
  })
  specs.push({
    id: DISM_RESETBASE_ID,
    kind: 'windowsComponents',
    title: 'Limpeza profunda de componentes (DISM /ResetBase)',
    description:
      'Versão mais forte do item acima ("DISM /StartComponentCleanup /ResetBase"): libera um pouco mais de espaço, mas TODAS as atualizações já instaladas deixam de poder ser desinstaladas.',
    paths: [],
    requiresAdmin: true,
    verdict: 'review',
    risk: 'medium',
    method: 'command',
    measure: 'custom',
    extreme: true,
    pathsInfoOnly: true,
    note: 'Só use se o Windows está estável há algumas semanas: se uma atualização der problema, não será possível removê-la.',
    measureFn: async () => ({ bytes: 0, files: 0, sizeUnknown: true })
  })

  // ===== DriverStore: versões antigas de vídeo NVIDIA/AMD (pnputil /delete-driver, sem /force) =====
  specs.push({
    id: DRIVERSTORE_ID,
    kind: 'driverStore',
    title: 'Versões antigas do driver de vídeo (NVIDIA / AMD)',
    description:
      'Cada vez que você atualiza o driver da placa de vídeo, o Windows guarda a versão anterior inteira (às vezes mais de 1 GB cada). Remove só versões antigas que nenhum dispositivo usa, com o comando oficial "pnputil /delete-driver" SEM forçar: se o Windows disser que o driver está em uso, ele fica.',
    paths: [],
    requiresAdmin: true,
    verdict: 'review',
    risk: 'low',
    method: 'command',
    measure: 'custom',
    extreme: true,
    pathsInfoOnly: true,
    note: 'Depois disso não dá para "Reverter driver" para essas versões. O driver em uso não é tocado.',
    measureFn: async () => {
      const d = await drivers()
      if (d.error && d.gpu.length === 0) return { bytes: 0, files: 0, sizeUnknown: true, note: `Não foi possível listar os drivers (${d.error}).` }
      return { bytes: sumBytes(d.gpu.map((c) => ({ bytes: c.pkg.bytes ?? 0 }))), files: d.gpu.length, breakdown: driverBreakdown(d.gpu), paths: d.gpu.map((c) => driverRepoFolder(c.pkg.folder!)) }
    }
  })

  // ===== Itens manuais (só informam e levam ao lugar certo) =====
  const probe = await probeP
  specs.push({
    id: 'extreme-restore-points',
    kind: 'windowsComponents',
    title: 'Pontos de restauração do sistema',
    description:
      'Cópias do sistema que o Windows cria antes de atualizações e instalações, para voltar atrás se algo der errado. Podem ocupar vários GB. Quem decide quanto espaço usar é você, na tela "Proteção do Sistema".',
    paths: [],
    requiresAdmin: true,
    verdict: 'review',
    risk: 'medium',
    method: 'command',
    measure: 'custom',
    extreme: true,
    pathsInfoOnly: true,
    manual: {
      label: 'Abrir Proteção do Sistema',
      url: 'ms-settings:about',
      special: 'systemProtection',
      steps: [
        'Na janela "Proteção do Sistema", selecione o disco C: e clique em "Configurar...".',
        'Diminua o "Uso máximo" (ex.: 5%) ou clique em "Excluir" para apagar os pontos antigos.',
        'Recomendado manter a proteção ligada: ela salva o PC depois de um driver ou atualização ruim.'
      ]
    },
    measureFn: async () => (probe.restore !== null ? { bytes: probe.restore, files: 0 } : { bytes: 0, files: 0, sizeUnknown: true })
  })
  if (probe.hiber && probe.hiber > 0) {
    specs.push({
      id: 'extreme-hibernation',
      kind: 'windowsComponents',
      title: 'Arquivo de hibernação (hiberfil.sys)',
      description:
        'O Windows reserva no disco C: um arquivo do tamanho de boa parte da sua memória RAM para a hibernação e a "Inicialização rápida". Se você só desliga ou usa Suspender, dá para desligar a hibernação e recuperar esse espaço na hora.',
      paths: [`${sys}\\hiberfil.sys`],
      requiresAdmin: true,
      verdict: 'review',
      risk: 'low',
      method: 'command',
      measure: 'custom',
      extreme: true,
      pathsInfoOnly: true,
      manual: {
        label: 'Abrir Desempenho',
        url: 'ms-settings:powersleep',
        page: 'performance',
        steps: ['Na página Desempenho, desligue a hibernação.', 'O arquivo some na hora. Você perde a opção "Hibernar" e a "Inicialização rápida" (o PC pode ligar alguns segundos mais devagar).']
      },
      measureFn: async () => ({ bytes: probe.hiber ?? 0, files: 1 })
    })
  }
  specs.push({
    id: 'extreme-search-index',
    kind: 'windowsComponents',
    title: 'Índice de pesquisa do Windows',
    description:
      'Banco de dados que o Windows monta para a pesquisa do Menu Iniciar achar arquivos rápido. Normalmente é pequeno; se passar de alguns GB, recriar o índice ou indexar menos pastas resolve.',
    paths: [],
    requiresAdmin: true,
    verdict: 'review',
    risk: 'low',
    method: 'command',
    measure: 'custom',
    extreme: true,
    pathsInfoOnly: true,
    manual: {
      label: 'Abrir configurações de pesquisa',
      url: 'ms-settings:cortana-windowssearch',
      steps: [
        'Em "Pesquisar no Windows", abra "Opções avançadas do indexador".',
        'Clique em "Avançado" > "Recriar" (a pesquisa fica mais lenta por algumas horas), ou em "Modificar" para indexar menos pastas.'
      ]
    },
    measureFn: async () => (probe.index !== null ? { bytes: probe.index, files: 1 } : { bytes: 0, files: 0, sizeUnknown: true })
  })

  // Discos virtuais grandes (só orientação: compactar/remover pelo próprio programa)
  const vdisk = (id: string, title: string, description: string, bases: { dir: string; depth: number }[], manual: NonNullable<TargetSpec['manual']>, exclude?: (p: string) => boolean): void => {
    const roots = bases.filter((b) => isDir(b.dir))
    if (roots.length === 0) return
    specs.push({
      id,
      kind: 'virtualDisk',
      title,
      description,
      paths: roots.map((b) => b.dir),
      requiresAdmin: false,
      verdict: 'review',
      risk: 'medium',
      method: 'command',
      measure: 'custom',
      extreme: true,
      pathsInfoOnly: true,
      manual,
      measureFn: async () => {
        const deadline = Date.now() + 15_000
        const found: FoundFile[] = []
        for (const b of roots) await findFiles(b.dir, { maxDepth: b.depth, match: (n) => /\.(vhdx?|avhdx|vdi|vmdk|qcow2|img)$/i.test(n), minBytes: 100 * MB, deadline }, found)
        const list = exclude ? found.filter((f) => !exclude(f.path)) : found
        const bytes = sumBytes(list)
        if (bytes < GB) return { bytes: 0, files: 0, drop: true }
        return { bytes, files: list.length, sampleFiles: topSamples(list, 10), paths: [...new Set(list.map((f) => path.dirname(f.path)))].slice(0, 20) }
      }
    })
  }
  vdisk(
    'extreme-vdisk-docker',
    'Disco virtual do Docker Desktop',
    'O Docker guarda imagens, contêineres e volumes num disco virtual (.vhdx) que cresce e não diminui sozinho.',
    [{ dir: path.join(local, 'Docker', 'wsl'), depth: 3 }],
    {
      label: 'Como liberar no Docker',
      url: 'https://docs.docker.com/desktop/troubleshoot-and-support/troubleshoot/',
      steps: [
        'Abra o Docker Desktop e apague imagens, contêineres e volumes que você não usa (ou rode "docker system prune" no terminal).',
        'Depois, em Troubleshoot, use "Clean / Purge data" se quiser zerar tudo.',
        'Não apague o arquivo .vhdx à mão: o Docker deixa de funcionar.'
      ]
    }
  )
  const wslBases = probe.wsl
    .filter((w) => !/^docker-desktop/i.test(w.name))
    .map((w) => ({ dir: w.base.replace(/^\\\\\?\\/, ''), depth: 0 }))
  vdisk(
    'extreme-vdisk-wsl',
    `Disco virtual do Linux (WSL)${probe.wsl.length ? `: ${probe.wsl.filter((w) => !/^docker-desktop/i.test(w.name)).map((w) => w.name).join(', ')}` : ''}`,
    'Cada distribuição Linux do WSL vive num disco virtual (ext4.vhdx) que cresce quando você baixa coisas no Linux e não devolve o espaço sozinho.',
    wslBases,
    {
      label: 'Como liberar no WSL',
      url: 'https://learn.microsoft.com/windows/wsl/disk-space',
      steps: [
        'Apague dentro do Linux o que não usa e, no PowerShell, rode "wsl --shutdown".',
        'Para o disco devolver o espaço sozinho: "wsl --manage <nome> --set-sparse true".',
        'Distribuição que não usa mais: "wsl --unregister <nome>" (apaga tudo dela, sem volta).'
      ]
    }
  )
  vdisk(
    'extreme-vdisk-bluestacks',
    'Discos do BlueStacks (emulador Android)',
    'Cada instância do BlueStacks é um disco virtual com os apps e jogos Android instalados nela.',
    [
      { dir: path.join(programData, 'BlueStacks_nxt', 'Engine'), depth: 2 },
      { dir: path.join(programData, 'BlueStacks', 'Engine'), depth: 2 }
    ],
    {
      label: 'Abrir Jogos & Programas',
      url: 'ms-settings:appsfeatures',
      page: 'apps',
      steps: [
        'No BlueStacks, abra o "Gerenciador de instâncias" e apague as instâncias que não usa.',
        'Nas configurações do BlueStacks, use "Liberar espaço em disco" para compactar.',
        'Se não usa mais o BlueStacks, desinstale pela página Jogos & Programas.'
      ]
    }
  )
  vdisk(
    'extreme-vdisk-emulators',
    'Emuladores Android (Android Studio, LDPlayer, MEmu, Nox)',
    'Emuladores guardam cada "celular virtual" num disco próprio, que pode passar de 10 GB.',
    [
      { dir: path.join(home, '.android', 'avd'), depth: 2 },
      { dir: path.join(`${sys}\\`, 'LDPlayer'), depth: 3 },
      { dir: path.join(known.programFiles, 'Microvirt', 'MEmu', 'MemuHyperv VMs'), depth: 2 },
      { dir: path.join(known.programFilesX86, 'Nox', 'bin', 'BignoxVMS'), depth: 2 },
      { dir: path.join(known.programFiles, 'Nox', 'bin', 'BignoxVMS'), depth: 2 }
    ],
    {
      label: 'Abrir Jogos & Programas',
      url: 'ms-settings:appsfeatures',
      page: 'apps',
      steps: ['No próprio emulador (Device Manager / Multi-instância), apague os aparelhos virtuais que não usa.', 'Se não usa mais o emulador, desinstale pela página Jogos & Programas.']
    }
  )
  vdisk(
    'extreme-vdisk-vms',
    'Máquinas virtuais (VirtualBox, Hyper-V, VMware)',
    'Discos de máquinas virtuais costumam ser os maiores arquivos do PC.',
    [
      { dir: path.join(home, 'VirtualBox VMs'), depth: 2 },
      { dir: path.join(programData, 'Microsoft', 'Windows', 'Virtual Hard Disks'), depth: 1 },
      { dir: path.join(home, 'Documents', 'Virtual Machines'), depth: 2 }
    ],
    {
      label: 'Como liberar',
      url: 'https://learn.microsoft.com/windows-server/virtualization/hyper-v/manage/manage-hyper-v-virtual-hard-disks',
      steps: [
        'Apague pelo próprio programa (VirtualBox: Remover > "Apagar todos os arquivos"; Hyper-V: excluir a VM e o disco) as máquinas que não usa.',
        'Para compactar: VirtualBox "VBoxManage modifymedium --compact"; Hyper-V "Editar disco > Compactar".'
      ]
    }
  )

  // ===== Caches pesados de programas (motor seguro, só pastas de cache) =====
  const cache = (s: Omit<TargetSpec, 'requiresAdmin' | 'method' | 'measure' | 'extreme'> & { requiresAdmin?: boolean }): void => {
    if (s.paths.length === 0) return
    specs.push({ ...base, method: 'deleteContents', measure: 'walk', timeBudgetMs: 45_000, ...s })
  }
  const capcutCache = path.join(local, 'CapCut', 'User Data', 'Cache')
  cache({
    id: 'extreme-capcut',
    kind: 'mediaCache',
    title: 'Cache do CapCut',
    description:
      'Efeitos, músicas, miniaturas e análises de vídeo que o CapCut baixa e guarda para editar mais rápido. Seus projetos (pasta Projects) e rascunhos NÃO são tocados; o CapCut baixa de novo o que precisar.',
    paths: existing(listDirs(capcutCache).filter((d) => !/draft|project|template|export/i.test(d)).map((d) => path.join(capcutCache, d))),
    verdict: 'safe',
    risk: 'low',
    requiresClosed: ['capcut.exe'],
    note: 'Feche o CapCut antes de limpar.'
  })
  cache({
    id: 'extreme-adobe-media-cache',
    kind: 'mediaCache',
    title: 'Cache de mídia da Adobe (Premiere, After Effects, Media Encoder)',
    description:
      'Arquivos de pré-visualização e de áudio (Media Cache / Peak Files) que os programas da Adobe criam para cada vídeo importado. A própria Adobe recomenda limpar de vez em quando: são recriados ao abrir os projetos.',
    paths: existing([path.join(roaming, 'Adobe', 'Common', 'Media Cache Files'), path.join(roaming, 'Adobe', 'Common', 'Media Cache'), path.join(roaming, 'Adobe', 'Common', 'Peak Files')]),
    verdict: 'safe',
    risk: 'low',
    requiresClosed: ['adobe premiere pro.exe', 'afterfx.exe', 'adobe media encoder.exe', 'audition.exe'],
    note: 'Feche os programas da Adobe. Ao reabrir um projeto, ele demora um pouco mais enquanto refaz o cache.'
  })
  const aeRoot = path.join(local, 'Adobe', 'After Effects')
  cache({
    id: 'extreme-ae-disk-cache',
    kind: 'mediaCache',
    title: 'Cache de disco do After Effects',
    description: 'Quadros já renderizados que o After Effects guarda para tocar a prévia mais rápido. São recriados quando necessário.',
    paths: existing(listDirs(aeRoot).flatMap((v) => listDirs(path.join(aeRoot, v)).filter((d) => /disk cache/i.test(d)).map((d) => path.join(aeRoot, v, d)))),
    verdict: 'safe',
    risk: 'low',
    requiresClosed: ['afterfx.exe']
  })
  cache({
    id: 'extreme-davinci-cacheclip',
    kind: 'mediaCache',
    title: 'Cache de renderização do DaVinci Resolve (CacheClip)',
    description: 'Clipes de cache que o DaVinci Resolve gera para tocar a timeline sem travar. São recriados quando você abre o projeto.',
    paths: existing([path.join(roaming, 'Blackmagic Design', 'DaVinci Resolve', 'Support', 'CacheClip'), path.join(videosDir(), 'CacheClip')]),
    verdict: 'safe',
    risk: 'low',
    requiresClosed: ['resolve.exe']
  })
  cache({
    id: 'extreme-unity-cache',
    kind: 'devCache',
    title: 'Cache do Unity',
    description: 'Pacotes e dados de iluminação (GI) baixados/gerados pelo Unity. Seus projetos não são tocados; o Unity baixa/gera de novo (a primeira abertura fica mais lenta).',
    paths: existing([path.join(local, 'Unity', 'cache'), path.join(localLow, 'Unity', 'Caches')]),
    verdict: 'review',
    risk: 'low',
    requiresClosed: ['unity.exe', 'unity hub.exe']
  })
  const ue = path.join(local, 'UnrealEngine')
  cache({
    id: 'extreme-unreal-ddc',
    kind: 'devCache',
    title: 'Cache de dados derivados do Unreal Engine (DDC)',
    description: 'Shaders e assets já processados que o Unreal Engine guarda. São recriados ao abrir os projetos (a primeira abertura fica bem mais lenta).',
    paths: existing([path.join(ue, 'Common', 'DerivedDataCache'), ...listDirs(ue).map((v) => path.join(ue, v, 'DerivedDataCache'))]),
    verdict: 'review',
    risk: 'low',
    requiresClosed: ['unrealeditor.exe', 'ue4editor.exe']
  })
  const jb = path.join(local, 'JetBrains')
  const studio = path.join(local, 'Google')
  cache({
    id: 'extreme-jetbrains',
    kind: 'devCache',
    title: 'Caches e índices das IDEs JetBrains / Android Studio',
    description: 'Índices e caches que IntelliJ, PyCharm, Rider, Android Studio etc. montam dos seus projetos. Configurações, plugins e histórico local NÃO são tocados; a IDE reindexa ao abrir.',
    paths: existing([
      ...listDirs(jb).flatMap((p) => ['caches', 'index', 'log', 'tmp'].map((s) => path.join(jb, p, s))),
      ...listDirs(studio)
        .filter((d) => /^AndroidStudio/i.test(d))
        .flatMap((p) => ['caches', 'index', 'log', 'tmp'].map((s) => path.join(studio, p, s)))
    ]),
    verdict: 'review',
    risk: 'low',
    requiresClosed: ['idea64.exe', 'pycharm64.exe', 'webstorm64.exe', 'rider64.exe', 'clion64.exe', 'goland64.exe', 'phpstorm64.exe', 'datagrip64.exe', 'rubymine64.exe', 'studio64.exe']
  })
  cache({
    id: 'extreme-gradle',
    kind: 'devCache',
    title: 'Cache do Gradle (Android / Java)',
    description: 'Bibliotecas e versões do Gradle baixadas pelos seus projetos Java/Android. Os projetos baixam tudo de novo no próximo build (mais lento e gasta internet).',
    paths: existing([path.join(home, '.gradle', 'caches'), path.join(home, '.gradle', 'wrapper', 'dists')]),
    verdict: 'review',
    risk: 'low',
    requiresClosed: ['studio64.exe', 'idea64.exe']
  })
  cache({
    id: 'extreme-conda',
    kind: 'devCache',
    title: 'Pacotes baixados do Conda (Python)',
    description: 'Arquivos compactados (.tar.bz2/.conda) que o Conda baixou para instalar pacotes. Os ambientes já instalados não dependem deles (é o mesmo que "conda clean --tarballs").',
    paths: existing([path.join(home, 'anaconda3', 'pkgs'), path.join(home, 'miniconda3', 'pkgs'), path.join(home, '.conda', 'pkgs')]),
    include: ['*.tar.bz2', '*.conda'],
    maxDepth: 0,
    verdict: 'safe',
    risk: 'low'
  })
  cache({
    id: 'extreme-js-stores',
    kind: 'devCache',
    title: 'Caches do pnpm e do Yarn (Node.js)',
    description: 'Pacotes baixados por pnpm/Yarn Berry. Projetos já instalados continuam funcionando; no próximo "install" os pacotes são baixados de novo.',
    paths: existing([path.join(local, 'pnpm', 'store'), path.join(local, 'pnpm-cache'), path.join(local, 'Yarn', 'Berry', 'cache')]),
    verdict: 'review',
    risk: 'low'
  })
  cache({
    id: 'extreme-huggingface',
    kind: 'devCache',
    title: 'Modelos de IA baixados (Hugging Face)',
    description: 'Modelos de inteligência artificial que programas Python/IA baixaram. Cada um pode ter vários GB e terá de ser baixado de novo se você usar outra vez.',
    paths: existing([path.join(home, '.cache', 'huggingface', 'hub')]),
    verdict: 'review',
    risk: 'medium',
    note: 'Confira antes: se você usa esses modelos, apagar significa baixar tudo de novo.'
  })

  // Docker: cache de build (comando oficial "docker builder prune")
  const dockerCli = fs.existsSync(path.join(known.programFiles, 'Docker', 'Docker', 'resources', 'bin', 'docker.exe'))
    ? path.join(known.programFiles, 'Docker', 'Docker', 'resources', 'bin', 'docker.exe')
    : probe.dockerCli
  if (dockerCli) {
    specs.push({
      id: DOCKER_ID,
      kind: 'devCache',
      title: 'Cache de build do Docker',
      description: 'Camadas intermediárias que o Docker guarda para montar imagens mais rápido. Removidas pelo comando oficial "docker builder prune" (imagens, contêineres e volumes NÃO são tocados).',
      paths: [],
      ...base,
      verdict: 'review',
      risk: 'low',
      method: 'command',
      measure: 'custom',
      pathsInfoOnly: true,
      note: 'O próximo build de imagens fica mais lento. O Docker Desktop precisa estar aberto.',
      measureFn: async () => {
        const b = await dockerBuildCacheBytes(dockerCli)
        if (b === null) {
          warnings.push('Busca extrema: o Docker está instalado mas fechado; abra o Docker Desktop e analise de novo para medir o cache de build.')
          return { bytes: 0, files: 0, drop: true }
        }
        return { bytes: b, files: 0 }
      }
    })
  }

  // Downloads incompletos/temporários de launchers
  const launcherDirs: string[] = []
  for (const lib of await steamLibraries()) launcherDirs.push(path.join(lib, 'steamapps', 'downloading'), path.join(lib, 'steamapps', 'temp'))
  launcherDirs.push(...epicStagingDirs())
  cache({
    id: 'extreme-launcher-downloads',
    kind: 'gameLauncherCache',
    title: 'Downloads incompletos e temporários de launchers (Steam / Epic)',
    description:
      'Pedaços de jogos e atualizações que a Steam (steamapps\\downloading e \\temp) e a Epic (pasta de preparação) baixaram e não terminaram de instalar. Se você não está baixando nada agora, não servem para nada.',
    paths: existing(launcherDirs),
    verdict: 'review',
    risk: 'low',
    requiresClosed: ['steam.exe', 'epicgameslauncher.exe'],
    note: 'Se algum jogo estiver no meio de um download/atualização, o launcher baixa essa parte de novo. Feche a Steam e a Epic antes.'
  })
  // Instaladores antigos de driver baixados pelo app da NVIDIA
  const nvDl = path.join(programData, 'NVIDIA Corporation', 'Downloader')
  cache({
    id: 'extreme-nvidia-downloader',
    kind: 'installerLeftovers',
    title: 'Instaladores antigos baixados pelo app da NVIDIA',
    description:
      'Cada atualização de driver pelo GeForce Experience / NVIDIA App deixa o instalador baixado (centenas de MB cada) em ProgramData. O driver instalado não depende deles; o app baixa de novo se precisar.',
    paths: existing(listDirs(nvDl).filter((d) => /^[0-9a-f]{32}$/i.test(d)).map((d) => path.join(nvDl, d))),
    requiresAdmin: true,
    verdict: 'safe',
    risk: 'low'
  })

  // Dumps grandes (.dmp) esquecidos em AppData
  specs.push({
    id: 'extreme-appdata-dumps',
    kind: 'crashDumps',
    title: 'Relatórios de travamento grandes (.dmp) em AppData',
    description:
      'Arquivos de "dump" que programas e jogos gravam na pasta AppData quando travam (cada um pode ter centenas de MB). Servem só para os desenvolvedores investigarem o travamento.',
    paths: [],
    ...base,
    verdict: 'safe',
    risk: 'low',
    method: 'deleteContents',
    measure: 'custom',
    measureFn: async () => {
      const deadline = Date.now() + 20_000
      const found: FoundFile[] = []
      const skip = (full: string, name: string): boolean =>
        /^(temp|crashdumps|packages|microsoft|google|mozilla|bravesoftware|opera software|discord|npm-cache|pip|nvidia)$/i.test(name) && path.win32.dirname(full).split('\\').length <= 6
      for (const b of [local, roaming, localLow]) await findFiles(b, { maxDepth: 6, match: (n) => /\.(dmp|mdmp|hdmp)$/i.test(n), minBytes: 20 * MB, deadline, skipDir: skip, limit: 500 }, found)
      // Mesmo guard da exclusão manual (arquivo de jogo/programa instalado, área protegida... ficam de fora).
      const okFiles = found.filter((f) => checkPath(f.path, 'userSelected').allowed)
      found.length = 0
      found.push(...okFiles)
      if (found.length === 0) return { bytes: 0, files: 0, drop: true }
      return { bytes: sumBytes(found), files: found.length, paths: found.map((f) => f.path), sampleFiles: topSamples(found) }
    }
  })

  // Gravações de jogos (NVIDIA ShadowPlay/App e Xbox Game Bar): dados do usuário -> Revisar, vão para a Lixeira
  specs.push({
    id: 'extreme-game-recordings',
    kind: 'gameRecordings',
    title: 'Gravações de jogos (NVIDIA e Xbox Game Bar)',
    description:
      'Vídeos gravados automaticamente pelo "Replay instantâneo"/"Destaques" da NVIDIA (arquivos .DVR.mp4) e pela Xbox Game Bar. Costumam se acumular sem você perceber. São SEUS vídeos: confira antes; eles vão para a Lixeira.',
    paths: [],
    ...base,
    verdict: 'review',
    risk: 'medium',
    method: 'deleteContents',
    measure: 'custom',
    recycle: true,
    measureFn: async () => {
      const deadline = Date.now() + 25_000
      const found: FoundFile[] = []
      const bases = new Set<string>()
      for (const sp of probe.shadowPlay) {
        const p = /^[A-Za-z]:$/.test(sp) ? `${sp}\\` : sp
        if (/^[A-Za-z]:\\/.test(p)) bases.add(p)
      }
      const videos = videosDir()
      bases.add(videos)
      for (const b of bases) {
        const isRoot = /^[A-Za-z]:\\$/.test(b)
        await findFiles(b, { maxDepth: 1, match: (n) => SHADOWPLAY_NAME.test(n), deadline, skipDir: (_f, n) => isRoot && ROOT_SKIP.test(n) }, found)
      }
      await findFiles(path.join(videos, 'Captures'), { maxDepth: 0, match: (n) => /\.mp4$/i.test(n), deadline }, found)
      const seen = new Set<string>()
      const list = found.filter((f) => {
        const k = f.path.toLowerCase()
        if (seen.has(k)) return false
        seen.add(k)
        // Mesmo guard da exclusão manual: vídeo dentro de jogo/programa instalado ou área protegida fica de fora.
        return checkPath(f.path, 'userSelected').allowed
      })
      if (list.length === 0) return { bytes: 0, files: 0, drop: true }
      // Por pasta (ex.: "E:\PLAYERUNKNOWN'S BATTLEGROUNDS")
      const byDir = new Map<string, FoundFile[]>()
      for (const f of list) byDir.set(path.dirname(f.path), [...(byDir.get(path.dirname(f.path)) ?? []), f])
      const breakdown = [...byDir.entries()].map(([d, fs]) => ({ label: d, bytes: sumBytes(fs), files: fs.length })).sort((a, b) => b.bytes - a.bytes)
      // A Lixeira de cada unidade comporta tudo? (senão o resto fica para depois — nada é apagado de vez sem você pedir)
      const notes: string[] = []
      try {
        const bins = await getBinState()
        const perDrive = new Map<string, number>()
        for (const f of list) perDrive.set(f.path.slice(0, 2).toUpperCase(), (perDrive.get(f.path.slice(0, 2).toUpperCase()) ?? 0) + f.bytes)
        for (const [drive, bytes] of perDrive) {
          const b = bins.find((x) => x.drive === drive)
          if (!b) continue
          const free = Math.max(0, b.maxBytes - b.bytes)
          if (bytes > free) {
            notes.push(
              `A Lixeira do ${drive} só comporta mais ${formatBytes(free)} (limite ${formatBytes(b.maxBytes)}) e há ${formatBytes(bytes)} de gravações lá: vai para a Lixeira só o que couber. Para o resto, esvazie a Lixeira e limpe de novo, ou apague de vez pela Análise de Discos (pede confirmação).`
            )
          }
        }
      } catch {
        // sem informação da Lixeira: o envio confere de novo na hora
      }
      return {
        bytes: sumBytes(list),
        files: list.length,
        paths: list.map((f) => f.path),
        breakdown,
        sampleFiles: topSamples(list),
        note: notes.length ? notes.join(' ') : 'Vão para a Lixeira (dá para recuperar até esvaziá-la). O espaço só volta para o disco depois de esvaziar a Lixeira.'
      }
    }
  })

  return specs
}

/** Pastas de preparação (StagingLocation) que a própria Epic declara nos manifestos dos jogos instalados. */
function epicStagingDirs(): string[] {
  const dir = path.join(known.programData, 'Epic', 'EpicGamesLauncher', 'Data', 'Manifests')
  const out: string[] = []
  let files: string[] = []
  try {
    files = fs.readdirSync(dir).filter((f) => /\.item$/i.test(f))
  } catch {
    return out
  }
  for (const f of files) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as { InstallLocation?: string; StagingLocation?: string }
      const inst = typeof j.InstallLocation === 'string' ? path.win32.resolve(j.InstallLocation) : ''
      const stg = typeof j.StagingLocation === 'string' ? path.win32.resolve(j.StagingLocation) : ''
      if (!inst || !stg) continue
      // Só a subpasta de preparação dentro de "<jogo>\.egstore\" (nunca o .egstore nem o jogo).
      const rel = path.win32.relative(inst, stg).toLowerCase()
      if (/^\.egstore\\[^\\]+$/.test(rel) && rel !== '.egstore') out.push(stg)
    } catch {
      // manifesto ilegível
    }
  }
  return out
}
