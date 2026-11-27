// Coletas SOMENTE LEITURA do domínio Reparar Erros (PowerShell 5.1). Quatro scripts independentes, rodados em
// paralelo: entradas (registro/atalhos — redirecionáveis para a raiz de teste), sistema (tarefas, serviços,
// drivers, discos, Windows Update, Defender), eventos (travamentos, disco, WHEA) e rede (DNS/HTTPS/relógio).
// Os scripts devolvem dados BRUTOS; a interpretação (caminhos quebrados, severidade, textos) fica em analyze.ts.
import type { Hive, LnkFolder, RepairEnv } from './env'
import { psJson } from './util'

// ---------------------------------------------------------------- helpers PowerShell (leitura de registro via .NET)

/** Abre chaves do registro a partir de 'Registry::HKEY_...\sub' (somente leitura) e lê valores sem expandir %VAR%. */
export const PS_REG_READ = String.raw`
function Open-RegKey([string]$p) {
  $p = $p -replace '^Registry::', ''
  $i = $p.IndexOf('\')
  if ($i -lt 0) { $hive = $p; $sub = '' } else { $hive = $p.Substring(0, $i); $sub = $p.Substring($i + 1) }
  $root = $null
  switch ($hive.ToUpperInvariant()) {
    'HKEY_CURRENT_USER' { $root = [Microsoft.Win32.Registry]::CurrentUser }
    'HKEY_LOCAL_MACHINE' { $root = [Microsoft.Win32.Registry]::LocalMachine }
    'HKEY_CLASSES_ROOT' { $root = [Microsoft.Win32.Registry]::ClassesRoot }
  }
  if ($null -eq $root) { return $null }
  if (-not $sub) { return $root }
  try { return $root.OpenSubKey($sub, $false) } catch { return $null }
}
function Get-RawValue($k, [string]$n) {
  if ($null -eq $k) { return $null }
  try { $v = $k.GetValue($n, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) } catch { return $null }
  if ($null -eq $v) { return $null }
  if ($v -is [byte[]]) { return [Convert]::ToBase64String($v) }
  if ($v -is [string[]]) { return ($v -join [char]10) }
  return [string]$v
}
function Get-ValKind($k, [string]$n) { try { return [string]$k.GetValueKind($n) } catch { return '' } }
function Get-SubNames($k) { if ($null -eq $k) { return @() }; try { return @($k.GetSubKeyNames()) } catch { return @() } }
function Get-ValNames($k) { if ($null -eq $k) { return @() }; try { return @($k.GetValueNames()) } catch { return @() } }
`

// ---------------------------------------------------------------- tipos brutos

export interface RawRegValue {
  name: string
  data: string | null
  kind: string
}

export interface RawRunKey {
  key: string
  exists: boolean
  values: RawRegValue[] | RawRegValue | null
}

export interface RawAppPath {
  key: string
  sub: string
  data: string | null
}

export interface RawFontKey {
  key: string
  values: RawRegValue[] | RawRegValue | null
}

export interface RawShellExt {
  parent: string
  name: string
  clsid: string
  hasClsid: boolean
  hasInproc: boolean
  dll: string | null
}

export interface RawOverlay {
  name: string
  clsid: string | null
  dll: string | null
  hasInproc: boolean
}

export interface RawAssoc {
  ext: string
  progId: string
  progExists: boolean
  command: string | null
  delegate: boolean
}

export interface RawLnk {
  path: string
  scope: 'user' | 'common'
  kind: 'startup' | 'desktop' | 'startMenu'
  target: string | null
  args: string | null
  error?: string | null
}

export interface RawEntries {
  run: RawRunKey[] | RawRunKey | null
  appPaths: RawAppPath[] | RawAppPath | null
  fonts: RawFontKey[] | RawFontKey | null
  shell: RawShellExt[] | RawShellExt | null
  overlays: RawOverlay[] | RawOverlay | null
  blocked: string[] | string | null
  assoc: RawAssoc[] | RawAssoc | null
  proxy: { enable: number | null; server: string | null; pac: string | null; override: string | null; autoDetect: number | null } | null
  winsock: { catalog: string; id: string; dll: string }[] | { catalog: string; id: string; dll: string } | null
  lnk: RawLnk[] | RawLnk | null
  folders: { scope: string; kind: string; path: string; exists: boolean }[] | { scope: string; kind: string; path: string; exists: boolean } | null
  iconCache: { name: string; size: number }[] | { name: string; size: number } | null
  iconDirExists: boolean
  warnings: string[] | string | null
}

export interface EntriesSpec {
  run: { key: string; path: string }[]
  appPaths: { key: string; path: string }[]
  fonts: { key: string; path: string }[]
  classes: string
  shellParents: string[]
  overlays: string[]
  blocked: string[]
  fileExts: string
  proxy: string
  winsock: string[]
  folders: LnkFolder[] | null
  iconDir: string
  maxLnk: number
  maxAssoc: number
}

/** Chaves de inicialização conferidas: id estável -> (colmeia, subchave, 32 bits, RunOnce). */
export const RUN_KEYS: { key: string; hive: Hive; sub: string; wow: boolean; once: boolean; policy?: boolean }[] = [
  { key: 'HKCU\\Run', hive: 'HKCU', sub: 'Software\\Microsoft\\Windows\\CurrentVersion\\Run', wow: false, once: false },
  { key: 'HKCU\\RunOnce', hive: 'HKCU', sub: 'Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce', wow: false, once: true },
  { key: 'HKLM\\Run', hive: 'HKLM', sub: 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run', wow: false, once: false },
  { key: 'HKLM\\RunOnce', hive: 'HKLM', sub: 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\RunOnce', wow: false, once: true },
  { key: 'HKLM\\WOW64\\Run', hive: 'HKLM', sub: 'SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Run', wow: true, once: false },
  { key: 'HKLM\\WOW64\\RunOnce', hive: 'HKLM', sub: 'SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\RunOnce', wow: true, once: true },
  { key: 'HKCU\\Policies\\Run', hive: 'HKCU', sub: 'Software\\Microsoft\\Windows\\CurrentVersion\\Policies\\Explorer\\Run', wow: false, once: false, policy: true },
  { key: 'HKLM\\Policies\\Run', hive: 'HKLM', sub: 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\Explorer\\Run', wow: false, once: false, policy: true }
]

export const APP_PATH_KEYS: { key: string; hive: Hive; sub: string; wow: boolean }[] = [
  { key: 'HKCU\\AppPaths', hive: 'HKCU', sub: 'Software\\Microsoft\\Windows\\CurrentVersion\\App Paths', wow: false },
  { key: 'HKLM\\AppPaths', hive: 'HKLM', sub: 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths', wow: false },
  { key: 'HKLM\\WOW64\\AppPaths', hive: 'HKLM', sub: 'SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths', wow: true }
]

export const FONT_KEYS: { key: string; hive: Hive; sub: string }[] = [
  { key: 'HKLM\\Fonts', hive: 'HKLM', sub: 'SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts' },
  { key: 'HKCU\\Fonts', hive: 'HKCU', sub: 'Software\\Microsoft\\Windows NT\\CurrentVersion\\Fonts' }
]

export const SHELL_PARENTS = ['*', 'AllFilesystemObjects', 'Directory', 'Directory\\Background', 'Drive', 'Folder']
export const OVERLAY_SUB = 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\ShellIconOverlayIdentifiers'
export const BLOCKED_SUB_HKLM = 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Shell Extensions\\Blocked'
export const BLOCKED_SUB_HKCU = 'Software\\Microsoft\\Windows\\CurrentVersion\\Shell Extensions\\Blocked'
export const FILEEXTS_SUB = 'Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts'
export const PROXY_SUB = 'Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
export const WINSOCK_SUBS = [
  'SYSTEM\\CurrentControlSet\\Services\\WinSock2\\Parameters\\Protocol_Catalog9\\Catalog_Entries64',
  'SYSTEM\\CurrentControlSet\\Services\\WinSock2\\Parameters\\Protocol_Catalog9\\Catalog_Entries'
]

export function buildEntriesSpec(e: RepairEnv): EntriesSpec {
  return {
    run: RUN_KEYS.map((k) => ({ key: k.key, path: e.regPath(k.hive, k.sub) })),
    appPaths: APP_PATH_KEYS.map((k) => ({ key: k.key, path: e.regPath(k.hive, k.sub) })),
    fonts: FONT_KEYS.map((k) => ({ key: k.key, path: e.regPath(k.hive, k.sub) })),
    classes: e.regPath('HKCR', ''),
    shellParents: SHELL_PARENTS,
    overlays: [e.regPath('HKLM', OVERLAY_SUB)],
    blocked: [e.regPath('HKLM', BLOCKED_SUB_HKLM), e.regPath('HKCU', BLOCKED_SUB_HKCU)],
    fileExts: e.regPath('HKCU', FILEEXTS_SUB),
    proxy: e.regPath('HKCU', PROXY_SUB),
    winsock: WINSOCK_SUBS.map((s) => e.regPath('HKLM', s)),
    folders: e.lnkFolders,
    iconDir: e.explorerCacheDir,
    maxLnk: 4000,
    maxAssoc: 900
  }
}

export function entriesScript(spec: EntriesSpec): string {
  return `${PS_REG_READ}
$spec = ${psJson(spec)}
$warnings = New-Object System.Collections.ArrayList
$GUIDRE = '^\\{[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\\}$'

# --- Inicialização (Run/RunOnce)
$run = New-Object System.Collections.ArrayList
foreach ($r in @($spec.run)) {
  $vals = New-Object System.Collections.ArrayList
  $k = Open-RegKey ([string]$r.path)
  $exists = $null -ne $k
  foreach ($n in (Get-ValNames $k)) {
    if ([string]::IsNullOrEmpty($n)) { continue }
    [void]$vals.Add([ordered]@{ name = [string]$n; data = (Get-RawValue $k $n); kind = (Get-ValKind $k $n) })
  }
  if ($k) { $k.Close() }
  [void]$run.Add([ordered]@{ key = [string]$r.key; exists = $exists; values = @($vals) })
}

# --- App Paths
$appPaths = New-Object System.Collections.ArrayList
foreach ($a in @($spec.appPaths)) {
  $k = Open-RegKey ([string]$a.path)
  foreach ($s in (Get-SubNames $k)) {
    $sk = $null
    try { $sk = $k.OpenSubKey($s, $false) } catch { }
    if ($null -eq $sk) { continue }
    [void]$appPaths.Add([ordered]@{ key = [string]$a.key; sub = [string]$s; data = (Get-RawValue $sk '') })
    $sk.Close()
  }
  if ($k) { $k.Close() }
}

# --- Fontes
$fonts = New-Object System.Collections.ArrayList
foreach ($f in @($spec.fonts)) {
  $vals = New-Object System.Collections.ArrayList
  $k = Open-RegKey ([string]$f.path)
  foreach ($n in (Get-ValNames $k)) {
    if ([string]::IsNullOrEmpty($n)) { continue }
    [void]$vals.Add([ordered]@{ name = [string]$n; data = (Get-RawValue $k $n); kind = (Get-ValKind $k $n) })
  }
  if ($k) { $k.Close() }
  [void]$fonts.Add([ordered]@{ key = [string]$f.key; values = @($vals) })
}

# --- Extensões do menu de contexto (CLSID -> InprocServer32)
$cls = [string]$spec.classes
function Get-Inproc([string]$clsid) {
  $ip = Open-RegKey ($cls + '\\CLSID\\' + $clsid + '\\InprocServer32')
  $c = Open-RegKey ($cls + '\\CLSID\\' + $clsid)
  $r = [ordered]@{ hasClsid = ($null -ne $c); hasInproc = ($null -ne $ip); dll = (Get-RawValue $ip '') }
  if ($ip) { $ip.Close() }
  if ($c) { $c.Close() }
  return $r
}
$shell = New-Object System.Collections.ArrayList
foreach ($p in @($spec.shellParents)) {
  $k = Open-RegKey ($cls + '\\' + [string]$p + '\\shellex\\ContextMenuHandlers')
  foreach ($n in (Get-SubNames $k)) {
    $sk = $null
    try { $sk = $k.OpenSubKey($n, $false) } catch { }
    $d = Get-RawValue $sk ''
    if ($sk) { $sk.Close() }
    $clsid = $null
    if ($d -and ($d.Trim() -match $GUIDRE)) { $clsid = $d.Trim() } elseif ($n -match $GUIDRE) { $clsid = [string]$n }
    if (-not $clsid) { continue }
    $ip = Get-Inproc $clsid
    [void]$shell.Add([ordered]@{ parent = [string]$p; name = [string]$n; clsid = $clsid; hasClsid = $ip.hasClsid; hasInproc = $ip.hasInproc; dll = $ip.dll })
  }
  if ($k) { $k.Close() }
}
$overlays = New-Object System.Collections.ArrayList
foreach ($o in @($spec.overlays)) {
  $k = Open-RegKey ([string]$o)
  foreach ($n in (Get-SubNames $k)) {
    $sk = $null
    try { $sk = $k.OpenSubKey($n, $false) } catch { }
    $d = Get-RawValue $sk ''
    if ($sk) { $sk.Close() }
    $clsid = $null
    if ($d -and ($d.Trim() -match $GUIDRE)) { $clsid = $d.Trim() }
    $ip = if ($clsid) { Get-Inproc $clsid } else { [ordered]@{ hasInproc = $false; dll = $null } }
    [void]$overlays.Add([ordered]@{ name = [string]$n; clsid = $clsid; dll = $ip.dll; hasInproc = $ip.hasInproc })
  }
  if ($k) { $k.Close() }
}
$blocked = New-Object System.Collections.ArrayList
foreach ($b in @($spec.blocked)) {
  $k = Open-RegKey ([string]$b)
  foreach ($n in (Get-ValNames $k)) { if ($n) { [void]$blocked.Add(([string]$n).ToUpperInvariant()) } }
  if ($k) { $k.Close() }
}

# --- Associações de arquivo (escolha do usuário -> comando)
$assoc = New-Object System.Collections.ArrayList
$fe = Open-RegKey ([string]$spec.fileExts)
$count = 0
foreach ($ext in (Get-SubNames $fe)) {
  if ($count -ge [int]$spec.maxAssoc) { break }
  if ($ext -notmatch '^\\.[A-Za-z0-9_+~-]{1,16}$') { continue }
  $progId = $null
  $ucl = $null; try { $ucl = $fe.OpenSubKey($ext + '\\UserChoiceLatest\\ProgId', $false) } catch { }
  if ($ucl) { $progId = Get-RawValue $ucl 'ProgId'; $ucl.Close() }
  if (-not $progId) {
    $uc = $null; try { $uc = $fe.OpenSubKey($ext + '\\UserChoice', $false) } catch { }
    if ($uc) { $progId = Get-RawValue $uc 'ProgId'; $uc.Close() }
  }
  if (-not $progId) { continue }
  $count++
  if ($progId -like 'AppX*' -or $progId -like 'MSEdge*') { continue }
  $pk = Open-RegKey ($cls + '\\' + $progId)
  $cmd = $null; $delegate = $false
  if ($pk) {
    $verb = 'open'
    $sh = $null; try { $sh = $pk.OpenSubKey('shell', $false) } catch { }
    if ($sh) { $dv = Get-RawValue $sh ''; if ($dv) { $verb = ($dv -split ',')[0].Trim() }; $sh.Close() }
    $ck = $null; try { $ck = $pk.OpenSubKey('shell\\' + $verb + '\\command', $false) } catch { }
    if (-not $ck -and $verb -ne 'open') { try { $ck = $pk.OpenSubKey('shell\\open\\command', $false) } catch { } }
    if ($ck) { $cmd = Get-RawValue $ck ''; $delegate = ((Get-ValNames $ck) -contains 'DelegateExecute'); $ck.Close() }
    else { $delegate = $true }
    $pk.Close()
  }
  [void]$assoc.Add([ordered]@{ ext = [string]$ext; progId = [string]$progId; progExists = ($null -ne $pk); command = $cmd; delegate = $delegate })
}
if ($fe) { $fe.Close() }

# --- Proxy do usuário
$proxy = $null
$pk = Open-RegKey ([string]$spec.proxy)
if ($pk) {
  $en = $pk.GetValue('ProxyEnable', $null); $ad = $pk.GetValue('AutoDetect', $null)
  $proxy = [ordered]@{
    enable = $(if ($null -ne $en) { [int64]$en } else { $null })
    server = (Get-RawValue $pk 'ProxyServer')
    pac = (Get-RawValue $pk 'AutoConfigURL')
    override = (Get-RawValue $pk 'ProxyOverride')
    autoDetect = $(if ($null -ne $ad) { [int64]$ad } else { $null })
  }
  $pk.Close()
}

# --- Catálogo Winsock (DLL de cada provedor)
$winsock = New-Object System.Collections.ArrayList
foreach ($w in @($spec.winsock)) {
  $k = Open-RegKey ([string]$w)
  foreach ($n in (Get-SubNames $k)) {
    try {
      $sk = $k.OpenSubKey($n, $false)
      $b = $sk.GetValue('PackedCatalogItem', $null)
      $sk.Close()
      if ($b -is [byte[]] -and $b.Length -ge 4) {
        $len = [Math]::Min(260, $b.Length)
        $s = [System.Text.Encoding]::Default.GetString($b, 0, $len)
        $z = $s.IndexOf([char]0); if ($z -ge 0) { $s = $s.Substring(0, $z) }
        [void]$winsock.Add([ordered]@{ catalog = ([string]$w -replace '^.*\\\\', ''); id = [string]$n; dll = $s })
      }
    } catch { }
  }
  if ($k) { $k.Close() }
}

# --- Atalhos (.lnk): Inicializar, Área de Trabalho, Menu Iniciar (usuário e todos)
$folders = New-Object System.Collections.ArrayList
if ($null -eq $spec.folders) {
  $defs = @(
    @('user','startup','Startup',$false), @('common','startup','CommonStartup',$false),
    @('user','desktop','Desktop',$false), @('common','desktop','CommonDesktopDirectory',$false),
    @('user','startMenu','StartMenu',$true), @('common','startMenu','CommonStartMenu',$true)
  )
  foreach ($d in $defs) {
    $p = ''
    try { $p = [Environment]::GetFolderPath([Environment+SpecialFolder]$d[2]) } catch { }
    if ($p) { [void]$folders.Add([ordered]@{ scope = $d[0]; kind = $d[1]; path = $p; recurse = $d[3] }) }
  }
} else {
  foreach ($f in @($spec.folders)) { [void]$folders.Add([ordered]@{ scope = [string]$f.scope; kind = [string]$f.kind; path = [string]$f.path; recurse = [bool]$f.recurse }) }
}
$lnk = New-Object System.Collections.ArrayList
$seen = @{}
$wsh = $null
try { $wsh = New-Object -ComObject WScript.Shell } catch { [void]$warnings.Add('WScript.Shell: ' + $_.Exception.Message) }
function Walk-Lnk([string]$dir, [string]$scope, [string]$kind, [bool]$recurse, [int]$depth) {
  if ($lnk.Count -ge [int]$spec.maxLnk) { return }
  $files = @()
  try { $files = @([System.IO.Directory]::GetFiles($dir, '*.lnk')) } catch { return }
  foreach ($f in $files) {
    if ($lnk.Count -ge [int]$spec.maxLnk) { return }
    $key = $f.ToLowerInvariant()
    if ($seen.ContainsKey($key)) { continue }
    $seen[$key] = $true
    try { if (([System.IO.File]::GetAttributes($f) -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { continue } } catch { continue }
    $t = $null; $a = $null; $er = $null
    try { $s = $wsh.CreateShortcut($f); $t = [string]$s.TargetPath; $a = [string]$s.Arguments } catch { $er = $_.Exception.Message }
    [void]$lnk.Add([ordered]@{ path = $f; scope = $scope; kind = $kind; target = $t; args = $a; error = $er })
  }
  if (-not $recurse -or $depth -ge 8) { return }
  $dirs = @()
  try { $dirs = @([System.IO.Directory]::GetDirectories($dir)) } catch { return }
  foreach ($d in $dirs) {
    try { if (([System.IO.File]::GetAttributes($d) -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { continue } } catch { continue }
    Walk-Lnk $d $scope $kind $true ($depth + 1)
  }
}
$folderOut = New-Object System.Collections.ArrayList
foreach ($f in $folders) {
  $ex = [System.IO.Directory]::Exists([string]$f.path)
  [void]$folderOut.Add([ordered]@{ scope = $f.scope; kind = $f.kind; path = $f.path; exists = $ex })
  if ($ex -and $wsh) { Walk-Lnk ([string]$f.path) ([string]$f.scope) ([string]$f.kind) ([bool]$f.recurse) 0 }
}

# --- Cache de ícones/miniaturas
$icon = New-Object System.Collections.ArrayList
$iconDir = [string]$spec.iconDir
$iconDirExists = [System.IO.Directory]::Exists($iconDir)
if ($iconDirExists) {
  try {
    foreach ($fi in (New-Object System.IO.DirectoryInfo($iconDir)).GetFiles()) {
      if ($fi.Name -match '^(iconcache_|thumbcache_).*\\.db$') { [void]$icon.Add([ordered]@{ name = $fi.Name; size = [int64]$fi.Length }) }
    }
  } catch { [void]$warnings.Add('cache de ícones: ' + $_.Exception.Message) }
}
$legacy = [System.IO.Path]::Combine([System.IO.Path]::GetDirectoryName([System.IO.Path]::GetDirectoryName([System.IO.Path]::GetDirectoryName($iconDir))), 'IconCache.db')
try { if ([System.IO.File]::Exists($legacy)) { [void]$icon.Add([ordered]@{ name = 'IconCache.db'; size = [int64](New-Object System.IO.FileInfo($legacy)).Length }) } } catch { }

ConvertTo-Json -InputObject ([ordered]@{
  run = @($run); appPaths = @($appPaths); fonts = @($fonts); shell = @($shell); overlays = @($overlays); blocked = @($blocked)
  assoc = @($assoc); proxy = $proxy; winsock = @($winsock); lnk = @($lnk); folders = @($folderOut)
  iconCache = @($icon); iconDirExists = $iconDirExists; warnings = @($warnings)
}) -Depth 6 -Compress
`
}

// ---------------------------------------------------------------- sistema (só PC real)

export interface RawTask {
  path: string
  name: string
  state: string
  user: string
  runLevel: string
  execute: string
  args: string
}

export interface RawService {
  name: string
  display: string
  path: string | null
  startMode: string
  state: string
  delayed: boolean | null
}

export interface RawDriver {
  name: string
  display: string
  path: string | null
  startMode: string
  state: string
}

export interface RawPhysicalDisk {
  id: string
  name: string
  media: string
  bus: string
  health: string
  op: string
  size: number
}

export interface RawVolume {
  letter: string
  fs: string
  health: string
  op: string
  size: number
  free: number
  type: string
  label: string
}

export interface RawWuFailure {
  date: number
  title: string
  hr: string
  rc: number
}

export interface RawSystem {
  admin: boolean
  tasks: RawTask[] | RawTask | null
  services: RawService[] | RawService | null
  drivers: RawDriver[] | RawDriver | null
  disks: RawPhysicalDisk[] | RawPhysicalDisk | null
  volumes: RawVolume[] | RawVolume | null
  partitions: { disk: number; letter: string }[] | { disk: number; letter: string } | null
  systemDrive: string
  wu: { ok: boolean; error: string | null; total: number; failures: RawWuFailure[] | RawWuFailure | null; successes: number; lastSuccess: number | null; okTitles: { title: string; date: number }[] | { title: string; date: number } | null }
  reboot: { wu: boolean; cbs: boolean; fileRename: boolean; lastBoot: number | null }
  defender: {
    ok: boolean
    error: string | null
    mode: string | null
    av: boolean | null
    rtp: boolean | null
    sigAge: number | null
    sigUpdated: number | null
    quickAge: number | null
    quickEnd: number | null
    fullAge: number | null
    tamper: boolean | null
  }
  threats: { ok: boolean; error: string | null; items: { name: string; time: number; ok: boolean; res: string }[] | { name: string; time: number; ok: boolean; res: string } | null }
  avProducts: { name: string; state: number; exe: string }[] | { name: string; state: number; exe: string } | null
  store: { installed: boolean; version: string | null; error: string | null }
  warnings: string[] | string | null
}

export function systemScript(): string {
  return String.raw`
$warnings = New-Object System.Collections.ArrayList
function Ms($d) { if ($null -eq $d) { return $null }; try { return ([DateTimeOffset]$d).ToUnixTimeMilliseconds() } catch { return $null } }
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

$tasks = New-Object System.Collections.ArrayList
try {
  foreach ($t in @(Get-ScheduledTask -ErrorAction Stop)) {
    if ([string]$t.TaskPath -like '\Microsoft\*') { continue }
    foreach ($a in @($t.Actions)) {
      if ($null -eq $a -or $a.CimClass.CimClassName -ne 'MSFT_TaskExecAction') { continue }
      [void]$tasks.Add([ordered]@{ path = [string]$t.TaskPath; name = [string]$t.TaskName; state = [string]$t.State; user = [string]$t.Principal.UserId; runLevel = [string]$t.Principal.RunLevel; execute = [string]$a.Execute; args = [string]$a.Arguments })
    }
  }
} catch { [void]$warnings.Add('tarefas: ' + $_.Exception.Message) }

$services = New-Object System.Collections.ArrayList
try {
  foreach ($s in @(Get-CimInstance Win32_Service -ErrorAction Stop)) {
    $dl = $null; try { $dl = [bool]$s.DelayedAutoStart } catch { }
    [void]$services.Add([ordered]@{ name = [string]$s.Name; display = [string]$s.DisplayName; path = [string]$s.PathName; startMode = [string]$s.StartMode; state = [string]$s.State; delayed = $dl })
  }
} catch { [void]$warnings.Add('serviços: ' + $_.Exception.Message) }

$drivers = New-Object System.Collections.ArrayList
try {
  foreach ($d in @(Get-CimInstance Win32_SystemDriver -ErrorAction Stop)) {
    [void]$drivers.Add([ordered]@{ name = [string]$d.Name; display = [string]$d.DisplayName; path = [string]$d.PathName; startMode = [string]$d.StartMode; state = [string]$d.State })
  }
} catch { [void]$warnings.Add('drivers: ' + $_.Exception.Message) }

$disks = New-Object System.Collections.ArrayList
try {
  foreach ($p in @(Get-PhysicalDisk -ErrorAction Stop)) {
    [void]$disks.Add([ordered]@{ id = [string]$p.DeviceId; name = [string]$p.FriendlyName; media = [string]$p.MediaType; bus = [string]$p.BusType; health = [string]$p.HealthStatus; op = ((@($p.OperationalStatus) | ForEach-Object { [string]$_ }) -join ','); size = [int64]$p.Size })
  }
} catch { [void]$warnings.Add('discos: ' + $_.Exception.Message) }
$volumes = New-Object System.Collections.ArrayList
try {
  foreach ($v in @(Get-Volume -ErrorAction Stop | Where-Object { $_.DriveLetter })) {
    [void]$volumes.Add([ordered]@{ letter = [string]$v.DriveLetter; fs = [string]$v.FileSystem; health = [string]$v.HealthStatus; op = ((@($v.OperationalStatus) | ForEach-Object { [string]$_ }) -join ','); size = [int64]$v.Size; free = [int64]$v.SizeRemaining; type = [string]$v.DriveType; label = [string]$v.FileSystemLabel })
  }
} catch { [void]$warnings.Add('volumes: ' + $_.Exception.Message) }
$parts = New-Object System.Collections.ArrayList
try { foreach ($p in @(Get-Partition -ErrorAction Stop | Where-Object { $_.DriveLetter })) { [void]$parts.Add([ordered]@{ disk = [int]$p.DiskNumber; letter = [string]$p.DriveLetter }) } } catch { }

# Windows Update: histórico (60 dias)
$wu = [ordered]@{ ok = $false; error = $null; total = 0; failures = @(); successes = 0; lastSuccess = $null; okTitles = @() }
try {
  $sess = New-Object -ComObject Microsoft.Update.Session
  $se = $sess.CreateUpdateSearcher()
  $n = [int]$se.GetTotalHistoryCount()
  $wu.total = $n
  $fails = New-Object System.Collections.ArrayList
  $oks = New-Object System.Collections.ArrayList
  $limit = [DateTime]::UtcNow.AddDays(-60)
  if ($n -gt 0) {
    $h = $se.QueryHistory(0, [Math]::Min($n, 400))
    foreach ($e in $h) {
      $dt = [DateTime]::SpecifyKind([DateTime]$e.Date, 'Utc')
      if ($dt -lt $limit) { continue }
      if ([int]$e.Operation -ne 1) { continue }
      $rc = [int]$e.ResultCode
      $ms = ([DateTimeOffset]$dt).ToUnixTimeMilliseconds()
      if ($rc -eq 4 -or $rc -eq 5) { [void]$fails.Add([ordered]@{ date = $ms; title = [string]$e.Title; hr = ('0x{0:X8}' -f [int]$e.HResult); rc = $rc }) }
      elseif ($rc -eq 2 -or $rc -eq 3) { $wu.successes++; if ($null -eq $wu.lastSuccess -or $ms -gt $wu.lastSuccess) { $wu.lastSuccess = $ms }; [void]$oks.Add([ordered]@{ title = [string]$e.Title; date = $ms }) }
    }
  }
  $wu.failures = @($fails)
  $wu.okTitles = @($oks)
  $wu.ok = $true
} catch { $wu.error = $_.Exception.Message }

$reboot = [ordered]@{ wu = $false; cbs = $false; fileRename = $false; lastBoot = $null }
try { $reboot.wu = Test-Path -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired' } catch { }
try { $reboot.cbs = Test-Path -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending' } catch { }
try { $reboot.fileRename = $null -ne (Get-ItemProperty -LiteralPath 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager' -Name PendingFileRenameOperations -ErrorAction Stop).PendingFileRenameOperations } catch { }
try { $reboot.lastBoot = Ms (Get-CimInstance Win32_OperatingSystem -ErrorAction Stop).LastBootUpTime } catch { }

$def = [ordered]@{ ok = $false; error = $null; mode = $null; av = $null; rtp = $null; sigAge = $null; sigUpdated = $null; quickAge = $null; quickEnd = $null; fullAge = $null; tamper = $null }
try {
  $m = Get-MpComputerStatus -ErrorAction Stop
  $def.ok = $true; $def.mode = [string]$m.AMRunningMode; $def.av = [bool]$m.AntivirusEnabled; $def.rtp = [bool]$m.RealTimeProtectionEnabled
  $def.sigAge = [int64]$m.AntivirusSignatureAge; $def.sigUpdated = Ms $m.AntivirusSignatureLastUpdated
  $def.quickAge = [int64]$m.QuickScanAge; $def.quickEnd = Ms $m.QuickScanEndTime; $def.fullAge = [int64]$m.FullScanAge
  try { $def.tamper = [bool]$m.IsTamperProtected } catch { }
} catch { $def.error = $_.Exception.Message }
$threats = [ordered]@{ ok = $false; error = $null; items = @() }
try {
  $names = @{}
  try { foreach ($t in @(Get-MpThreat -ErrorAction Stop)) { $names[[string]$t.ThreatID] = [string]$t.ThreatName } } catch { }
  $lim = (Get-Date).AddDays(-30)
  $it = New-Object System.Collections.ArrayList
  foreach ($d in @(Get-MpThreatDetection -ErrorAction Stop)) {
    if ($d.InitialDetectionTime -lt $lim) { continue }
    $nm = $names[[string]$d.ThreatID]; if (-not $nm) { $nm = 'Ameaça ' + [string]$d.ThreatID }
    [void]$it.Add([ordered]@{ name = $nm; time = (Ms $d.InitialDetectionTime); ok = [bool]$d.ActionSuccess; res = ((@($d.Resources) | Select-Object -First 2) -join ' ; ') })
  }
  $threats.items = @($it); $threats.ok = $true
} catch { $threats.error = $_.Exception.Message }
$avs = New-Object System.Collections.ArrayList
try { foreach ($a in @(Get-CimInstance -Namespace root/SecurityCenter2 -ClassName AntiVirusProduct -ErrorAction Stop)) { [void]$avs.Add([ordered]@{ name = [string]$a.displayName; state = [int64]$a.productState; exe = [string]$a.pathToSignedReportingExe }) } } catch { [void]$warnings.Add('antivírus: ' + $_.Exception.Message) }

$store = [ordered]@{ installed = $false; version = $null; error = $null }
try { $sp = Get-AppxPackage -Name Microsoft.WindowsStore -ErrorAction Stop | Select-Object -First 1; if ($sp) { $store.installed = $true; $store.version = [string]$sp.Version } } catch { $store.error = $_.Exception.Message }

ConvertTo-Json -InputObject ([ordered]@{
  admin = $admin; tasks = @($tasks); services = @($services); drivers = @($drivers); disks = @($disks); volumes = @($volumes); partitions = @($parts)
  systemDrive = [string]$env:SystemDrive; wu = $wu; reboot = $reboot; defender = $def; threats = $threats; avProducts = @($avs); store = $store; warnings = @($warnings)
}) -Depth 6 -Compress
`
}

// ---------------------------------------------------------------- eventos (só PC real)

export interface RawEvents {
  kp41: { time: number; code: number; pbt: number; longPress: boolean; sleep: boolean }[] | { time: number; code: number; pbt: number; longPress: boolean; sleep: boolean } | null
  kp41Error: string | null
  bugchecks: { time: number; text: string; dump: string }[] | { time: number; text: string; dump: string } | null
  unexpected: number
  whea: { id: number; count: number; level: number; last: number; msg: string }[] | { id: number; count: number; level: number; last: number; msg: string } | null
  disk: { id: number; provider: string; level: number; count: number; last: number; msg: string }[] | { id: number; provider: string; level: number; count: number; last: number; msg: string } | null
  diskError: string | null
  gpu: { tdr: number; tdrLast: number | null; driverErrors: number; driverName: string | null }
  apps: { app: string; kind: string; count: number; last: number; modules: string; codes: string; path: string }[] | { app: string; kind: string; count: number; last: number; modules: string; codes: string; path: string } | null
  reliability: { latest: number | null; min7: number | null; at: number | null; error: string | null }
  memDiag: { time: number; id: number; msg: string } | null
  warnings: string[] | string | null
}

export function eventsScript(): string {
  return String.raw`
$warnings = New-Object System.Collections.ArrayList
function Ms($d) { if ($null -eq $d) { return $null }; try { return ([DateTimeOffset]$d).ToUnixTimeMilliseconds() } catch { return $null } }
function Get-Ev($filter) { try { return @(Get-WinEvent -FilterHashtable $filter -ErrorAction Stop) } catch { if ($_.FullyQualifiedErrorId -like 'NoMatchingEventsFound*') { return @() }; throw } }
$since30 = (Get-Date).AddDays(-30)
$since90 = (Get-Date).AddDays(-90)
function Short([string]$m) { if (-not $m) { return '' }; $m = ($m -replace '\s+', ' ').Trim(); if ($m.Length -gt 240) { $m = $m.Substring(0, 240) }; return $m }

$kp = New-Object System.Collections.ArrayList; $kpErr = $null
try {
  foreach ($e in (Get-Ev @{ LogName = 'System'; ProviderName = 'Microsoft-Windows-Kernel-Power'; Id = 41; StartTime = $since30 })) {
    $d = @{}
    try { foreach ($n in ([xml]$e.ToXml()).Event.EventData.Data) { $d[[string]$n.Name] = [string]$n.'#text' } } catch { }
    $code = 0; try { $code = [int64]$d['BugcheckCode'] } catch { }
    $pbt = 0; try { $pbt = [int64]$d['PowerButtonTimestamp'] } catch { }
    [void]$kp.Add([ordered]@{ time = (Ms $e.TimeCreated); code = $code; pbt = $pbt; longPress = ($d['LongPowerButtonPressDetected'] -eq 'true'); sleep = ($d['SleepInProgress'] -eq 'true' -or ($d['SleepInProgress'] -match '^[1-9]')) })
  }
} catch { $kpErr = $_.Exception.Message }

$bc = New-Object System.Collections.ArrayList
try {
  foreach ($e in (Get-Ev @{ LogName = 'System'; Id = 1001; StartTime = $since90 })) {
    if ($e.ProviderName -notlike '*WER-SystemErrorReporting*') { continue }
    $p0 = ''; $p1 = ''
    try { $p0 = [string]$e.Properties[0].Value } catch { }
    try { $p1 = [string]$e.Properties[1].Value } catch { }
    [void]$bc.Add([ordered]@{ time = (Ms $e.TimeCreated); text = $p0; dump = $p1 })
  }
} catch { [void]$warnings.Add('telas azuis: ' + $_.Exception.Message) }

$unexpected = 0
try { $unexpected = @(Get-Ev @{ LogName = 'System'; Id = 6008; StartTime = $since30 }).Count } catch { }

$whea = New-Object System.Collections.ArrayList
try {
  $ev = Get-Ev @{ LogName = 'System'; ProviderName = 'Microsoft-Windows-WHEA-Logger'; StartTime = $since30 }
  foreach ($g in @($ev | Group-Object Id)) {
    $first = $g.Group | Sort-Object TimeCreated -Descending | Select-Object -First 1
    [void]$whea.Add([ordered]@{ id = [int]$g.Name; count = [int]$g.Count; level = [int](($g.Group | Measure-Object Level -Minimum).Minimum); last = (Ms $first.TimeCreated); msg = (Short $first.Message) })
  }
} catch { [void]$warnings.Add('WHEA: ' + $_.Exception.Message) }

$disk = New-Object System.Collections.ArrayList; $diskErr = $null
try {
  $ev = Get-Ev @{ LogName = 'System'; Id = 7, 11, 51, 55, 98, 129, 153, 157; StartTime = $since30 }
  $keep = @($ev | Where-Object {
    $p = [string]$_.ProviderName; $i = [int]$_.Id
    if ($p -match 'Hyper-V|Kernel-Processor|Kernel-Boot|Kernel-General') { $false }
    elseif ($i -in 7, 11, 51, 153, 157) { $p -eq 'disk' }
    elseif ($i -eq 55) { $p -match 'Ntfs' }
    elseif ($i -eq 98) { ($p -match 'Ntfs') -and ([int]$_.Level -le 3) -and ([int]$_.Level -ge 1) }
    elseif ($i -eq 129) { $p -match 'stor|ahci|nvme|iaStor|amd|sata|raid|scsi' }
    else { $false }
  })
  foreach ($g in @($keep | Group-Object ProviderName, Id)) {
    $first = $g.Group | Sort-Object TimeCreated -Descending | Select-Object -First 1
    [void]$disk.Add([ordered]@{ id = [int]$first.Id; provider = [string]$first.ProviderName; level = [int](($g.Group | Measure-Object Level -Minimum).Minimum); count = [int]$g.Count; last = (Ms $first.TimeCreated); msg = (Short $first.Message) })
  }
} catch { $diskErr = $_.Exception.Message }

$gpu = [ordered]@{ tdr = 0; tdrLast = $null; driverErrors = 0; driverName = $null }
try {
  $t = Get-Ev @{ LogName = 'System'; ProviderName = 'Display'; Id = 4101; StartTime = $since30 }
  $gpu.tdr = $t.Count
  if ($t.Count) { $gpu.tdrLast = Ms (($t | Sort-Object TimeCreated -Descending | Select-Object -First 1).TimeCreated) }
} catch { }
foreach ($pn in 'nvlddmkm', 'amdkmdag', 'amdkmdap', 'igfx') {
  try {
    $t = @(Get-Ev @{ LogName = 'System'; ProviderName = $pn; StartTime = $since30; Level = 1, 2 })
    if ($t.Count) { $gpu.driverErrors += $t.Count; $gpu.driverName = $pn }
  } catch { }
}

$apps = New-Object System.Collections.ArrayList
try {
  $ev = Get-Ev @{ LogName = 'Application'; Id = 1000, 1002; StartTime = $since30 }
  $rows = foreach ($e in $ev) {
    $app = ''; $mod = ''; $code = ''; $pth = ''
    try { $app = [string]$e.Properties[0].Value } catch { }
    if ($e.Id -eq 1000) {
      try { $mod = [string]$e.Properties[3].Value } catch { }
      try { $code = [string]$e.Properties[6].Value } catch { }
      try { $pth = [string]$e.Properties[10].Value } catch { }
    } else { try { $pth = [string]$e.Properties[5].Value } catch { } }
    [pscustomobject]@{ app = $app; kind = $(if ($e.Id -eq 1000) { 'crash' } else { 'hang' }); mod = $mod; code = $code; path = $pth; time = $e.TimeCreated }
  }
  foreach ($g in @($rows | Where-Object { $_.app } | Group-Object app, kind | Sort-Object Count -Descending | Select-Object -First 12)) {
    $first = $g.Group | Sort-Object time -Descending | Select-Object -First 1
    $mods = (@($g.Group | Where-Object { $_.mod } | Group-Object mod | Sort-Object Count -Descending | Select-Object -First 3 | ForEach-Object { $_.Name + ' (' + $_.Count + 'x)' })) -join ', '
    $codes = (@($g.Group | Where-Object { $_.code } | Group-Object code | Sort-Object Count -Descending | Select-Object -First 2 | ForEach-Object { $_.Name })) -join ', '
    [void]$apps.Add([ordered]@{ app = [string]$first.app; kind = [string]$first.kind; count = [int]$g.Count; last = (Ms $first.time); modules = $mods; codes = $codes; path = [string]$first.path })
  }
} catch { [void]$warnings.Add('travamentos de programas: ' + $_.Exception.Message) }

$rel = [ordered]@{ latest = $null; min7 = $null; at = $null; error = $null }
try {
  $r = @(Get-CimInstance -Query 'SELECT SystemStabilityIndex, TimeGenerated FROM Win32_ReliabilityStabilityMetrics' -ErrorAction Stop)
  if ($r.Count) {
    $s = $r | Sort-Object TimeGenerated -Descending
    $rel.latest = [double]$s[0].SystemStabilityIndex; $rel.at = Ms $s[0].TimeGenerated
    $lim = (Get-Date).AddDays(-7)
    $m = @($s | Where-Object { $_.TimeGenerated -ge $lim } | Measure-Object SystemStabilityIndex -Minimum)
    if ($m.Count -and $null -ne $m[0].Minimum) { $rel.min7 = [double]$m[0].Minimum }
  }
} catch { $rel.error = $_.Exception.Message }

$mem = $null
try {
  $e = @(Get-WinEvent -FilterHashtable @{ LogName = 'System'; ProviderName = 'Microsoft-Windows-MemoryDiagnostics-Results' } -MaxEvents 1 -ErrorAction Stop)
  if ($e.Count) { $mem = [ordered]@{ time = (Ms $e[0].TimeCreated); id = [int]$e[0].Id; msg = (Short $e[0].Message) } }
} catch { }

ConvertTo-Json -InputObject ([ordered]@{
  kp41 = @($kp); kp41Error = $kpErr; bugchecks = @($bc); unexpected = $unexpected; whea = @($whea); disk = @($disk); diskError = $diskErr
  gpu = $gpu; apps = @($apps); reliability = $rel; memDiag = $mem; warnings = @($warnings)
}) -Depth 6 -Compress
`
}

// ---------------------------------------------------------------- rede (só PC real)

export interface RawNetwork {
  adaptersUp: number
  dns: { host: string; ok: boolean; ms: number; error: string | null; addr: string | null }[] | { host: string; ok: boolean; ms: number; error: string | null; addr: string | null } | null
  http: { url: string; ok: boolean; status: number | null; error: string | null; date: string | null; t0: number; t1: number; viaProxy: boolean }[] | { url: string; ok: boolean; status: number | null; error: string | null; date: string | null; t0: number; t1: number; viaProxy: boolean } | null
}

export function networkScript(): string {
  return String.raw`
$up = 0
try {
  foreach ($n in [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()) {
    if ([string]$n.OperationalStatus -eq 'Up' -and [string]$n.NetworkInterfaceType -notin @('Loopback', 'Tunnel')) { $up++ }
  }
} catch { }
$dns = New-Object System.Collections.ArrayList
foreach ($h in 'www.microsoft.com', 'www.google.com') {
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $r = [ordered]@{ host = $h; ok = $false; ms = 0; error = $null; addr = $null }
  try {
    $ar = [System.Net.Dns]::BeginGetHostAddresses($h, $null, $null)
    if ($ar.AsyncWaitHandle.WaitOne(5000)) {
      $a = [System.Net.Dns]::EndGetHostAddresses($ar)
      if (@($a).Count) { $r.ok = $true; $r.addr = [string]@($a)[0] } else { $r.error = 'sem endereços' }
    } else { $r.error = 'tempo esgotado' }
  } catch { $e = $_.Exception; while ($e.InnerException) { $e = $e.InnerException }; $r.error = $e.Message }
  $r.ms = [int]$sw.ElapsedMilliseconds
  [void]$dns.Add($r)
}
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch { }
$http = New-Object System.Collections.ArrayList
foreach ($u in 'https://www.microsoft.com/', 'https://www.google.com/') {
  $r = [ordered]@{ url = $u; ok = $false; status = $null; error = $null; date = $null; t0 = 0; t1 = 0; viaProxy = $false }
  try {
    $uri = New-Object System.Uri($u)
    try { $px = [System.Net.WebRequest]::DefaultWebProxy; if ($px) { $r.viaProxy = -not $px.IsBypassed($uri) -and ($px.GetProxy($uri).AbsoluteUri -ne $uri.AbsoluteUri) } } catch { }
    $req = [System.Net.HttpWebRequest]::Create($uri)
    $req.Method = 'HEAD'; $req.Timeout = 8000; $req.ReadWriteTimeout = 8000; $req.AllowAutoRedirect = $false
    $req.UserAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) IACleaner'
    $r.t0 = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $resp = $req.GetResponse()
    $r.t1 = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $r.ok = $true; $r.status = [int]$resp.StatusCode; $r.date = [string]$resp.Headers['Date']
    $resp.Close()
  } catch {
    if (-not $r.t1) { $r.t1 = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }
    $we = $_.Exception
    while ($we -and -not ($we -is [System.Net.WebException])) { $we = $we.InnerException }
    if ($we -and $we.Response) {
      $r.ok = $true; try { $r.status = [int]$we.Response.StatusCode } catch { }; $r.date = [string]$we.Response.Headers['Date']; try { $we.Response.Close() } catch { }
    } else {
      $e = $_.Exception; while ($e.InnerException) { $e = $e.InnerException }; $r.error = $e.Message
    }
  }
  [void]$http.Add($r)
  if ($r.ok -and $r.date) { break }
}
ConvertTo-Json -InputObject ([ordered]@{ adaptersUp = $up; dns = @($dns); http = @($http) }) -Depth 5 -Compress
`
}
