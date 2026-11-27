// Domínio: Hardware (estilo CPU-Z) + monitor ao vivo.
import type { Severity } from './common'

export interface CpuCacheInfo {
  /** 1, 2, 3 */
  level: number
  type: 'data' | 'instruction' | 'unified'
  /** Tamanho de UMA instância, em KB */
  sizeKb: number
  /** Quantas instâncias (ex.: 8 = uma por núcleo) */
  count: number
  /** Associatividade (vias) */
  ways?: number
  lineBytes?: number
}

export interface CpuInfo {
  name: string
  vendor: string
  /** Ex.: 'Zen 3 (Cezanne)' quando reconhecido */
  codename?: string
  /** Ex.: 'AMD64 Family 25 Model 80 Stepping 0' */
  identifier?: string
  family?: number
  model?: number
  stepping?: number
  socket?: string
  cores: number
  threads: number
  baseMhz?: number
  maxMhz?: number
  currentMhz?: number
  /** Totais do processador inteiro (soma de todos os núcleos), em KB */
  l1Kb?: number
  l2Kb?: number
  l3Kb?: number
  /** Ex.: ['SSE4.2', 'AVX', 'AVX2', 'AVX-512'] */
  instructions: string[]
  virtualizationEnabled?: boolean
  architecture: string
  /** Microarquitetura (ex.: 'Zen 3') — parte de `codename` */
  microarchitecture?: string
  /** Processo de fabricação (ex.: '7 nm') quando reconhecido */
  technology?: string
  /** Detalhe dos caches (L1 dados/instruções, L2, L3) quando disponível */
  caches?: CpuCacheInfo[]
  /** Quantidade de processadores físicos (soquetes ocupados) */
  sockets?: number
  /** Há um hipervisor ativo (Hyper-V, WSL2, VBS/Integridade de memória) */
  hypervisorPresent?: boolean
}

export interface MotherboardInfo {
  manufacturer: string
  product: string
  version?: string
  serial?: string
  chipset?: string
}

export interface BiosInfo {
  vendor: string
  version: string
  /** ISO date */
  releaseDate?: string
  mode?: 'UEFI' | 'Legacy' | 'Unknown'
  secureBoot?: boolean
}

export interface RamModule {
  slot: string
  bank?: string
  capacityBytes: number
  /** Ex.: 'DDR4' */
  type: string
  /** Velocidade nominal (MHz/MT/s) */
  speedMhz?: number
  /** Velocidade configurada atual */
  configuredMhz?: number
  manufacturer?: string
  partNumber?: string
  formFactor?: string
  voltageMv?: number
  /** Velocidade anunciada no código do pente (XMP/EXPO), inferida do part number */
  advertisedMhz?: number
  /** Canal de memória inferido do nome do slot (ex.: 'A') */
  channel?: string
}

export interface MemoryInfo {
  totalBytes: number
  slotsTotal?: number
  slotsUsed: number
  modules: RamModule[]
  /** 'Dual channel (provável)' etc. */
  channelsGuess?: string
  /** Memória utilizável pelo Windows (total instalado menos o reservado pelo hardware) */
  usableBytes?: number
  /** Capacidade máxima suportada pela placa, quando informada */
  maxCapacityBytes?: number
}

export interface GpuInfo {
  name: string
  vendor: string
  vramBytes?: number
  driverVersion?: string
  /** ISO date */
  driverDate?: string
  currentResolution?: string
  refreshRateHz?: number
  isIntegrated: boolean
  pnpDeviceId?: string
  /** Adaptador virtual (Parsec, área de trabalho remota etc.) — não é uma placa física */
  isVirtual?: boolean
  /** Provedor do driver (ex.: 'NVIDIA', 'Advanced Micro Devices, Inc.') */
  driverProvider?: string
  /** De onde veio o valor de VRAM */
  vramSource?: 'registry' | 'wmi'
  /** Sem driver do fabricante (Adaptador de Vídeo Básico da Microsoft) */
  basicDriver?: boolean
  /** Dados extras lidos do driver NVIDIA (nvidia-smi), só em placas NVIDIA com o driver oficial */
  nvidia?: GpuNvidiaInfo
}

/** Informações fixas de uma placa NVIDIA lidas pelo nvidia-smi na coleta (somente leitura). */
export interface GpuNvidiaInfo {
  /** Índice da placa no nvidia-smi (casa com a telemetria ao vivo) */
  index: number
  /** Ex.: '00000000:01:00.0' */
  pciBusId?: string
  vbiosVersion?: string
  /** Clock máximo do núcleo (boost) em MHz */
  maxClockMhz?: number
  /** Limite de energia em vigor (W) */
  powerLimitW?: number
  /** Limite de energia de fábrica (W) */
  powerDefaultLimitW?: number
  /** Maior limite permitido pela placa (W) */
  powerMaxLimitW?: number
  /** Geração PCIe máxima da placa (ex.: 4) */
  pcieGenGpuMax?: number
  /** Geração PCIe máxima possível com esta placa-mãe/processador (ex.: 3) */
  pcieGenSystemMax?: number
  /** Largura atual do link PCIe (ex.: 16 = x16) */
  pcieWidthCurrent?: number
  /** Largura máxima do link PCIe */
  pcieWidthMax?: number
  /** Janela BAR1 (bytes). Igual/próxima da VRAM = Resizable BAR ativo; 256 MB = desativado */
  bar1TotalBytes?: number
  /** Resizable BAR ativo (deduzido da janela BAR1) */
  resizableBar?: boolean
  /** Temperatura-alvo do GPU Boost (°C): acima dela o driver reduz o clock (ex.: 83) */
  targetTempC?: number
  /** Temperatura máxima de operação (°C): acima dela o driver corta o clock (ex.: 93) */
  maxOperatingTempC?: number
  /** O hardware reduz o clock pela metade (°C) */
  slowdownTempC?: number
  /** O hardware desliga a placa (°C) */
  shutdownTempC?: number
  /**
   * Tempo acumulado (s) com clock reduzido desde que o driver foi carregado (normalmente desde o boot), por motivo.
   * Só presente quando o driver informa.
   */
  throttleSeconds?: { thermal?: number; hwThermal?: number; powerBrake?: number; powerCap?: number }
}

/** Motivos de limitação de clock da GPU (estáveis, para regras/IA). */
export type GpuThrottleFlag =
  /** Limite de energia (normal em carga máxima) */
  | 'power'
  /** Temperatura acima do máximo de operação (driver) */
  | 'thermal'
  /** Temperatura crítica (hardware corta o clock pela metade) */
  | 'hw-thermal'
  /** Proteção do hardware (calor ou fonte) */
  | 'hw-slowdown'
  /** Freio de energia acionado pela fonte/placa-mãe */
  | 'power-brake'
  /** Clock fixado por um programa */
  | 'app-clocks'
  /** Sincronização entre placas (SLI) */
  | 'sync-boost'
  /** Clock limitado pela configuração de vídeo */
  | 'display-clocks'
  /** Outro motivo informado pelo driver */
  | 'other'

export interface PartitionInfo {
  letter?: string
  sizeBytes: number
  label?: string
  freeBytes?: number
  fileSystem?: string
}

export interface PhysicalDiskInfo {
  number?: number
  model: string
  serial?: string
  firmware?: string
  mediaType: 'SSD' | 'HDD' | 'SCM' | 'Unknown'
  busType: string
  sizeBytes: number
  health?: string
  temperatureC?: number
  /** % de desgaste (SSD), quando disponível */
  wearPercent?: number
  powerOnHours?: number
  readErrors?: number
  partitions: PartitionInfo[]
  /** Disco onde o Windows está instalado */
  isSystemDisk?: boolean
  writeErrors?: number
  temperatureMaxC?: number
  /** Os contadores de confiabilidade (temperatura, desgaste, horas) foram lidos */
  reliabilityAvailable?: boolean
}

export interface DisplayInfo {
  name: string
  manufacturer?: string
  resolution?: string
  refreshRateHz?: number
  /** Maior taxa de atualização disponível na resolução atual */
  maxRefreshRateHz?: number
  /** Diagonal aproximada (EDID) */
  sizeInches?: number
  /** 'HDMI', 'DisplayPort', 'DVI', 'VGA', 'Interna'... */
  connection?: string
  /** Placa de vídeo à qual está ligado */
  adapter?: string
  isPrimary?: boolean
  year?: number
  bitsPerPixel?: number
}

export interface NetAdapterInfo {
  name: string
  description: string
  macAddress?: string
  /** bits/s */
  linkSpeedBps?: number
  status: string
  isWifi: boolean
  driverVersion?: string
  /** Adaptador virtual (VPN, Hyper-V, Hamachi...) */
  isVirtual?: boolean
  /** ISO date */
  driverDate?: string
  driverProvider?: string
  /** Conectado agora */
  connected?: boolean
}

export interface OsInfo {
  caption: string
  version: string
  build: string
  architecture: string
  /** ISO */
  installDate?: string
  /** ISO */
  lastBoot?: string
  computerName: string
  userName: string
  /** Ex.: '24H2' */
  displayVersion?: string
  /** Ex.: 'Professional' */
  edition?: string
}

/** Destaque calculado localmente (sem IA) a partir das informações coletadas. */
export interface HardwareInsight {
  /** Estável (ex.: 'ram-xmp-off', 'disk-hdd-E') */
  id: string
  area: 'cpu' | 'memory' | 'gpu' | 'storage' | 'display' | 'network' | 'board' | 'system'
  severity: Severity
  /** PT-BR, curto */
  title: string
  /** PT-BR: o porquê e o efeito */
  detail: string
  /** PT-BR: o que fazer (opcional) */
  tip?: string
}

export interface HardwareInfo {
  /** ISO */
  collectedAt: string
  system: { manufacturer: string; model: string; isLaptop: boolean; chassis?: string }
  cpu: CpuInfo
  motherboard: MotherboardInfo
  bios: BiosInfo
  memory: MemoryInfo
  gpus: GpuInfo[]
  storage: PhysicalDiskInfo[]
  displays: DisplayInfo[]
  network: NetAdapterInfo[]
  audio: string[]
  os: OsInfo
  battery?: {
    designCapacityMwh?: number
    fullChargeCapacityMwh?: number
    healthPercent?: number
    status?: string
    chargePercent?: number
  }
  warnings: string[]
  /** Destaques úteis em PT-BR (RAM sem XMP, HDD lento, monitor em 60 Hz...) */
  insights?: HardwareInsight[]
  /** Duração da coleta (ms) */
  durationMs?: number
}

export interface LiveDiskStats {
  /** Número do disco físico */
  number: number
  /** Ex.: 'C:' ou 'D: E:' (letras das partições) */
  name: string
  readBps: number
  writeBps: number
  activePercent: number
}

export interface LiveStats {
  /** epoch ms */
  t: number
  /** Temperatura da GPU (°C) — NVIDIA via nvidia-smi; ausente se não disponível */
  gpuTempC?: number
  /** Clock atual do núcleo da GPU (MHz) */
  gpuClockMhz?: number
  /** Consumo da GPU (W) */
  gpuPowerW?: number
  /** Ventoinha da GPU (%) */
  gpuFanPercent?: number
  /** Motivo de limitação de clock da GPU (ex.: 'temperatura', 'energia'), se houver */
  gpuThrottleReason?: string
  /** Mesmos motivos de `gpuThrottleReason` em forma estável (para regras e IA) */
  gpuThrottleFlags?: GpuThrottleFlag[]
  /** Consumo máximo permitido agora (W) — para mostrar "X W de Y W" */
  gpuPowerLimitW?: number
  /** Índice (nvidia-smi) da placa a que se referem os campos gpuTempC/gpuClockMhz/... */
  gpuTelemetryIndex?: number
  cpuPercent: number
  perCore: number[]
  cpuMhz?: number
  memUsedBytes: number
  memTotalBytes: number
  diskReadBps?: number
  diskWriteBps?: number
  /** % ativo do disco MAIS ocupado (como no Gerenciador de Tarefas) */
  diskActivePercent?: number
  netRxBps?: number
  netTxBps?: number
  /** Maior uso entre os motores da GPU (como no Gerenciador de Tarefas) */
  gpuPercent?: number
  /** Uso por disco físico */
  perDisk?: LiveDiskStats[]
  /** Uso do motor 3D da GPU (jogos) */
  gpu3dPercent?: number
  /** Memória de vídeo dedicada em uso */
  gpuMemDedicatedBytes?: number
  /** Memória compartilhada (RAM) usada pela GPU */
  gpuMemSharedBytes?: number
  /** false enquanto o coletor de disco/rede/GPU ainda está iniciando ou falhou */
  extendedAvailable?: boolean
  /** Preenchido quando o coletor de disco/rede/GPU não pode rodar nesta máquina (só CPU/RAM ficam disponíveis) */
  collectorError?: string
}

export interface HardwareApi {
  getInfo(refresh?: boolean): Promise<HardwareInfo>
  /** Último resultado salvo (instantâneo, sem coletar). null se nunca coletou. */
  getLast(): Promise<HardwareInfo | null>
  /** Começa a emitir 'hardware:live' (~1x por segundo). Pode ser chamado várias vezes. */
  startLive(): Promise<void>
  stopLive(): Promise<void>
}

export const HARDWARE_METHODS = ['getInfo', 'getLast', 'startLive', 'stopLive'] as const satisfies readonly (keyof HardwareApi)[]
