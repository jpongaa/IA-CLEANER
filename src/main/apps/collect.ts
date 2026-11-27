// Coletas SOMENTE LEITURA via PowerShell: registro (desinstalação, launchers, UserAssist, BAM, Prefetch)
// e apps da Microsoft Store. Dois scripts rodando em paralelo (cada spawn custa ~0,5 s).
import { runPowerShellJson } from '../core/powershell'

export interface RegUninstallEntry {
  hive: 'HKLM' | 'HKLM32' | 'HKCU' | 'HKCU32'
  key: string
  name: string
  publisher?: string | null
  version?: string | null
  /** KB */
  size?: number | null
  location?: string | null
  date?: string | null
  icon?: string | null
  uninstall?: string | null
  system?: number | null
  parent?: string | null
  release?: string | null
  noRemove?: number | null
  msi?: number | null
}

export interface UserAssistEntry {
  /** Caminho (pasta conhecida resolvida) ou AppUserModelID ('PFN!App') */
  p: string
  /** execuções */
  n: number
  /** ms em foco */
  f: number
  /** epoch ms da última execução */
  t: number | null
  /** destino do atalho .lnk */
  lnk?: string | null
}

export interface RegistryData {
  sid?: string | null
  steam: { path?: string | null; exe?: string | null; hklm?: string | null }
  uninstall: RegUninstallEntry[]
  ubisoft: { launcher?: string | null; installs: { id: string; dir?: string | null }[] }
  gog: { client?: string | null; games: { id: string; name?: string | null; path?: string | null; exe?: string | null }[] }
  ea: { desktop?: string | null; games: { key: string; dir?: string | null; name?: string | null }[] }
  rockstar: { launcher?: string | null; games: { key: string; dir?: string | null }[] }
  epic: { appData?: string | null }
  /** NtfsDisableLastAccessUpdate (bruto) */
  lastAccess?: number | null
  userAssist: { readable: boolean; entries: UserAssistEntry[] }
  bam: { readable: boolean; entries: { p: string; t: number }[] }
  prefetch: { readable: boolean; entries: { exe: string; t: number }[] }
  warnings: string[]
}

export interface StorePackage {
  name: string
  pfn: string
  fullName?: string
  version?: string
  publisher?: string
  location?: string
  signature?: string
  nonRemovable?: boolean
  isGame?: boolean
  /** Nome amigável (Menu Iniciar) */
  display?: string | null
  /** YYYY-MM-DD (criação da pasta do pacote) */
  date?: string | null
}

export interface StoreData {
  packages: StorePackage[]
  warnings: string[]
}

// String.raw: mantém as barras invertidas dos caminhos do registro. Não usar crase nem "${" no PowerShell.
const REGISTRY_SCRIPT = String.raw`
$warnings = New-Object System.Collections.ArrayList
function Warn([string]$m) { [void]$warnings.Add($m) }
$HKLM = [Microsoft.Win32.RegistryKey]::OpenBaseKey('LocalMachine', 'Registry64')
$HKCU = [Microsoft.Win32.RegistryKey]::OpenBaseKey('CurrentUser', 'Registry64')
function OpenK($base, [string]$p) { if (-not $base) { return $null }; try { return $base.OpenSubKey($p, $false) } catch { return $null } }
function RegStr($k, [string]$n) {
  if (-not $k) { return $null }
  try {
    $v = $k.GetValue($n, $null)
    if ($null -eq $v) { return $null }
    if ($v -is [string[]]) { return ($v -join ' ') }
    if ($v -is [byte[]]) { return $null }
    return [string]$v
  } catch { return $null }
}
function RegNum($k, [string]$n) {
  if (-not $k) { return $null }
  try { $v = $k.GetValue($n, $null); if ($null -eq $v -or $v -is [byte[]]) { return $null }; return [double]$v } catch { return $null }
}

# ---------- Entradas de desinstalação ----------
$uninst = New-Object System.Collections.ArrayList
$srcs = @(
  @{ b = $HKLM; p = 'SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall'; t = 'HKLM' },
  @{ b = $HKLM; p = 'SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'; t = 'HKLM32' },
  @{ b = $HKCU; p = 'Software\Microsoft\Windows\CurrentVersion\Uninstall'; t = 'HKCU' },
  @{ b = $HKCU; p = 'Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'; t = 'HKCU32' }
)
foreach ($s in $srcs) {
  $root = OpenK $s.b $s.p
  if (-not $root) { continue }
  foreach ($kn in $root.GetSubKeyNames()) {
    $k = OpenK $root $kn
    if (-not $k) { continue }
    try {
      $dn = RegStr $k 'DisplayName'
      if ($dn -and $dn.Trim()) {
        [void]$uninst.Add([ordered]@{
          hive = $s.t; key = $kn; name = $dn.Trim()
          publisher = RegStr $k 'Publisher'; version = RegStr $k 'DisplayVersion'
          size = RegNum $k 'EstimatedSize'; location = RegStr $k 'InstallLocation'; date = RegStr $k 'InstallDate'
          icon = RegStr $k 'DisplayIcon'; uninstall = RegStr $k 'UninstallString'
          system = RegNum $k 'SystemComponent'; parent = RegStr $k 'ParentKeyName'; release = RegStr $k 'ReleaseType'
          noRemove = RegNum $k 'NoRemove'; msi = RegNum $k 'WindowsInstaller'
        })
      }
    } catch { } finally { $k.Close() }
  }
  $root.Close()
}

# ---------- Steam ----------
$steam = [ordered]@{ path = $null; exe = $null; hklm = $null }
$k = OpenK $HKCU 'Software\Valve\Steam'
if ($k) { $steam.path = RegStr $k 'SteamPath'; $steam.exe = RegStr $k 'SteamExe'; $k.Close() }
$k = OpenK $HKLM 'SOFTWARE\WOW6432Node\Valve\Steam'
if ($k) { $steam.hklm = RegStr $k 'InstallPath'; $k.Close() }

# ---------- Ubisoft ----------
$ubi = [ordered]@{ launcher = $null; installs = @() }
$k = OpenK $HKLM 'SOFTWARE\WOW6432Node\Ubisoft\Launcher'
if ($k) { $ubi.launcher = RegStr $k 'InstallDir'; $k.Close() }
$k = OpenK $HKLM 'SOFTWARE\WOW6432Node\Ubisoft\Launcher\Installs'
if ($k) {
  $l = New-Object System.Collections.ArrayList
  foreach ($id in $k.GetSubKeyNames()) { $s2 = OpenK $k $id; if ($s2) { [void]$l.Add([ordered]@{ id = $id; dir = (RegStr $s2 'InstallDir') }); $s2.Close() } }
  $ubi.installs = @($l); $k.Close()
}

# ---------- GOG ----------
$gog = [ordered]@{ client = $null; games = @() }
$k = OpenK $HKLM 'SOFTWARE\WOW6432Node\GOG.com\GalaxyClient\paths'
if ($k) { $gog.client = RegStr $k 'client'; $k.Close() }
$k = OpenK $HKLM 'SOFTWARE\WOW6432Node\GOG.com\Games'
if ($k) {
  $l = New-Object System.Collections.ArrayList
  foreach ($id in $k.GetSubKeyNames()) { $s2 = OpenK $k $id; if ($s2) { [void]$l.Add([ordered]@{ id = $id; name = (RegStr $s2 'gameName'); path = (RegStr $s2 'path'); exe = (RegStr $s2 'exe') }); $s2.Close() } }
  $gog.games = @($l); $k.Close()
}

# ---------- EA ----------
$ea = [ordered]@{ desktop = $null; games = @() }
foreach ($p in @('SOFTWARE\WOW6432Node\Electronic Arts\EA Desktop', 'SOFTWARE\Electronic Arts\EA Desktop')) {
  $k = OpenK $HKLM $p
  if ($k) { if (-not $ea.desktop) { $ea.desktop = RegStr $k 'DesktopAppPath' }; $k.Close() }
}
$l = New-Object System.Collections.ArrayList
foreach ($p in @('SOFTWARE\WOW6432Node\EA Games', 'SOFTWARE\EA Games', 'SOFTWARE\WOW6432Node\Origin Games')) {
  $k = OpenK $HKLM $p
  if ($k) {
    foreach ($n in $k.GetSubKeyNames()) { $s2 = OpenK $k $n; if ($s2) { [void]$l.Add([ordered]@{ key = $n; dir = (RegStr $s2 'Install Dir'); name = (RegStr $s2 'DisplayName') }); $s2.Close() } }
    $k.Close()
  }
}
$ea.games = @($l)

# ---------- Rockstar ----------
$rs = [ordered]@{ launcher = $null; games = @() }
$k = OpenK $HKLM 'SOFTWARE\WOW6432Node\Rockstar Games'
if ($k) {
  $l = New-Object System.Collections.ArrayList
  foreach ($n in $k.GetSubKeyNames()) {
    $s2 = OpenK $k $n
    if ($s2) {
      $dir = RegStr $s2 'InstallFolder'
      if ($n -eq 'Launcher') { $rs.launcher = $dir } elseif ($dir -and $n -notmatch 'Social Club') { [void]$l.Add([ordered]@{ key = $n; dir = $dir }) }
      $s2.Close()
    }
  }
  $rs.games = @($l); $k.Close()
}

# ---------- Epic ----------
$epic = [ordered]@{ appData = $null }
$k = OpenK $HKLM 'SOFTWARE\WOW6432Node\Epic Games\EpicGamesLauncher'
if ($k) { $epic.appData = RegStr $k 'AppDataPath'; $k.Close() }

# ---------- Último acesso NTFS ----------
$lastAccess = $null
$k = OpenK $HKLM 'SYSTEM\CurrentControlSet\Control\FileSystem'
if ($k) { $lastAccess = RegNum $k 'NtfsDisableLastAccessUpdate'; $k.Close() }

# ---------- UserAssist (ROT13) ----------
function Rot13([string]$s) {
  $sb = New-Object System.Text.StringBuilder $s.Length
  foreach ($ch in $s.ToCharArray()) {
    $c = [int]$ch
    if ($c -ge 65 -and $c -le 90) { [void]$sb.Append([char](65 + (($c - 52) % 26))) }
    elseif ($c -ge 97 -and $c -le 122) { [void]$sb.Append([char](97 + (($c - 84) % 26))) }
    else { [void]$sb.Append($ch) }
  }
  $sb.ToString()
}
$kf = @{
  '{6D809377-6AF0-444B-8957-A3773F02200E}' = $env:ProgramW6432
  '{7C5A40EF-A0FB-4BFC-874A-C0F2E0B9FA8E}' = [Environment]::GetEnvironmentVariable('ProgramFiles(x86)')
  '{905E63B6-C1BF-494E-B29C-65B732D3D21A}' = $env:ProgramFiles
  '{F38BF404-1D43-42F2-9305-67DE0B28FC23}' = $env:windir
  '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}' = [Environment]::GetFolderPath('System')
  '{D65231B0-B2F1-4857-A4CE-A8E7C6EA7D27}' = [Environment]::GetFolderPath('SystemX86')
  '{0139D44E-6AFE-49F2-8690-3DAFCAE6FFB8}' = [Environment]::GetFolderPath('CommonPrograms')
  '{A77F5D77-2E2B-44C3-A6A2-ABA601054A51}' = [Environment]::GetFolderPath('Programs')
  '{9E3995AB-1F9C-4F13-B827-48B24B6C7174}' = (Join-Path $env:APPDATA 'Microsoft\Internet Explorer\Quick Launch\User Pinned')
  '{B4BFCC3A-DB2C-424C-B029-7FE99A87C641}' = [Environment]::GetFolderPath('Desktop')
  '{F1B32785-6FBA-4FCF-9D55-7B8E7F157091}' = $env:LOCALAPPDATA
  '{3EB685DB-65F9-4CF6-A03A-E3EF65729F3D}' = $env:APPDATA
  '{62AB5D82-FDC1-4DC3-A9DD-070D1D495D97}' = $env:ProgramData
  '{6365D5A7-0F0D-45E5-87F6-0DA56B6A4F7D}' = $env:CommonProgramW6432
  '{DE974D24-D9C6-4D3E-BF91-F4455120B917}' = [Environment]::GetEnvironmentVariable('CommonProgramFiles(x86)')
  '{374DE290-123F-4565-9164-39C4925E467B}' = (Join-Path $env:USERPROFILE 'Downloads')
  '{5E6C858F-0E22-4760-9AFE-EA3317B67173}' = $env:USERPROFILE
}
$ua = New-Object System.Collections.ArrayList
$uaOk = $false
$shell = $null
try { $shell = New-Object -ComObject WScript.Shell } catch { }
$uaRoot = OpenK $HKCU 'Software\Microsoft\Windows\CurrentVersion\Explorer\UserAssist'
if ($uaRoot) {
  foreach ($g in $uaRoot.GetSubKeyNames()) {
    $ck = OpenK $uaRoot ($g + '\Count')
    if (-not $ck) { continue }
    $uaOk = $true
    foreach ($vn in $ck.GetValueNames()) {
      try {
        $d = $ck.GetValue($vn)
        if (($d -is [byte[]]) -and $d.Length -ge 68) {
          $ft = [BitConverter]::ToInt64($d, 60)
          $t = $null
          if ($ft -gt 116444736000000000) { $t = [int64](($ft - 116444736000000000) / 10000) }
          $name = Rot13 $vn
          if ($name -match '^\{[0-9A-Fa-f-]{36}\}') {
            $gid = $name.Substring(0, 38).ToUpperInvariant()
            if ($kf.ContainsKey($gid) -and $kf[$gid]) { $name = $kf[$gid] + $name.Substring(38) }
          }
          $lnk = $null
          if ($shell -and $name -match '\.lnk$') {
            try { if (Test-Path -LiteralPath $name) { $lnk = $shell.CreateShortcut($name).TargetPath } } catch { }
          }
          [void]$ua.Add([ordered]@{ p = $name; n = [BitConverter]::ToInt32($d, 4); f = [BitConverter]::ToInt32($d, 12); t = $t; lnk = $lnk })
        }
      } catch { }
    }
    $ck.Close()
  }
  $uaRoot.Close()
}

# ---------- BAM (normalmente exige Administrador) ----------
$sid = $null
try { $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value } catch { }
$bam = [ordered]@{ readable = $false; entries = @() }
if ($sid) {
  $bl = New-Object System.Collections.ArrayList
  foreach ($p in @(('SYSTEM\CurrentControlSet\Services\bam\State\UserSettings\' + $sid), ('SYSTEM\CurrentControlSet\Services\bam\UserSettings\' + $sid))) {
    $k = $null
    try { $k = $HKLM.OpenSubKey($p, $false) } catch { $k = $null }
    if (-not $k) { continue }
    $bam.readable = $true
    foreach ($vn in $k.GetValueNames()) {
      try {
        $d = $k.GetValue($vn)
        if (($d -is [byte[]]) -and $d.Length -ge 8) {
          $ft = [BitConverter]::ToInt64($d, 0)
          if ($ft -gt 116444736000000000) { [void]$bl.Add([ordered]@{ p = $vn; t = [int64](($ft - 116444736000000000) / 10000) }) }
        }
      } catch { }
    }
    $k.Close()
  }
  if ($bl.Count -gt 0) {
    try {
      Add-Type -Namespace IaCleanerApps -Name Dos -MemberDefinition '[DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern uint QueryDosDevice(string lpDeviceName, System.Text.StringBuilder lpTargetPath, int ucchMax);'
      $map = @{}
      foreach ($dl in [IO.DriveInfo]::GetDrives()) {
        $sb = New-Object System.Text.StringBuilder 1024
        $letter = $dl.Name.Substring(0, 2)
        if ([IaCleanerApps.Dos]::QueryDosDevice($letter, $sb, 1024) -gt 0) { $map[$sb.ToString()] = $letter }
      }
      foreach ($e in $bl) {
        foreach ($dev in @($map.Keys)) {
          if ($e.p.StartsWith($dev + '\', [StringComparison]::OrdinalIgnoreCase)) { $e.p = $map[$dev] + $e.p.Substring($dev.Length); break }
        }
      }
    } catch { Warn ('bam-map: ' + $_.Exception.Message) }
  }
  $bam.entries = @($bl)
}

# ---------- Prefetch (normalmente exige Administrador) ----------
$pf = [ordered]@{ readable = $false; entries = @() }
try {
  $files = [IO.Directory]::GetFiles((Join-Path $env:windir 'Prefetch'), '*.pf')
  $pf.readable = $true
  $best = @{}
  $epoch = New-Object DateTime 1970, 1, 1, 0, 0, 0, ([DateTimeKind]::Utc)
  foreach ($f in $files) {
    $n = [IO.Path]::GetFileNameWithoutExtension($f)
    $i = $n.LastIndexOf('-')
    if ($i -gt 0) {
      $exe = $n.Substring(0, $i).ToLowerInvariant()
      $t = [int64](([IO.File]::GetLastWriteTimeUtc($f) - $epoch).TotalMilliseconds)
      if (-not $best.ContainsKey($exe) -or $best[$exe] -lt $t) { $best[$exe] = $t }
    }
  }
  $pfl = New-Object System.Collections.ArrayList
  foreach ($key in $best.Keys) { [void]$pfl.Add([ordered]@{ exe = $key; t = $best[$key] }) }
  $pf.entries = @($pfl)
} catch { }

$out = [ordered]@{
  sid = $sid; steam = $steam; uninstall = @($uninst); ubisoft = $ubi; gog = $gog; ea = $ea; rockstar = $rs; epic = $epic
  lastAccess = $lastAccess
  userAssist = [ordered]@{ readable = $uaOk; entries = @($ua) }
  bam = $bam; prefetch = $pf; warnings = @($warnings)
}
ConvertTo-Json -InputObject $out -Depth 6 -Compress
`

const STORE_SCRIPT = String.raw`
$warnings = New-Object System.Collections.ArrayList
$start = @{}
try {
  foreach ($a in @(Get-StartApps)) {
    $id = [string]$a.AppID
    $i = $id.IndexOf('!')
    if ($i -gt 0) { $pfn = $id.Substring(0, $i); if (-not $start.ContainsKey($pfn)) { $start[$pfn] = [string]$a.Name } }
  }
} catch { [void]$warnings.Add('start: ' + $_.Exception.Message) }
$list = New-Object System.Collections.ArrayList
try {
  foreach ($p in @(Get-AppxPackage -PackageTypeFilter Main -ErrorAction Stop)) {
    try {
      if ($p.IsFramework) { continue }
      $sig = [string]$p.SignatureKind
      if ($sig -ne 'Store' -and $sig -ne 'Developer') { continue }
      $pfn = [string]$p.PackageFamilyName
      $loc = [string]$p.InstallLocation
      $date = $null
      try { if ($loc) { $date = (Get-Item -LiteralPath $loc -ErrorAction Stop).CreationTime.ToString('yyyy-MM-dd') } } catch { }
      $disp = $null
      if ($start.ContainsKey($pfn)) { $disp = $start[$pfn] }
      [void]$list.Add([ordered]@{
        name = [string]$p.Name; pfn = $pfn; fullName = [string]$p.PackageFullName; version = [string]$p.Version
        publisher = [string]$p.Publisher; location = $loc; signature = $sig; nonRemovable = [bool]$p.NonRemovable
        isGame = [bool]$p.IsGameInstall; display = $disp; date = $date
      })
    } catch { }
  }
} catch { [void]$warnings.Add('appx: ' + $_.Exception.Message) }
ConvertTo-Json -InputObject ([ordered]@{ packages = @($list); warnings = @($warnings) }) -Depth 4 -Compress
`

function arr<T>(v: T[] | T | null | undefined): T[] {
  return Array.isArray(v) ? v : v ? [v] : []
}

export async function collectRegistry(): Promise<RegistryData> {
  const raw = await runPowerShellJson<Partial<RegistryData>>(REGISTRY_SCRIPT, { timeoutMs: 90_000 })
  return {
    sid: raw.sid ?? null,
    steam: raw.steam ?? {},
    uninstall: arr(raw.uninstall),
    ubisoft: { launcher: raw.ubisoft?.launcher ?? null, installs: arr(raw.ubisoft?.installs) },
    gog: { client: raw.gog?.client ?? null, games: arr(raw.gog?.games) },
    ea: { desktop: raw.ea?.desktop ?? null, games: arr(raw.ea?.games) },
    rockstar: { launcher: raw.rockstar?.launcher ?? null, games: arr(raw.rockstar?.games) },
    epic: raw.epic ?? {},
    lastAccess: raw.lastAccess ?? null,
    userAssist: { readable: Boolean(raw.userAssist?.readable), entries: arr(raw.userAssist?.entries) },
    bam: { readable: Boolean(raw.bam?.readable), entries: arr(raw.bam?.entries) },
    prefetch: { readable: Boolean(raw.prefetch?.readable), entries: arr(raw.prefetch?.entries) },
    warnings: arr(raw.warnings)
  }
}

export async function collectStore(): Promise<StoreData> {
  const raw = await runPowerShellJson<Partial<StoreData>>(STORE_SCRIPT, { timeoutMs: 60_000 })
  return { packages: arr(raw.packages), warnings: arr(raw.warnings) }
}

/** Registro vazio (quando o PowerShell falha): o resto do inventário continua funcionando. */
export function emptyRegistry(warning: string): RegistryData {
  return {
    steam: {},
    uninstall: [],
    ubisoft: { installs: [] },
    gog: { games: [] },
    ea: { games: [] },
    rockstar: { games: [] },
    epic: {},
    userAssist: { readable: false, entries: [] },
    bam: { readable: false, entries: [] },
    prefetch: { readable: false, entries: [] },
    warnings: [warning]
  }
}
