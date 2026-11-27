// Coleta de hardware: roda UM script PowerShell (scripts.ts) e normaliza a saída crua em HardwareInfo.
// Somente leitura. Tudo que falhar vira aviso em `warnings`; nada derruba a coleta inteira.
import type {
  BiosInfo,
  CpuCacheInfo,
  CpuInfo,
  DisplayInfo,
  GpuInfo,
  HardwareInfo,
  MemoryInfo,
  MotherboardInfo,
  NetAdapterInfo,
  OsInfo,
  PartitionInfo,
  PhysicalDiskInfo,
  RamModule
} from '@shared/types/hardware'
import { runPowerShellJson } from '../core/powershell'
import { cpuVendorName, lookupCodename, parseCpuIdentifier } from './codenames'
import { buildInsights } from './insights'
import { collectNvidiaStatic, type NvidiaStaticGpu } from './nvidia'
import { INFO_SCRIPT } from './scripts'

// ---------------- Formato cru vindo do PowerShell ----------------
type Maybe<T> = T | null | undefined

interface RawCpu {
  name?: string
  manufacturer?: string
  caption?: string
  cores?: number
  threads?: number
  sockets?: number
  maxClock?: number
  curClock?: number
  l2?: number
  l3?: number
  socket?: string
  virtFw?: Maybe<boolean>
  arch?: number
  identifier?: string
  regMhz?: number
  regName?: string
  regVendor?: string
  wmiCaches?: Maybe<{ level: number; kb: number }[] | { level: number; kb: number }>
  features?: Maybe<string[] | string>
  caches?: Maybe<string[] | string>
}
interface RawSystem {
  manufacturer?: string
  model?: string
  pcSystemType?: number
  totalPhysical?: number
  hypervisor?: boolean
  chassis?: Maybe<number[] | number>
  hasBattery?: boolean
}
interface RawBoard {
  manufacturer?: string
  product?: string
  version?: string
  serial?: string
  pnp?: Maybe<string[] | string>
}
interface RawBios {
  vendor?: string
  version?: string
  fallbackVersion?: string
  releaseDate?: string
  firmwareType?: number
  envFirmware?: string
  secureBoot?: Maybe<number>
}
interface RawModule {
  capacity?: number
  smbiosType?: number
  memoryType?: number
  speed?: number
  configured?: number
  manufacturer?: string
  partNumber?: string
  locator?: string
  bank?: string
  voltage?: number
  formFactor?: number
}
interface RawGpu {
  name?: string
  compat?: string
  adapterRam?: number
  driverVersion?: string
  driverDate?: string
  w?: number
  h?: number
  hz?: number
  pnp?: string
}
interface RawGpuReg {
  desc?: string
  match?: string
  provider?: string
  qw?: Maybe<number>
  ms?: Maybe<number>
}
interface RawPartition {
  letter?: Maybe<string>
  size?: number
  type?: string
  label?: Maybe<string>
  free?: Maybe<number>
  fs?: Maybe<string>
}
interface RawDisk {
  number?: number
  friendly?: Maybe<string>
  model?: Maybe<string>
  serial?: Maybe<string>
  firmware?: Maybe<string>
  media?: string
  bus?: string
  size?: number
  health?: Maybe<string>
  rel?: Maybe<{
    temp?: Maybe<number>
    tempMax?: Maybe<number>
    wear?: Maybe<number>
    hours?: Maybe<number>
    readErr?: Maybe<number>
    writeErr?: Maybe<number>
  }>
  partitions?: Maybe<RawPartition[] | RawPartition>
}
interface RawMonitor {
  instance?: string
  name?: string
  mfg?: string
  product?: string
  year?: number
  active?: boolean
  wcm?: number
  hcm?: number
  tech?: Maybe<number>
}
interface RawMode {
  device?: string
  adapter?: string
  monitorName?: Maybe<string>
  monitorId?: Maybe<string>
  w?: number
  h?: number
  hz?: number
  bpp?: number
  primary?: boolean
  maxHz?: number
}
interface RawNet {
  name?: string
  desc?: string
  mac?: Maybe<string>
  speed?: number
  status?: string
  mediaConnect?: number
  physMedia?: Maybe<string>
  ndisMedium?: number
  driverVersion?: Maybe<string>
  driverDate?: Maybe<string>
  driverProvider?: Maybe<string>
  hardware?: boolean
  virtual?: boolean
}
interface RawOs {
  caption?: string
  version?: string
  build?: string
  osArch?: string
  installDate?: Maybe<string>
  lastBoot?: Maybe<string>
  csName?: string
  displayVersion?: Maybe<string>
  ubr?: Maybe<number>
  edition?: Maybe<string>
  currentBuild?: Maybe<string>
  is64?: boolean
  procArch?: string
  user?: string
  computer?: string
}
interface RawBattery {
  charge?: number
  status?: number
  design?: number
  full?: number
}
export interface RawHardware {
  native?: boolean
  cpu?: RawCpu
  system?: RawSystem
  board?: RawBoard
  bios?: RawBios
  memory?: { modules?: Maybe<RawModule[] | RawModule>; slots?: Maybe<number>; maxKb?: Maybe<number> }
  gpus?: Maybe<RawGpu[] | RawGpu>
  gpuReg?: Maybe<RawGpuReg[] | RawGpuReg>
  disks?: Maybe<RawDisk[] | RawDisk>
  monitors?: Maybe<RawMonitor[] | RawMonitor>
  modes?: Maybe<RawMode[] | RawMode>
  network?: Maybe<RawNet[] | RawNet>
  audio?: Maybe<string[] | string>
  os?: RawOs
  battery?: Maybe<RawBattery>
  sysDrive?: string
  warnings?: Maybe<string[] | string>
  timings?: Record<string, number>
}

// ---------------- Utilitários ----------------
export function arr<T>(x: Maybe<T[] | T>): T[] {
  if (Array.isArray(x)) return x.filter((v) => v !== null && v !== undefined)
  return x === null || x === undefined ? [] : [x]
}

function str(x: unknown): string | undefined {
  if (x === null || x === undefined) return undefined
  const s = String(x).replace(/\s+/g, ' ').trim()
  return s ? s : undefined
}

function pos(x: unknown): number | undefined {
  const n = typeof x === 'number' ? x : Number(x)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

/** Valores "de fábrica" sem significado que vários fabricantes deixam no SMBIOS. */
const PLACEHOLDER = /^(to be filled by o\.?e\.?m\.?|default string|system (product name|serial number|manufacturer|version)|not (specified|applicable|available)|none|null|n\/a|o\.?e\.?m\.?|unknown|0+|x+|123456789|base board serial number|sku|chassis serial number)$/i

export function clean(x: unknown): string | undefined {
  const s = str(x)
  if (!s || PLACEHOLDER.test(s)) return undefined
  return s
}

// ---------------- CPU ----------------
const GENERIC_SOCKET = /^(cpu\s*\d*|socket\s*\d*|proc(essor)?\s*\d*|u3e1|cpu\s*socket.*|none|unknown|other|p\d)$/i
const MOBILE_CPU = /\b\d{4,5}(U|H|HS|HX|HK|HQ|Y|M|P|G\d)\b|mobile|notebook|ryzen ai/i

function parseCaches(raw: RawCpu): CpuCacheInfo[] {
  const out: CpuCacheInfo[] = []
  for (const line of arr(raw.caches)) {
    const [level, type, size, ways, lineSize, count] = String(line).split('|').map(Number)
    if (!level || !size) continue
    out.push({
      level,
      type: type === 1 ? 'instruction' : type === 2 ? 'data' : 'unified',
      sizeKb: Math.round(size / 1024),
      count: count || 1,
      ways: ways && ways !== 0xff ? ways : undefined,
      lineBytes: lineSize || undefined
    })
  }
  return out.sort((a, b) => a.level - b.level || (a.type === 'data' ? -1 : 1))
}

function normalizeCpu(raw: RawCpu = {}, sys: RawSystem = {}): CpuInfo {
  const name = str(raw.regName) ?? str(raw.name) ?? 'Processador desconhecido'
  const vendor = cpuVendorName(raw.regVendor ?? raw.manufacturer, name)
  const identifier = str(raw.identifier) ?? str(raw.caption)
  const id = parseCpuIdentifier(identifier)
  const cn = lookupCodename(vendor, id)
  const caches = parseCaches(raw)
  const sumKb = (level: number): number | undefined => {
    const items = caches.filter((c) => c.level === level)
    return items.length ? items.reduce((s, c) => s + c.sizeKb * c.count, 0) : undefined
  }
  // Win32_CacheMemory: Level 3 = L1, 4 = L2, 5 = L3
  const wmiCache = (level: number): number | undefined => pos(arr(raw.wmiCaches).find((c) => c.level === level)?.kb)
  const features = arr(raw.features).map(String)
  const hypervisor = Boolean(sys.hypervisor)
  const virt = raw.virtFw === true || features.includes('VIRT') || hypervisor
  const arch = raw.arch === 9 ? 'x64 (64 bits)' : raw.arch === 12 ? 'ARM64' : raw.arch === 5 ? 'ARM' : raw.arch === 0 ? 'x86 (32 bits)' : 'Desconhecida'

  const SIMD = ['MMX', 'SSE', 'SSE2', 'SSE3', 'SSSE3', 'SSE4.1', 'SSE4.2', 'AVX', 'AVX2', 'AVX-512F', '3DNow!']
  const instructions = SIMD.filter((f) => features.includes(f))
  if (raw.arch === 9) instructions.push('x86-64')
  if (virt) instructions.push(vendor === 'AMD' ? 'AMD-V' : vendor === 'Intel' ? 'VT-x' : 'Virtualização')

  let socket = str(raw.socket)
  if ((!socket || GENERIC_SOCKET.test(socket)) && cn?.desktopSocket && !MOBILE_CPU.test(name)) socket = cn.desktopSocket
  if (socket && GENERIC_SOCKET.test(socket)) socket = undefined

  return {
    name,
    vendor,
    codename: cn ? `${cn.arch} (${cn.name})` : undefined,
    microarchitecture: cn?.arch,
    technology: cn?.tech,
    identifier,
    family: id.family,
    model: id.model,
    stepping: id.stepping,
    socket,
    cores: pos(raw.cores) ?? 0,
    threads: pos(raw.threads) ?? pos(raw.cores) ?? 0,
    sockets: pos(raw.sockets),
    baseMhz: pos(raw.maxClock) ?? pos(raw.regMhz),
    currentMhz: pos(raw.curClock),
    l1Kb: sumKb(1) ?? wmiCache(3),
    l2Kb: pos(raw.l2) ?? sumKb(2) ?? wmiCache(4),
    l3Kb: pos(raw.l3) ?? sumKb(3) ?? wmiCache(5),
    caches: caches.length ? caches : undefined,
    instructions,
    virtualizationEnabled: raw.virtFw === undefined && !features.length && !hypervisor ? undefined : virt,
    hypervisorPresent: hypervisor,
    architecture: arch
  }
}

// ---------------- Placa-mãe / BIOS / sistema ----------------
const CHIPSET_RE =
  /(?<![A-Z0-9])((?:A320|B350|X370|B450|X470|A520|B550|X570|A620|B650E?|X670E?|B840|B850|X870E?|TRX40|TRX50|X399|WRX80|WRX90)|(?:H61|B75|H77|Z77|H81|B85|H87|Z87|H97|Z97|X79|X99|H110|B150|H170|Z170|Q170|B250|H270|Z270|Q270|H310|B360|B365|H370|Z370|Z390|Q370|H410|B460|H470|Z490|Q470|W480|H510|B560|H570|Z590|W580|H610|B660|H670|Z690|Q670|W680|B760|H770|Z790|W790|X299|H810|B860|Z890))(?![0-9])/i

export function inferChipset(product: string | undefined, pnpNames: string[]): string | undefined {
  const m = product ? CHIPSET_RE.exec(product.toUpperCase()) : null
  if (m) return m[1].toUpperCase()
  for (const n of pnpNames) {
    const p = CHIPSET_RE.exec(n.toUpperCase())
    if (p) return p[1].toUpperCase()
    const series = /Intel\(R\)\s+(\d00)\s+Series\s+Chipset/i.exec(n)
    if (series) return `Intel série ${series[1]}`
  }
  return undefined
}

function normalizeBoard(raw: RawBoard = {}): MotherboardInfo {
  const product = clean(raw.product) ?? 'Desconhecida'
  return {
    manufacturer: clean(raw.manufacturer) ?? 'Desconhecido',
    product,
    version: clean(raw.version),
    serial: clean(raw.serial),
    chipset: inferChipset(product, arr(raw.pnp).map(String))
  }
}

function normalizeBios(raw: RawBios = {}): BiosInfo {
  const env = (raw.envFirmware ?? '').toLowerCase()
  const mode: BiosInfo['mode'] =
    raw.firmwareType === 2 ? 'UEFI' : raw.firmwareType === 1 ? 'Legacy' : env === 'uefi' ? 'UEFI' : env === 'legacy' ? 'Legacy' : 'Unknown'
  return {
    vendor: clean(raw.vendor) ?? 'Desconhecido',
    version: clean(raw.version) ?? clean(raw.fallbackVersion) ?? '—',
    releaseDate: str(raw.releaseDate),
    mode,
    secureBoot: raw.secureBoot === 1 ? true : raw.secureBoot === 0 ? false : mode === 'Legacy' ? false : undefined
  }
}

const CHASSIS: Record<number, string> = {
  3: 'Desktop',
  4: 'Desktop compacto',
  5: 'Pizza box',
  6: 'Mini torre',
  7: 'Torre',
  8: 'Portátil',
  9: 'Notebook',
  10: 'Notebook',
  11: 'Portátil de mão',
  13: 'All-in-one',
  14: 'Sub-notebook',
  15: 'Compacto',
  16: 'Lunch box',
  17: 'Servidor',
  30: 'Tablet',
  31: 'Conversível (2 em 1)',
  32: 'Destacável (2 em 1)',
  35: 'Mini PC',
  36: 'PC stick'
}
const LAPTOP_CHASSIS = new Set([8, 9, 10, 11, 14, 30, 31, 32])

// ---------------- Memória ----------------
const SMBIOS_MEM: Record<number, string> = {
  18: 'DDR',
  19: 'DDR2',
  20: 'DDR',
  21: 'DDR2',
  22: 'DDR2 FB-DIMM',
  24: 'DDR3',
  26: 'DDR4',
  27: 'LPDDR',
  28: 'LPDDR2',
  29: 'LPDDR3',
  30: 'LPDDR4',
  34: 'DDR5',
  35: 'LPDDR5'
}
const FORM_FACTOR: Record<number, string> = { 8: 'DIMM', 12: 'SO-DIMM', 13: 'SRIMM', 9: 'RIMM' }
/** IDs JEDEC que alguns BIOS colocam no campo Fabricante. */
const JEDEC: Record<string, string> = {
  '80CE': 'Samsung',
  CE00: 'Samsung',
  '00CE': 'Samsung',
  '80AD': 'SK Hynix',
  AD00: 'SK Hynix',
  '00AD': 'SK Hynix',
  '802C': 'Micron',
  '2C00': 'Micron',
  '002C': 'Micron',
  '859B': 'Crucial',
  '9B05': 'Crucial',
  '0198': 'Kingston',
  '9801': 'Kingston',
  '04CD': 'G.Skill',
  CD04: 'G.Skill',
  '029E': 'Corsair',
  '9E02': 'Corsair',
  '04EF': 'Team Group',
  EF04: 'Team Group',
  '04CB': 'ADATA',
  CB04: 'ADATA'
}

const DDR_SPEEDS = [
  1333, 1600, 1866, 2133, 2400, 2666, 2933, 3000, 3200, 3333, 3466, 3600, 3733, 3800, 4000, 4133, 4266, 4400, 4600, 4800, 5200, 5600, 6000,
  6200, 6400, 6600, 6800, 7200, 7600, 8000, 8200, 8400
]
const SHORT_SPEED: Record<string, number> = {
  '13': 1333,
  '16': 1600,
  '18': 1866,
  '21': 2133,
  '24': 2400,
  '26': 2666,
  '29': 2933,
  '30': 3000,
  '32': 3200,
  '33': 3333,
  '34': 3466,
  '36': 3600,
  '37': 3733,
  '38': 3800,
  '40': 4000,
  '42': 4266,
  '44': 4400,
  '46': 4600,
  '48': 4800,
  '52': 5200,
  '56': 5600,
  '60': 6000,
  '62': 6200,
  '64': 6400,
  '66': 6600,
  '68': 6800,
  '72': 7200,
  '76': 7600,
  '80': 8000
}

/** Velocidade anunciada no part number de kits XMP/EXPO comuns (Kingston, Corsair, G.Skill, Crucial, ADATA, Team...). */
export function advertisedSpeedFromPart(part: string | undefined): number | undefined {
  if (!part) return undefined
  const p = part.toUpperCase().replace(/\s+/g, '')
  const kingston = /^(?:KF|HX)([345])(\d{2})[A-Z]/.exec(p) ?? /^KVR(\d{2})[A-Z]/.exec(p)
  if (kingston) return SHORT_SPEED[kingston[kingston.length - 1]]
  const ballistix = /^BL\w*?G(\d{2})C\d{2}/.exec(p)
  if (ballistix) return SHORT_SPEED[ballistix[1]]
  const adata = /^AX[45]U(\d{4})/.exec(p)
  if (adata && DDR_SPEEDS.includes(Number(adata[1]))) return Number(adata[1])
  for (const m of p.matchAll(/(?<!\d)(\d{4})(?!\d)/g)) {
    const n = Number(m[1])
    if (DDR_SPEEDS.includes(n)) return n
  }
  return undefined
}

export function channelFromSlot(locator?: string, bank?: string): string | undefined {
  for (const s of [locator, bank]) {
    if (!s) continue
    const m =
      /CHANNEL\s*([A-H])\b/i.exec(s) ??
      /Channel([A-H])-/i.exec(s) ??
      /(?:^|[_\s-])CH(?:ANNEL)?[_\s-]?([A-H])(?:\b|\d)/i.exec(s) ??
      /DIMM[_\s-]?([A-H])\d/i.exec(s) ??
      /^([A-H])\d$/i.exec(s.trim())
    if (m) return m[1].toUpperCase()
  }
  return undefined
}

function normalizeMemory(raw: RawHardware['memory'] = {}, sys: RawSystem = {}): MemoryInfo {
  const modules: RamModule[] = arr(raw.modules).map((m, i) => {
    const mfgRaw = clean(m.manufacturer)
    const mfgKey = mfgRaw?.replace(/^0x/i, '').toUpperCase()
    const partNumber = clean(m.partNumber)
    const speed = pos(m.speed)
    const advertised = advertisedSpeedFromPart(partNumber)
    return {
      slot: clean(m.locator) ?? clean(m.bank) ?? `Slot ${i + 1}`,
      bank: clean(m.bank),
      capacityBytes: pos(m.capacity) ?? 0,
      type: SMBIOS_MEM[m.smbiosType ?? -1] ?? SMBIOS_MEM[m.memoryType ?? -1] ?? 'Desconhecido',
      speedMhz: speed,
      configuredMhz: pos(m.configured),
      manufacturer: mfgKey && JEDEC[mfgKey] ? JEDEC[mfgKey] : mfgRaw,
      partNumber,
      formFactor: FORM_FACTOR[m.formFactor ?? -1],
      voltageMv: pos(m.voltage),
      advertisedMhz: advertised && (!speed || advertised > speed) ? advertised : undefined,
      channel: channelFromSlot(clean(m.locator), clean(m.bank))
    }
  })
  const installed = modules.reduce((s, m) => s + m.capacityBytes, 0)
  const usable = pos(sys.totalPhysical)
  const slots = pos(raw.slots)
  return {
    totalBytes: installed || usable || 0,
    usableBytes: usable,
    slotsTotal: slots && slots >= modules.length ? slots : undefined,
    slotsUsed: modules.length,
    maxCapacityBytes: pos(raw.maxKb) ? (raw.maxKb as number) * 1024 : undefined,
    modules,
    channelsGuess: guessChannels(modules)
  }
}

export function guessChannels(modules: RamModule[]): string | undefined {
  if (modules.length === 0) return undefined
  if (modules.length === 1) return 'Single channel (1 pente)'
  const channels = new Set(modules.map((m) => m.channel).filter(Boolean))
  if (channels.size >= 4) return 'Quad channel (provável)'
  if (channels.size >= 2) return 'Dual channel'
  if (channels.size === 1 && modules.every((m) => m.channel)) return 'Single channel (pentes no mesmo canal)'
  return modules.length % 2 === 0 ? 'Dual channel (provável)' : 'Dual channel parcial (provável)'
}

// ---------------- Vídeo ----------------
function gpuVendor(name: string, compat?: string): string {
  const s = `${name} ${compat ?? ''}`.toLowerCase()
  if (s.includes('nvidia')) return 'NVIDIA'
  if (s.includes('amd') || s.includes('radeon') || s.includes('advanced micro') || s.includes('ati ')) return 'AMD'
  if (s.includes('intel')) return 'Intel'
  if (s.includes('microsoft')) return 'Microsoft'
  return clean(compat) ?? 'Desconhecido'
}

export function isIntegratedGpu(name: string, vendor: string, vram: number | undefined): boolean {
  const n = name.toLowerCase()
  if (vendor === 'Intel') return !/arc.*\b[ab]\d{3}\b/i.test(name)
  if (vendor === 'AMD') {
    if (/\brx\b|radeon pro|firepro|\br9\b|\bhd \d{4}\b|vii\b/i.test(name)) return false
    if (/radeon\(tm\) graphics|radeon graphics|vega \d+|\b\d{3}m\b/i.test(n)) return true
    return vram !== undefined && vram <= 2 * 1024 ** 3
  }
  return false
}

function normalizeGpus(gpus: RawGpu[], reg: RawGpuReg[]): GpuInfo[] {
  const list = gpus.map((g): GpuInfo => {
    const name = str(g.name) ?? 'Adaptador de vídeo'
    const pnp = str(g.pnp)
    const r = reg.find(
      (x) => (x.desc && x.desc === name) || (x.match && pnp && pnp.toLowerCase().startsWith(x.match.toLowerCase()))
    )
    const qw = pos(r?.qw)
    const ms = pos(r?.ms)
    const wmi = pos(g.adapterRam)
    const vram = qw ?? ms ?? wmi
    const vendor = gpuVendor(name, g.compat)
    const isVirtual = Boolean(pnp && /^ROOT\\/i.test(pnp)) || /virtual|parsec|remote display|indirect display|spacedesk|meta virtual/i.test(name)
    const basic = /basic display|vídeo básico|video básico/i.test(name)
    const w = pos(g.w)
    const h = pos(g.h)
    const hz = pos(g.hz)
    return {
      name,
      vendor,
      vramBytes: isVirtual ? undefined : vram,
      vramSource: isVirtual || vram === undefined ? undefined : qw || ms ? 'registry' : 'wmi',
      driverVersion: str(g.driverVersion),
      driverDate: str(g.driverDate),
      driverProvider: str(r?.provider),
      currentResolution: w && h ? `${w}x${h}` : undefined,
      refreshRateHz: hz && hz > 1 ? hz : undefined,
      isIntegrated: !isVirtual && isIntegratedGpu(name, vendor, vram),
      isVirtual,
      basicDriver: basic || undefined,
      pnpDeviceId: pnp
    }
  })
  const rank = (g: GpuInfo): number => (g.isVirtual ? 2 : g.isIntegrated ? 1 : 0)
  return list.sort((a, b) => rank(a) - rank(b))
}

// ---------------- Armazenamento ----------------
function normalizeMedia(m: string | undefined, bus: string): PhysicalDiskInfo['mediaType'] {
  const v = (m ?? '').toUpperCase()
  if (v === 'SSD' || v === '4') return 'SSD'
  if (v === 'HDD' || v === '3') return 'HDD'
  if (v === 'SCM' || v === '5') return 'SCM'
  if (bus === 'NVMe') return 'SSD'
  return 'Unknown'
}

function normalizeBus(b: string | undefined): string {
  const v = (b ?? '').trim()
  const map: Record<string, string> = {
    '17': 'NVMe',
    '11': 'SATA',
    '7': 'USB',
    '8': 'RAID',
    '10': 'SAS',
    '1': 'SCSI',
    '3': 'ATA',
    '12': 'SD',
    '13': 'MMC',
    '15': 'Virtual',
    '16': 'Storage Spaces',
    nvme: 'NVMe',
    sata: 'SATA',
    usb: 'USB',
    raid: 'RAID',
    sas: 'SAS',
    scsi: 'SCSI',
    ide: 'SATA/IDE',
    ata: 'ATA'
  }
  return map[v] ?? map[v.toLowerCase()] ?? (v || 'Desconhecido')
}

const PART_TYPE: Record<string, string> = {
  Recovery: 'Recuperação',
  System: 'Sistema EFI',
  Reserved: 'Reservada (MSR)',
  Unknown: 'Desconhecida'
}

function normalizeDisks(raw: RawDisk[], sysDrive: string): PhysicalDiskInfo[] {
  const sysLetter = sysDrive.replace(':', '').toUpperCase()
  const disks = raw.map((d): PhysicalDiskInfo => {
    const bus = normalizeBus(d.bus)
    const partitions: PartitionInfo[] = arr(d.partitions).map((p) => ({
      letter: str(p.letter) ? `${str(p.letter)!.toUpperCase()}:` : undefined,
      sizeBytes: pos(p.size) ?? 0,
      label: str(p.label) ?? (str(p.letter) ? undefined : (PART_TYPE[str(p.type) ?? ''] ?? str(p.type))),
      freeBytes: typeof p.free === 'number' && p.free >= 0 ? p.free : undefined,
      fileSystem: str(p.fs)
    }))
    const rel = d.rel ?? undefined
    const temp = pos(rel?.temp)
    return {
      number: typeof d.number === 'number' ? d.number : undefined,
      model: str(d.model) ?? str(d.friendly) ?? 'Disco',
      serial: clean(d.serial)?.replace(/\.$/, ''),
      firmware: str(d.firmware),
      mediaType: normalizeMedia(d.media, bus),
      busType: bus,
      sizeBytes: pos(d.size) ?? 0,
      health: str(d.health),
      temperatureC: temp && temp < 150 ? temp : undefined,
      temperatureMaxC: pos(rel?.tempMax),
      wearPercent: typeof rel?.wear === 'number' && rel.wear >= 0 && rel.wear <= 100 ? rel.wear : undefined,
      powerOnHours: pos(rel?.hours),
      readErrors: typeof rel?.readErr === 'number' ? rel.readErr : undefined,
      writeErrors: typeof rel?.writeErr === 'number' ? rel.writeErr : undefined,
      reliabilityAvailable: Boolean(rel),
      partitions,
      isSystemDisk: partitions.some((p) => p.letter === `${sysLetter}:`)
    }
  })
  return disks.sort((a, b) => Number(b.isSystemDisk) - Number(a.isSystemDisk) || (a.number ?? 99) - (b.number ?? 99))
}

// ---------------- Monitores ----------------
const PNP_VENDORS: Record<string, string> = {
  AOC: 'AOC',
  ACR: 'Acer',
  ACI: 'ASUS',
  AUS: 'ASUS',
  BNQ: 'BenQ',
  DEL: 'Dell',
  GSM: 'LG',
  LGD: 'LG Display',
  HWP: 'HP',
  HPN: 'HP',
  LEN: 'Lenovo',
  MSI: 'MSI',
  SAM: 'Samsung',
  SEC: 'Samsung',
  SNY: 'Sony',
  PHL: 'Philips',
  VSC: 'ViewSonic',
  GBT: 'Gigabyte',
  AUO: 'AU Optronics',
  BOE: 'BOE',
  CMN: 'Innolux',
  SHP: 'Sharp',
  IVM: 'iiyama',
  HKC: 'HKC',
  XMI: 'Xiaomi',
  PNP: 'Genérico',
  NEC: 'NEC',
  EIZ: 'EIZO',
  ENC: 'EIZO',
  AOP: 'AOpen',
  PGE: 'Pixio',
  KOA: 'Koorui',
  TCL: 'TCL',
  PCK: 'Pichau',
  MON: 'Monoprice'
}
const OUTPUT_TECH: Record<number, string> = {
  0: 'VGA',
  1: 'S-Video',
  2: 'Composto',
  3: 'Componente',
  4: 'DVI',
  5: 'HDMI',
  6: 'LVDS (interna)',
  10: 'DisplayPort',
  11: 'eDP (interna)',
  12: 'UDI',
  13: 'UDI (interna)',
  15: 'Miracast (sem fio)',
  16: 'Indireta (USB/virtual)',
  [-2147483648]: 'Interna',
  [2147483648]: 'Interna'
}

function normalizeDisplays(monitors: RawMonitor[], modes: RawMode[], gpus: GpuInfo[]): DisplayInfo[] {
  const used = new Set<RawMode>()
  const out: DisplayInfo[] = []
  for (const m of monitors) {
    if (m.active === false) continue
    const key = (m.instance ?? '').replace(/_\d+$/, '').replace(/\\/g, '#').toUpperCase()
    const mode = key ? modes.find((x) => !used.has(x) && (x.monitorId ?? '').toUpperCase().includes(key)) : undefined
    if (mode) used.add(mode)
    const mfgCode = str(m.mfg)?.toUpperCase()
    const manufacturer = mfgCode ? (PNP_VENDORS[mfgCode] ?? mfgCode) : undefined
    const w = pos(m.wcm)
    const h = pos(m.hcm)
    const diag = w && h ? Math.sqrt(w * w + h * h) / 2.54 : undefined
    const hz = pos(mode?.hz)
    const maxHz = pos(mode?.maxHz)
    out.push({
      name: str(m.name) ?? ([manufacturer, str(m.product)].filter(Boolean).join(' ') || 'Monitor'),
      manufacturer,
      resolution: mode && pos(mode.w) && pos(mode.h) ? `${mode.w}x${mode.h}` : undefined,
      refreshRateHz: hz && hz > 1 ? hz : undefined,
      maxRefreshRateHz: maxHz && maxHz > 1 ? maxHz : undefined,
      bitsPerPixel: pos(mode?.bpp),
      sizeInches: diag ? Math.round(diag * 2) / 2 : undefined,
      connection: typeof m.tech === 'number' ? OUTPUT_TECH[m.tech] : undefined,
      adapter: str(mode?.adapter),
      isPrimary: mode?.primary,
      year: pos(m.year)
    })
  }
  // Saídas ativas sem EDID correspondente (ex.: monitor virtual do Parsec, leitura do EDID negada)
  for (const mode of modes) {
    if (used.has(mode)) continue
    const hz = pos(mode.hz)
    const maxHz = pos(mode.maxHz)
    out.push({
      name: str(mode.monitorName) ?? 'Monitor',
      resolution: pos(mode.w) && pos(mode.h) ? `${mode.w}x${mode.h}` : undefined,
      refreshRateHz: hz && hz > 1 ? hz : undefined,
      maxRefreshRateHz: maxHz && maxHz > 1 ? maxHz : undefined,
      bitsPerPixel: pos(mode.bpp),
      adapter: str(mode.adapter),
      isPrimary: mode.primary
    })
  }
  // Sem leitor nativo: usa a resolução atual da placa de vídeo principal no primeiro monitor
  if (modes.length === 0 && out.length > 0) {
    const g = gpus.find((x) => x.currentResolution && !x.isVirtual)
    if (g) {
      out[0].resolution = g.currentResolution
      out[0].refreshRateHz = g.refreshRateHz
      out[0].adapter = g.name
    }
  }
  return out.sort((a, b) => Number(Boolean(b.isPrimary)) - Number(Boolean(a.isPrimary)))
}

// ---------------- Rede / SO / bateria ----------------
const NET_STATUS: Record<string, string> = {
  Up: 'Conectado',
  Disconnected: 'Desconectado',
  Disabled: 'Desativado',
  'Not Present': 'Ausente',
  Dormant: 'Inativo',
  Down: 'Desconectado'
}

function normalizeNetwork(raw: RawNet[]): NetAdapterInfo[] {
  const list = raw.map((n): NetAdapterInfo => {
    const status = str(n.status) ?? ''
    const desc = str(n.desc) ?? ''
    const isWifi = n.ndisMedium === 9 || /802\.11|wireless|wi-?fi|wlan/i.test(`${n.physMedia ?? ''} ${desc}`)
    return {
      name: str(n.name) ?? desc ?? 'Adaptador',
      description: desc,
      macAddress: str(n.mac),
      linkSpeedBps: pos(n.speed),
      status: NET_STATUS[status] ?? (status || 'Desconhecido'),
      connected: status === 'Up',
      isWifi,
      isVirtual: n.hardware === false || n.virtual === true,
      driverVersion: str(n.driverVersion),
      driverDate: str(n.driverDate),
      driverProvider: str(n.driverProvider)
    }
  })
  return list.sort(
    (a, b) => Number(Boolean(a.isVirtual)) - Number(Boolean(b.isVirtual)) || Number(Boolean(b.connected)) - Number(Boolean(a.connected))
  )
}

function normalizeOs(raw: RawOs = {}): OsInfo {
  const base = str(raw.currentBuild) ?? str(raw.build) ?? ''
  const arch = (raw.procArch ?? '').toUpperCase()
  return {
    caption: str(raw.caption) ?? 'Windows',
    version: str(raw.version) ?? '',
    build: base && typeof raw.ubr === 'number' ? `${base}.${raw.ubr}` : base,
    architecture:
      arch === 'ARM64' ? '64 bits (ARM64)' : raw.is64 || arch === 'AMD64' ? '64 bits (x64)' : arch === 'X86' ? '32 bits (x86)' : (str(raw.osArch) ?? ''),
    installDate: str(raw.installDate),
    lastBoot: str(raw.lastBoot),
    computerName: str(raw.computer) ?? str(raw.csName) ?? '',
    userName: str(raw.user) ?? '',
    displayVersion: str(raw.displayVersion),
    edition: str(raw.edition)
  }
}

const BATTERY_STATUS: Record<number, string> = {
  1: 'Descarregando',
  2: 'Ligado na tomada',
  3: 'Carga completa',
  4: 'Carga baixa',
  5: 'Carga crítica',
  6: 'Carregando',
  7: 'Carregando (carga alta)',
  8: 'Carregando (carga baixa)',
  9: 'Carregando (carga crítica)',
  11: 'Parcialmente carregada'
}

function normalizeBattery(raw: Maybe<RawBattery>): HardwareInfo['battery'] {
  if (!raw) return undefined
  const design = pos(raw.design)
  const full = pos(raw.full)
  return {
    designCapacityMwh: design,
    fullChargeCapacityMwh: full,
    healthPercent: design && full ? Math.min(100, Math.round((full / design) * 100)) : undefined,
    status: raw.status !== undefined ? BATTERY_STATUS[raw.status] : undefined,
    chargePercent: typeof raw.charge === 'number' ? raw.charge : undefined
  }
}

// ---------------- NVIDIA (nvidia-smi) ----------------
/** Liga cada placa do nvidia-smi à placa do Windows de mesmo nome (cada uma usada uma vez); senão, pela ordem. */
export function attachNvidia(gpus: GpuInfo[], nv: NvidiaStaticGpu[]): void {
  const pending = [...nv].sort((a, b) => a.index - b.index)
  const take = (g: GpuInfo): NvidiaStaticGpu | undefined => {
    const norm = (x: string): string => x.toLowerCase().replace(/\(r\)|\(tm\)/g, '').replace(/\s+/g, ' ').trim()
    let i = pending.findIndex((n) => n.name && norm(n.name) === norm(g.name))
    if (i < 0) i = pending.findIndex((n) => n.name && (norm(g.name).includes(norm(n.name)) || norm(n.name).includes(norm(g.name))))
    if (i < 0 && g.vendor === 'NVIDIA') i = 0
    return i >= 0 ? pending.splice(i, 1)[0] : undefined
  }
  for (const g of gpus) {
    if (g.isVirtual || g.vendor !== 'NVIDIA' || !pending.length) continue
    const n = take(g)
    if (!n) continue
    const { name: _name, memoryTotalBytes, ...rest } = n
    void _name
    g.nvidia = rest
    // O driver informa a VRAM exata; serve de reserva quando o registro/WMI não informou
    if (!g.vramBytes && memoryTotalBytes) {
      g.vramBytes = memoryTotalBytes
      g.vramSource = 'registry'
    }
  }
}

// ---------------- Montagem final ----------------
export function normalizeHardware(raw: RawHardware, durationMs?: number, nvidia?: NvidiaStaticGpu[] | null): HardwareInfo {
  const sys = raw.system ?? {}
  const chassisCodes = arr(sys.chassis).map(Number)
  const isLaptop =
    chassisCodes.some((c) => LAPTOP_CHASSIS.has(c)) || sys.pcSystemType === 2 || (Boolean(sys.hasBattery) && !chassisCodes.some((c) => c >= 3 && c <= 7))
  const gpus = normalizeGpus(arr(raw.gpus), arr(raw.gpuReg))
  if (nvidia?.length) attachNvidia(gpus, nvidia)
  const info: HardwareInfo = {
    collectedAt: new Date().toISOString(),
    system: {
      manufacturer: clean(sys.manufacturer) ?? 'Desconhecido',
      model: clean(sys.model) ?? 'Desconhecido',
      isLaptop,
      chassis: chassisCodes.map((c) => CHASSIS[c]).find(Boolean)
    },
    cpu: normalizeCpu(raw.cpu, sys),
    motherboard: normalizeBoard(raw.board),
    bios: normalizeBios(raw.bios),
    memory: normalizeMemory(raw.memory, sys),
    gpus,
    storage: normalizeDisks(arr(raw.disks), raw.sysDrive ?? 'C:'),
    displays: normalizeDisplays(arr(raw.monitors), arr(raw.modes), gpus),
    network: normalizeNetwork(arr(raw.network)),
    audio: [...new Set(arr(raw.audio).map((a) => str(a)).filter((a): a is string => Boolean(a)))],
    os: normalizeOs(raw.os),
    battery: normalizeBattery(raw.battery),
    warnings: arr(raw.warnings).map(String),
    durationMs
  }
  info.insights = buildInsights(info)
  return info
}

/** Executa a coleta completa na máquina (somente leitura). ~5 s. */
export async function collectHardware(): Promise<{ info: HardwareInfo; timings?: Record<string, number> }> {
  const started = Date.now()
  // nvidia-smi (~0,3 s) roda junto com o script do Windows; falha nele nunca derruba a coleta
  const [raw, nv] = await Promise.all([
    runPowerShellJson<RawHardware>(INFO_SCRIPT, { timeoutMs: 120_000 }),
    collectNvidiaStatic().catch((e: Error) => ({ gpus: null, warning: e.message }))
  ])
  // Aviso só interessa se o Windows vê uma placa NVIDIA (sobra de driver sem placa não é problema)
  if (nv.warning && arr(raw.gpus).some((g) => /nvidia/i.test(str(g.name) ?? ''))) raw.warnings = [...arr(raw.warnings), nv.warning]
  return { info: normalizeHardware(raw, Date.now() - started, nv.gpus), timings: raw.timings }
}
