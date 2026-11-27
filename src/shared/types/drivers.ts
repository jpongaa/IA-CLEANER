// Domínio: Drivers (versões instaladas, atualizações disponíveis, onde baixar oficialmente).

export type DriverImportance = 'critical' | 'important' | 'normal' | 'low'

/** Categoria funcional do driver (usada para agrupar, filtrar e definir o limite de "antigo"). */
export type DriverCategory =
  | 'gpu'
  | 'chipset'
  | 'network'
  | 'wifi'
  | 'bluetooth'
  | 'audio'
  | 'storage'
  | 'usb'
  | 'camera'
  | 'printer'
  | 'input'
  | 'system'
  | 'virtual'
  | 'other'

export const DRIVER_CATEGORY_LABELS: Record<DriverCategory, string> = {
  gpu: 'Vídeo (GPU)',
  chipset: 'Chipset / placa-mãe',
  network: 'Rede (cabo)',
  wifi: 'Wi-Fi',
  bluetooth: 'Bluetooth',
  audio: 'Áudio',
  storage: 'Armazenamento',
  usb: 'USB',
  camera: 'Câmera',
  printer: 'Impressora / scanner',
  input: 'Periféricos',
  system: 'Sistema',
  virtual: 'Virtual (instalado por programa)',
  other: 'Outros'
}

export interface DriverInfo {
  id: string
  deviceName: string
  /** Ex.: 'Display', 'Net', 'MEDIA', 'System', 'HDC' */
  deviceClass: string
  manufacturer: string
  provider: string
  version: string
  /** ISO date */
  date?: string
  ageDays?: number
  infName?: string
  hardwareId?: string
  /** Driver genérico da Microsoft (normalmente ok) */
  isMicrosoftGeneric: boolean
  importance: DriverImportance
  /**
   * ok | old (antigo para a categoria) | problem (dispositivo com erro, ou vídeo sem driver do fabricante).
   * Dispositivo apenas desativado (código 22) NÃO vira 'problem': ver `disabled`.
   */
  status: 'ok' | 'old' | 'problem'
  problemCode?: number
  /** Ex.: 'nvidia' | 'amd' | 'intel' | 'realtek' ... */
  vendorKey?: string
  // ---- extensões (opcionais) ----
  category?: DriverCategory
  /** Dispositivo virtual/software (VPN, áudio virtual, tela virtual...), não é uma peça física. */
  isVirtual?: boolean
  /** Quantos dispositivos idênticos foram agrupados nesta linha (ex.: 3 controladoras USB). */
  count?: number
  /** IDs de instância PnP agrupados (PNPDeviceID) */
  deviceIds?: string[]
  /** Dias a partir dos quais o driver é considerado antigo para a categoria */
  oldAfterDays?: number
  /** PT-BR: explicação curta do status (por que está ok/antigo/com problema) */
  statusReason?: string
  /** Versão como o fabricante divulga (ex.: NVIDIA 32.0.15.6094 -> '560.94') */
  displayVersion?: string
  /** A data do driver é um marcador fixo da Microsoft (21/06/2006), não a data real */
  datePlaceholder?: boolean
  /** Dispositivo desativado pelo usuário (código 22) */
  disabled?: boolean
  /** Melhor link oficial para obter este driver (https: ou ms-settings:) */
  officialUrl?: string
}

export interface ProblemDevice {
  name: string
  deviceClass?: string
  /** Código de erro do Gerenciador de Dispositivos */
  errorCode: number
  /** PT-BR */
  errorText: string
  pnpDeviceId?: string
  // ---- extensões (opcionais) ----
  /** error = não funciona; warning = funciona parcialmente/precisa reiniciar; info = desativado de propósito */
  severity?: 'error' | 'warning' | 'info'
  /** PT-BR: o que fazer */
  hint?: string
  vendorKey?: string
  /** Id do DriverInfo correspondente, quando o dispositivo tem driver listado */
  driverId?: string
}

export interface DriverUpdate {
  updateId: string
  title: string
  driverClass?: string
  driverVersion?: string
  /** ISO date */
  driverDate?: string
  manufacturer?: string
  model?: string
  sizeBytes?: number
}

export type VendorLinkTopic = 'gpu' | 'chipset' | 'board' | 'audio' | 'network' | 'printer' | 'windows' | 'other'

export interface VendorLink {
  vendor: string
  /** PT-BR */
  label: string
  url: string
  kind: 'official-tool' | 'download-page' | 'support-page'
  /** Para qual dispositivo/driver é esse link */
  relatedTo?: string
  // ---- extensões (opcionais) ----
  /** PT-BR: quando usar / o que esse link resolve */
  description?: string
  topic?: VendorLinkTopic
  vendorKey?: string
  /** Primeira opção recomendada para este tópico */
  recommended?: boolean
}

export interface DriverAlert {
  id: string
  severity: 'critical' | 'warning' | 'info'
  /** PT-BR */
  title: string
  /** PT-BR */
  detail: string
  driverId?: string
  /** Link oficial relacionado (https: ou ms-settings:) */
  url?: string
}

export interface DriverInventory {
  /** ISO */
  collectedAt: string
  drivers: DriverInfo[]
  problemDevices: ProblemDevice[]
  /** null = não consultado; [] = nenhum disponível */
  windowsUpdateDrivers: DriverUpdate[] | null
  windowsUpdateError?: string
  vendorLinks: VendorLink[]
  system: {
    manufacturer: string
    model: string
    boardManufacturer: string
    boardProduct: string
    isLaptop: boolean
    // ---- extensões (opcionais) ----
    cpuName?: string
    cpuVendor?: 'amd' | 'intel' | 'other'
    /** Ryzen com vídeo integrado (ex.: 5700G) */
    isAmdApu?: boolean
    /** Ex.: 'A520', 'B550', 'Z790' (deduzido do modelo da placa-mãe) */
    chipset?: string
    biosVersion?: string
    /** ISO date */
    biosDate?: string
    /** PC montado (placa-mãe avulsa) em vez de marca (Dell, Lenovo...) */
    isCustomBuild?: boolean
  }
  // ---- extensões (opcionais) ----
  /** ISO: quando o Windows Update foi consultado (pode vir de uma coleta anterior) */
  windowsUpdateCheckedAt?: string
  /** Alertas importantes já calculados (vídeo sem driver, driver de vídeo antigo...) */
  alerts?: DriverAlert[]
  /** Avisos de coleta (consultas que falharam, sem permissão...) */
  warnings?: string[]
  /** Quantos drivers foram lidos antes de filtrar/agrupar */
  rawDriverCount?: number
}

export interface DriversApi {
  /** Progresso em 'drivers:progress'. Consultar o Windows Update pode levar ~1 min. */
  getInventory(opts?: { includeWindowsUpdate?: boolean }): Promise<DriverInventory>
  getLastInventory(): Promise<DriverInventory | null>
  /** Abre Configurações > Windows Update > Atualizações opcionais */
  openOptionalUpdates(): Promise<void>
  openDeviceManager(): Promise<void>
}

export const DRIVERS_METHODS = [
  'getInventory',
  'getLastInventory',
  'openOptionalUpdates',
  'openDeviceManager'
] as const satisfies readonly (keyof DriversApi)[]

/**
 * Domínios oficiais de fabricantes aceitos para links de drivers (inclui subdomínios).
 * Usado pela interface (e disponível para a IA) para nunca abrir sites de "atualizadores" de terceiros.
 */
export const OFFICIAL_DRIVER_DOMAINS = [
  'nvidia.com',
  'nvidia.com.br',
  'amd.com',
  'intel.com',
  'intel.com.br',
  'microsoft.com',
  'windowsupdate.com',
  'asus.com',
  'msi.com',
  'gigabyte.com',
  'aorus.com',
  'asrock.com',
  'biostar.com.tw',
  'dell.com',
  'lenovo.com',
  'hp.com',
  'acer.com',
  'samsung.com',
  'positivotecnologia.com.br',
  'meupositivo.com.br',
  'avell.com.br',
  'vaio.com',
  'vaiobr.com.br',
  'realtek.com',
  'qualcomm.com',
  'mediatek.com',
  'broadcom.com',
  'killernetworking.com',
  'epson.com.br',
  'epson.com',
  'brother.com',
  'canon.com.br',
  'canon.com',
  'logitech.com',
  'logitechg.com',
  'razer.com',
  'hyperx.com',
  'kingston.com',
  'corsair.com',
  'steelseries.com',
  'samsungsemiconductor.com',
  'westerndigital.com',
  'crucial.com',
  'seagate.com',
  'asmedia.com.tw',
  'via.com.tw',
  'conexant.com',
  'synaptics.com',
  'elan.com.tw',
  'tp-link.com',
  'tplink.com',
  'dlink.com',
  'netgear.com',
  'xbox.com',
  'creative.com'
] as const

/** true se a URL é https de um domínio oficial (ou o atalho ms-settings: do Windows Update). */
export function isOfficialDriverUrl(url: string | undefined | null): boolean {
  if (!url) return false
  // Só a página do Windows Update, inteira (o link pode vir da IA: nada de parâmetros, aspas ou '&' depois do nome).
  if (/^ms-settings:windowsupdate(-[a-z]+)*$/i.test(url)) return true
  let host: string
  try {
    const u = new URL(url)
    if (u.protocol !== 'https:') return false
    host = u.hostname.toLowerCase()
  } catch {
    return false
  }
  return OFFICIAL_DRIVER_DOMAINS.some((d) => host === d || host.endsWith('.' + d))
}
