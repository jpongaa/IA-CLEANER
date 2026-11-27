// Classificação dos drivers coletados: categoria, importância, idade, status e agrupamento.
// Funções puras (sem PowerShell) para poderem ser testadas isoladamente.
import { createHash } from 'node:crypto'
import { type DriverCategory, type DriverImportance, type DriverInfo, type ProblemDevice } from '@shared/types/drivers'
import { describeProblemCode, IGNORED_PROBLEM_CODES } from './problemCodes'
import { detectVendorKey, hdAudioCodecKind, vendorDisplayName, vendorFromHardwareId } from './vendors'

/** Driver como sai do PowerShell (nomes curtos para reduzir o JSON). */
export interface RawDriver {
  n: string
  c: string
  m: string
  p: string
  v: string
  /** yyyy-MM-dd (UTC) */
  d: string | null
  inf: string
  hw: string
  id: string
}

export interface RawProblem {
  n: string
  c: string
  code: number
  id: string
  present: boolean | null
  hw: string
}

const DAY = 86_400_000

/** Limite (dias) a partir do qual o driver é "antigo" para a categoria. undefined = não se aplica. */
export const OLD_AFTER_DAYS: Partial<Record<DriverCategory, number>> = {
  gpu: 180,
  chipset: 730,
  network: 730,
  wifi: 730,
  bluetooth: 730,
  audio: 1095,
  storage: 1095,
  usb: 1095,
  camera: 1095,
  printer: 1095,
  system: 1095
}

export const CATEGORY_ORDER: DriverCategory[] = [
  'gpu',
  'chipset',
  'network',
  'wifi',
  'bluetooth',
  'audio',
  'storage',
  'usb',
  'camera',
  'printer',
  'system',
  'input',
  'other',
  'virtual'
]

const IMPORTANCE_ORDER: DriverImportance[] = ['critical', 'important', 'normal', 'low']

/** Nome da categoria para usar no meio de frases. */
const CATEGORY_PHRASE: Record<DriverCategory, string> = {
  gpu: 'drivers de vídeo',
  chipset: 'chipset',
  network: 'rede',
  wifi: 'Wi-Fi',
  bluetooth: 'Bluetooth',
  audio: 'áudio',
  storage: 'armazenamento',
  usb: 'USB',
  camera: 'câmera',
  printer: 'impressora',
  input: 'periféricos',
  system: 'sistema',
  virtual: 'dispositivos virtuais',
  other: 'este tipo de dispositivo'
}

/** Enumeradores de dispositivos físicos (prefixo do PNPDeviceID). */
const PHYSICAL_ENUMS = new Set([
  'PCI',
  'HDAUDIO',
  'INTELAUDIO',
  'USB',
  'ACPI',
  'ACPI_HAL',
  'BTH',
  'BTHENUM',
  'BTHLE',
  'BTHLEDEVICE',
  'BTHHFENUM',
  'HID',
  'SD',
  'SDIO',
  'UEFI',
  'SCSI',
  'STORAGE',
  'USBSTOR',
  'NVME',
  'IDE',
  'PCIIDE',
  'DISPLAY',
  'MONITOR',
  'USBPRINT',
  'WSDPRINT',
  'SWC',
  'TBT',
  'THUNDERBOLT',
  'I2C',
  'SPI',
  'GPIO'
])

const VIRTUAL_NAME_RE =
  /virtual|miniport|hyper-v|\bvpn\b|tap-|tunnel|wintun|wireguard|hamachi|zerotier|tailscale|vmware|virtualbox|kernel debug|loopback|teredo|isatap|6to4|wi-fi direct|personal area network|streaming|broadcast|droidcam|voicemeeter|vb-audio|\bcable (input|output)\b|parsec|sunshine|remote desktop|rdp|xvdd|steam/i

const MS_NOISE_CLASSES = new Set([
  'VOLUME',
  'VOLUMESNAPSHOT',
  'PROCESSOR',
  'AUDIOENDPOINT',
  'PRINTQUEUE',
  'SOFTWAREDEVICE',
  'MONITOR',
  'HIDCLASS',
  'KEYBOARD',
  'MOUSE',
  'DISKDRIVE',
  'COMPUTER',
  'CDROM',
  'WPD',
  'SECURITYDEVICES',
  'FIRMWARE',
  'SOFTWARECOMPONENT',
  'EXTENSION',
  'PORTS',
  'LEGACYDRIVER',
  'NETSERVICE',
  'NETTRANS',
  'NETCLIENT'
])

const INPUT_CLASSES = new Set(['KEYBOARD', 'MOUSE', 'HIDCLASS', 'XNACOMPOSITE', 'XBOXCOMPOSITE', 'RAZER DEVICE'])

export function enumeratorOf(deviceId: string | undefined): string {
  const id = (deviceId ?? '').toUpperCase()
  const i = id.indexOf('\\')
  return i > 0 ? id.slice(0, i) : id
}

export function isMicrosoftProvider(provider: string): boolean {
  return /^microsoft( corporation)?$/i.test(provider.trim())
}

/** Adaptador de vídeo básico da Microsoft (sem driver do fabricante). */
export function isBasicDisplay(raw: Pick<RawDriver, 'n' | 'inf' | 'p'>): boolean {
  return (
    /basic display|v[íi]deo b[áa]sico|adaptador de v[íi]deo b[áa]sico|basic render/i.test(raw.n) ||
    /^(display|basicdisplay)\.inf$/i.test(raw.inf.trim())
  )
}

interface Classification {
  category: DriverCategory
  importance: DriverImportance
  isVirtual: boolean
  /** Áudio HDMI de placa de vídeo */
  hdmiAudio?: boolean
  /** Áudio da placa-mãe (codec Realtek etc.) */
  onboardAudio?: boolean
  /** Periférico USB (fone, webcam...): o driver vem do app do fabricante, sem limite de idade */
  peripheral?: boolean
  /** Componente de software de um driver (instalado junto com ele) */
  component?: boolean
}

/** Decide a categoria/importância de um driver; null = ruído (genérico do Windows sem interesse). */
export function classify(raw: RawDriver): Classification | null {
  const cls = raw.c.trim().toUpperCase()
  const name = raw.n
  const en = enumeratorOf(raw.id)
  const physical = PHYSICAL_ENUMS.has(en)
  const ms = isMicrosoftProvider(raw.p)
  const virtualName = VIRTUAL_NAME_RE.test(name)
  const virt = (): Classification | null => (ms ? null : { category: 'virtual', importance: 'low', isVirtual: true })

  switch (cls) {
    case 'DISPLAY':
      if (!physical || virtualName) return virt()
      return { category: 'gpu', importance: 'critical', isVirtual: false }
    case 'NET': {
      if (!physical || virtualName || en.startsWith('BTH')) return virt()
      const wifi = /wi-?fi|wireless|wlan|802\.11/i.test(name)
      return { category: wifi ? 'wifi' : 'network', importance: 'important', isVirtual: false }
    }
    case 'BLUETOOTH':
      if (en === 'USB' || en === 'PCI' || en === 'ACPI' || en === 'SDIO' || en === 'SD') {
        return { category: 'bluetooth', importance: 'normal', isVirtual: false }
      }
      return ms ? null : { category: 'other', importance: 'low', isVirtual: false }
    case 'MEDIA': {
      if (!physical || virtualName) return virt()
      if (en === 'USB' && /cam|webcam|v[íi]deo/i.test(name)) return { category: 'camera', importance: 'normal', isVirtual: false }
      if (en === 'HDAUDIO' || en === 'INTELAUDIO') {
        const kind = hdAudioCodecKind(raw.hw || raw.id)
        if (kind === 'hdmi') return { category: 'audio', importance: 'normal', isVirtual: false, hdmiAudio: true }
        return { category: 'audio', importance: 'important', isVirtual: false, onboardAudio: true }
      }
      if (en === 'PCI') return { category: 'audio', importance: 'important', isVirtual: false, onboardAudio: true }
      return { category: 'audio', importance: 'normal', isVirtual: false, peripheral: en === 'USB' || en.startsWith('BTH') }
    }
    case 'CAMERA':
    case 'IMAGE':
      if (!physical || virtualName) return virt()
      if (/scan/i.test(name)) return { category: 'printer', importance: 'normal', isVirtual: false }
      return { category: 'camera', importance: 'normal', isVirtual: false }
    case 'PRINTER':
      if (/pdf|xps|onenote|fax|anydesk|print to|send to|enviar para/i.test(name) || !physical) return virt()
      return { category: 'printer', importance: 'normal', isVirtual: false }
    case 'HDC':
    case 'SCSIADAPTER':
    case 'SDHOST':
      if (!physical || virtualName) return virt()
      if (en === 'PCI' || en === 'ACPI') return { category: 'storage', importance: cls === 'SDHOST' ? 'normal' : 'important', isVirtual: false }
      return ms ? null : { category: 'storage', importance: 'normal', isVirtual: false }
    case 'USB':
      if (!physical || virtualName) return virt()
      if (en === 'PCI' || /host controller|xhci|ehci|ohci|uhci|extensible/i.test(name)) {
        return { category: 'usb', importance: 'normal', isVirtual: false }
      }
      return ms ? null : { category: 'input', importance: 'low', isVirtual: false }
    case 'SOFTWARECOMPONENT':
    case 'EXTENSION':
    case 'AUDIOPROCESSINGOBJECT':
      return ms ? null : { category: 'other', importance: 'low', isVirtual: false, component: true }
    case 'SYSTEM':
    case 'SECURITYDEVICES': {
      if (!physical) return virt()
      if (ms) return null
      const vk = detectVendorKey([raw.hw, raw.id], raw.p, raw.m)
      if ((vk === 'amd' || vk === 'intel') && (en === 'PCI' || en === 'ACPI')) {
        return { category: 'chipset', importance: 'important', isVirtual: false }
      }
      if (cls === 'SECURITYDEVICES') return { category: 'other', importance: 'low', isVirtual: false }
      return { category: 'system', importance: 'normal', isVirtual: false }
    }
    default:
      break
  }
  if (INPUT_CLASSES.has(cls)) return ms ? null : { category: 'input', importance: 'low', isVirtual: !physical }
  if (ms) {
    // Genéricos do Windows: só interessam leitores biométricos/sensores físicos; o resto é ruído.
    if (MS_NOISE_CLASSES.has(cls) || !physical) return null
    return cls === 'BIOMETRIC' || cls === 'SENSOR' ? { category: 'other', importance: 'normal', isVirtual: false } : null
  }
  if (!physical || virtualName) return virt()
  if (cls === 'BIOMETRIC' || cls === 'SENSOR' || cls === 'SMARTCARDREADER') return { category: 'other', importance: 'normal', isVirtual: false }
  return { category: 'other', importance: 'low', isVirtual: false }
}

/** Data 'yyyy-MM-dd' -> ISO ao meio-dia UTC (mostra o mesmo dia em qualquer fuso do Brasil). */
export function dateOnlyToIso(d: string | null | undefined): string | undefined {
  if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return undefined
  const iso = `${d}T12:00:00.000Z`
  return Number.isNaN(Date.parse(iso)) ? undefined : iso
}

/** A Microsoft carimba drivers internos do Windows com 21/06/2006 (marcador, não é a data real). */
export function isPlaceholderDate(d: string | null | undefined): boolean {
  if (!d) return false
  return d <= '2006-06-22' && d >= '2006-06-20'
}

/** Versão "comercial" da NVIDIA: 32.0.15.6094 -> 560.94 */
export function nvidiaDisplayVersion(version: string): string | undefined {
  const parts = version.trim().split('.')
  if (parts.length !== 4 || !parts.every((p) => /^\d+$/.test(p))) return undefined
  const digits = parts[2] + parts[3].padStart(4, '0')
  if (digits.length < 5) return undefined
  const last5 = digits.slice(-5)
  return `${Number(last5.slice(0, 3))}.${last5.slice(3)}`
}

export function formatAge(days: number): string {
  if (days < 1) return 'hoje'
  if (days < 30) return days === 1 ? '1 dia' : `${days} dias`
  const months = Math.floor(days / 30.44)
  if (months < 12) return months === 1 ? '1 mês' : `${months} meses`
  const years = days / 365.25
  const y = Math.floor(years)
  const rest = Math.floor((years - y) * 12)
  const ys = y === 1 ? '1 ano' : `${y} anos`
  return rest >= 1 && y < 5 ? `${ys} e ${rest === 1 ? '1 mês' : `${rest} meses`}` : ys
}

/** 'hoje' | 'há 3 meses' */
export function releasedWhen(days: number): string {
  return days < 1 ? 'hoje' : `há ${formatAge(days)}`
}

function thresholdText(days: number): string {
  if (days % 365 === 0 || days === 730 || days === 1095) return `${Math.round(days / 365)} anos`
  return `${Math.round(days / 30)} meses`
}

function slug(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\(r\)|\(tm\)|®|™/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '')
}

function shortHash(s: string): string {
  return createHash('sha1').update(s).digest('hex').slice(0, 6)
}

function hwBase(hw: string): string {
  return hw.toUpperCase().replace(/&REV_[0-9A-F]+/g, '')
}

interface Group {
  raw: RawDriver
  cls: Classification
  deviceIds: string[]
  hardwareIds: string[]
}

export interface ClassifyResult {
  drivers: DriverInfo[]
  problemDevices: ProblemDevice[]
  /** Contexto útil para alertas/links */
  onboardAudioGeneric: DriverInfo[]
}

/**
 * Converte a lista crua em DriverInfo[] (filtrada, agrupada e ordenada) e cruza com os dispositivos com erro.
 * `now` é injetável para testes.
 */
export function buildDrivers(rawDrivers: RawDriver[], rawProblems: RawProblem[], now = Date.now()): ClassifyResult {
  // Erros por instância de dispositivo
  const problemById = new Map<string, number>()
  for (const p of rawProblems) {
    if (!p.id || IGNORED_PROBLEM_CODES.has(p.code) || p.present === false) continue
    problemById.set(p.id.toUpperCase(), p.code)
  }

  // Agrupa dispositivos idênticos (mesmo nome, provedor, versão e INF)
  const groups = new Map<string, Group>()
  for (const raw of rawDrivers) {
    if (!raw || !raw.n?.trim()) continue
    const r: RawDriver = {
      n: raw.n.trim(),
      c: (raw.c ?? '').trim(),
      m: (raw.m ?? '').trim(),
      p: (raw.p ?? '').trim(),
      v: (raw.v ?? '').trim(),
      d: raw.d ?? null,
      inf: (raw.inf ?? '').trim(),
      hw: (raw.hw ?? '').trim(),
      id: (raw.id ?? '').trim()
    }
    const cls = classify(r)
    if (!cls) continue
    const key = [cls.category, r.n.toLowerCase(), r.p.toLowerCase(), r.v].join('|')
    const g = groups.get(key)
    if (g) {
      if (r.id) g.deviceIds.push(r.id)
      if (r.hw) g.hardwareIds.push(r.hw)
    } else {
      groups.set(key, { raw: r, cls, deviceIds: r.id ? [r.id] : [], hardwareIds: r.hw ? [r.hw] : [] })
    }
  }

  const usedIds = new Set<string>()
  const drivers: DriverInfo[] = []
  const onboardAudioGeneric: DriverInfo[] = []

  for (const g of groups.values()) {
    const { raw, cls } = g
    const ms = isMicrosoftProvider(raw.p)
    const vendorKey = detectVendorKey(g.hardwareIds.length ? g.hardwareIds : [raw.id], raw.p, raw.m)
    const sortedHw = [...g.hardwareIds].map(hwBase).sort()
    let id = `${slug(raw.n) || 'driver'}-${shortHash(`${cls.category}|${raw.n.toLowerCase()}|${sortedHw[0] ?? raw.id.toUpperCase()}`)}`
    while (usedIds.has(id)) id = `${id}x`
    usedIds.add(id)

    const placeholder = isPlaceholderDate(raw.d)
    const date = dateOnlyToIso(raw.d)
    const ageDays = date && !placeholder ? Math.max(0, Math.floor((now - Date.parse(date)) / DAY)) : undefined
    const oldAfter = cls.isVirtual || cls.peripheral || cls.component ? undefined : OLD_AFTER_DAYS[cls.category]

    // Erros dos dispositivos do grupo (pega o mais grave)
    let problemCode: number | undefined
    for (const devId of g.deviceIds) {
      const code = problemById.get(devId.toUpperCase())
      if (code !== undefined && (problemCode === undefined || problemCode === 22)) problemCode = code
    }
    const disabled = problemCode === 22

    const info: DriverInfo = {
      id,
      deviceName: raw.n,
      deviceClass: raw.c,
      manufacturer: raw.m,
      provider: raw.p,
      version: raw.v,
      date: placeholder ? undefined : date,
      ageDays,
      infName: raw.inf || undefined,
      hardwareId: raw.hw || undefined,
      isMicrosoftGeneric: ms,
      importance: cls.importance,
      status: 'ok',
      problemCode,
      vendorKey,
      category: cls.category,
      isVirtual: cls.isVirtual || undefined,
      count: g.deviceIds.length > 1 ? g.deviceIds.length : undefined,
      deviceIds: g.deviceIds.length ? g.deviceIds : undefined,
      oldAfterDays: oldAfter,
      datePlaceholder: placeholder || undefined,
      disabled: disabled || undefined
    }

    if (cls.category === 'gpu' && vendorKey === 'nvidia') info.displayVersion = nvidiaDisplayVersion(raw.v)

    const vendorName = vendorDisplayName(vendorKey)
    if (problemCode !== undefined && !disabled) {
      info.status = 'problem'
      info.statusReason = describeProblemCode(problemCode).text
    } else if (cls.category === 'gpu' && (ms || isBasicDisplay(raw))) {
      info.status = 'problem'
      info.importance = 'critical'
      const chip = vendorFromHardwareId(raw.hw)
      info.statusReason =
        'O Windows está usando o "Adaptador de Vídeo Básico da Microsoft": sem aceleração 3D, jogos ficam lentos ou nem abrem. ' +
        `Instale o driver oficial${chip ? ` da ${vendorDisplayName(chip)}` : ' do fabricante da placa de vídeo'}.`
    } else if (!ms && oldAfter !== undefined && ageDays !== undefined && ageDays > oldAfter) {
      info.status = 'old'
      const base = `Driver lançado ${releasedWhen(ageDays)}; para ${CATEGORY_PHRASE[cls.category]} recomendamos atualizar após ${thresholdText(oldAfter)}.`
      info.statusReason =
        cls.category === 'gpu'
          ? `${base} Para jogos, drivers de vídeo novos trazem otimizações e correções para títulos recentes.`
          : cls.hdmiAudio
            ? `${base} Este é o áudio HDMI da placa de vídeo: ele é atualizado junto com o driver de vídeo.`
            : base
    } else if (cls.isVirtual) {
      info.statusReason = 'Instalado por um programa (não é uma peça física). Atualiza junto com o programa que o instalou.'
    } else if (cls.component) {
      info.statusReason = 'Componente de software de um driver: é instalado e atualizado junto com o driver principal.'
    } else if (cls.peripheral && !ms) {
      info.statusReason = `Driver do periférico${vendorName ? ` (${vendorName})` : ''}: normalmente é atualizado pelo app do fabricante do periférico.`
    } else if (ms) {
      if (cls.onboardAudio) {
        info.statusReason =
          'Driver genérico da Microsoft: o som funciona, mas sem o painel e os recursos do fabricante. Opcional: instale o driver de áudio da página da placa-mãe/notebook.'
        onboardAudioGeneric.push(info)
      } else if (cls.category === 'bluetooth' || cls.category === 'wifi' || cls.category === 'network') {
        info.statusReason = 'Driver genérico da Microsoft: funciona, mas o driver do fabricante costuma ser mais estável e rápido.'
      } else {
        info.statusReason = 'Driver padrão do Windows: funciona bem e é atualizado automaticamente pelo Windows Update.'
      }
    } else if (cls.hdmiAudio) {
      info.statusReason = 'Áudio HDMI/DisplayPort da placa de vídeo: é atualizado junto com o driver de vídeo.'
    } else if (ageDays !== undefined) {
      info.statusReason = `Driver lançado ${releasedWhen(ageDays)}${oldAfter ? ` (dentro do esperado para ${CATEGORY_PHRASE[cls.category]})` : ''}.`
    } else {
      info.statusReason = vendorName ? `Driver da ${vendorName}.` : undefined
    }

    drivers.push(info)
  }

  drivers.sort(
    (a, b) =>
      CATEGORY_ORDER.indexOf(a.category ?? 'other') - CATEGORY_ORDER.indexOf(b.category ?? 'other') ||
      IMPORTANCE_ORDER.indexOf(a.importance) - IMPORTANCE_ORDER.indexOf(b.importance) ||
      a.deviceName.localeCompare(b.deviceName, 'pt-BR')
  )

  // Dispositivos com erro (inclui os sem driver, que não aparecem em Win32_PnPSignedDriver)
  const driverByDeviceId = new Map<string, DriverInfo>()
  for (const d of drivers) for (const devId of d.deviceIds ?? []) driverByDeviceId.set(devId.toUpperCase(), d)
  const problemDevices: ProblemDevice[] = []
  const seenProblem = new Set<string>()
  for (const p of rawProblems) {
    if (!p || IGNORED_PROBLEM_CODES.has(p.code) || p.present === false) continue
    const key = (p.id || p.n).toUpperCase()
    if (seenProblem.has(key)) continue
    seenProblem.add(key)
    const info = describeProblemCode(p.code)
    const name = p.n?.trim() || 'Dispositivo desconhecido'
    const linked = p.id ? driverByDeviceId.get(p.id.toUpperCase()) : undefined
    const vendorKey = vendorFromHardwareId(p.hw) ?? vendorFromHardwareId(p.id)
    let hint = info.hint
    if (p.code === 28 || (!p.c && /desconhecido|unknown/i.test(name))) {
      hint =
        `Dispositivo sem driver${vendorKey ? ` (o chip parece ser da ${vendorDisplayName(vendorKey)})` : ''}. ` +
        'Instale o pacote de drivers da placa-mãe/notebook ou procure em Atualizações opcionais do Windows Update.'
    }
    problemDevices.push({
      name,
      deviceClass: p.c || undefined,
      errorCode: p.code,
      errorText: info.text,
      pnpDeviceId: p.id || undefined,
      severity: info.severity,
      hint,
      vendorKey,
      driverId: linked?.id
    })
  }
  const sevOrder = { error: 0, warning: 1, info: 2 }
  problemDevices.sort((a, b) => sevOrder[a.severity ?? 'error'] - sevOrder[b.severity ?? 'error'] || a.name.localeCompare(b.name, 'pt-BR'))

  return { drivers, problemDevices, onboardAudioGeneric }
}
