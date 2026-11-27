// Scripts PowerShell (5.1) + C# (Add-Type) usados pelo domínio Hardware.
// Escritos com String.raw: NÃO use crase nem a sequência cifrão+chave dentro deles.
//
// Armadilhas tratadas aqui:
// - Add-Type compila com csc.exe, que trata como ERRO um caminho inválido na variável de ambiente LIB
//   (ex.: LIB=C:\Python\libs nesta máquina). Removemos LIB apenas no processo filho e usamos -IgnoreWarnings.
// - Win32_PerfFormattedData_* e os contadores PDH de PhysicalDisk/Network podem não existir (ADAP quebrado ou
//   contadores desativados). Por isso o monitor ao vivo usa: IOCTL_DISK_PERFORMANCE (disco), estatísticas .NET das
//   interfaces (rede) e PDH com nomes em INGLÊS via PdhAddEnglishCounter (GPU, frequência) — nada localizado.

/** C# do coletor de informações (instruções, firmware, caches, modos de vídeo). */
const INFO_CS = String.raw`
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public class IacDisplayMode {
  public string Device { get; set; }
  public string Adapter { get; set; }
  public string MonitorName { get; set; }
  public string MonitorId { get; set; }
  public int Width { get; set; }
  public int Height { get; set; }
  public int Hz { get; set; }
  public int Bpp { get; set; }
  public bool Primary { get; set; }
  public int MaxHzAtRes { get; set; }
  public int MaxWidth { get; set; }
  public int MaxHeight { get; set; }
}

public static class IacHwInfo {
  [DllImport("kernel32.dll")] static extern bool IsProcessorFeaturePresent(uint feature);
  [DllImport("kernel32.dll")] static extern bool GetFirmwareType(out uint type);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetLogicalProcessorInformation(IntPtr buffer, ref uint length);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool EnumDisplayDevicesW(string device, uint index, ref DISPLAY_DEVICE dd, uint flags);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool EnumDisplaySettingsW(string device, int mode, ref DEVMODE dm);

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct DISPLAY_DEVICE {
    public int cb;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string DeviceName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceString;
    public int StateFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceID;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceKey;
  }

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct DEVMODE {
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmDeviceName;
    public short dmSpecVersion; public short dmDriverVersion; public short dmSize; public short dmDriverExtra;
    public int dmFields;
    public int dmPositionX; public int dmPositionY; public int dmDisplayOrientation; public int dmDisplayFixedOutput;
    public short dmColor; public short dmDuplex; public short dmYResolution; public short dmTTOption; public short dmCollate;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmFormName;
    public short dmLogPixels; public int dmBitsPerPel; public int dmPelsWidth; public int dmPelsHeight;
    public int dmDisplayFlags; public int dmDisplayFrequency;
    public int dmICMMethod; public int dmICMIntent; public int dmMediaType; public int dmDitherType;
    public int dmReserved1; public int dmReserved2; public int dmPanningWidth; public int dmPanningHeight;
  }

  static readonly uint[] FeatureIds = new uint[] { 3, 6, 10, 13, 36, 37, 38, 39, 40, 41, 7, 28, 32, 17, 14, 12, 20, 21, 42 };
  static readonly string[] FeatureNames = new string[] { "MMX", "SSE", "SSE2", "SSE3", "SSSE3", "SSE4.1", "SSE4.2", "AVX", "AVX2", "AVX-512F", "3DNow!", "RDRAND", "RDTSCP", "XSAVE", "CMPXCHG16B", "NX", "SLAT", "VIRT", "ERMS" };

  public static string[] Features() {
    var list = new List<string>();
    for (int i = 0; i < FeatureIds.Length; i++) {
      try { if (IsProcessorFeaturePresent(FeatureIds[i])) list.Add(FeatureNames[i]); } catch { }
    }
    return list.ToArray();
  }

  public static int FirmwareType() {
    try { uint t; if (GetFirmwareType(out t)) return (int)t; } catch { }
    return 0;
  }

  // Cada item: "nivel|tipo|tamanhoBytes|vias|linha|quantidade" (tipo: 0 unificado, 1 instrução, 2 dados)
  public static string[] Caches() {
    uint len = 0;
    GetLogicalProcessorInformation(IntPtr.Zero, ref len);
    if (len == 0) return new string[0];
    IntPtr buf = Marshal.AllocHGlobal((int)len);
    try {
      if (!GetLogicalProcessorInformation(buf, ref len)) return new string[0];
      int item = IntPtr.Size == 8 ? 32 : 24;
      int uo = IntPtr.Size == 8 ? 16 : 8;
      var counts = new Dictionary<string, int>();
      var order = new List<string>();
      for (int off = 0; off + item <= (int)len; off += item) {
        int rel = Marshal.ReadInt32(buf, off + IntPtr.Size);
        if (rel != 2) continue;
        int level = Marshal.ReadByte(buf, off + uo);
        int ways = Marshal.ReadByte(buf, off + uo + 1);
        int line = (ushort)Marshal.ReadInt16(buf, off + uo + 2);
        long size = (uint)Marshal.ReadInt32(buf, off + uo + 4);
        int type = Marshal.ReadInt32(buf, off + uo + 8);
        string key = level + "|" + type + "|" + size + "|" + ways + "|" + line;
        if (!counts.ContainsKey(key)) { counts[key] = 0; order.Add(key); }
        counts[key] = counts[key] + 1;
      }
      var res = new List<string>();
      foreach (var k in order) res.Add(k + "|" + counts[k]);
      return res.ToArray();
    } finally { Marshal.FreeHGlobal(buf); }
  }

  public static IacDisplayMode[] Displays() {
    var res = new List<IacDisplayMode>();
    for (uint i = 0; i < 32; i++) {
      var dd = new DISPLAY_DEVICE();
      dd.cb = Marshal.SizeOf(typeof(DISPLAY_DEVICE));
      if (!EnumDisplayDevicesW(null, i, ref dd, 0)) break;
      if ((dd.StateFlags & 1) == 0) continue;
      var m = new IacDisplayMode();
      m.Device = dd.DeviceName; m.Adapter = dd.DeviceString; m.Primary = (dd.StateFlags & 4) != 0;
      var dm = new DEVMODE();
      dm.dmSize = (short)Marshal.SizeOf(typeof(DEVMODE));
      if (EnumDisplaySettingsW(dd.DeviceName, -1, ref dm)) {
        m.Width = dm.dmPelsWidth; m.Height = dm.dmPelsHeight; m.Hz = dm.dmDisplayFrequency; m.Bpp = dm.dmBitsPerPel;
      }
      int maxHz = m.Hz; int maxW = 0; int maxH = 0; long maxArea = 0;
      for (int k = 0; k < 3000; k++) {
        var d2 = new DEVMODE();
        d2.dmSize = (short)Marshal.SizeOf(typeof(DEVMODE));
        if (!EnumDisplaySettingsW(dd.DeviceName, k, ref d2)) break;
        if (d2.dmPelsWidth == m.Width && d2.dmPelsHeight == m.Height && d2.dmDisplayFrequency > maxHz) maxHz = d2.dmDisplayFrequency;
        long area = (long)d2.dmPelsWidth * d2.dmPelsHeight;
        if (area > maxArea) { maxArea = area; maxW = d2.dmPelsWidth; maxH = d2.dmPelsHeight; }
      }
      m.MaxHzAtRes = maxHz; m.MaxWidth = maxW; m.MaxHeight = maxH;
      var mon = new DISPLAY_DEVICE();
      mon.cb = Marshal.SizeOf(typeof(DISPLAY_DEVICE));
      if (EnumDisplayDevicesW(dd.DeviceName, 0, ref mon, 1)) { m.MonitorName = mon.DeviceString; m.MonitorId = mon.DeviceID; }
      res.Add(m);
    }
    return res.ToArray();
  }
}
`

/**
 * Coleta completa (somente leitura). Cada parte em try/catch -> $warnings.
 * Saída: objeto "cru" (normalizado em collect.ts).
 */
export const INFO_SCRIPT = String.raw`
$warnings = New-Object System.Collections.ArrayList
$timings = [ordered]@{}
$sw = [Diagnostics.Stopwatch]::StartNew()
function W([string]$m) { [void]$warnings.Add($m) }
function S($v) { if ($null -eq $v) { return $null }; $s = ([string]$v).Trim(); if ($s -eq '') { return $null }; return $s }
function IsoDT($d) { if ($null -eq $d) { return $null }; try { return ([DateTime]$d).ToString('o') } catch { return $null } }
function DateOnly($d) { if ($null -eq $d) { return $null }; try { return ([DateTime]$d).ToUniversalTime().ToString('yyyy-MM-dd') } catch { return $null } }
function Mark([string]$k) { $timings[$k] = $sw.ElapsedMilliseconds; $sw.Restart() }
function IsDenied($e) { $msg = [string]$e.Exception.Message; return ($msg -match 'acesso|access|negad|denied|dispon') }

$native = $false
try {
  Remove-Item Env:LIB -ErrorAction SilentlyContinue
  Add-Type -TypeDefinition @'
__INFO_CS__
'@ -IgnoreWarnings -ErrorAction Stop
  $native = $true
} catch { W 'Não foi possível usar o leitor nativo do Windows: instruções da CPU, detalhes de cache e modos de vídeo podem ficar incompletos.' }
Mark 'native'

# ---------------- CPU ----------------
$cpu = [ordered]@{}
try {
  $procs = @(Get-CimInstance -ClassName Win32_Processor)
  $p = $procs[0]
  $cpu.name = S $p.Name
  $cpu.manufacturer = S $p.Manufacturer
  $cpu.caption = S $p.Caption
  $cpu.cores = [int](($procs | Measure-Object -Property NumberOfCores -Sum).Sum)
  $cpu.threads = [int](($procs | Measure-Object -Property NumberOfLogicalProcessors -Sum).Sum)
  $cpu.sockets = $procs.Count
  $cpu.maxClock = [int]$p.MaxClockSpeed
  $cpu.curClock = [int]$p.CurrentClockSpeed
  $cpu.l2 = [int](($procs | Measure-Object -Property L2CacheSize -Sum).Sum)
  $cpu.l3 = [int](($procs | Measure-Object -Property L3CacheSize -Sum).Sum)
  $cpu.socket = S $p.SocketDesignation
  $cpu.virtFw = $p.VirtualizationFirmwareEnabled
  $cpu.arch = [int]$p.Architecture
} catch { W ('Processador (WMI): ' + $_.Exception.Message) }
try {
  $r = Get-ItemProperty -Path 'HKLM:\HARDWARE\DESCRIPTION\System\CentralProcessor\0'
  $cpu.identifier = S $r.Identifier
  $cpu.regMhz = [int]$r.'~MHz'
  $cpu.regName = S $r.ProcessorNameString
  $cpu.regVendor = S $r.VendorIdentifier
} catch { W 'Não foi possível ler o registro do processador (família/modelo).' }
try {
  $cpu.wmiCaches = @(Get-CimInstance -ClassName Win32_CacheMemory | ForEach-Object { [ordered]@{ level = [int]$_.Level; kb = [int]$_.InstalledSize } })
} catch { }
if ($native) {
  try { $cpu.features = @([IacHwInfo]::Features()) } catch { W 'Não foi possível ler as instruções suportadas pelo processador.' }
  try { $cpu.caches = @([IacHwInfo]::Caches()) } catch { }
}
Mark 'cpu'

# ---------------- Sistema / placa-mãe / BIOS ----------------
$sys = [ordered]@{}
try {
  $cs = Get-CimInstance -ClassName Win32_ComputerSystem
  $sys.manufacturer = S $cs.Manufacturer
  $sys.model = S $cs.Model
  $sys.pcSystemType = [int]$cs.PCSystemType
  $sys.totalPhysical = [double]$cs.TotalPhysicalMemory
  $sys.hypervisor = [bool]$cs.HypervisorPresent
} catch { W ('Sistema (WMI): ' + $_.Exception.Message) }
try { $sys.chassis = @(@(Get-CimInstance -ClassName Win32_SystemEnclosure | ForEach-Object { $_.ChassisTypes }) | ForEach-Object { [int]$_ }) } catch { }
try { $sys.hasBattery = (@(Get-CimInstance -ClassName Win32_Battery).Count -gt 0) } catch { $sys.hasBattery = $false }

$board = [ordered]@{}
try {
  $b = Get-CimInstance -ClassName Win32_BaseBoard | Select-Object -First 1
  $board.manufacturer = S $b.Manufacturer
  $board.product = S $b.Product
  $board.version = S $b.Version
  $board.serial = S $b.SerialNumber
} catch { W ('Placa-mãe (WMI): ' + $_.Exception.Message) }
try {
  $board.pnp = @(Get-CimInstance -ClassName Win32_PnPEntity -Filter "Name LIKE '%Chipset%' OR Name LIKE '%LPC%' OR Name LIKE '%eSPI%'" | Select-Object -First 25 | ForEach-Object { [string]$_.Name })
} catch { }

$bios = [ordered]@{}
try {
  $bi = Get-CimInstance -ClassName Win32_BIOS | Select-Object -First 1
  $bios.vendor = S $bi.Manufacturer
  $bios.version = S $bi.SMBIOSBIOSVersion
  $bios.fallbackVersion = S $bi.Version
  $bios.releaseDate = DateOnly $bi.ReleaseDate
} catch { W ('BIOS (WMI): ' + $_.Exception.Message) }
$bios.firmwareType = 0
if ($native) { try { $bios.firmwareType = [IacHwInfo]::FirmwareType() } catch { } }
$bios.envFirmware = S $env:firmware_type
try {
  $sb = Get-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\SecureBoot\State' -ErrorAction Stop
  $bios.secureBoot = [int]$sb.UEFISecureBootEnabled
} catch { $bios.secureBoot = $null }
Mark 'board'

# ---------------- Memória ----------------
$mem = [ordered]@{ modules = @(); slots = $null; maxKb = $null }
try {
  $mem.modules = @(Get-CimInstance -ClassName Win32_PhysicalMemory | ForEach-Object {
    [ordered]@{
      capacity = [double]$_.Capacity
      smbiosType = [int]$_.SMBIOSMemoryType
      memoryType = [int]$_.MemoryType
      speed = [int]$_.Speed
      configured = [int]$_.ConfiguredClockSpeed
      manufacturer = S $_.Manufacturer
      partNumber = S $_.PartNumber
      locator = S $_.DeviceLocator
      bank = S $_.BankLabel
      voltage = [int]$_.ConfiguredVoltage
      formFactor = [int]$_.FormFactor
    }
  })
} catch { W ('Pentes de memória (WMI): ' + $_.Exception.Message) }
try {
  $arr = @(Get-CimInstance -ClassName Win32_PhysicalMemoryArray | Where-Object { [int]$_.Use -eq 3 })
  if ($arr.Count -gt 0) {
    $mem.slots = [int](($arr | Measure-Object -Property MemoryDevices -Sum).Sum)
    $mem.maxKb = [double](($arr | Measure-Object -Property MaxCapacityEx -Sum).Sum)
  }
} catch { }
Mark 'memory'

# ---------------- Vídeo ----------------
$gpus = @()
try {
  $gpus = @(Get-CimInstance -ClassName Win32_VideoController | ForEach-Object {
    [ordered]@{
      name = S $_.Name
      compat = S $_.AdapterCompatibility
      adapterRam = [double]$_.AdapterRAM
      driverVersion = S $_.DriverVersion
      driverDate = DateOnly $_.DriverDate
      w = [int]$_.CurrentHorizontalResolution
      h = [int]$_.CurrentVerticalResolution
      hz = [int]$_.CurrentRefreshRate
      pnp = S $_.PNPDeviceID
      infSection = S $_.InfSection
    }
  })
} catch { W ('Placas de vídeo (WMI): ' + $_.Exception.Message) }
$gpuReg = @()
try {
  $cls = 'HKLM:\SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}'
  $gpuReg = @(Get-ChildItem -Path $cls -ErrorAction SilentlyContinue | Where-Object { $_.PSChildName -match '^\d{4}$' } | ForEach-Object {
    $k = Get-ItemProperty -Path $_.PSPath -ErrorAction SilentlyContinue
    if ($k) {
      $qw = $k.'HardwareInformation.qwMemorySize'
      $ms = $k.'HardwareInformation.MemorySize'
      if ($ms -is [byte[]] -and $ms.Length -ge 4) { $ms = [BitConverter]::ToUInt32($ms, 0) }
      [ordered]@{
        desc = S $k.DriverDesc
        match = S $k.MatchingDeviceId
        provider = S $k.ProviderName
        qw = $(if ($null -ne $qw) { [double]$qw } else { $null })
        ms = $(if ($null -ne $ms -and -not ($ms -is [array])) { [double]$ms } else { $null })
      }
    }
  })
} catch { }
Mark 'gpu'

# ---------------- Armazenamento ----------------
$disks = @()
$relDenied = $false
$relErr = $null
$pdisks = @()
try { $pdisks = @(Get-PhysicalDisk -ErrorAction Stop) } catch { W ('Discos físicos (Storage): ' + $_.Exception.Message) }
$dd = @{}
try { foreach ($d in @(Get-CimInstance -ClassName Win32_DiskDrive)) { $dd[[string]$d.Index] = $d } } catch { }
$parts = @()
try { $parts = @(Get-Partition -ErrorAction Stop) } catch { }
$vols = @{}
function HasLetter($l) { if ($null -eq $l) { return $false }; try { return ([int][char]$l -ne 0) } catch { return $false } }
try { foreach ($v in @(Get-Volume -ErrorAction Stop)) { if (HasLetter $v.DriveLetter) { $vols[[string]$v.DriveLetter] = $v } } } catch { }
$diskIds = @()
if ($pdisks.Count -gt 0) { $diskIds = @($pdisks | ForEach-Object { [string]$_.DeviceId }) } else { $diskIds = @($dd.Keys) }
foreach ($id in $diskIds) {
  $pd = $pdisks | Where-Object { [string]$_.DeviceId -eq $id } | Select-Object -First 1
  $w = $dd[$id]
  $o = [ordered]@{
    number = [int]$id
    friendly = $(if ($pd) { S $pd.FriendlyName } else { $null })
    model = $(if ($w) { S $w.Model } else { $null })
    serial = $(if ($pd -and (S $pd.SerialNumber)) { S $pd.SerialNumber } elseif ($w) { S $w.SerialNumber } else { $null })
    firmware = $(if ($pd -and (S $pd.FirmwareVersion)) { S $pd.FirmwareVersion } elseif ($w) { S $w.FirmwareRevision } else { $null })
    media = $(if ($pd) { [string]$pd.MediaType } else { 'Unknown' })
    bus = $(if ($pd) { [string]$pd.BusType } elseif ($w) { S $w.InterfaceType } else { '' })
    size = $(if ($pd) { [double]$pd.Size } elseif ($w) { [double]$w.Size } else { 0 })
    health = $(if ($pd) { [string]$pd.HealthStatus } else { $null })
    rel = $null
    partitions = @()
  }
  if ($pd -and -not $relDenied) {
    try {
      $rc = $pd | Get-StorageReliabilityCounter -ErrorAction Stop
      if ($rc) {
        $o.rel = [ordered]@{
          temp = $(if ($null -ne $rc.Temperature) { [int]$rc.Temperature } else { $null })
          tempMax = $(if ($null -ne $rc.TemperatureMax) { [int]$rc.TemperatureMax } else { $null })
          wear = $(if ($null -ne $rc.Wear) { [int]$rc.Wear } else { $null })
          hours = $(if ($null -ne $rc.PowerOnHours) { [int]$rc.PowerOnHours } else { $null })
          readErr = $(if ($null -ne $rc.ReadErrorsTotal) { [double]$rc.ReadErrorsTotal } else { $null })
          writeErr = $(if ($null -ne $rc.WriteErrorsTotal) { [double]$rc.WriteErrorsTotal } else { $null })
        }
      }
    } catch {
      if (IsDenied $_) { $relDenied = $true } else { $relErr = $_.Exception.Message }
    }
  }
  $o.partitions = @($parts | Where-Object { [string]$_.DiskNumber -eq $id } | ForEach-Object {
    $letter = $null
    if (HasLetter $_.DriveLetter) { $letter = [string]$_.DriveLetter }
    $v = $null
    if ($letter) { $v = $vols[$letter] }
    [ordered]@{
      letter = $letter
      size = [double]$_.Size
      type = [string]$_.Type
      label = $(if ($v) { S $v.FileSystemLabel } else { $null })
      free = $(if ($v) { [double]$v.SizeRemaining } else { $null })
      fs = $(if ($v) { S $v.FileSystem } else { $null })
    }
  })
  $disks += $o
}
if ($relDenied) { W 'Temperatura, desgaste e horas de uso dos discos só podem ser lidos com o app aberto como Administrador.' }
elseif ($relErr) { W ('Contadores de confiabilidade dos discos indisponíveis: ' + $relErr) }
Mark 'storage'

# ---------------- Monitores ----------------
$mons = @()
try {
  $basic = @{}
  try { foreach ($bp in @(Get-CimInstance -Namespace root\wmi -ClassName WmiMonitorBasicDisplayParams -ErrorAction Stop)) { $basic[[string]$bp.InstanceName] = $bp } } catch { }
  $conn = @{}
  try { foreach ($cp in @(Get-CimInstance -Namespace root\wmi -ClassName WmiMonitorConnectionParams -ErrorAction Stop)) { $conn[[string]$cp.InstanceName] = [int64]$cp.VideoOutputTechnology } } catch { }
  $mons = @(Get-CimInstance -Namespace root\wmi -ClassName WmiMonitorID -ErrorAction Stop | ForEach-Object {
    $inst = [string]$_.InstanceName
    $bp = $basic[$inst]
    [ordered]@{
      instance = $inst
      name = (($_.UserFriendlyName | Where-Object { $_ -ne 0 } | ForEach-Object { [char][int]$_ }) -join '')
      mfg = (($_.ManufacturerName | Where-Object { $_ -ne 0 } | ForEach-Object { [char][int]$_ }) -join '')
      product = (($_.ProductCodeID | Where-Object { $_ -ne 0 } | ForEach-Object { [char][int]$_ }) -join '')
      year = [int]$_.YearOfManufacture
      active = [bool]$_.Active
      wcm = $(if ($bp) { [int]$bp.MaxHorizontalImageSize } else { 0 })
      hcm = $(if ($bp) { [int]$bp.MaxVerticalImageSize } else { 0 })
      tech = $(if ($conn.ContainsKey($inst)) { $conn[$inst] } else { $null })
    }
  })
} catch { W 'Não foi possível ler os dados dos monitores (EDID).' }
$modes = @()
if ($native) {
  try {
    $modes = @([IacHwInfo]::Displays() | ForEach-Object {
      [ordered]@{ device = $_.Device; adapter = $_.Adapter; monitorName = $_.MonitorName; monitorId = $_.MonitorId; w = $_.Width; h = $_.Height; hz = $_.Hz; bpp = $_.Bpp; primary = $_.Primary; maxHz = $_.MaxHzAtRes; maxW = $_.MaxWidth; maxH = $_.MaxHeight }
    })
  } catch { W 'Não foi possível ler a resolução atual de cada monitor.' }
}
Mark 'displays'

# ---------------- Rede ----------------
$nets = @()
try {
  $nets = @(Get-NetAdapter -ErrorAction Stop | ForEach-Object {
    [ordered]@{
      name = S $_.Name
      desc = S $_.InterfaceDescription
      mac = S $_.MacAddress
      speed = [double]$_.ReceiveLinkSpeed
      status = [string]$_.Status
      mediaConnect = [int]$_.MediaConnectState
      physMedia = S $_.PhysicalMediaType
      ndisMedium = [int]$_.NdisPhysicalMedium
      driverVersion = S $_.DriverVersionString
      driverDate = S $_.DriverDate
      driverProvider = S $_.DriverProvider
      hardware = [bool]$_.HardwareInterface
      virtual = [bool]$_.Virtual
    }
  })
} catch { W ('Adaptadores de rede: ' + $_.Exception.Message) }
Mark 'network'

# ---------------- Áudio ----------------
$audio = @()
try { $audio = @(Get-CimInstance -ClassName Win32_SoundDevice | ForEach-Object { S $_.Name } | Where-Object { $_ } | Select-Object -Unique) } catch { W 'Dispositivos de áudio indisponíveis.' }

# ---------------- Sistema operacional ----------------
$os = [ordered]@{}
try {
  $o = Get-CimInstance -ClassName Win32_OperatingSystem
  $os.caption = S $o.Caption
  $os.version = S $o.Version
  $os.build = S $o.BuildNumber
  $os.osArch = S $o.OSArchitecture
  $os.installDate = IsoDT $o.InstallDate
  $os.lastBoot = IsoDT $o.LastBootUpTime
  $os.csName = S $o.CSName
} catch { W ('Sistema operacional (WMI): ' + $_.Exception.Message) }
try {
  $cv = Get-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
  $os.displayVersion = S $cv.DisplayVersion
  $os.ubr = $(if ($null -ne $cv.UBR) { [int]$cv.UBR } else { $null })
  $os.edition = S $cv.EditionID
  $os.currentBuild = S $cv.CurrentBuild
} catch { }
$os.is64 = [Environment]::Is64BitOperatingSystem
$os.procArch = $(if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE })
$os.user = $env:USERNAME
$os.computer = $env:COMPUTERNAME

# ---------------- Bateria (notebooks) ----------------
$bat = $null
if ($sys.hasBattery) {
  $bat = [ordered]@{}
  try {
    $wb = Get-CimInstance -ClassName Win32_Battery | Select-Object -First 1
    $bat.charge = [int]$wb.EstimatedChargeRemaining
    $bat.status = [int]$wb.BatteryStatus
  } catch { }
  try { $bat.design = [double](@(Get-CimInstance -Namespace root\wmi -ClassName BatteryStaticData -ErrorAction Stop)[0].DesignedCapacity) } catch { }
  try { $bat.full = [double](@(Get-CimInstance -Namespace root\wmi -ClassName BatteryFullChargedCapacity -ErrorAction Stop)[0].FullChargedCapacity) } catch { }
}
Mark 'os'

$out = [ordered]@{
  native = $native
  cpu = $cpu
  system = $sys
  board = $board
  bios = $bios
  memory = $mem
  gpus = @($gpus)
  gpuReg = @($gpuReg)
  disks = @($disks)
  monitors = @($mons)
  modes = @($modes)
  network = @($nets)
  audio = @($audio)
  os = $os
  battery = $bat
  sysDrive = $env:SystemDrive
  warnings = @($warnings)
  timings = $timings
}
ConvertTo-Json -InputObject $out -Depth 8 -Compress
`.replace('__INFO_CS__', () => INFO_CS)

/** C# do coletor ao vivo (disco via IOCTL, rede via .NET, GPU/frequência via PDH em inglês). */
const LIVE_CS = String.raw`
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Net.NetworkInformation;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.Win32.SafeHandles;

public static class IacLive {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr sec, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool DeviceIoControl(SafeFileHandle h, uint code, IntPtr inBuf, uint inSize, IntPtr outBuf, uint outSize, out uint returned, IntPtr overlapped);
  [DllImport("pdh.dll", CharSet = CharSet.Unicode)] static extern uint PdhOpenQueryW(string source, IntPtr user, out IntPtr query);
  [DllImport("pdh.dll", CharSet = CharSet.Unicode)] static extern uint PdhAddEnglishCounterW(IntPtr query, string path, IntPtr user, out IntPtr counter);
  [DllImport("pdh.dll")] static extern uint PdhCollectQueryData(IntPtr query);
  [DllImport("pdh.dll", CharSet = CharSet.Unicode)] static extern uint PdhGetFormattedCounterArrayW(IntPtr counter, uint format, ref uint size, out uint count, IntPtr buffer);

  const uint PDH_MORE_DATA = 0x800007D2;
  const uint FMT = 0x200 | 0x8000; // DOUBLE | NOCAP100

  class DiskState { public int Number; public long R, W, Idle, Qt; public bool Has; public bool Ok = true; }

  static List<DiskState> disks = new List<DiskState>();
  static HashSet<string> physNics = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
  // Sem a lista de placas físicas (vinda do app), descarta adaptadores virtuais conhecidos pela descrição.
  static readonly Regex VirtualNic = new Regex(@"hyper-v|virtual|vpn|\btap\b|tap-|tunnel|tailscale|wireguard|hamachi|zerotier|vmware|virtualbox|npcap|loopback|bluetooth|wan miniport|teredo|isatap|kernel debug|wi-fi direct|radmin|openvpn|nordlynx|proton", RegexOptions.IgnoreCase);
  static Dictionary<string, long[]> prevNet = new Dictionary<string, long[]>();
  static Stopwatch netWatch = new Stopwatch();
  static IntPtr query = IntPtr.Zero, cGpu = IntPtr.Zero, cGpuDed = IntPtr.Zero, cGpuShared = IntPtr.Zero, cPerf = IntPtr.Zero, cFreq = IntPtr.Zero;
  static int samples = 0;

  public static string Init(int[] diskNumbers, string[] physicalNics) {
    var notes = new List<string>();
    for (int i = 0; i < diskNumbers.Length; i++) {
      var d = new DiskState();
      d.Number = diskNumbers[i];
      disks.Add(d);
    }
    if (physicalNics != null) foreach (var n in physicalNics) if (!string.IsNullOrEmpty(n)) physNics.Add(n);
    try {
      if (PdhOpenQueryW(null, IntPtr.Zero, out query) == 0) {
        if (PdhAddEnglishCounterW(query, @"\GPU Engine(*)\Utilization Percentage", IntPtr.Zero, out cGpu) != 0) { cGpu = IntPtr.Zero; notes.Add("gpu"); }
        if (PdhAddEnglishCounterW(query, @"\GPU Adapter Memory(*)\Dedicated Usage", IntPtr.Zero, out cGpuDed) != 0) cGpuDed = IntPtr.Zero;
        if (PdhAddEnglishCounterW(query, @"\GPU Adapter Memory(*)\Shared Usage", IntPtr.Zero, out cGpuShared) != 0) cGpuShared = IntPtr.Zero;
        if (PdhAddEnglishCounterW(query, @"\Processor Information(_Total)\% Processor Performance", IntPtr.Zero, out cPerf) != 0) { cPerf = IntPtr.Zero; notes.Add("perf"); }
        if (PdhAddEnglishCounterW(query, @"\Processor Information(_Total)\Processor Frequency", IntPtr.Zero, out cFreq) != 0) cFreq = IntPtr.Zero;
        PdhCollectQueryData(query);
      } else { query = IntPtr.Zero; notes.Add("pdh"); }
    } catch { query = IntPtr.Zero; notes.Add("pdh"); }
    netWatch.Start();
    return string.Join(",", notes.ToArray());
  }

  static Dictionary<string, double> ReadArray(IntPtr counter) {
    var res = new Dictionary<string, double>();
    if (counter == IntPtr.Zero) return res;
    uint size = 0, count = 0;
    uint r = PdhGetFormattedCounterArrayW(counter, FMT, ref size, out count, IntPtr.Zero);
    if (r != PDH_MORE_DATA || size == 0) return res;
    IntPtr buf = Marshal.AllocHGlobal((int)size);
    try {
      r = PdhGetFormattedCounterArrayW(counter, FMT, ref size, out count, buf);
      if (r != 0) return res;
      for (int i = 0; i < count; i++) {
        long baseAddr = buf.ToInt64() + (long)i * 24;
        IntPtr item = new IntPtr(baseAddr);
        string name = Marshal.PtrToStringUni(Marshal.ReadIntPtr(item)) ?? "";
        uint status = (uint)Marshal.ReadInt32(item, 8);
        if (status != 0 && status != 1) continue;
        double v = BitConverter.Int64BitsToDouble(Marshal.ReadInt64(item, 16));
        if (double.IsNaN(v) || double.IsInfinity(v)) continue;
        res[name] = v;
      }
    } finally { Marshal.FreeHGlobal(buf); }
    return res;
  }

  static bool ReadDisk(int n, out long r, out long w, out long idle, out long qt) {
    r = w = idle = qt = 0;
    using (var h = CreateFileW(@"\\.\PhysicalDrive" + n, 0, 3, IntPtr.Zero, 3, 0, IntPtr.Zero)) {
      if (h.IsInvalid) return false;
      IntPtr buf = Marshal.AllocHGlobal(256);
      try {
        uint ret;
        if (!DeviceIoControl(h, 0x70020, IntPtr.Zero, 0, buf, 256, out ret, IntPtr.Zero) || ret < 64) return false;
        r = Marshal.ReadInt64(buf, 0); w = Marshal.ReadInt64(buf, 8); idle = Marshal.ReadInt64(buf, 32); qt = Marshal.ReadInt64(buf, 56);
        return true;
      } finally { Marshal.FreeHGlobal(buf); }
    }
  }

  static string F(double v) { return v.ToString("0.##", CultureInfo.InvariantCulture); }

  public static string Sample() {
    samples++;
    var sb = new StringBuilder();
    sb.Append("{\"t\":").Append(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
    // 1ª amostra só guarda a base para os deltas (disco, rede e GPU ainda não têm taxa)
    if (samples == 1) sb.Append(",\"warmup\":true");

    // ---- Disco (IOCTL_DISK_PERFORMANCE: sem contadores de desempenho, sem admin)
    double totR = 0, totW = 0, maxA = -1; bool anyDisk = false;
    var parts = new List<string>();
    foreach (var d in disks) {
      if (!d.Ok) continue;
      long r, w, idle, qt;
      bool ok = false;
      try { ok = ReadDisk(d.Number, out r, out w, out idle, out qt); } catch { r = w = idle = qt = 0; }
      if (!ok) { d.Ok = false; continue; }
      if (d.Has && qt > d.Qt) {
        double secs = (qt - d.Qt) / 1e7;
        double rb = Math.Max(0, (r - d.R) / secs), wb = Math.Max(0, (w - d.W) / secs);
        double active = 100.0 * (1.0 - (double)(idle - d.Idle) / (double)(qt - d.Qt));
        if (active < 0) active = 0; if (active > 100) active = 100;
        totR += rb; totW += wb; if (active > maxA) maxA = active; anyDisk = true;
        parts.Add("{\"n\":" + d.Number + ",\"r\":" + F(rb) + ",\"w\":" + F(wb) + ",\"a\":" + F(active) + "}");
      }
      d.R = r; d.W = w; d.Idle = idle; d.Qt = qt; d.Has = true;
    }
    if (anyDisk) sb.Append(",\"dr\":").Append(F(totR)).Append(",\"dw\":").Append(F(totW)).Append(",\"da\":").Append(F(maxA)).Append(",\"disks\":[").Append(string.Join(",", parts.ToArray())).Append("]");

    // ---- Rede (estatísticas das interfaces físicas; sem contadores de desempenho)
    try {
      double elapsed = netWatch.Elapsed.TotalSeconds; netWatch.Restart();
      double rx = 0, tx = 0; bool anyNet = false, hasPrev = prevNet.Count > 0;
      var seen = new Dictionary<string, long[]>();
      foreach (var ni in NetworkInterface.GetAllNetworkInterfaces()) {
        if (ni.NetworkInterfaceType == NetworkInterfaceType.Loopback || ni.NetworkInterfaceType == NetworkInterfaceType.Tunnel) continue;
        if (physNics.Count > 0) { if (!physNics.Contains(ni.Description)) continue; }
        else if (ni.OperationalStatus != OperationalStatus.Up || VirtualNic.IsMatch(ni.Description ?? "") || VirtualNic.IsMatch(ni.Name ?? "")) continue;
        long br, bs;
        try { var st = ni.GetIPStatistics(); br = st.BytesReceived; bs = st.BytesSent; } catch { continue; }
        seen[ni.Id] = new long[] { br, bs };
        long[] prev;
        if (hasPrev && elapsed > 0.05 && prevNet.TryGetValue(ni.Id, out prev)) {
          rx += Math.Max(0, br - prev[0]) / elapsed; tx += Math.Max(0, bs - prev[1]) / elapsed; anyNet = true;
        }
      }
      prevNet = seen;
      if (anyNet) sb.Append(",\"rx\":").Append(F(rx)).Append(",\"tx\":").Append(F(tx));
    } catch { }

    // ---- GPU e frequência (PDH com nomes em inglês)
    if (query != IntPtr.Zero) {
      try {
        PdhCollectQueryData(query);
        if (cGpu != IntPtr.Zero) {
          var eng = ReadArray(cGpu);
          var groups = new Dictionary<string, double>();
          foreach (var kv in eng) {
            string k = kv.Key; int li = k.IndexOf("luid_"); int ei = k.IndexOf("engtype_");
            if (li < 0 || ei < 0) continue;
            int pi = k.IndexOf("_phys", li); if (pi < 0) pi = ei;
            string g = k.Substring(li, pi - li) + "|" + k.Substring(ei + 8);
            double cur; groups.TryGetValue(g, out cur); groups[g] = cur + kv.Value;
          }
          double gmax = -1, g3d = -1;
          foreach (var kv in groups) {
            double v = Math.Min(100, kv.Value);
            if (v > gmax) gmax = v;
            if (kv.Key.EndsWith("|3D", StringComparison.OrdinalIgnoreCase) && v > g3d) g3d = v;
          }
          if (samples > 1 && gmax >= 0) sb.Append(",\"gpu\":").Append(F(gmax));
          if (samples > 1 && g3d >= 0) sb.Append(",\"gpu3d\":").Append(F(g3d));
        }
        if (cGpuDed != IntPtr.Zero) {
          var ded = ReadArray(cGpuDed); var sh = ReadArray(cGpuShared);
          string best = null; double bestV = -1;
          foreach (var kv in ded) if (kv.Value > bestV) { bestV = kv.Value; best = kv.Key; }
          if (best != null) {
            sb.Append(",\"gded\":").Append(F(bestV));
            double s; if (sh.TryGetValue(best, out s)) sb.Append(",\"gsh\":").Append(F(s));
          }
        }
        if (cPerf != IntPtr.Zero && cFreq != IntPtr.Zero) {
          var perf = ReadArray(cPerf); var freq = ReadArray(cFreq);
          double p, f;
          if (perf.TryGetValue("_Total", out p) && freq.TryGetValue("_Total", out f) && p > 0 && f > 0) sb.Append(",\"mhz\":").Append(F(f * p / 100.0));
        }
      } catch { }
    }
    sb.Append("}");
    return sb.ToString();
  }
}
`

/**
 * Loop persistente: imprime 1 linha JSON por segundo. Encerra sozinho quando o processo pai
 * (PID __PARENT_PID__) morre ou quando a saída padrão é fechada.
 * Marcadores substituídos em live.ts: __PARENT_PID__, __DISK_NUMS__ (ex.: 0,1,2), __NICS__ (strings já com psQuote).
 */
export const LIVE_SCRIPT_TEMPLATE = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
$parentPid = __PARENT_PID__
$parent = $null
try { $parent = [System.Diagnostics.Process]::GetProcessById($parentPid) } catch { exit 3 }
function ParentAlive {
  try { if ($parent.HasExited) { return $false }; return $true } catch {
    try { [void][System.Diagnostics.Process]::GetProcessById($parentPid); return $true } catch { return $false }
  }
}
function Emit([string]$line) {
  try { [Console]::Out.WriteLine($line); [Console]::Out.Flush() } catch { exit 0 }
}
try {
  Remove-Item Env:LIB -ErrorAction SilentlyContinue
  Add-Type -TypeDefinition @'
__LIVE_CS__
'@ -IgnoreWarnings -ErrorAction Stop
} catch {
  Emit ('{"error":"compile","message":' + (ConvertTo-Json -InputObject ([string]$_.Exception.Message) -Compress) + '}')
  exit 4
}
# Discos e placas de rede físicas vêm do app (já coletados); sem eles, testa PhysicalDrive0..15 e
# filtra adaptadores virtuais pela descrição (consultar Get-PhysicalDisk/Get-NetAdapter aqui custaria ~2 s).
[int[]]$diskNums = @(__DISK_NUMS__)
[string[]]$nics = @(__NICS__)
if ($diskNums.Count -eq 0) { $diskNums = [int[]](0..15) }
$notes = [IacLive]::Init($diskNums, $nics)
Emit ('{"ready":true,"notes":"' + $notes + '"}')
$warm = $true
while ($true) {
  $t0 = [Environment]::TickCount
  if (-not (ParentAlive)) { exit 0 }
  $line = $null
  try { $line = [IacLive]::Sample() } catch { $line = '{"error":"sample"}' }
  Emit $line
  $wait = 1000 - ([Environment]::TickCount - $t0)
  if ($wait -lt 50) { $wait = 50 }
  # Depois da amostra-base, a primeira taxa sai mais cedo (os cálculos usam o tempo real decorrido)
  if ($warm) { $wait = 450; $warm = $false }
  Start-Sleep -Milliseconds $wait
}
`.replace('__LIVE_CS__', () => LIVE_CS)
