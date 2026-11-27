// Domínio: Diagnóstico de Lentidão & Otimização (o que realmente deixa o PC lento).
import type { ActionResult, DriveInfo, Impact, Risk, Severity } from './common'

export type PerfCategory =
  | 'disk'
  | 'memory'
  | 'cpu'
  | 'startup'
  | 'services'
  | 'power'
  | 'system'
  | 'drivers'
  | 'security'
  | 'thermal'
  | 'gaming'
  | 'network'
  | 'updates'

export interface PerfFinding {
  /** Estável (ex.: 'system-drive-almost-full'). Achados com id 'ok-*' (severity 'info') = verificado e OK. */
  id: string
  category: PerfCategory
  severity: Severity
  /** PT-BR */
  title: string
  /** PT-BR, explica o porquê e o efeito na velocidade */
  detail: string
  evidence?: Record<string, string | number | boolean>
  /** Ações do catálogo (OptimizationAction.id) que resolvem/mitigam */
  actionIds?: string[]
  /** Passos manuais PT-BR (ex.: ativar XMP/EXPO na BIOS) */
  manualSteps?: string[]
  /** Itens de inicialização relacionados (StartupItem.id) */
  startupIds?: string[]
}

export type StartupLocation =
  | 'HKCU Run'
  | 'HKLM Run'
  | 'HKLM Run (32-bit)'
  | 'Pasta Inicializar (usuário)'
  | 'Pasta Inicializar (todos)'
  | 'Tarefa agendada'

export interface StartupItem {
  /** Ex.: 'run:HKCU:Discord', 'run32:HKLM:Lightshot', 'folder:user:App.lnk', 'task:\\ASUS\\AsusDriverHub' */
  id: string
  name: string
  command: string
  location: StartupLocation
  publisher?: string
  enabled: boolean
  /** Estimativa: high/medium/low/unknown */
  impact: Impact | 'unknown'
  canToggle: boolean
  requiresAdmin: boolean
  /** Arquivo executável resolvido, se encontrado */
  exePath?: string
  /** Descrição do executável (FileDescription) */
  description?: string
  /** Por que o impacto foi estimado assim (PT-BR) */
  impactReason?: string
  /** Item importante para o sistema (antivírus, áudio...): recomenda manter ativo */
  essential?: boolean
  /** O executável não existe mais (entrada órfã) */
  missing?: boolean
  exeBytes?: number
}

export interface ServiceInfo {
  name: string
  displayName: string
  /** 'Running' | 'Stopped' | ... */
  status: string
  /** 'Auto' | 'Manual' | 'Disabled' | 'Boot' | 'System' */
  startType: string
  isMicrosoft: boolean
  path?: string
  description?: string
  /** Empresa do executável (CompanyName) */
  company?: string
}

export interface ProcessInfo {
  /** Nome do executável (ex.: 'opera.exe') */
  name: string
  /** PID do processo principal (o maior do grupo) */
  pid: number
  /** % de CPU normalizado pelo nº de threads (0..100), medido por ~1,5 s */
  cpuPercent?: number
  /** Memória na RAM (working set, soma do grupo) */
  memoryBytes: number
  path?: string
  description?: string
  company?: string
  /** Quantos processos com o mesmo executável foram somados */
  instances?: number
  /** Memória privada (commit) somada */
  privateBytes?: number
}

export interface OptimizationAction {
  /** Estável (ex.: 'power-plan-balanced', 'hibernation-reduce', 'optimize-drive:E') */
  id: string
  title: string
  description: string
  category: PerfCategory
  requiresAdmin: boolean
  reversible: boolean
  risk: Risk
  estimatedImpact: Impact
  /** Estado atual na máquina */
  state: 'applied' | 'notApplied' | 'unknown' | 'notApplicable'
  /** Ação demorada (ex.: DISM, desfragmentar) */
  longRunning?: boolean
  /** Texto do que será feito, mostrado na confirmação */
  confirmText?: string
  /** Lista exata do que muda (comandos/registro), mostrada na confirmação */
  changes?: string[]
  /** Precisa reiniciar (ou sair e entrar na conta) para ter efeito */
  requiresRestart?: boolean
  /** Valor atual legível (ex.: 'Atual: Alto desempenho') */
  currentValue?: string
  /** Por que não se aplica / observação (PT-BR) */
  note?: string
  /** Letra da unidade, nas ações por unidade */
  drive?: string
  /**
   * Seção própria na interface (fora da lista geral de otimizações):
   * 'features' = recursos do Windows que gastam memória; 'updaters' = atualizadores de terceiros; 'dns' = servidor DNS.
   */
  group?: 'features' | 'updaters' | 'dns'
}

export interface RamModuleBrief {
  slot: string
  bank?: string
  capacityBytes: number
  /** 'DDR4' | 'DDR5' | ... */
  type?: string
  /** Velocidade máxima informada pelo pente (MT/s) */
  speedMhz?: number
  /** Velocidade em uso (MT/s) */
  configuredMhz?: number
  /** Velocidade nominal inferida pelo part number (ex.: KF3200C16 -> 3200) */
  ratedMhz?: number
  manufacturer?: string
  partNumber?: string
  /** Canal inferido do nome do slot ('A', 'B'...) */
  channel?: string
}

export interface MemoryStatus {
  totalBytes: number
  usedBytes: number
  availableBytes: number
  commitUsedBytes: number
  commitLimitBytes: number
  modulesInstalled: number
  slotsTotal?: number
  /** MHz em que a RAM está rodando */
  configuredMhz?: number
  /** MHz nominal do pente (XMP/EXPO) */
  ratedMhz?: number
  /** true = dual channel provável; 'unknown' se não der para inferir */
  dualChannel: boolean | 'unknown'
  modules?: RamModuleBrief[]
  /** 'DDR4' | 'DDR5' ... */
  memoryType?: string
}

export interface PerfEventIssue {
  source: string
  eventId: number
  count: number
  lastSeen: string
  message: string
  /** Agrupamento: disco, hardware (WHEA), energia, tela azul, travamento de app */
  kind?: 'disk' | 'whea' | 'power' | 'bugcheck' | 'appCrash' | 'appHang'
  /** Programa afetado (travamentos) */
  app?: string
}

export interface PerformanceSnapshot {
  /** ISO */
  collectedAt: string
  uptimeSeconds: number
  /** Último tempo de boot medido pelo Windows, se disponível (ms) */
  lastBootDurationMs?: number
  os: { caption: string; version: string; build: string; installDate?: string; displayVersion?: string; lastBoot?: string }
  cpu: {
    name: string
    loadPercent: number
    cores: number
    threads: number
    currentMhz?: number
    maxMhz?: number
    /** Processador com vídeo integrado (ex.: Ryzen 5700G) */
    hasIntegratedGraphics?: boolean
  }
  memory: MemoryStatus
  drives: DriveInfo[]
  powerPlan: { name: string; guid: string; available?: { guid: string; name: string }[] }
  topProcessesByCpu: ProcessInfo[]
  topProcessesByMemory: ProcessInfo[]
  startupItems: StartupItem[]
  services: { running: number; nonMicrosoftRunning: number; nonMicrosoft: ServiceInfo[]; total?: number }
  security: {
    defenderRealtime?: boolean
    antivirusProducts: string[]
    multipleAntivirus: boolean
    /** Produtos com proteção em tempo real ligada */
    activeAntivirus?: string[]
  }
  pendingReboot: boolean
  /** Motivos legíveis (PT-BR) do reinício pendente */
  pendingRebootReasons?: string[]
  gaming: { gameMode?: boolean; hags?: boolean; gameDvrBackgroundRecording?: boolean; gameDvrEnabled?: boolean }
  hibernation: { enabled: boolean; fileBytes?: number; type?: 'full' | 'reduced'; fastStartup?: boolean }
  pagefile: {
    systemManaged?: boolean
    currentBytes?: number
    files?: { path: string; allocatedBytes: number; currentUsageBytes?: number; peakUsageBytes?: number; drive?: string }[]
    /** Configuração manual (registro PagingFiles), quando não gerenciado pelo sistema */
    manualSettings?: string[]
  }
  visualEffects?: string
  /** Erros relevantes do log de eventos (disco, WHEA, travamentos) nos últimos 30 dias */
  eventLogIssues: PerfEventIssue[]
  findings: PerfFinding[]
  /** 0..100 (regra local, sem IA) */
  score: number
  actions: OptimizationAction[]
  /** Itens que não puderam ser coletados (ex.: precisa de admin) */
  warnings: string[]
  /** Placas de vídeo detectadas */
  gpus?: { name: string; integrated: boolean; vramBytes?: number }[]
  isLaptop?: boolean
  trim?: { ntfsEnabled?: boolean; refsEnabled?: boolean }
  /** Fragmentação por unidade (última análise do Windows) */
  fragmentation?: { letter: string; percent: number; lastRun?: string }[]
  storageSense?: boolean
  /** Contadores de desempenho do WMI funcionando */
  perfCountersOk?: boolean
  /**
   * Contadores desligados por configuração do registro ("Disable Performance Counters"):
   * global = chave Perflib; libraries = bibliotecas do Windows desligadas (PerfOS, PerfProc...).
   */
  perfCountersDisabled?: { global: boolean; libraries: string[] }
  /** Tempo da coleta (ms) */
  collectionMs?: number
}

/** Medição rápida para comparar ANTES x DEPOIS das otimizações (mesmos critérios sempre). */
export interface SpeedMeasurement {
  id: string
  /** ISO */
  takenAt: string
  /** Ex.: 'Antes de otimizar', 'Depois de otimizar' */
  label?: string
  /** Duração do último boot medida pelo Windows (s), se disponível */
  bootSeconds?: number
  /** Itens ativos na inicialização */
  startupItems: number
  servicesRunning: number
  processes: number
  /** RAM em uso com o PC parado (média de alguns segundos) */
  ramUsedBytesIdle: number
  ramTotalBytes: number
  /** CPU ociosa média durante a medição (%) */
  cpuIdlePercent?: number
  systemDriveFreeBytes: number
  /** Leitura/escrita sequencial de um arquivo de teste temporário no disco do sistema (MB/s) */
  diskReadMBps?: number
  diskWriteMBps?: number
  /** Nota 0..100 do diagnóstico no momento */
  score?: number
  notes?: string[]
}

/** Agrupamento dos itens do plano "Otimizar tudo" na interface. */
export type BoostGroup = 'windows' | 'updaters' | 'gaming' | 'system' | 'disk' | 'network'

/** Uma ação sugerida no plano "Otimizar tudo". */
export interface BoostPlanItem {
  /** OptimizationAction.id */
  actionId: string
  title: string
  /** PT-BR: por que entra no plano neste PC */
  why: string
  impact: Impact
  risk: Risk
  requiresAdmin: boolean
  requiresRestart?: boolean
  /** Pré-marcado (seguro e com efeito) */
  selected: boolean
  group?: BoostGroup
  /** Aviso importante PT-BR (ex.: 'o Edge vai mostrar "gerenciado pela organização"') */
  warning?: string
  /** Estado atual legível (ex.: 'Widgets usando 180 MB agora') */
  currentValue?: string
  reversible?: boolean
}

export interface BoostStartupSuggestion {
  id: string
  name: string
  why: string
  impact: Impact | 'unknown'
  /** Pré-marcado (launcher, atualizador, entrada órfã...). Chat/nuvem/periféricos vêm desmarcados. */
  selected?: boolean
  /** Aviso PT-BR (ex.: 'se desativar, os arquivos só sincronizam quando você abrir o app') */
  warning?: string
  requiresAdmin?: boolean
  /** Tipo em PT-BR (ex.: 'Launcher de jogos', 'Atualizador') */
  kind?: string
}

export interface BoostPlan {
  /** ISO */
  createdAt: string
  items: BoostPlanItem[]
  /** Itens de inicialização sugeridos para desativar (com motivo) */
  startupToDisable: BoostStartupSuggestion[]
  /** Observações PT-BR (ex.: 'passos manuais: ativar XMP na BIOS') */
  notes: string[]
  /** Data da análise usada para montar o plano (ISO) */
  snapshotAt?: string
  /** Alguma ação marcada só vale depois de reiniciar o Explorer (pesquisa do Iniciar) */
  explorerRestartHelps?: boolean
}

export interface BoostBatchRequest {
  actionIds: string[]
  startupIdsToDisable?: string[]
  /** Criar ponto de restauração antes (recomendado) */
  createRestorePoint?: boolean
  /** Reiniciar o Windows Explorer no final (a barra de tarefas some por 2 s; pastas abertas fecham) */
  restartExplorer?: boolean
}

export interface BoostBatchItemResult {
  id: string
  title: string
  ok: boolean
  message: string
  logId?: string
  requiresRestart?: boolean
  /** Tem "Desfazer" no Histórico */
  reversible?: boolean
  /** 'action' = otimização do catálogo; 'startup' = item de inicialização desativado */
  kind?: 'action' | 'startup'
  /** Não foi executado (ex.: o ponto de restauração falhou, UAC negado, já estava aplicado) */
  skipped?: boolean
  /** Aplicado só em parte (ok:true para haver "Desfazer"; a mensagem explica o que faltou) */
  partial?: boolean
}

export interface BoostBatchResult {
  results: BoostBatchItemResult[]
  restorePoint?: ActionResult
  /** Tudo que precisava de admin rodou com UM pedido de UAC */
  elevatedOnce?: boolean
  cancelled?: boolean
  /**
   * A permissão de administrador não chegou a valer (UAC sem resposta/expirado, prazo embutido...): tratado como
   * negado — nada foi aplicado nem registrado. Texto PT-BR com o motivo.
   */
  elevationError?: string
  /** Algum item aplicado só vale depois de reiniciar o PC */
  restartNeeded?: boolean
  explorerRestarted?: boolean
  notes?: string[]
}

/** Um servidor DNS no teste de velocidade. */
export interface DnsServerResult {
  /** Ex.: 'current:8.8.8.8', '1.1.1.1' */
  id: string
  address: string
  /** PT-BR (ex.: 'Cloudflare', 'Atual (Google)', 'Atual (provedor, IPv6)') */
  name: string
  /** Em uso hoje neste PC */
  current: boolean
  /** Mediana do tempo de resposta (ms) */
  medianMs?: number
  avgMs?: number
  /** Primeira rodada (respostas fora do cache do servidor) */
  coldMs?: number
  failures: number
  samples: number
  /** Ação do catálogo para passar a usar este servidor (só provedores públicos conhecidos) */
  actionId?: string
}

export interface DnsBenchmarkResult {
  /** ISO */
  testedAt: string
  domains: string[]
  rounds: number
  servers: DnsServerResult[]
  /** Adaptadores de rede ativos e o DNS configurado em cada um */
  adapters: { alias: string; description?: string; v4: string[]; v6: string[]; automaticV4: boolean; automaticV6: boolean }[]
  /** Servidor mais rápido do teste */
  bestId?: string
  recommendation?: { actionId: string; gainMs: number; gainPercent: number; text: string; strong: boolean }
  notes: string[]
  durationMs?: number
}

export interface PerformanceApi {
  /** Progresso em 'perf:progress'. */
  collect(): Promise<PerformanceSnapshot>
  getLastSnapshot(): Promise<PerformanceSnapshot | null>
  listActions(): Promise<OptimizationAction[]>
  applyAction(id: string): Promise<ActionResult>
  undo(logId: string): Promise<ActionResult>
  setStartupItem(id: string, enabled: boolean): Promise<ActionResult>
  createRestorePoint(description?: string): Promise<ActionResult>
  /** Medição antes/depois (leva ~10-20 s; progresso em 'perf:progress'). */
  measure(label?: string): Promise<SpeedMeasurement>
  /** Histórico de medições (mais recente primeiro). */
  getMeasurements(): Promise<SpeedMeasurement[]>
  /** Plano "Otimizar tudo" sob medida para este PC (usa o último snapshot; coleta se não houver). */
  getBoostPlan(): Promise<BoostPlan>
  /**
   * Aplica várias otimizações de uma vez: ponto de restauração opcional e UM único UAC para tudo que exige admin.
   * Cada item vai para o Histórico com seu Desfazer. Progresso em 'perf:progress'.
   */
  applyBatch(req: BoostBatchRequest): Promise<BoostBatchResult>
  /**
   * Desfaz vários itens do Histórico de uma vez (os que exigem admin com UM pedido de UAC).
   * Progresso em 'perf:progress'.
   */
  undoBatch(logIds: string[]): Promise<BoostBatchResult>
  /** Teste de velocidade de DNS (somente leitura; ~5-15 s). Progresso em 'perf:progress'. */
  dnsBenchmark(): Promise<DnsBenchmarkResult>
  getLastDnsBenchmark(): Promise<DnsBenchmarkResult | null>
}

export const PERFORMANCE_METHODS = [
  'collect',
  'getLastSnapshot',
  'listActions',
  'applyAction',
  'undo',
  'setStartupItem',
  'createRestorePoint',
  'measure',
  'getMeasurements',
  'getBoostPlan',
  'applyBatch',
  'undoBatch',
  'dnsBenchmark',
  'getLastDnsBenchmark'
] as const satisfies readonly (keyof PerformanceApi)[]
