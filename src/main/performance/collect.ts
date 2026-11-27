// Coleta somente-leitura: roda os scripts em paralelo e monta o PerformanceSnapshot (sem achados/ações).
import type { DriveInfo } from '@shared/types/common'
import type {
  PerfEventIssue,
  PerformanceSnapshot,
  ProcessInfo,
  RamModuleBrief,
  ServiceInfo,
  StartupItem,
  StartupLocation
} from '@shared/types/performance'
import { runPowerShellJson } from '../core/powershell'
import { getDrives } from '../core/drives'
import { PROCS_SCRIPT, STARTUP_SCRIPT, STATE_SCRIPT, SYSTEM_SCRIPT } from './scripts'
import { channelOf, inferDualChannel, memoryTypeName, ratedFromPartNumber } from './ram'
import { guessStartupImpact } from './startupMeta'
import { arr, clamp, errText, num, str } from './util'

// ---------- Tipos crus (saída dos scripts) ----------
type N = number | null

export interface RawState {
  power?: { guid: string | null; name: string | null; schemes?: { guid: string; name: string; active: boolean }[] | null }
  hibernation?: { enabledValue: N; enabledDefault: N; fileType: N; fileBytes: N; hiberboot: N }
  gaming?: { autoGameMode: N; gameDvrEnabled: N; appCapture: N; historicalCapture: N; policyAllow: N; hwSchMode: N }
  visual?: { fx: N; transparency: N; taskbarAnim: N }
  storageSense?: N
  pagefile?: {
    automatic: boolean
    files?: { path: string; allocatedMb: number; currentMb: number; peakMb: number }[] | null
    settings?: string[] | string | null
  }
  pcSystemType?: number
  trim?: { ntfs: N; refs: N }
  /** Bateria presente e "ação de bateria crítica" do plano atual (0 nada, 1 suspender, 2 hibernar, 3 desligar). */
  battery?: { present: boolean; critAc: N; critDc: N }
  perfCountersOk?: boolean
  /** "Disable Performance Counters": global (Perflib) e por biblioteca do Windows (PerfOS, PerfProc...). */
  perfCounters?: { disabledGlobal: N; disabledLibs?: string[] | string | null }
  fragmentation?: { letter: string; percent: number; lastRun: string | null }[] | null
  scheduledOptimize?: boolean | null
  /** Recursos do Windows que gastam memória (Widgets, pesquisa na web, sugestões, Edge/Chrome em segundo plano) */
  features?: RawFeatures
  /** Atualizadores de terceiros da lista curada (catalogData.UPDATERS) que existem neste PC */
  updaterServices?: RawUpdaterService[] | RawUpdaterService | null
  /** Adaptadores de rede ativos (com gateway) e o DNS de cada um */
  dns?: RawDnsAdapter[] | RawDnsAdapter | null
}

export interface RawFeatures {
  dsh: N
  taskbarDa: N
  searchPolicy: N
  bing: N
  cdm?: Record<string, N> | null
  iris: N
  syncNotif: N
  scoobe: N
  edge?: { boost: N; background: N; installed: boolean } | null
  chrome?: { background: N; installed: boolean } | null
  bgApps: N
  defaultBrowser: string | null
  procs?: Record<string, { count: number; ws: number; priv: number }> | null
}

export interface RawUpdaterService {
  name: string
  displayName: string | null
  /** 2 = automático, 3 = manual, 4 = desativado */
  start: N
  delayed: N
  path: string | null
  status: string | null
}

export interface RawDnsAdapter {
  index: N
  alias: string
  description: string
  guid: string
  v4: string[] | string | null
  v6: string[] | string | null
  v4Static: boolean
  v6Static: boolean
}

interface RawSystem {
  os?: {
    caption: string
    version: string
    build: string
    ubr: N
    displayVersion: string | null
    installDate: string | null
    lastBoot: string | null
    uptimeSec: number
    totalKb: number
    freeKb: number
    virtTotalKb: number
    virtFreeKb: number
  }
  perfMem?: { committed: number; limit: number; available: number }
  cpu?: { name: string; cores: number; threads: number; currentMhz: number; maxMhz: number; load: N }
  ram?: {
    modules?: {
      bank: string
      locator: string
      capacity: number
      speed: number
      configured: number
      part: string
      manufacturer: string
      smbiosType: number
      memoryType: number
      formFactor: number
    }[]
    slots: number
  }
  gpus?: { name: string; ram: number; pnp: string }[]
  hasBattery?: boolean
  pendingReboot?: string[] | string | null
  antivirus?: { name: string; state: number }[]
  defender?: { realtime: boolean; antivirus: boolean; mode: string }
  boot?: { ms: number; at: string }
}

interface VerInfo {
  d: string
  c: string
  n: number
}

interface RawProcs {
  procs?: {
    elapsedMs: number
    logical: number
    idle: number
    list: { pid: number; name: string; path: string; cpu: number; ws: number; priv: number; self: boolean }[]
  }
  services?: {
    total: number
    running: {
      name: string
      displayName: string
      state: string
      startMode: string
      path: string | null
      company: string | null
      description: string
    }[]
  }
  versions?: Record<string, VerInfo | null>
  warnings?: string[]
}

interface RawStartupItem {
  id: string
  name: string
  command: string
  location: StartupLocation
  enabled: boolean
  admin: boolean
  exe: string | null
  exists: boolean
  ver: VerInfo | null
  kind: 'run' | 'folder' | 'task'
  taskPath?: string
  author?: string
}

interface RawEvent {
  kind: PerfEventIssue['kind']
  source: string
  id: number
  count: number
  last: string | null
  message: string
  level: number
  app?: string
  withBugcheck?: number
  powerButton?: number
}

interface RawStartup {
  startup?: RawStartupItem[]
  events?: RawEvent[]
  warnings?: string[]
}

/** Dados extras que não vão no snapshot mas os achados/ações usam. */
export interface CollectExtras {
  state: RawState
  powerSchemes: { guid: string; name: string; active: boolean }[]
  scheduledOptimize?: boolean
  /** Eventos crus de energia (contagem com/sem tela azul) */
  unexpectedShutdowns?: { count: number; withBugcheck: number; powerButton: number; last?: string }
  /**
   * Da última análise de HARDWARE salva (getLatest('hardware')): placa de vídeo que acusou "freio de energia"
   * (fonte/placa-mãe não entregando energia). null = analisado e sem freio; ausente = não lido.
   */
  gpuPowerBrake?: { gpu: string; seconds?: number; checkedAt?: string } | null
  /** Existe uma análise de hardware salva (para saber se dá para cruzar com a GPU) */
  hardwareChecked?: boolean
}

/**
 * Entrada de inicialização "órfã" (programa desinstalado): só quando o executável tem caminho ABSOLUTO e não existe.
 * Nome sem pasta que o script não conseguiu resolver (PATH/System32) fica como "não sei" — nunca vira órfã.
 */
export function startupOrphan(exists: boolean, exe: string | null | undefined): boolean {
  if (exists) return false
  return typeof exe === 'string' && /^([a-z]:\\|\\\\)/i.test(exe.trim())
}

export type Progress = (phase: string, message: string, percent: number) => void

const PS_TIMEOUT = 90_000

// ---------- Execução ----------

/** Lê apenas o estado das configurações (para o catálogo de otimizações). */
export async function readState(): Promise<{ state: RawState; warnings: string[] }> {
  const raw = await runPowerShellJson<{ state: RawState; warnings?: string[] | string }>(STATE_SCRIPT, { timeoutMs: 60_000 })
  return { state: raw.state ?? {}, warnings: arr(raw.warnings) }
}

export async function collectRaw(progress: Progress): Promise<{
  base: Omit<PerformanceSnapshot, 'findings' | 'score' | 'actions'>
  extras: CollectExtras
}> {
  const started = Date.now()
  const warnings: string[] = []
  // Fase 1 (em paralelo): sistema, inicialização/eventos e discos.
  // Fase 2 (sozinha): amostra de CPU por processo — assim a própria coleta não "suja" a medição.
  let done = 0
  const tick = (message: string): void => {
    done++
    progress('collect', message, Math.round((done / 4) * 80))
  }
  const sysP = runPowerShellJson<{ state: RawState; sys: RawSystem; warnings?: string[] }>(SYSTEM_SCRIPT, { timeoutMs: PS_TIMEOUT }).then((v) => {
    tick('Sistema, memória e configurações lidos')
    return v
  })
  const startP = runPowerShellJson<RawStartup>(STARTUP_SCRIPT, { timeoutMs: PS_TIMEOUT }).then((v) => {
    tick('Inicialização e log de eventos lidos')
    return v
  })
  const drivesP = getDrives(true).then((v) => {
    tick('Unidades de disco verificadas')
    return v
  })
  progress('collect', 'Lendo sistema, memória, inicialização, log de eventos e discos...', 5)
  const [sysR, startR, drivesR] = await Promise.allSettled([sysP, startP, drivesP])

  progress('collect', 'Medindo o uso do processador e da memória por programa...', 62)
  const [procR] = await Promise.allSettled([runPowerShellJson<RawProcs>(PROCS_SCRIPT, { timeoutMs: PS_TIMEOUT })])
  tick('Processos e serviços medidos')

  const sysRaw = sysR.status === 'fulfilled' ? sysR.value : null
  if (!sysRaw) warnings.push('Informações do sistema: ' + errText((sysR as PromiseRejectedResult).reason))
  const procRaw = procR.status === 'fulfilled' ? procR.value : null
  if (!procRaw) warnings.push('Processos e serviços: ' + errText((procR as PromiseRejectedResult).reason))
  const startRaw = startR.status === 'fulfilled' ? startR.value : null
  if (!startRaw) warnings.push('Inicialização e eventos: ' + errText((startR as PromiseRejectedResult).reason))
  const drives: DriveInfo[] = drivesR.status === 'fulfilled' ? drivesR.value : []
  if (drivesR.status === 'rejected') warnings.push('Unidades de disco: ' + errText(drivesR.reason))

  warnings.push(...arr(sysRaw?.warnings), ...arr(procRaw?.warnings), ...arr(startRaw?.warnings))

  const state: RawState = sysRaw?.state ?? {}
  const sys: RawSystem = sysRaw?.sys ?? {}
  progress('analyze', 'Analisando os resultados...', 92)

  // ---------- SO / CPU ----------
  const os = sys.os
  const cpuName = str(sys.cpu?.name) ?? 'Processador desconhecido'
  const threads = num(sys.cpu?.threads) || num(procRaw?.procs?.logical) || 1
  const gpus = arr(sys.gpus)
    .filter((g) => !/parsec|basic display|basic render|remote|virtual|citrix|displaylink|idd|spacedesk|meta virtual/i.test(g.name))
    .map((g) => ({ name: g.name, integrated: isIntegratedGpu(g.name), vramBytes: num(g.ram) || undefined }))
  const hasIntegratedGraphics = cpuHasIgpu(cpuName)

  // ---------- Processos ----------
  const { byCpu, byMem, loadPercent } = summarizeProcesses(procRaw, threads)

  // ---------- Memória ----------
  const totalBytes = (num(os?.totalKb) ?? 0) * 1024
  const availableBytes = num(sys.perfMem?.available) ?? (num(os?.freeKb) ?? 0) * 1024
  const commitLimitBytes = num(sys.perfMem?.limit) ?? (num(os?.virtTotalKb) ?? 0) * 1024
  const commitUsedBytes =
    num(sys.perfMem?.committed) ?? Math.max(0, ((num(os?.virtTotalKb) ?? 0) - (num(os?.virtFreeKb) ?? 0)) * 1024)
  const modules: RamModuleBrief[] = arr(sys.ram?.modules).map((m) => {
    const rated = ratedFromPartNumber(m.part)
    const speed = num(m.speed) || undefined
    return {
      slot: str(m.locator) ?? str(m.bank) ?? 'Slot ?',
      bank: str(m.bank),
      capacityBytes: num(m.capacity) ?? 0,
      type: memoryTypeName(num(m.smbiosType)),
      speedMhz: speed,
      configuredMhz: num(m.configured) || undefined,
      ratedMhz: Math.max(rated ?? 0, speed ?? 0) || undefined,
      manufacturer: str(m.manufacturer),
      partNumber: str(m.part),
      channel: channelOf(m.locator, m.bank)
    }
  })
  const configuredList = modules.map((m) => m.configuredMhz ?? m.speedMhz).filter((v): v is number => Boolean(v))
  const ratedList = modules.map((m) => m.ratedMhz).filter((v): v is number => Boolean(v))

  // ---------- Serviços ----------
  const running = arr(procRaw?.services?.running)
  const services: ServiceInfo[] = running.map((s) => {
    const company = cleanMeta(s.company)
    return {
      name: s.name,
      displayName: s.displayName || s.name,
      status: s.state,
      startType: s.startMode,
      isMicrosoft: isMicrosoftService(company, s.path),
      path: str(s.path),
      description: cleanMeta(s.description),
      company: company ?? vendorFromPath(s.path)
    }
  })
  const nonMicrosoft = services.filter((s) => !s.isMicrosoft).sort((a, b) => a.displayName.localeCompare(b.displayName, 'pt-BR'))

  // ---------- Inicialização ----------
  const startupItems: StartupItem[] = arr(startRaw?.startup).map((r) => {
    const missing = startupOrphan(r.exists, r.exe)
    const verC = cleanMeta(r.ver?.c)
    const verD = cleanMeta(r.ver?.d)
    const guess = guessStartupImpact({
      name: r.name,
      command: r.command,
      publisher: verC ?? r.author,
      description: verD,
      exeBytes: r.ver?.n,
      missing
    })
    return {
      id: r.id,
      name: friendlyStartupName(r.name, verD),
      command: r.command,
      location: r.location,
      publisher: verC ?? (r.kind === 'task' ? cleanMeta(r.author) : undefined) ?? vendorFromPath(r.exe),
      enabled: Boolean(r.enabled),
      impact: guess.impact,
      canToggle: true,
      requiresAdmin: Boolean(r.admin),
      exePath: str(r.exe),
      description: verD,
      impactReason: guess.reason,
      essential: guess.essential,
      missing,
      exeBytes: num(r.ver?.n)
    }
  })
  const impactRank = { high: 0, medium: 1, low: 2, unknown: 3 } as const
  startupItems.sort(
    (a, b) => Number(b.enabled) - Number(a.enabled) || impactRank[a.impact] - impactRank[b.impact] || a.name.localeCompare(b.name, 'pt-BR')
  )

  // ---------- Eventos ----------
  const rawEvents = arr(startRaw?.events)
  const power = rawEvents.find((e) => e.kind === 'power')
  const eventLogIssues: PerfEventIssue[] = rawEvents.map((e) => ({
    source: e.source,
    eventId: e.id,
    count: e.count,
    lastSeen: e.last ?? '',
    message: eventMessage(e),
    kind: e.kind,
    app: str(e.app)
  }))

  // ---------- Segurança ----------
  const avList = arr(sys.antivirus)
  const activeAv = avList.filter((a) => (Number(a.state) & 0x1000) !== 0).map((a) => a.name)
  const defenderRealtime = sys.defender ? Boolean(sys.defender.realtime && sys.defender.antivirus) : undefined

  // ---------- Reinício pendente ----------
  const pr = arr(sys.pendingReboot)
  const reasonText: Record<string, string> = {
    cbs: 'Atualização de componentes do Windows aguardando reinício',
    wu: 'Windows Update aguardando reinício',
    pfro: 'Arquivos aguardando substituição no próximo reinício (instalação ou atualização de programa)'
  }

  // ---------- Jogos / hibernação / paginação ----------
  const g = state.gaming
  const hib = state.hibernation
  const hibEnabled = hibernationEnabled(state)
  const hibType = hibernationType(state, totalBytes)
  const pf = state.pagefile
  const pfFiles = arr(pf?.files).map((f) => ({
    path: f.path,
    allocatedBytes: (num(f.allocatedMb) ?? 0) * 1024 * 1024,
    currentUsageBytes: (num(f.currentMb) ?? 0) * 1024 * 1024,
    peakUsageBytes: (num(f.peakMb) ?? 0) * 1024 * 1024,
    drive: /^([a-z]:)/i.exec(f.path)?.[1]?.toUpperCase()
  }))

  const fx = num(state.visual?.fx)
  const visualEffects =
    fx === 2 ? 'Melhor desempenho' : fx === 1 ? 'Melhor aparência' : fx === 3 ? 'Personalizado' : 'Deixar o Windows escolher'

  const ubr = num(os?.ubr)
  const base: Omit<PerformanceSnapshot, 'findings' | 'score' | 'actions'> = {
    collectedAt: new Date().toISOString(),
    uptimeSeconds: Math.max(0, Math.round(num(os?.uptimeSec) ?? 0)),
    lastBootDurationMs: num(sys.boot?.ms),
    os: {
      caption: str(os?.caption) ?? 'Windows',
      version: str(os?.version) ?? '',
      build: os?.build ? (ubr ? `${os.build}.${ubr}` : os.build) : '',
      installDate: str(os?.installDate),
      displayVersion: str(os?.displayVersion),
      lastBoot: str(os?.lastBoot)
    },
    cpu: {
      name: cpuName,
      loadPercent: loadPercent ?? num(sys.cpu?.load) ?? 0,
      cores: num(sys.cpu?.cores) ?? 0,
      threads,
      currentMhz: num(sys.cpu?.currentMhz) || undefined,
      maxMhz: num(sys.cpu?.maxMhz) || undefined,
      hasIntegratedGraphics
    },
    memory: {
      totalBytes,
      usedBytes: Math.max(0, totalBytes - availableBytes),
      availableBytes,
      commitUsedBytes,
      commitLimitBytes,
      modulesInstalled: modules.length,
      slotsTotal: num(sys.ram?.slots) || undefined,
      configuredMhz: configuredList.length ? Math.min(...configuredList) : undefined,
      ratedMhz: ratedList.length ? Math.max(...ratedList) : undefined,
      dualChannel: inferDualChannel(modules),
      modules,
      memoryType: modules.find((m) => m.type)?.type
    },
    drives,
    powerPlan: {
      name: str(state.power?.name) ?? 'Desconhecido',
      guid: str(state.power?.guid) ?? '',
      available: arr(state.power?.schemes).map((s) => ({ guid: s.guid, name: s.name }))
    },
    topProcessesByCpu: byCpu,
    topProcessesByMemory: byMem,
    startupItems,
    services: { running: services.length, nonMicrosoftRunning: nonMicrosoft.length, nonMicrosoft, total: num(procRaw?.services?.total) },
    security: {
      defenderRealtime,
      antivirusProducts: avList.map((a) => a.name),
      multipleAntivirus: activeAv.length > 1,
      activeAntivirus: activeAv
    },
    pendingReboot: pr.length > 0,
    pendingRebootReasons: pr.map((r) => reasonText[r] ?? r),
    gaming: {
      gameMode: g ? (g.autoGameMode === null || g.autoGameMode === undefined ? true : g.autoGameMode === 1) : undefined,
      hags: g?.hwSchMode === 2 ? true : g?.hwSchMode === 1 ? false : undefined,
      gameDvrBackgroundRecording: g ? g.historicalCapture === 1 : undefined,
      gameDvrEnabled: g ? (g.gameDvrEnabled ?? 1) === 1 && g.policyAllow !== 0 && g.appCapture !== 0 : undefined
    },
    hibernation: { enabled: hibEnabled, fileBytes: num(hib?.fileBytes), type: hibEnabled ? hibType : undefined, fastStartup: hibEnabled && hib?.hiberboot !== 0 },
    pagefile: {
      systemManaged: pf ? Boolean(pf.automatic) : undefined,
      currentBytes: pfFiles.length ? pfFiles.reduce((s, f) => s + f.allocatedBytes, 0) : undefined,
      files: pfFiles,
      manualSettings: pf && !pf.automatic ? arr(pf.settings) : undefined
    },
    visualEffects,
    eventLogIssues,
    warnings: [...new Set(warnings)],
    gpus,
    isLaptop: isLaptopState(state) || Boolean(sys.hasBattery),
    trim: state.trim ? { ntfsEnabled: state.trim.ntfs === null ? undefined : state.trim.ntfs === 0, refsEnabled: state.trim.refs === null ? undefined : state.trim.refs === 0 } : undefined,
    fragmentation: arr(state.fragmentation).map((f) => ({ letter: f.letter, percent: f.percent, lastRun: str(f.lastRun) })),
    storageSense: state.storageSense === null || state.storageSense === undefined ? undefined : state.storageSense === 1,
    perfCountersOk: state.perfCountersOk,
    perfCountersDisabled: perfCounterPolicy(state),
    collectionMs: Date.now() - started
  }

  const extras: CollectExtras = {
    state,
    powerSchemes: arr(state.power?.schemes),
    scheduledOptimize: state.scheduledOptimize ?? undefined,
    unexpectedShutdowns: power
      ? { count: power.count, withBugcheck: power.withBugcheck ?? 0, powerButton: power.powerButton ?? 0, last: power.last ?? undefined }
      : undefined
  }
  return { base, extras }
}

// ---------- Auxiliares ----------

export function hibernationEnabled(state: RawState): boolean {
  const h = state.hibernation
  if (!h) return false
  const v = h.enabledValue ?? h.enabledDefault
  if (v !== null && v !== undefined) return v === 1 && (h.fileBytes ?? 1) > 0
  return (h.fileBytes ?? 0) > 0
}

/** Contadores desligados por configuração do registro (undefined = não lido). */
export function perfCounterPolicy(state: RawState): { global: boolean; libraries: string[] } | undefined {
  const pc = state.perfCounters
  if (!pc) return undefined
  const g = num(pc.disabledGlobal)
  return { global: g !== undefined && g !== 0, libraries: arr(pc.disabledLibs).filter((x): x is string => typeof x === 'string') }
}

/** Notebook (tipo "móvel" ou com bateria). */
export function isLaptopState(state: RawState): boolean {
  return state.pcSystemType === 2 || Boolean(state.battery?.present)
}

export function hibernationType(state: RawState, totalRamBytes: number): 'full' | 'reduced' | undefined {
  const h = state.hibernation
  if (!h) return undefined
  if (h.fileType === 1) return 'reduced'
  if (h.fileType === 2) return 'full'
  if (h.fileBytes && totalRamBytes > 0) return h.fileBytes / totalRamBytes < 0.3 ? 'reduced' : 'full'
  return undefined
}

function isIntegratedGpu(name: string): boolean {
  if (/\bRX\b|Radeon Pro|GeForce|NVIDIA|Quadro|Arc A\d|Arc B\d|RTX|GTX/i.test(name)) return false
  return /Radeon\(TM\) Graphics|Radeon Graphics|Vega \d|Radeon \d{3}M|Intel\(R\) (UHD|HD|Iris)|Intel.*Graphics/i.test(name)
}

function cpuHasIgpu(name: string): boolean {
  if (/AMD/i.test(name)) return /Radeon|Graphics|Vega|\b\d{4}G[E]?\b/i.test(name)
  if (/Intel/i.test(name)) return !/\d{4,5}[A-Z]*F\b/i.test(name)
  return false
}

export function isMicrosoftService(company: string | null | undefined, path: string | null | undefined): boolean {
  const c = (company ?? '').trim()
  if (/microsoft|windows \(r\)/i.test(c)) return true
  if (!path) return true // serviços protegidos do sistema (ex.: LSM) não expõem o caminho
  if (!c) {
    const p = path.toLowerCase()
    const win = (process.env.SystemRoot ?? 'C:\\Windows').toLowerCase()
    return p.startsWith(`${win}\\system32\\`) && !p.includes('\\driverstore\\') && !/nv|amd|realtek|intel/.test(p.split('\\').pop() ?? '')
  }
  return false
}

const IGNORE_PROCS = new Set(['system idle process', 'idle'])

/** Processos do Windows que o usuário comum não consegue identificar (sem caminho legível sem admin). */
const KNOWN_PROCS: Record<string, [string, string]> = {
  'svchost.exe': ['Serviços do Windows (svchost)', 'Microsoft'],
  'msmpeng.exe': ['Microsoft Defender Antivírus', 'Microsoft'],
  'mpdefendercoreservice.exe': ['Microsoft Defender (núcleo)', 'Microsoft'],
  'nissrv.exe': ['Microsoft Defender (proteção de rede)', 'Microsoft'],
  'dwm.exe': ['Gerenciador de Janelas da Área de Trabalho', 'Microsoft'],
  'wmiprvse.exe': ['WMI (informações do sistema)', 'Microsoft'],
  system: ['Núcleo do Windows (kernel e drivers)', 'Microsoft'],
  registry: ['Registro do Windows', 'Microsoft'],
  'memory compression': ['Compressão de memória do Windows', 'Microsoft'],
  'services.exe': ['Gerenciador de serviços', 'Microsoft'],
  'lsass.exe': ['Segurança local (login)', 'Microsoft'],
  'csrss.exe': ['Subsistema do Windows', 'Microsoft'],
  'searchindexer.exe': ['Indexador de pesquisa do Windows', 'Microsoft'],
  'searchhost.exe': ['Pesquisa do Windows', 'Microsoft'],
  'audiodg.exe': ['Áudio do Windows', 'Microsoft'],
  'tiworker.exe': ['Windows Update (instalando)', 'Microsoft'],
  'trustedinstaller.exe': ['Windows Update (instalador)', 'Microsoft'],
  'msiexec.exe': ['Instalador do Windows', 'Microsoft'],
  vmmem: ['Máquina virtual (WSL/Docker)', 'Microsoft'],
  vmmemwsl: ['Máquina virtual do WSL', 'Microsoft'],
  'presentmon_x64.exe': ['PresentMon (medidor de FPS de overlays)', '']
}

/** Descarta metadados lixo que alguns fabricantes deixam no executável (ex.: 'TODO: <公司名稱>'). */
export function cleanMeta(v: string | null | undefined): string | undefined {
  const t = str(v)
  if (!t) return undefined
  if (/\bTODO\b|<[^>]*>|^\W+$/i.test(t)) return undefined
  return t
}

/** Fabricante provável a partir do caminho do executável (quando o arquivo não informa a empresa). */
export function vendorFromPath(p: string | null | undefined): string | undefined {
  if (!p) return undefined
  const lower = p.toLowerCase()
  if (/nvidia|nvcontainer/.test(lower) || /\\nv[a-z0-9]*\.inf_/.test(lower)) return 'NVIDIA'
  if (/\\(amd|ati)[^\\]*\\/.test(lower) || /\\u\d+\.inf_/.test(lower)) return 'AMD'
  if (/realtek|\\rtk/.test(lower)) return 'Realtek'
  if (/\\intel/.test(lower)) return 'Intel'
  let m = /\\windowsapps\\([^_\\]+)_/i.exec(p)
  if (m) return m[1].replace(/^[A-Za-z0-9]+\./, '')
  m = /\\program files(?: \(x86\))?\\(?:common files\\)?([^\\]+)\\/i.exec(p)
  if (m) return m[1]
  return undefined
}

/**
 * Aproximação do "conjunto de trabalho privado" (coluna Memória do Gerenciador de Tarefas):
 * a soma dos working sets conta várias vezes as páginas compartilhadas (navegadores com dezenas de processos).
 */
function approxPrivateWs(ws: number, priv: number): number {
  if (!(priv > 0)) return ws
  return Math.min(ws, priv)
}

/** Nome amigável: remove SIDs/hashes/números de série que os instaladores colocam no nome. */
export function friendlyStartupName(name: string, description?: string): string {
  let n = name.trim()
  if (/^MicrosoftEdgeAutoLaunch/i.test(n)) return 'Microsoft Edge (pré-carregamento)'
  n = n.replace(/^electron\.app\./i, '')
  n = n.replace(/[-_ ]?S-1-5-21(-\d+)+$/i, '')
  n = n.replace(/[-_ ]\{?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}?$/i, '')
  n = n.replace(/\s+\d{6,}$/, '')
  n = n.replace(/_[0-9A-F]{16,}$/i, '')
  n = n.trim()
  if (!n) n = description?.trim() || name.trim()
  return n
}

function summarizeProcesses(raw: RawProcs | null, threads: number): { byCpu: ProcessInfo[]; byMem: ProcessInfo[]; loadPercent?: number } {
  const p = raw?.procs
  if (!p || !p.list?.length) return { byCpu: [], byMem: [] }
  const logical = num(p.logical) || threads || 1
  const cap = logical * Math.max(1, num(p.elapsedMs) ?? 1500) * 10_000 // 100 ns
  const versions = raw?.versions ?? {}
  const groups = new Map<string, ProcessInfo & { cpuRaw: number; maxWs: number }>()
  let busy = 0
  for (const pr of arr(p.list)) {
    if (pr.self || IGNORE_PROCS.has(pr.name.toLowerCase())) continue
    busy += pr.cpu
    const key = (pr.path || pr.name).toLowerCase()
    const g = groups.get(key)
    if (!g) {
      const vi = pr.path ? versions[pr.path] : null
      const known = KNOWN_PROCS[pr.name.toLowerCase()]
      const company = cleanMeta(vi?.c) ?? vendorFromPath(pr.path) ?? (known?.[1] || undefined)
      groups.set(key, {
        name: pr.name,
        pid: pr.pid,
        memoryBytes: approxPrivateWs(pr.ws, pr.priv),
        privateBytes: pr.priv,
        cpuRaw: pr.cpu,
        maxWs: pr.ws,
        instances: 1,
        path: str(pr.path),
        description: cleanMeta(vi?.d) ?? known?.[0],
        company
      })
    } else {
      g.instances = (g.instances ?? 1) + 1
      g.memoryBytes += approxPrivateWs(pr.ws, pr.priv)
      g.privateBytes = (g.privateBytes ?? 0) + pr.priv
      g.cpuRaw += pr.cpu
      if (pr.ws > g.maxWs) {
        g.maxWs = pr.ws
        g.pid = pr.pid
      }
    }
  }
  const list = [...groups.values()].map(({ cpuRaw, maxWs: _m, ...rest }) => ({
    ...rest,
    cpuPercent: Math.round(clamp((cpuRaw / cap) * 100, 0, 100) * 10) / 10
  }))
  const byCpu = list
    .filter((x) => (x.cpuPercent ?? 0) > 0)
    .sort((a, b) => (b.cpuPercent ?? 0) - (a.cpuPercent ?? 0))
    .slice(0, 12)
  const byMem = [...list].sort((a, b) => b.memoryBytes - a.memoryBytes).slice(0, 12)
  return { byCpu, byMem, loadPercent: Math.round(clamp((busy / cap) * 100, 0, 100)) }
}

function eventMessage(e: RawEvent): string {
  switch (e.kind) {
    case 'power': {
      const parts = [`O PC desligou ou reiniciou sem o desligamento normal ${e.count} ${e.count === 1 ? 'vez' : 'vezes'} nos últimos 30 dias`]
      if (e.withBugcheck) parts.push(`${e.withBugcheck} com tela azul`)
      if (e.powerButton) parts.push(`${e.powerButton} pelo botão de energia`)
      return parts.join('; ') + '.'
    }
    case 'appCrash':
      return `${e.app ?? 'Programa'} fechou com erro ${e.count} ${e.count === 1 ? 'vez' : 'vezes'} nos últimos 30 dias.`
    case 'appHang':
      return `${e.app ?? 'Programa'} parou de responder ${e.count} ${e.count === 1 ? 'vez' : 'vezes'} nos últimos 30 dias.`
    default:
      return (e.message || '').replace(/\s+/g, ' ').trim()
  }
}
