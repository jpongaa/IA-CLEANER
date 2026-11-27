// Coleta SOMENTE LEITURA (um único PowerShell) de tudo que "usa" uma pasta no Windows: serviços, drivers, tarefas
// agendadas, itens de inicialização, processos em execução, App Paths, PATH, produtos MSI registrados e as pastas
// do usuário (Downloads/Área de Trabalho reais). Usado para decidir se uma pasta tem dono (ownership.ts) e para
// achar programas que abrem com o Windows sem desinstalador.
import { runPowerShellJson } from '../core/powershell'

export interface ServiceSignal {
  name: string
  display?: string
  /** Linha de comando (ImagePath) */
  path?: string
  startMode?: string
  state?: string
  pid?: number
  driver?: boolean
}

export interface TaskSignal {
  path: string
  name: string
  exe?: string
  args?: string
  workDir?: string
  enabled: boolean
  /** Dispara ao entrar no Windows / ao iniciar o PC */
  autoStart: boolean
  /** Precisa de administrador para desativar */
  admin: boolean
  author?: string
}

export interface StartupSignal {
  /** Mesmo formato de performance/startup (run:HKCU:Nome, run32:HKLM:Nome, folder:user:App.lnk...) */
  id: string
  name: string
  command: string
  /** .exe/arquivo alvo resolvido */
  target?: string
  enabled: boolean
  admin: boolean
  location: string
}

export interface ProcessSignal {
  pid: number
  name: string
  path?: string
}

export interface SystemSignals {
  services: ServiceSignal[]
  tasks: TaskSignal[]
  startup: StartupSignal[]
  processes: ProcessSignal[]
  appPaths: string[]
  pathDirs: string[]
  /** GUIDs (formato {XXXXXXXX-...}) dos produtos MSI registrados (máquina e usuário) */
  msiProducts: string[]
  folders: { downloads?: string; desktop?: string; documents?: string; videos?: string }
  isAdmin: boolean
  warnings: string[]
}

const SCRIPT = String.raw`
$warn = New-Object System.Collections.ArrayList
function Arr($x) { if ($null -eq $x) { return @() }; return @($x) }
function Resolve-Exe([string]$cmd) {
  if (-not $cmd) { return $null }
  $c = [Environment]::ExpandEnvironmentVariables($cmd.Trim())
  if ($c.StartsWith('"')) { $i = $c.IndexOf('"', 1); if ($i -gt 1) { return $c.Substring(1, $i - 1) } ; return $c.Trim('"') }
  $m = [regex]::Match($c, '^(.+?\.(exe|com|bat|cmd|dll|sys|ps1|vbs|lnk))(\s|,|$)', 'IgnoreCase')
  if ($m.Success) { return $m.Groups[1].Value }
  return ($c -split '\s+')[0]
}
$out = [ordered]@{}
$isAdmin = $false
try { $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) } catch { }
$out.isAdmin = $isAdmin

# ---------- Serviços e drivers ----------
$svc = New-Object System.Collections.ArrayList
try {
  foreach ($s in @(Get-CimInstance Win32_Service -ErrorAction Stop)) {
    [void]$svc.Add([ordered]@{ name = [string]$s.Name; display = [string]$s.DisplayName; path = [string]$s.PathName; startMode = [string]$s.StartMode; state = [string]$s.State; pid = [int]$s.ProcessId; driver = $false })
  }
} catch { [void]$warn.Add('Serviços: ' + $_.Exception.Message) }
try {
  foreach ($s in @(Get-CimInstance Win32_SystemDriver -ErrorAction Stop)) {
    [void]$svc.Add([ordered]@{ name = [string]$s.Name; display = [string]$s.DisplayName; path = [string]$s.PathName; startMode = [string]$s.StartMode; state = [string]$s.State; pid = 0; driver = $true })
  }
} catch { [void]$warn.Add('Drivers: ' + $_.Exception.Message) }
$out.services = @($svc)

# ---------- Tarefas agendadas ----------
$tasks = New-Object System.Collections.ArrayList
try {
  $me = [Security.Principal.WindowsIdentity]::GetCurrent()
  $meName = ([string]$me.Name).ToLower(); $meShort = ($meName -split '\\')[-1]; $meSid = ([string]$me.User.Value).ToLower()
  foreach ($t in @(Get-ScheduledTask -ErrorAction Stop)) {
    $tp = [string]$t.TaskPath
    if ($tp -like '\Microsoft\*') { continue }
    $trig = @($t.Triggers | ForEach-Object { if ($_) { [string]$_.CimClass.CimClassName } })
    $auto = ($trig -contains 'MSFT_TaskLogonTrigger') -or ($trig -contains 'MSFT_TaskBootTrigger')
    $uid = ([string]$t.Principal.UserId).ToLower()
    $mine = ($uid -and (($uid -eq $meName) -or ($uid -eq $meShort) -or ($uid -eq $meSid)))
    $needAdmin = (-not $mine) -or ([string]$t.Principal.RunLevel -eq 'Highest')
    $acts = @($t.Actions | Where-Object { $_ -and $_.Execute })
    if ($acts.Count -eq 0) {
      [void]$tasks.Add([ordered]@{ path = $tp; name = [string]$t.TaskName; exe = $null; args = $null; workDir = $null; enabled = ([string]$t.State -ne 'Disabled'); autoStart = $auto; admin = $needAdmin; author = [string]$t.Author })
    }
    foreach ($a in $acts) {
      [void]$tasks.Add([ordered]@{
        path = $tp; name = [string]$t.TaskName
        exe = [Environment]::ExpandEnvironmentVariables(([string]$a.Execute).Trim().Trim('"'))
        args = [Environment]::ExpandEnvironmentVariables([string]$a.Arguments)
        workDir = [Environment]::ExpandEnvironmentVariables([string]$a.WorkingDirectory)
        enabled = ([string]$t.State -ne 'Disabled'); autoStart = $auto; admin = $needAdmin; author = [string]$t.Author
      })
    }
  }
} catch { [void]$warn.Add('Tarefas agendadas: ' + $_.Exception.Message) }
$out.tasks = @($tasks)

# ---------- Inicialização (Run/RunOnce/pastas) ----------
$items = New-Object System.Collections.ArrayList
$approvedBase = 'Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved'
function Get-ApprovedMap([string]$key) {
  $m = @{}
  try {
    $k = Get-Item -LiteralPath $key -ErrorAction Stop
    foreach ($n in $k.GetValueNames()) { $v = $k.GetValue($n); if ($v -is [byte[]] -and $v.Length -gt 0) { $m[$n] = [int]$v[0] } }
  } catch { }
  return $m
}
try {
  $runs = @(
    @{ path = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'; approved = ('HKCU:\' + $approvedBase + '\Run'); loc = 'Inicialização (usuário)'; admin = $false; idp = 'run:HKCU' },
    @{ path = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run'; approved = ('HKLM:\' + $approvedBase + '\Run'); loc = 'Inicialização (todos os usuários)'; admin = $true; idp = 'run:HKLM' },
    @{ path = 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Run'; approved = ('HKLM:\' + $approvedBase + '\Run32'); loc = 'Inicialização (todos, 32 bits)'; admin = $true; idp = 'run32:HKLM' },
    @{ path = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\RunOnce'; approved = $null; loc = 'Executar uma vez (usuário)'; admin = $false; idp = 'runonce:HKCU' },
    @{ path = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\RunOnce'; approved = $null; loc = 'Executar uma vez (todos)'; admin = $true; idp = 'runonce:HKLM' }
  )
  foreach ($r in $runs) {
    $k = $null
    try { $k = Get-Item -LiteralPath $r.path -ErrorAction Stop } catch { continue }
    $ap = @{}
    if ($r.approved) { $ap = Get-ApprovedMap $r.approved }
    foreach ($n in $k.GetValueNames()) {
      if (-not $n) { continue }
      $cmd = [string]$k.GetValue($n, $null, 'DoNotExpandEnvironmentNames')
      $enabled = $true
      if ($ap.ContainsKey($n)) { $enabled = (($ap[$n] -band 1) -eq 0) }
      [void]$items.Add([ordered]@{ id = ($r.idp + ':' + $n); name = $n; command = $cmd; target = (Resolve-Exe $cmd); enabled = $enabled; admin = $r.admin; location = $r.loc })
    }
  }
} catch { [void]$warn.Add('Inicialização (registro): ' + $_.Exception.Message) }
try {
  $sh = New-Object -ComObject WScript.Shell
  $folders = @(
    @{ dir = [Environment]::GetFolderPath('Startup'); approved = ('HKCU:\' + $approvedBase + '\StartupFolder'); loc = 'Pasta Inicializar (usuário)'; admin = $false; idp = 'folder:user' },
    @{ dir = [Environment]::GetFolderPath('CommonStartup'); approved = ('HKLM:\' + $approvedBase + '\StartupFolder'); loc = 'Pasta Inicializar (todos)'; admin = $true; idp = 'folder:common' }
  )
  foreach ($f in $folders) {
    if (-not $f.dir -or -not (Test-Path -LiteralPath $f.dir)) { continue }
    $ap = Get-ApprovedMap $f.approved
    foreach ($file in @(Get-ChildItem -LiteralPath $f.dir -File -Force -ErrorAction SilentlyContinue)) {
      if ($file.Name -ieq 'desktop.ini') { continue }
      $target = $file.FullName; $cmd = $file.FullName
      if ($file.Extension -ieq '.lnk') {
        try { $lnk = $sh.CreateShortcut($file.FullName); if ($lnk.TargetPath) { $target = [string]$lnk.TargetPath; $cmd = ('"' + $lnk.TargetPath + '" ' + $lnk.Arguments).Trim() } } catch { }
      }
      $enabled = $true
      if ($ap.ContainsKey($file.Name)) { $enabled = (($ap[$file.Name] -band 1) -eq 0) }
      [void]$items.Add([ordered]@{ id = ($f.idp + ':' + $file.Name); name = [IO.Path]::GetFileNameWithoutExtension($file.Name); command = $cmd; target = $target; enabled = $enabled; admin = $f.admin; location = $f.loc })
    }
  }
} catch { [void]$warn.Add('Inicialização (pastas): ' + $_.Exception.Message) }
$out.startup = @($items)

# ---------- Processos ----------
$procs = New-Object System.Collections.ArrayList
try {
  foreach ($p in @(Get-CimInstance Win32_Process -Property ProcessId, Name, ExecutablePath -ErrorAction Stop)) {
    [void]$procs.Add([ordered]@{ pid = [int]$p.ProcessId; name = [string]$p.Name; path = [string]$p.ExecutablePath })
  }
} catch { [void]$warn.Add('Processos: ' + $_.Exception.Message) }
$out.processes = @($procs)

# ---------- App Paths ----------
$ap = New-Object System.Collections.ArrayList
foreach ($root in @('HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths', 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths', 'HKCU:\Software\Microsoft\Windows\CurrentVersion\App Paths')) {
  try {
    foreach ($k in @(Get-ChildItem -LiteralPath $root -ErrorAction Stop)) {
      foreach ($vn in @('', 'Path')) {
        try { $v = [string]$k.GetValue($vn); if ($v) { [void]$ap.Add([Environment]::ExpandEnvironmentVariables($v.Trim().Trim('"'))) } } catch { }
      }
    }
  } catch { }
}
$out.appPaths = @($ap)

# ---------- PATH ----------
$pd = New-Object System.Collections.ArrayList
foreach ($scope in @('Machine', 'User')) {
  try { foreach ($x in ([string][Environment]::GetEnvironmentVariable('Path', $scope)).Split(';')) { if ($x.Trim()) { [void]$pd.Add([Environment]::ExpandEnvironmentVariables($x.Trim())) } } } catch { }
}
$out.pathDirs = @($pd)

# ---------- Produtos MSI registrados ----------
$msi = New-Object System.Collections.ArrayList
foreach ($root in @('HKLM:\SOFTWARE\Classes\Installer\Products', 'HKCU:\Software\Microsoft\Installer\Products')) {
  try { foreach ($k in @(Get-ChildItem -LiteralPath $root -ErrorAction Stop)) { [void]$msi.Add([string]$k.PSChildName) } } catch { }
}
$out.msiPacked = @($msi)

# ---------- Pastas do usuário ----------
$fo = [ordered]@{}
try {
  $usf = Get-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders' -ErrorAction Stop
  $dl = [string]$usf.'{374DE290-123F-4565-9164-39C4925E467B}'
  if ($dl) { $fo.downloads = [Environment]::ExpandEnvironmentVariables($dl) }
  if ($usf.Desktop) { $fo.desktop = [Environment]::ExpandEnvironmentVariables([string]$usf.Desktop) }
  if ($usf.Personal) { $fo.documents = [Environment]::ExpandEnvironmentVariables([string]$usf.Personal) }
  if ($usf.'My Video') { $fo.videos = [Environment]::ExpandEnvironmentVariables([string]$usf.'My Video') }
} catch { [void]$warn.Add('Pastas do usuário: ' + $_.Exception.Message) }
$out.folders = $fo
$out.warnings = @($warn)
ConvertTo-Json -InputObject $out -Depth 6 -Compress
`

function arr<T>(x: T[] | T | null | undefined): T[] {
  return Array.isArray(x) ? x : x ? [x] : []
}

/** {GUID} a partir do formato "empacotado" do Windows Installer (32 hex, grupos invertidos). */
export function unpackMsiGuid(packed: string): string | null {
  const s = packed.trim()
  if (!/^[0-9a-f]{32}$/i.test(s)) return null
  const rev = (x: string): string => x.split('').reverse().join('')
  const pairs = (x: string): string => x.match(/../g)!.map(rev).join('')
  const a = rev(s.slice(0, 8))
  const b = rev(s.slice(8, 12))
  const c = rev(s.slice(12, 16))
  const d = pairs(s.slice(16, 20))
  const e = pairs(s.slice(20, 32))
  return `{${a}-${b}-${c}-${d}-${e}}`.toUpperCase()
}

interface RawSignals {
  isAdmin?: boolean
  services?: ServiceSignal[] | ServiceSignal
  tasks?: TaskSignal[] | TaskSignal
  startup?: StartupSignal[] | StartupSignal
  processes?: ProcessSignal[] | ProcessSignal
  appPaths?: string[] | string
  pathDirs?: string[] | string
  msiPacked?: string[] | string
  folders?: SystemSignals['folders']
  warnings?: string[] | string
}

const empty = (s: string | null | undefined): string | undefined => (s && s.trim() ? s.trim() : undefined)

export function normalizeSignals(raw: RawSignals): SystemSignals {
  return {
    isAdmin: Boolean(raw.isAdmin),
    services: arr(raw.services).map((s) => ({ ...s, path: empty(s.path), display: empty(s.display) })),
    tasks: arr(raw.tasks).map((t) => ({ ...t, exe: empty(t.exe), args: empty(t.args), workDir: empty(t.workDir) })),
    startup: arr(raw.startup).map((s) => ({ ...s, target: empty(s.target) })),
    processes: arr(raw.processes).map((p) => ({ ...p, path: empty(p.path) })),
    appPaths: arr(raw.appPaths).filter(Boolean),
    pathDirs: arr(raw.pathDirs).filter(Boolean),
    msiProducts: arr(raw.msiPacked)
      .map((p) => unpackMsiGuid(p))
      .filter((g): g is string => Boolean(g)),
    folders: raw.folders ?? {},
    warnings: arr(raw.warnings)
  }
}

export async function collectSignals(): Promise<SystemSignals> {
  const raw = await runPowerShellJson<RawSignals>(SCRIPT, { timeoutMs: 90_000 })
  return normalizeSignals(raw ?? {})
}

export function emptySignals(warning?: string): SystemSignals {
  return { services: [], tasks: [], startup: [], processes: [], appPaths: [], pathDirs: [], msiProducts: [], folders: {}, isAdmin: false, warnings: warning ? [warning] : [] }
}

/** Primeiro caminho absoluto (X:\...) de uma linha de comando (com ou sem aspas). */
export function exeFromCommand(cmd: string | undefined | null): string | undefined {
  if (!cmd) return undefined
  let c = cmd.trim().replace(/^\\\?\?\\/, '')
  c = c.replace(/%([^%\s]+)%/g, (all, name: string) => {
    const key = Object.keys(process.env).find((k) => k.toLowerCase() === name.toLowerCase())
    return key ? (process.env[key] ?? all) : all
  })
  if (/^\\SystemRoot\\/i.test(c)) c = (process.env.SystemRoot ?? 'C:\\Windows') + c.slice('\\SystemRoot'.length)
  if (/^system32\\/i.test(c)) c = (process.env.SystemRoot ?? 'C:\\Windows') + '\\' + c
  if (c.startsWith('"')) {
    const i = c.indexOf('"', 1)
    return i > 1 ? c.slice(1, i) : c.slice(1)
  }
  const m = /^([a-z]:\\.+?\.(exe|com|bat|cmd|dll|sys|ps1|vbs|lnk|jar))(\s|,|$)/i.exec(c)
  if (m) return m[1]
  const first = c.split(/\s+/)[0]
  return /^[a-z]:\\/i.test(first) ? first : undefined
}

/** Todos os caminhos absolutos citados numa linha de comando (inclusive argumentos entre aspas). */
export function pathsInCommand(cmd: string | undefined | null): string[] {
  if (!cmd) return []
  const out = new Set<string>()
  const exe = exeFromCommand(cmd)
  if (exe) out.add(exe)
  for (const m of cmd.matchAll(/"([a-z]:\\[^"]+)"/gi)) out.add(m[1])
  for (const m of cmd.matchAll(/(?:^|\s|=)([a-z]:\\[^\s"]+)/gi)) out.add(m[1])
  return [...out]
}
