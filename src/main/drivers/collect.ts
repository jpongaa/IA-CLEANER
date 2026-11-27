// Coleta SOMENTE LEITURA (um único PowerShell): drivers assinados, dispositivos com erro,
// dados do sistema (placa-mãe/notebook/CPU/BIOS) e políticas do Windows Update que afetam drivers.
import { runPowerShellJson } from '../core/powershell'
import type { RawDriver, RawProblem } from './classify'

export interface RawSystem {
  manufacturer: string
  model: string
  family: string
  productVersion: string
  pcType: number
  boardManufacturer: string
  boardProduct: string
  chassis: number[]
  battery: number
  cpuName: string
  cpuMfr: string
  biosVersion: string
  biosDate: string | null
}

export interface RawWuPolicy {
  /** Política: não oferecer drivers pelo Windows Update */
  excludeDrivers: boolean
  /** Gerenciado por WSUS (PC de empresa) */
  wsus: boolean
  /** Configuração de instalação de dispositivos (0 = nunca buscar drivers no Windows Update) */
  searchOrder: number | null
  /** Tipo de inicialização do serviço wuauserv ('Disabled', 'Manual', 'Automatic'...) */
  serviceStartType: string
}

export interface RawCollect {
  drivers: RawDriver[]
  problems: RawProblem[]
  sys: RawSystem
  wu: RawWuPolicy
  warnings: string[]
}

// String.raw: as barras invertidas dos caminhos do registro chegam intactas ao PowerShell.
const SCRIPT = String.raw`
$warnings = New-Object System.Collections.ArrayList
$drivers = New-Object System.Collections.ArrayList
try {
  foreach ($d in @(Get-CimInstance -ClassName Win32_PnPSignedDriver -ErrorAction Stop)) {
    if (-not $d.DeviceName) { continue }
    $date = $null
    if ($d.DriverDate) { try { $date = ([datetime]$d.DriverDate).ToUniversalTime().ToString('yyyy-MM-dd') } catch { } }
    [void]$drivers.Add([ordered]@{
      n = [string]$d.DeviceName; c = [string]$d.DeviceClass; m = [string]$d.Manufacturer; p = [string]$d.DriverProviderName
      v = [string]$d.DriverVersion; d = $date; inf = [string]$d.InfName; hw = [string]$d.HardWareID; id = [string]$d.DeviceID
    })
  }
} catch { [void]$warnings.Add('Não foi possível ler a lista de drivers: ' + $_.Exception.Message) }

$problems = New-Object System.Collections.ArrayList
try {
  foreach ($e in @(Get-CimInstance -ClassName Win32_PnPEntity -Filter 'ConfigManagerErrorCode <> 0' -ErrorAction Stop)) {
    $hw = $null
    try { $hw = [string](@($e.HardwareID) | Select-Object -First 1) } catch { }
    $present = $null
    try { if ($null -ne $e.Present) { $present = [bool]$e.Present } } catch { }
    [void]$problems.Add([ordered]@{ n = [string]$e.Name; c = [string]$e.PNPClass; code = [int]$e.ConfigManagerErrorCode; id = [string]$e.PNPDeviceID; present = $present; hw = $hw })
  }
} catch { [void]$warnings.Add('Não foi possível ler os dispositivos com problema: ' + $_.Exception.Message) }

$sys = [ordered]@{ manufacturer = ''; model = ''; family = ''; productVersion = ''; pcType = 0; boardManufacturer = ''; boardProduct = ''; chassis = @(); battery = 0; cpuName = ''; cpuMfr = ''; biosVersion = ''; biosDate = $null }
try {
  $cs = Get-CimInstance -ClassName Win32_ComputerSystem -ErrorAction Stop
  $sys.manufacturer = ([string]$cs.Manufacturer).Trim(); $sys.model = ([string]$cs.Model).Trim(); $sys.family = ([string]$cs.SystemFamily).Trim(); $sys.pcType = [int]$cs.PCSystemType
} catch { [void]$warnings.Add('Não foi possível ler o modelo do computador.') }
try { $sys.productVersion = ([string](Get-CimInstance -ClassName Win32_ComputerSystemProduct -ErrorAction Stop | Select-Object -First 1).Version).Trim() } catch { }
try {
  $bb = Get-CimInstance -ClassName Win32_BaseBoard -ErrorAction Stop | Select-Object -First 1
  $sys.boardManufacturer = ([string]$bb.Manufacturer).Trim(); $sys.boardProduct = ([string]$bb.Product).Trim()
} catch { [void]$warnings.Add('Não foi possível ler a placa-mãe.') }
try { $sys.chassis = @(@(Get-CimInstance -ClassName Win32_SystemEnclosure -ErrorAction Stop) | ForEach-Object { @($_.ChassisTypes) } | ForEach-Object { [int]$_ }) } catch { }
try { $sys.battery = @(Get-CimInstance -ClassName Win32_Battery -ErrorAction Stop).Count } catch { }
try {
  $cpu = Get-CimInstance -ClassName Win32_Processor -ErrorAction Stop | Select-Object -First 1
  $sys.cpuName = ([string]$cpu.Name).Trim(); $sys.cpuMfr = ([string]$cpu.Manufacturer).Trim()
} catch { }
try {
  $bios = Get-CimInstance -ClassName Win32_BIOS -ErrorAction Stop | Select-Object -First 1
  $sys.biosVersion = ([string]$bios.SMBIOSBIOSVersion).Trim()
  if ($bios.ReleaseDate) { $sys.biosDate = ([datetime]$bios.ReleaseDate).ToUniversalTime().ToString('yyyy-MM-dd') }
} catch { }

$wu = [ordered]@{ excludeDrivers = $false; wsus = $false; searchOrder = $null; serviceStartType = '' }
try {
  $pol = Get-ItemProperty -Path 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate' -ErrorAction Stop
  if ($pol.ExcludeWUDriversInQualityUpdate -eq 1) { $wu.excludeDrivers = $true }
} catch { }
try {
  $au = Get-ItemProperty -Path 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate\AU' -ErrorAction Stop
  if ($au.UseWUServer -eq 1) { $wu.wsus = $true }
} catch { }
try {
  $mdm = Get-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\PolicyManager\current\device\Update' -ErrorAction Stop
  if ($mdm.ExcludeWUDriversInQualityUpdate -eq 1) { $wu.excludeDrivers = $true }
} catch { }
try {
  $ds = Get-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\DriverSearching' -ErrorAction Stop
  if ($null -ne $ds.SearchOrderConfig) { $wu.searchOrder = [int]$ds.SearchOrderConfig }
} catch { }
try { $wu.serviceStartType = [string](Get-Service -Name wuauserv -ErrorAction Stop).StartType } catch { }

ConvertTo-Json -InputObject ([ordered]@{ drivers = @($drivers); problems = @($problems); sys = $sys; wu = $wu; warnings = @($warnings) }) -Depth 5 -Compress
`

function arr<T>(x: T[] | T | null | undefined): T[] {
  return Array.isArray(x) ? x : x ? [x] : []
}

export async function collectRaw(signal?: AbortSignal): Promise<RawCollect> {
  const raw = await runPowerShellJson<Partial<RawCollect>>(SCRIPT, { timeoutMs: 120_000, signal })
  const sys = (raw.sys ?? {}) as Partial<RawSystem>
  const wu = (raw.wu ?? {}) as Partial<RawWuPolicy>
  return {
    drivers: arr(raw.drivers),
    problems: arr(raw.problems).map((p) => ({ ...p, code: Number(p.code) || 0 })),
    sys: {
      manufacturer: sys.manufacturer ?? '',
      model: sys.model ?? '',
      family: sys.family ?? '',
      productVersion: sys.productVersion ?? '',
      pcType: Number(sys.pcType) || 0,
      boardManufacturer: sys.boardManufacturer ?? '',
      boardProduct: sys.boardProduct ?? '',
      chassis: arr(sys.chassis).map(Number).filter(Number.isFinite),
      battery: Number(sys.battery) || 0,
      cpuName: (sys.cpuName ?? '').replace(/\s+/g, ' ').trim(),
      cpuMfr: sys.cpuMfr ?? '',
      biosVersion: sys.biosVersion ?? '',
      biosDate: sys.biosDate ?? null
    },
    wu: {
      excludeDrivers: Boolean(wu.excludeDrivers),
      wsus: Boolean(wu.wsus),
      searchOrder: typeof wu.searchOrder === 'number' ? wu.searchOrder : null,
      serviceStartType: wu.serviceStartType ?? ''
    },
    warnings: arr(raw.warnings).map(String)
  }
}
