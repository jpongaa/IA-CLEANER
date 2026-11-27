// Scripts PowerShell (somente leitura) da coleta de desempenho.
// Escritos com String.raw para preservar as barras invertidas dos caminhos do registro.
// Regras: cada parte em try/catch (adiciona aviso em $warn), nada de crase, saída única em JSON.
// Observação: em alguns PCs as classes Win32_PerfFormattedData_* não existem ("Classe inválida"),
// então CPU por processo é medida amostrando Win32_Process (tempo de CPU) duas vezes.
import { psQuote } from '../core/powershell'
import { CDM_KEY, CDM_VALUES, UPDATER_NAME_PS_REGEX } from './catalogData'
import { PERF_CORE_LIBS, PERF_DISABLE_VALUE, PERFLIB_KEY } from './util'

/**
 * Recursos do Windows que gastam memória, atualizadores de terceiros e DNS dos adaptadores ativos (somente leitura,
 * rápido: registro, Get-Process e .NET). Parte do STATE_BODY (usado pelo catálogo e pela coleta).
 */
export const FEATURES_BODY = String.raw`
try {
  $adv = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced'
  $f = [ordered]@{}
  $f.dsh = Get-RegValue 'HKLM:\SOFTWARE\Policies\Microsoft\Dsh' 'AllowNewsAndInterests'
  $f.taskbarDa = Get-RegValue $adv 'TaskbarDa'
  $f.searchPolicy = Get-RegValue 'HKCU:\Software\Policies\Microsoft\Windows\Explorer' 'DisableSearchBoxSuggestions'
  $f.bing = Get-RegValue 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Search' 'BingSearchEnabled'
  $cdm = [ordered]@{}
  foreach ($n in @(${CDM_VALUES.map((v) => psQuote(v)).join(', ')})) { $cdm[$n] = Get-RegValue ${psQuote(CDM_KEY)} $n }
  $f.cdm = $cdm
  $f.iris = Get-RegValue $adv 'Start_IrisRecommendations'
  $f.syncNotif = Get-RegValue $adv 'ShowSyncProviderNotifications'
  $f.scoobe = Get-RegValue 'HKCU:\Software\Microsoft\Windows\CurrentVersion\UserProfileEngagement' 'ScoobeSystemSettingEnabled'
  $pf86 = [Environment]::GetFolderPath('ProgramFilesX86')
  $pf64 = [Environment]::GetFolderPath('ProgramFiles')
  $edgeExe = (Join-Path $pf86 'Microsoft\Edge\Application\msedge.exe')
  $f.edge = [ordered]@{ boost = (Get-RegValue 'HKLM:\SOFTWARE\Policies\Microsoft\Edge' 'StartupBoostEnabled'); background = (Get-RegValue 'HKLM:\SOFTWARE\Policies\Microsoft\Edge' 'BackgroundModeEnabled'); installed = ((Test-Path -LiteralPath $edgeExe) -or (Test-Path -LiteralPath (Join-Path $pf64 'Microsoft\Edge\Application\msedge.exe'))) }
  $chromeIn = $false
  foreach ($c in @((Join-Path $pf64 'Google\Chrome\Application\chrome.exe'), (Join-Path $pf86 'Google\Chrome\Application\chrome.exe'), (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe'))) { if (Test-Path -LiteralPath $c) { $chromeIn = $true } }
  $f.chrome = [ordered]@{ background = (Get-RegValue 'HKLM:\SOFTWARE\Policies\Google\Chrome' 'BackgroundModeEnabled'); installed = $chromeIn }
  $f.bgApps = Get-RegValue 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\AppPrivacy' 'LetAppsRunInBackground'
  $f.defaultBrowser = Get-RegValue 'HKCU:\Software\Microsoft\Windows\Shell\Associations\UrlAssociations\https\UserChoice' 'ProgId'
  $procs = [ordered]@{}
  foreach ($g in @(Get-Process -Name 'Widgets','WidgetService','msedge','msedgewebview2','chrome' -ErrorAction SilentlyContinue | Group-Object { $_.ProcessName.ToLower() })) {
    $ws = 0.0; $pv = 0.0
    foreach ($p in $g.Group) { $ws += [double]$p.WorkingSet64; $pv += [double]$p.PrivateMemorySize64 }
    $procs[[string]$g.Name] = [ordered]@{ count = $g.Count; ws = $ws; priv = $pv }
  }
  $f.procs = $procs
  $state.features = $f
} catch { [void]$warn.Add('Recursos do Windows: ' + $_.Exception.Message) }

try {
  $ups = New-Object System.Collections.ArrayList
  $svcRoot = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('SYSTEM\CurrentControlSet\Services')
  foreach ($n in @($svcRoot.GetSubKeyNames() | Where-Object { $_ -match ${psQuote(UPDATER_NAME_PS_REGEX)} })) {
    $k = $svcRoot.OpenSubKey($n)
    if (-not $k) { continue }
    $start = $k.GetValue('Start'); $delayed = $k.GetValue('DelayedAutostart'); $img = [string]$k.GetValue('ImagePath', '', 'DoNotExpandEnvironmentNames'); $dn = [string]$k.GetValue('DisplayName')
    $k.Close()
    $status = $null
    try { $status = [string](Get-Service -Name $n -ErrorAction Stop).Status } catch {}
    [void]$ups.Add([ordered]@{ name = $n; displayName = $dn; start = $start; delayed = $delayed; path = $img; status = $status })
  }
  $svcRoot.Close()
  $state.updaterServices = @($ups)
} catch { [void]$warn.Add('Atualizadores: ' + $_.Exception.Message) }

try {
  $adapters = New-Object System.Collections.ArrayList
  foreach ($ni in [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()) {
    if ([string]$ni.OperationalStatus -ne 'Up') { continue }
    $t = [string]$ni.NetworkInterfaceType
    if ($t -eq 'Loopback' -or $t -eq 'Tunnel') { continue }
    $ip = $ni.GetIPProperties()
    $gws = @($ip.GatewayAddresses | ForEach-Object { $_.Address.ToString() } | Where-Object { $_ -and $_ -ne '0.0.0.0' -and $_ -ne '::' })
    if ($gws.Count -eq 0) { continue }
    $v4 = @($ip.DnsAddresses | Where-Object { [string]$_.AddressFamily -eq 'InterNetwork' } | ForEach-Object { $_.ToString() })
    $v6 = @($ip.DnsAddresses | Where-Object { [string]$_.AddressFamily -eq 'InterNetworkV6' } | ForEach-Object { $_.ToString() } | Where-Object { $_ -notmatch '^fec0:' } | Select-Object -Unique)
    $idx = $null
    try { $idx = $ip.GetIPv4Properties().Index } catch {}
    $guid = [string]$ni.Id
    $ns4 = [string](Get-RegValue ('HKLM:\SYSTEM\CurrentControlSet\Services\Tcpip\Parameters\Interfaces\' + $guid) 'NameServer')
    $ns6 = [string](Get-RegValue ('HKLM:\SYSTEM\CurrentControlSet\Services\Tcpip6\Parameters\Interfaces\' + $guid) 'NameServer')
    [void]$adapters.Add([ordered]@{ index = $idx; alias = [string]$ni.Name; description = [string]$ni.Description; guid = $guid; v4 = @($v4); v6 = @($v6); v4Static = [bool]($ns4.Trim()); v6Static = [bool]($ns6.Trim()) })
  }
  $state.dns = @($adapters)
} catch { [void]$warn.Add('DNS: ' + $_.Exception.Message) }
`

/** Funções auxiliares comuns a todos os scripts. */
export const PS_HELPERS = String.raw`
$warn = New-Object System.Collections.ArrayList
function Get-RegValue([string]$path, [string]$name) {
  try {
    $k = Get-Item -LiteralPath $path -ErrorAction Stop
    if ($k.GetValueNames() -contains $name) { return $k.GetValue($name) }
  } catch {}
  return $null
}
function To-Iso($d) {
  if ($null -eq $d) { return $null }
  try { return ([DateTime]$d).ToUniversalTime().ToString('o') } catch { return $null }
}
function Invoke-Native([scriptblock]$sb) {
  $ErrorActionPreference = 'Continue'
  try { return ((& $sb 2>&1 | ForEach-Object { [string]$_ }) -join [Environment]::NewLine) } catch { return '' }
}
$__bareCache = @{}
function Resolve-Bare([string]$p) {
  # Nome sem pasta (rundll32.exe, cmd, wscript.exe): o Windows procura no PATH/System32 — nunca na pasta atual.
  if (-not $p) { return $p }
  if ($p -match '^[A-Za-z]:\\|^\\\\|[\\/]') { return $p }
  if ($__bareCache.ContainsKey($p)) { return $__bareCache[$p] }
  $r = $p
  try {
    $gc = @(Get-Command -Name $p -CommandType Application -ErrorAction Stop) | Select-Object -First 1
    if ($gc -and $gc.Source -and ($gc.Source -match '^[A-Za-z]:\\|^\\\\')) { $r = [string]$gc.Source }
  } catch {}
  if ($r -eq $p) {
    foreach ($d in @((Join-Path $env:SystemRoot 'System32'), $env:SystemRoot)) {
      foreach ($n in @($p, ($p + '.exe'))) {
        $f = Join-Path $d $n
        if (Test-Path -LiteralPath $f -PathType Leaf) { $r = $f; break }
      }
      if ($r -ne $p) { break }
    }
  }
  $__bareCache[$p] = $r
  return $r
}
function Resolve-Exe([string]$cmd) {
  if (-not $cmd) { return $null }
  $c = [Environment]::ExpandEnvironmentVariables($cmd.Trim())
  $e = $null
  if ($c -match '^"([^"]+)"') { $e = $matches[1] }
  elseif ($c -match '^(.+?\.(exe|com|bat|cmd|lnk|vbs|ps1))(\s|$)') { $e = $matches[1] }
  else { $e = ($c -split '\s+')[0] }
  return (Resolve-Bare $e)
}
function Get-VerInfo([string]$path, $cache) {
  if (-not $path) { return $null }
  # Caminho relativo seria testado contra a pasta ATUAL do processo (resultado aleatório): só caminho absoluto.
  if ($path -notmatch '^[A-Za-z]:\\|^\\\\') { return $null }
  if ($cache.ContainsKey($path)) { return $cache[$path] }
  $r = $null
  try {
    if (Test-Path -LiteralPath $path -PathType Leaf) {
      $vi = [Diagnostics.FileVersionInfo]::GetVersionInfo($path)
      $len = (New-Object IO.FileInfo($path)).Length
      $r = [ordered]@{ d = ([string]$vi.FileDescription).Trim(); c = ([string]$vi.CompanyName).Trim(); n = [double]$len }
    }
  } catch {}
  $cache[$path] = $r
  return $r
}
`

/** Estado das configurações que as otimizações alteram (rápido; usado também por listActions). */
export const STATE_BODY = String.raw`
$state = [ordered]@{}
$guidRx = '([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})'
try {
  $activeTxt = Invoke-Native { powercfg /getactivescheme }
  $listTxt = Invoke-Native { powercfg /list }
  $schemes = New-Object System.Collections.ArrayList
  foreach ($line in ($listTxt -split '\r?\n')) {
    if ($line -match ($guidRx + '\s*\((.+)\)\s*(\*?)\s*$')) {
      [void]$schemes.Add([ordered]@{ guid = $matches[1].ToLower(); name = $matches[2].Trim(); active = ($matches[3] -eq '*') })
    }
  }
  $ag = $null; $an = $null
  if ($activeTxt -match $guidRx) { $ag = $matches[1].ToLower() }
  if ($activeTxt -match '\((.+)\)\s*$') { $an = $matches[1].Trim() }
  $state.power = [ordered]@{ guid = $ag; name = $an; schemes = @($schemes) }
} catch { [void]$warn.Add('Plano de energia: ' + $_.Exception.Message) }

try {
  $pw = 'HKLM:\SYSTEM\CurrentControlSet\Control\Power'
  $hfs = $null
  try {
    $f = Get-ChildItem -LiteralPath ($env:SystemDrive + '\') -Force -Filter 'hiberfil.sys' -ErrorAction Stop | Select-Object -First 1
    if ($f) { $hfs = [double]$f.Length }
  } catch {}
  $state.hibernation = [ordered]@{
    enabledValue = Get-RegValue $pw 'HibernateEnabled'
    enabledDefault = Get-RegValue $pw 'HibernateEnabledDefault'
    fileType = Get-RegValue $pw 'HiberFileType'
    fileBytes = $hfs
    hiberboot = Get-RegValue 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Power' 'HiberbootEnabled'
  }
} catch { [void]$warn.Add('Hibernação: ' + $_.Exception.Message) }

try {
  $state.gaming = [ordered]@{
    autoGameMode = Get-RegValue 'HKCU:\Software\Microsoft\GameBar' 'AutoGameModeEnabled'
    gameDvrEnabled = Get-RegValue 'HKCU:\System\GameConfigStore' 'GameDVR_Enabled'
    appCapture = Get-RegValue 'HKCU:\Software\Microsoft\Windows\CurrentVersion\GameDVR' 'AppCaptureEnabled'
    historicalCapture = Get-RegValue 'HKCU:\Software\Microsoft\Windows\CurrentVersion\GameDVR' 'HistoricalCaptureEnabled'
    policyAllow = Get-RegValue 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\GameDVR' 'AllowGameDVR'
    hwSchMode = Get-RegValue 'HKLM:\SYSTEM\CurrentControlSet\Control\GraphicsDrivers' 'HwSchMode'
  }
} catch { [void]$warn.Add('Configurações de jogos: ' + $_.Exception.Message) }

try {
  $state.visual = [ordered]@{
    fx = Get-RegValue 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\VisualEffects' 'VisualFXSetting'
    transparency = Get-RegValue 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize' 'EnableTransparency'
    taskbarAnim = Get-RegValue 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced' 'TaskbarAnimations'
  }
  $state.storageSense = Get-RegValue 'HKCU:\Software\Microsoft\Windows\CurrentVersion\StorageSense\Parameters\StoragePolicy' '01'
} catch { [void]$warn.Add('Efeitos visuais: ' + $_.Exception.Message) }

try {
  $cs = Get-CimInstance Win32_ComputerSystem -Property AutomaticManagedPagefile,PCSystemType
  $files = @(Get-CimInstance Win32_PageFileUsage -ErrorAction SilentlyContinue | ForEach-Object {
    [ordered]@{ path = [string]$_.Name; allocatedMb = [double]$_.AllocatedBaseSize; currentMb = [double]$_.CurrentUsage; peakMb = [double]$_.PeakUsage }
  })
  $pf = (Get-ItemProperty -LiteralPath 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Memory Management' -Name PagingFiles -ErrorAction SilentlyContinue).PagingFiles
  $state.pagefile = [ordered]@{ automatic = [bool]$cs.AutomaticManagedPagefile; files = $files; settings = @($pf | Where-Object { $_ }) }
  $state.pcSystemType = [int]$cs.PCSystemType
} catch { [void]$warn.Add('Arquivo de paginação: ' + $_.Exception.Message) }

try {
  $t = Invoke-Native { fsutil behavior query DisableDeleteNotify }
  $ntfs = $null; $refs = $null
  if ($t -match 'NTFS\s+DisableDeleteNotify\s*=\s*(\d+)') { $ntfs = [int]$matches[1] }
  elseif ($t -match 'DisableDeleteNotify\s*=\s*(\d+)') { $ntfs = [int]$matches[1] }
  if ($t -match 'ReFS\s+DisableDeleteNotify\s*=\s*(\d+)') { $refs = [int]$matches[1] }
  $state.trim = [ordered]@{ ntfs = $ntfs; refs = $refs }
} catch { [void]$warn.Add('TRIM: ' + $_.Exception.Message) }

# Bateria e "ação de bateria crítica" (0 nada, 1 suspender, 2 hibernar, 3 desligar): importa para avisar sobre a hibernação.
$state.battery = [ordered]@{ present = $false; critAc = $null; critDc = $null }
try { $state.battery.present = (@(Get-CimInstance Win32_Battery -ErrorAction Stop).Count -gt 0) } catch {}
if ($state.battery.present -or $state.pcSystemType -eq 2) {
  try {
    $q = Invoke-Native { powercfg /q SCHEME_CURRENT SUB_BATTERY BATACTIONCRIT }
    $mm = [regex]::Matches([string]$q, ':\s*0x([0-9a-fA-F]+)\s*$', [Text.RegularExpressions.RegexOptions]::Multiline)
    if ($mm.Count -ge 2) {
      $state.battery.critAc = [Convert]::ToInt32($mm[0].Groups[1].Value, 16)
      $state.battery.critDc = [Convert]::ToInt32($mm[1].Groups[1].Value, 16)
    }
  } catch {}
}

$state.perfCountersOk = $true
try { $null = Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory -ErrorAction Stop } catch { $state.perfCountersOk = $false }
# Contadores desligados por configuração (causa comum de "Classe inválida"; lodctr /R não mexe nisso).
$state.perfCounters = [ordered]@{ disabledGlobal = $null; disabledLibs = @() }
try {
  $state.perfCounters.disabledGlobal = Get-RegValue ${psQuote(PERFLIB_KEY)} ${psQuote(PERF_DISABLE_VALUE)}
  $libs = New-Object System.Collections.ArrayList
  foreach ($n in @(${PERF_CORE_LIBS.map((n) => psQuote(n)).join(', ')})) {
    $v = Get-RegValue ('HKLM:\SYSTEM\CurrentControlSet\Services\' + $n + '\Performance') ${psQuote(PERF_DISABLE_VALUE)}
    $iv = 0
    if ($null -ne $v) { try { $iv = [int64]$v } catch { $iv = 1 } }
    if ($iv -ne 0) { [void]$libs.Add($n) }
  }
  $state.perfCounters.disabledLibs = @($libs)
} catch { [void]$warn.Add('Contadores de desempenho: ' + $_.Exception.Message) }

try {
  $vols = @{}
  foreach ($v in @(Get-CimInstance Win32_Volume -Property DeviceID,DriveLetter -ErrorAction Stop)) {
    if ($v.DriveLetter) {
      $g = ([string]$v.DeviceID) -replace '^\\\\\?\\','' -replace '\\$',''
      $vols[$g.ToLower()] = [string]$v.DriveLetter
    }
  }
  $frag = New-Object System.Collections.ArrayList
  foreach ($k in @(Get-ChildItem -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Dfrg\Statistics' -ErrorAction SilentlyContinue)) {
    $letter = $vols[([string]$k.PSChildName).ToLower()]
    if (-not $letter) { continue }
    $p = Get-ItemProperty -LiteralPath $k.PSPath
    $last = $null
    $st = $p.LastRunTime
    if ($st -is [byte[]] -and $st.Length -ge 14) {
      $y = [BitConverter]::ToUInt16($st, 0); $mo = [BitConverter]::ToUInt16($st, 2); $dd = [BitConverter]::ToUInt16($st, 6)
      $hh = [BitConverter]::ToUInt16($st, 8); $mi = [BitConverter]::ToUInt16($st, 10); $ss = [BitConverter]::ToUInt16($st, 12)
      if ($y -gt 2000 -and $mo -ge 1 -and $mo -le 12) {
        try { $last = [DateTime]::new([int]$y, [int]$mo, [int]$dd, [int]$hh, [int]$mi, [int]$ss, [DateTimeKind]::Utc).ToString('o') } catch {}
      }
    }
    [void]$frag.Add([ordered]@{ letter = $letter; percent = [int]$p.LastRunPercentFragmentation; lastRun = $last })
  }
  $state.fragmentation = @($frag)
  $state.scheduledOptimize = $null
  try {
    $sch = New-Object -ComObject Schedule.Service
    $sch.Connect()
    $state.scheduledOptimize = [bool]$sch.GetFolder('\Microsoft\Windows\Defrag').GetTask('ScheduledDefrag').Enabled
  } catch {}
} catch { [void]$warn.Add('Fragmentação: ' + $_.Exception.Message) }
${FEATURES_BODY}
`

export const STATE_SCRIPT = `${PS_HELPERS}
${STATE_BODY}
ConvertTo-Json -InputObject ([ordered]@{ state = $state; warnings = @($warn) }) -Depth 8 -Compress
`

/** Sistema, memória, pentes de RAM, GPU, segurança, reinício pendente, boot. Inclui STATE_BODY. */
export const SYSTEM_SCRIPT = String.raw`${PS_HELPERS}
${STATE_BODY}
$sys = [ordered]@{}
try {
  $os = Get-CimInstance Win32_OperatingSystem -Property Caption,Version,BuildNumber,InstallDate,LastBootUpTime,TotalVisibleMemorySize,FreePhysicalMemory,TotalVirtualMemorySize,FreeVirtualMemory
  $cv = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
  $sys.os = [ordered]@{
    caption = ([string]$os.Caption).Trim()
    version = [string]$os.Version
    build = [string]$os.BuildNumber
    ubr = Get-RegValue $cv 'UBR'
    displayVersion = Get-RegValue $cv 'DisplayVersion'
    installDate = To-Iso $os.InstallDate
    lastBoot = To-Iso $os.LastBootUpTime
    uptimeSec = [double]((Get-Date) - [DateTime]$os.LastBootUpTime).TotalSeconds
    totalKb = [double]$os.TotalVisibleMemorySize
    freeKb = [double]$os.FreePhysicalMemory
    virtTotalKb = [double]$os.TotalVirtualMemorySize
    virtFreeKb = [double]$os.FreeVirtualMemory
  }
} catch { [void]$warn.Add('Sistema operacional: ' + $_.Exception.Message) }

if ($state.perfCountersOk) {
  try {
    $pm = Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory -ErrorAction Stop
    $sys.perfMem = [ordered]@{ committed = [double]$pm.CommittedBytes; limit = [double]$pm.CommitLimit; available = [double]$pm.AvailableBytes }
  } catch {}
}

try {
  $cpus = @(Get-CimInstance Win32_Processor -Property Name,NumberOfCores,NumberOfLogicalProcessors,CurrentClockSpeed,MaxClockSpeed,LoadPercentage)
  $sys.cpu = [ordered]@{
    name = ([string]$cpus[0].Name).Trim()
    cores = [int](($cpus | Measure-Object -Property NumberOfCores -Sum).Sum)
    threads = [int](($cpus | Measure-Object -Property NumberOfLogicalProcessors -Sum).Sum)
    currentMhz = [int]$cpus[0].CurrentClockSpeed
    maxMhz = [int]$cpus[0].MaxClockSpeed
    load = $cpus[0].LoadPercentage
  }
} catch { [void]$warn.Add('Processador: ' + $_.Exception.Message) }

try {
  $mods = New-Object System.Collections.ArrayList
  foreach ($m in @(Get-CimInstance Win32_PhysicalMemory)) {
    [void]$mods.Add([ordered]@{
      bank = ([string]$m.BankLabel).Trim(); locator = ([string]$m.DeviceLocator).Trim(); capacity = [double]$m.Capacity
      speed = [int]$m.Speed; configured = [int]$m.ConfiguredClockSpeed; part = ([string]$m.PartNumber).Trim()
      manufacturer = ([string]$m.Manufacturer).Trim(); smbiosType = [int]$m.SMBIOSMemoryType; memoryType = [int]$m.MemoryType
      formFactor = [int]$m.FormFactor
    })
  }
  $slots = 0
  foreach ($arr in @(Get-CimInstance Win32_PhysicalMemoryArray -ErrorAction SilentlyContinue)) {
    if ($null -eq $arr.Use -or [int]$arr.Use -eq 3) { $slots += [int]$arr.MemoryDevices }
  }
  $sys.ram = [ordered]@{ modules = @($mods); slots = $slots }
} catch { [void]$warn.Add('Pentes de memória: ' + $_.Exception.Message) }

try {
  $sys.gpus = @(Get-CimInstance Win32_VideoController -Property Name,AdapterRAM,PNPDeviceID -ErrorAction Stop | ForEach-Object {
    [ordered]@{ name = ([string]$_.Name).Trim(); ram = [double]$_.AdapterRAM; pnp = [string]$_.PNPDeviceID }
  })
} catch { [void]$warn.Add('Placa de vídeo: ' + $_.Exception.Message) }

try { $sys.hasBattery = (@(Get-CimInstance Win32_Battery -ErrorAction Stop).Count -gt 0) } catch { $sys.hasBattery = $false }

try {
  $reasons = New-Object System.Collections.ArrayList
  if (Test-Path -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending') { [void]$reasons.Add('cbs') }
  if (Test-Path -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired') { [void]$reasons.Add('wu') }
  $pfro = (Get-ItemProperty -LiteralPath 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager' -Name PendingFileRenameOperations -ErrorAction SilentlyContinue).PendingFileRenameOperations
  if ($pfro -and @($pfro | Where-Object { $_ }).Count -gt 0) { [void]$reasons.Add('pfro') }
  $sys.pendingReboot = @($reasons)
} catch { [void]$warn.Add('Reinício pendente: ' + $_.Exception.Message) }

try {
  $av = New-Object System.Collections.ArrayList
  foreach ($p in @(Get-CimInstance -Namespace 'root\SecurityCenter2' -ClassName AntiVirusProduct -ErrorAction Stop)) {
    [void]$av.Add([ordered]@{ name = [string]$p.displayName; state = [int64]$p.productState })
  }
  $sys.antivirus = @($av)
} catch { [void]$warn.Add('Antivírus (Central de Segurança): ' + $_.Exception.Message) }

try {
  $mp = Get-MpComputerStatus -ErrorAction Stop
  $sys.defender = [ordered]@{ realtime = [bool]$mp.RealTimeProtectionEnabled; antivirus = [bool]$mp.AntivirusEnabled; mode = [string]$mp.AMRunningMode }
} catch {}

try {
  $e = Get-WinEvent -FilterHashtable @{ LogName = 'Microsoft-Windows-Diagnostics-Performance/Operational'; Id = 100 } -MaxEvents 1 -ErrorAction Stop
  $x = [xml]$e.ToXml()
  $bt = ($x.Event.EventData.Data | Where-Object { $_.Name -eq 'BootTime' } | Select-Object -First 1).'#text'
  if ($bt) { $sys.boot = [ordered]@{ ms = [double]$bt; at = To-Iso $e.TimeCreated } }
} catch {}

ConvertTo-Json -InputObject ([ordered]@{ state = $state; sys = $sys; warnings = @($warn) }) -Depth 8 -Compress
`

/** Processos (amostra de CPU por 1,5 s) e serviços em execução. */
export const PROCS_SCRIPT = String.raw`${PS_HELPERS}
$out = [ordered]@{}
$ver = @{}
try {
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $parentPid = -1
  try { $parentPid = [int](Get-CimInstance Win32_Process -Filter ('ProcessId=' + $PID) -Property ParentProcessId).ParentProcessId } catch {}
  $props = @('ProcessId','ParentProcessId','Name','KernelModeTime','UserModeTime','WorkingSetSize','PrivatePageCount','ExecutablePath')
  $a = @(Get-CimInstance Win32_Process -Property $props)
  $t0 = $sw.Elapsed.TotalMilliseconds
  Start-Sleep -Milliseconds 1500
  $b = @(Get-CimInstance Win32_Process -Property $props)
  $t1 = $sw.Elapsed.TotalMilliseconds
  $prev = @{}
  $children = @{}
  foreach ($p in $a) {
    $prev[[int]$p.ProcessId] = [double]$p.KernelModeTime + [double]$p.UserModeTime
    $pp = [int]$p.ParentProcessId
    if (-not $children.ContainsKey($pp)) { $children[$pp] = New-Object System.Collections.ArrayList }
    [void]$children[$pp].Add([int]$p.ProcessId)
  }
  # Árvore do próprio app (processo que iniciou este PowerShell e todos os seus filhos): não entra na medição.
  $own = @{}
  $stack = New-Object System.Collections.Stack
  if ($parentPid -gt 0) { $stack.Push($parentPid) }
  $stack.Push([int]$PID)
  while ($stack.Count -gt 0) {
    $x = [int]$stack.Pop()
    if ($own.ContainsKey($x)) { continue }
    $own[$x] = $true
    if ($children.ContainsKey($x)) { foreach ($c in $children[$x]) { if ($c -ne $x) { $stack.Push([int]$c) } } }
  }
  $list = New-Object System.Collections.ArrayList
  $idle = 0.0
  foreach ($p in $b) {
    $id = [int]$p.ProcessId
    $now = [double]$p.KernelModeTime + [double]$p.UserModeTime
    $delta = 0.0
    if ($prev.ContainsKey($id)) { $delta = $now - $prev[$id] }
    if ($delta -lt 0) { $delta = 0.0 }
    if ($id -eq 0) { $idle = $delta; continue }
    $self = $own.ContainsKey($id)
    $path = [string]$p.ExecutablePath
    [void]$list.Add([ordered]@{ pid = $id; name = [string]$p.Name; path = $path; cpu = $delta; ws = [double]$p.WorkingSetSize; priv = [double]$p.PrivatePageCount; self = $self })
    if ($path) { $null = Get-VerInfo $path $ver }
  }
  $out.procs = [ordered]@{ elapsedMs = ($t1 - $t0); logical = [Environment]::ProcessorCount; idle = $idle; list = @($list) }
} catch { [void]$warn.Add('Processos: ' + $_.Exception.Message) }

try {
  $svc = @(Get-CimInstance Win32_Service -Property Name,DisplayName,State,StartMode,PathName,Description)
  $running = New-Object System.Collections.ArrayList
  foreach ($s in $svc) {
    if ([string]$s.State -ne 'Running') { continue }
    $exe = Resolve-Exe ([string]$s.PathName)
    $vi = Get-VerInfo $exe $ver
    $desc = [string]$s.Description
    if ($desc.Length -gt 240) { $desc = $desc.Substring(0, 240) + '...' }
    [void]$running.Add([ordered]@{
      name = [string]$s.Name; displayName = [string]$s.DisplayName; state = [string]$s.State; startMode = [string]$s.StartMode
      path = $exe; company = $(if ($vi) { $vi.c } else { $null }); description = $desc
    })
  }
  $out.services = [ordered]@{ total = $svc.Count; running = @($running) }
} catch { [void]$warn.Add('Serviços: ' + $_.Exception.Message) }

$out.versions = $ver
$out.warnings = @($warn)
ConvertTo-Json -InputObject $out -Depth 8 -Compress
`

/** Itens de inicialização (Run, StartupApproved, pastas, tarefas) + log de eventos (30 dias). */
export const STARTUP_SCRIPT = String.raw`${PS_HELPERS}
$out = [ordered]@{}
$ver = @{}
function Get-ApprovedMap([string]$key) {
  $m = @{}
  try {
    $k = Get-Item -LiteralPath $key -ErrorAction Stop
    foreach ($n in $k.GetValueNames()) {
      $v = $k.GetValue($n)
      if ($v -is [byte[]] -and $v.Length -gt 0) { $m[$n] = [int]$v[0] }
    }
  } catch {}
  return $m
}
$items = New-Object System.Collections.ArrayList
$approvedBase = 'Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved'
try {
  $runs = @(
    @{ path = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'; approved = ('HKCU:\' + $approvedBase + '\Run'); loc = 'HKCU Run'; admin = $false; idp = 'run:HKCU' },
    @{ path = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run'; approved = ('HKLM:\' + $approvedBase + '\Run'); loc = 'HKLM Run'; admin = $true; idp = 'run:HKLM' },
    @{ path = 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Run'; approved = ('HKLM:\' + $approvedBase + '\Run32'); loc = 'HKLM Run (32-bit)'; admin = $true; idp = 'run32:HKLM' }
  )
  foreach ($r in $runs) {
    $k = $null
    try { $k = Get-Item -LiteralPath $r.path -ErrorAction Stop } catch { continue }
    $ap = Get-ApprovedMap $r.approved
    foreach ($n in $k.GetValueNames()) {
      if (-not $n) { continue }
      $cmd = [string]$k.GetValue($n, $null, 'DoNotExpandEnvironmentNames')
      $exe = Resolve-Exe $cmd
      $vi = Get-VerInfo $exe $ver
      $enabled = $true
      if ($ap.ContainsKey($n)) { $enabled = (($ap[$n] -band 1) -eq 0) }
      [void]$items.Add([ordered]@{ id = ($r.idp + ':' + $n); name = $n; command = $cmd; location = $r.loc; enabled = $enabled; admin = $r.admin; exe = $exe; exists = [bool]$vi; ver = $vi; kind = 'run' })
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
        try {
          $lnk = $sh.CreateShortcut($file.FullName)
          if ($lnk.TargetPath) { $target = [string]$lnk.TargetPath; $cmd = ('"' + $lnk.TargetPath + '" ' + $lnk.Arguments).Trim() }
        } catch {}
      }
      $vi = Get-VerInfo $target $ver
      $enabled = $true
      if ($ap.ContainsKey($file.Name)) { $enabled = (($ap[$file.Name] -band 1) -eq 0) }
      $nm = [IO.Path]::GetFileNameWithoutExtension($file.Name)
      [void]$items.Add([ordered]@{ id = ($f.idp + ':' + $file.Name); name = $nm; command = $cmd; location = $f.loc; enabled = $enabled; admin = $f.admin; exe = $target; exists = [bool]$vi; ver = $vi; kind = 'folder' })
    }
  }
} catch { [void]$warn.Add('Inicialização (pastas): ' + $_.Exception.Message) }

try {
  $me = [Security.Principal.WindowsIdentity]::GetCurrent()
  $meName = ([string]$me.Name).ToLower(); $meShort = ($meName -split '\\')[-1]; $meSid = [string]$me.User.Value
  foreach ($t in @(Get-ScheduledTask -ErrorAction Stop)) {
    if ([string]$t.TaskPath -like '\Microsoft\*') { continue }
    $trig = @($t.Triggers | ForEach-Object { [string]$_.CimClass.CimClassName })
    if (-not (($trig -contains 'MSFT_TaskLogonTrigger') -or ($trig -contains 'MSFT_TaskBootTrigger'))) { continue }
    $act = @($t.Actions | Where-Object { $_.Execute } | Select-Object -First 1)
    if ($act.Count -eq 0) { continue }
    $exe = Resolve-Bare ([Environment]::ExpandEnvironmentVariables(([string]$act[0].Execute).Trim('"')))
    $cmd = ('"' + $exe + '" ' + [string]$act[0].Arguments).Trim()
    $vi = Get-VerInfo $exe $ver
    $uid = ([string]$t.Principal.UserId).ToLower()
    $mine = ($uid -and (($uid -eq $meName) -or ($uid -eq $meShort) -or ($uid -eq $meSid.ToLower())))
    $needAdmin = (-not $mine) -or ([string]$t.Principal.RunLevel -eq 'Highest')
    [void]$items.Add([ordered]@{
      id = ('task:' + $t.TaskPath + $t.TaskName); name = [string]$t.TaskName; command = $cmd; location = 'Tarefa agendada'
      enabled = ([string]$t.State -ne 'Disabled'); admin = $needAdmin; exe = $exe; exists = [bool]$vi; ver = $vi; kind = 'task'
      taskPath = [string]$t.TaskPath; author = [string]$t.Author; boot = ($trig -contains 'MSFT_TaskBootTrigger')
    })
  }
} catch { [void]$warn.Add('Tarefas agendadas: ' + $_.Exception.Message) }
$out.startup = @($items)

$since = (Get-Date).AddDays(-30)
$ev = New-Object System.Collections.ArrayList
function Test-NoEvents($err) { return ([string]$err.Exception.Message) -match 'No events|Nenhum evento|nenhum evento|não foi encontrado' }
function Add-Group($events, [string]$kind) {
  foreach ($g in @($events | Group-Object ProviderName, Id)) {
    $first = $g.Group | Sort-Object TimeCreated -Descending | Select-Object -First 1
    $msg = [string]$first.Message
    if ($msg.Length -gt 400) { $msg = $msg.Substring(0, 400) + '...' }
    [void]$ev.Add([ordered]@{ kind = $kind; source = [string]$first.ProviderName; id = [int]$first.Id; count = $g.Count; last = To-Iso $first.TimeCreated; message = $msg; level = [int]$first.Level })
  }
}
try {
  $diskProviders = @('disk','Ntfs','Microsoft-Windows-Ntfs','stornvme','storahci','nvme','iaStorAC','iaStorA','iaStorAVC','amdsata','amd_sata')
  $d = @(Get-WinEvent -FilterHashtable @{ LogName = 'System'; Id = @(7,11,51,55,98,129,153); Level = @(1,2,3); StartTime = $since } -ErrorAction Stop | Where-Object { $diskProviders -contains [string]$_.ProviderName })
  Add-Group $d 'disk'
} catch { if (-not (Test-NoEvents $_)) { [void]$warn.Add('Eventos de disco: ' + $_.Exception.Message) } }
try {
  $w = @(Get-WinEvent -FilterHashtable @{ LogName = 'System'; ProviderName = 'Microsoft-Windows-WHEA-Logger'; Level = @(1,2,3); StartTime = $since } -ErrorAction Stop)
  Add-Group $w 'whea'
} catch { if (-not (Test-NoEvents $_)) { [void]$warn.Add('Eventos WHEA: ' + $_.Exception.Message) } }
try {
  $k = @(Get-WinEvent -FilterHashtable @{ LogName = 'System'; ProviderName = 'Microsoft-Windows-Kernel-Power'; Id = 41; StartTime = $since } -ErrorAction Stop)
  $bug = 0; $btn = 0
  foreach ($e in $k) {
    try {
      $x = [xml]$e.ToXml()
      $bc = ($x.Event.EventData.Data | Where-Object { $_.Name -eq 'BugcheckCode' } | Select-Object -First 1).'#text'
      $pb = ($x.Event.EventData.Data | Where-Object { $_.Name -eq 'PowerButtonTimestamp' } | Select-Object -First 1).'#text'
      if ($bc -and [int64]$bc -ne 0) { $bug++ }
      if ($pb -and [int64]$pb -ne 0) { $btn++ }
    } catch {}
  }
  if ($k.Count -gt 0) {
    $last = $k | Sort-Object TimeCreated -Descending | Select-Object -First 1
    [void]$ev.Add([ordered]@{ kind = 'power'; source = 'Microsoft-Windows-Kernel-Power'; id = 41; count = $k.Count; last = To-Iso $last.TimeCreated; message = ''; level = 1; withBugcheck = $bug; powerButton = $btn })
  }
} catch { if (-not (Test-NoEvents $_)) { [void]$warn.Add('Eventos de energia: ' + $_.Exception.Message) } }
try {
  $bsod = @(Get-WinEvent -FilterHashtable @{ LogName = 'System'; ProviderName = 'Microsoft-Windows-WER-SystemErrorReporting'; Id = 1001; StartTime = $since } -ErrorAction Stop)
  Add-Group $bsod 'bugcheck'
} catch { if (-not (Test-NoEvents $_)) { [void]$warn.Add('Telas azuis: ' + $_.Exception.Message) } }
function Add-AppGroup($events, [string]$kind) {
  foreach ($g in @($events | Group-Object { [string]$_.Properties[0].Value } | Sort-Object Count -Descending | Select-Object -First 6)) {
    $first = $g.Group | Sort-Object TimeCreated -Descending | Select-Object -First 1
    [void]$ev.Add([ordered]@{ kind = $kind; source = [string]$first.ProviderName; id = [int]$first.Id; count = $g.Count; last = To-Iso $first.TimeCreated; message = ''; level = 2; app = [string]$g.Name })
  }
}
try {
  $ae = @(Get-WinEvent -FilterHashtable @{ LogName = 'Application'; ProviderName = 'Application Error'; Id = 1000; StartTime = $since } -ErrorAction Stop)
  Add-AppGroup $ae 'appCrash'
} catch { if (-not (Test-NoEvents $_)) { [void]$warn.Add('Travamentos de programas: ' + $_.Exception.Message) } }
try {
  $ah = @(Get-WinEvent -FilterHashtable @{ LogName = 'Application'; ProviderName = 'Application Hang'; Id = 1002; StartTime = $since } -ErrorAction Stop)
  Add-AppGroup $ah 'appHang'
} catch { if (-not (Test-NoEvents $_)) { [void]$warn.Add('Programas que pararam de responder: ' + $_.Exception.Message) } }
$out.events = @($ev)
$out.warnings = @($warn)
ConvertTo-Json -InputObject $out -Depth 8 -Compress
`
