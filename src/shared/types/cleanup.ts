// Domínio: Limpeza Inteligente (alvos conhecidos de lixo + exclusão segura de arquivos escolhidos).
import type { ActionResult, Risk, TaskProgress, Verdict } from './common'

export type CleanupKind =
  | 'userTemp'
  | 'systemTemp'
  | 'browserCache'
  | 'shaderCache'
  | 'appCache'
  | 'gameLauncherCache'
  | 'windowsUpdate'
  | 'deliveryOptimization'
  | 'crashDumps'
  | 'errorReports'
  | 'logs'
  | 'thumbnails'
  | 'recycleBin'
  | 'windowsOld'
  | 'installerLeftovers'
  | 'devCache'
  | 'downloadsInstallers'
  /** Busca extrema: componentes do Windows (Limpeza de Disco oficial, DISM, pontos de restauração, hibernação, índice) */
  | 'windowsComponents'
  /** Busca extrema: versões antigas de drivers no DriverStore */
  | 'driverStore'
  /** Busca extrema: gravações de jogos (NVIDIA ShadowPlay/DVR, Xbox Game Bar, Bandicam) */
  | 'gameRecordings'
  /** Busca extrema: discos virtuais grandes (WSL, Docker, BlueStacks, emuladores, VMs) */
  | 'virtualDisk'
  /** Busca extrema: caches de edição de vídeo/áudio (CapCut, Adobe, DaVinci...) */
  | 'mediaCache'
  | 'other'

/** Arquivo de exemplo de um alvo (ex.: instaladores antigos em Downloads), para o usuário conferir. */
export interface CleanupSampleFile {
  path: string
  bytes: number
  /** epoch ms */
  lastWrite: number
}

/** Ação manual (o app só orienta; quem faz é o Windows). Ex.: Windows.old pelas Configurações. */
export interface CleanupManualAction {
  /** Rótulo do botão (PT-BR) */
  label: string
  /** URI segura (ms-settings: ou https:) */
  url: string
  /** Passo a passo em PT-BR */
  steps?: string[]
  /** Em vez da URL, abre esta tela do Windows (system.openSpecial). Ex.: 'systemProtection' (pontos de restauração). */
  special?: 'recycleBin' | 'systemProtection' | 'storageSettings' | 'startupApps' | 'appsSettings' | 'taskManager' | 'diskCleanup'
  /** Em vez da URL, leva para uma página do app (ex.: 'performance' para desligar a hibernação). */
  page?: 'performance' | 'apps' | 'disk' | 'discover' | 'drivers' | 'repair'
}

/** Lixeira de uma unidade (do usuário atual). */
export interface RecycleBinDriveInfo {
  /** 'C:' */
  drive: string
  bytes: number
  items?: number
  /** Limite da Lixeira nesta unidade (Configurações da Lixeira: MaxCapacity). Sem valor = desconhecido. */
  maxBytes?: number
  /** A Lixeira está desligada nesta unidade ("Não mover arquivos para a Lixeira"): apagar aqui é definitivo. */
  disabled?: boolean
}

export interface RecycleBinInfo {
  bytes: number
  items: number
  perDrive: RecycleBinDriveInfo[]
}

export interface CleanupTarget {
  /** Estável entre execuções (ex.: 'chrome-cache-default'). */
  id: string
  kind: CleanupKind
  /** Título em PT-BR */
  title: string
  /** Explicação em PT-BR do que é e por que é (ou não) seguro */
  description: string
  /** Caminhos absolutos resolvidos que serão limpos */
  paths: string[]
  bytes: number
  files: number
  requiresAdmin: boolean
  verdict: Verdict
  risk: Risk
  /**
   * deleteContents: apaga o conteúdo das pastas (não a pasta raiz);
   * recycleBin: esvazia a Lixeira; command: executa comando oficial do Windows (DISM, cleanmgr etc.)
   */
  method: 'deleteContents' | 'recycleBin' | 'command'
  /** Só apaga arquivos mais antigos que N dias (ex.: temp > 1 dia). */
  olderThanDays?: number
  /** Programa que precisa estar fechado (ex.: 'chrome.exe'). */
  requiresClosed?: string[]
  /** Programas da lista acima que estão abertos agora. */
  blockedBy?: string[]
  selectedByDefault: boolean
  /**
   * Item da "Busca extrema" (pesado e mais avançado: DriverStore antigo, componentes do Windows, pontos de
   * restauração, discos virtuais, caches de edição de vídeo...). Só aparece com estimate({ extreme: true }).
   */
  extreme?: boolean
  note?: string
  /** Só arquivos cujo nome casa com um destes padrões (ex.: '*.exe', 'thumbcache_*.db'). */
  include?: string[]
  /** Profundidade máxima (0 = só os arquivos direto na pasta). Sem valor = todas as subpastas. */
  maxDepth?: number
  /** Envia para a Lixeira em vez de apagar de vez (reversível). */
  recycle?: boolean
  /** Não dá para medir sem administrador (bytes = 0 não significa vazio). */
  sizeUnknown?: boolean
  /** Medição parcial (pastas sem permissão de leitura ou tempo esgotado): o tamanho real pode ser maior. */
  approximate?: boolean
  /** Detalhamento (ex.: Lixeira por unidade). key: identificador interno (ex.: 'oem45.inf' no DriverStore). */
  breakdown?: { label: string; bytes: number; files?: number; key?: string }[]
  /** Maiores arquivos que seriam afetados (para alvos "Revisar" como Downloads). */
  sampleFiles?: CleanupSampleFile[]
  /** Alvo que o app não limpa sozinho: só orienta (ex.: Windows.old). Não é executado por run(). */
  manual?: CleanupManualAction
}

export interface CleanupEstimate {
  /** ISO */
  scannedAt: string
  targets: CleanupTarget[]
  totalBytes: number
  safeBytes: number
  /** Tempo da análise */
  durationMs?: number
  /** O app estava rodando como Administrador na análise */
  isAdmin?: boolean
  /** Avisos não fatais (PT-BR) */
  warnings?: string[]
}

export interface CleanupRunRequest {
  targetIds: string[]
}

export interface CleanupTargetResult {
  targetId: string
  title: string
  bytesFreed: number
  filesDeleted: number
  /** Arquivos em uso / sem permissão / protegidos */
  skipped: number
  errors: string[]
  /** ok = limpo; partial = parte ficou (em uso etc.); skipped = não executado (programa aberto, UAC negado...); failed = erro */
  status?: 'ok' | 'partial' | 'skipped' | 'failed'
  /** Os arquivos foram para a Lixeira (reversível) */
  recycled?: boolean
}

export interface CleanupRunReport {
  /** ISO */
  startedAt: string
  /** ISO */
  finishedAt: string
  results: CleanupTargetResult[]
  totalFreed: number
  logId?: string
  cancelled?: boolean
  /** O usuário negou a permissão de administrador (UAC) */
  adminDenied?: boolean
}

export interface DeleteFilesRequest {
  paths: string[]
  /** recycle = Lixeira (padrão, reversível); permanent = apagar de vez */
  mode: 'recycle' | 'permanent'
  reason?: string
}

/** Motivo estruturado de um item não apagado (a interface decide o que oferecer). */
export type SkipCode =
  /** Bloqueado pela proteção (sistema, programa instalado...) */
  | 'blocked'
  /** Em uso por algum programa */
  | 'inUse'
  /** Grande demais para a Lixeira: só dá para apagar de vez (confirmação forte) */
  | 'tooBigForRecycle'
  /** Relatório/varredura desatualizado: procure de novo */
  | 'stale'
  /** Apagar de vez só vale para itens listados numa análise do app */
  | 'notListed'
  /** Não existe mais */
  | 'missing'
  | 'error'

export interface DeleteFilesReport {
  deleted: string[]
  skipped: { path: string; reason: string; code?: SkipCode }[]
  bytesFreed: number
  logId?: string
}

/** Um grupo de duplicados a apagar: o backend revalida tudo antes (relatório pode estar desatualizado). */
export interface DeleteDuplicatesGroup {
  /** Hash do grupo (do relatório de duplicados) */
  hash: string
  /** Tamanho de cada cópia (bytes) */
  bytes: number
  /** Cópias que FICAM (pelo menos 1). lastWrite = epoch ms do relatório */
  keep: { path: string; lastWrite: number }[]
  /** Cópias a apagar */
  remove: { path: string; lastWrite: number }[]
}

export interface DeleteDuplicatesRequest {
  groups: DeleteDuplicatesGroup[]
  mode: 'recycle' | 'permanent'
}

/** Estado atual do módulo de limpeza (para a página retomar uma análise em andamento). */
export interface CleanupStatus {
  busy: 'estimate' | 'run' | 'delete' | null
  progress: TaskProgress | null
}

export interface GuardDecision {
  path: string
  allowed: boolean
  /** blocked = nunca; warn = permitido com aviso forte; ok = permitido */
  level: 'blocked' | 'warn' | 'ok'
  /** Motivo em PT-BR */
  reason: string
}

export interface CleanupApi {
  /**
   * Mede o tamanho de todos os alvos. Progresso em 'cleanup:progress'.
   * extreme: inclui também os itens da Busca extrema (CleanupTarget.extreme).
   */
  estimate(opts?: { extreme?: boolean }): Promise<CleanupEstimate>
  getLastEstimate(): Promise<CleanupEstimate | null>
  /** Executa a limpeza dos alvos escolhidos. Progresso em 'cleanup:progress'. */
  run(req: CleanupRunRequest): Promise<CleanupRunReport>
  cancel(): Promise<void>
  /** Apaga arquivos/pastas escolhidos pelo usuário (ex.: arquivos grandes, duplicados). Passa pelo guard. */
  deleteFiles(req: DeleteFilesRequest): Promise<DeleteFilesReport>
  /** Verifica se caminhos podem ser apagados (guard de segurança). */
  checkPaths(paths: string[]): Promise<GuardDecision[]>
  /**
   * Apaga cópias duplicadas revalidando cada grupo no disco: só apaga se pelo menos uma cópia 'keep' existir
   * (mesmo tamanho, não-link) e cada 'remove' ainda tiver o mesmo tamanho/data do relatório. Senão pula o grupo inteiro.
   * mode 'permanent': além disso confere o SHA-256 COMPLETO de cada cópia (keep e remove) contra `hash` (o SHA-256
   * do relatório de duplicados); 'recycle' compara só amostras (início/meio/fim), pois a Lixeira permite desfazer.
   */
  deleteDuplicates(req: DeleteDuplicatesRequest): Promise<DeleteFilesReport>
  /** Análise/limpeza em andamento (para retomar o progresso ao voltar para a página). */
  getStatus(): Promise<CleanupStatus>
  /** Cancela apenas uma exclusão de arquivos em andamento (deleteFiles/deleteDuplicates). */
  cancelDelete(): Promise<void>
  /** Tamanho atual da Lixeira do usuário (todas as unidades), com o limite de cada unidade quando conhecido. */
  getRecycleBinInfo(): Promise<RecycleBinInfo>
  /** Esvazia a Lixeira (todas as unidades ou só uma, ex.: 'E:'). Registra no Histórico. */
  emptyRecycleBin(drive?: string): Promise<ActionResult>
}

export const CLEANUP_METHODS = [
  'estimate',
  'getLastEstimate',
  'run',
  'cancel',
  'deleteFiles',
  'checkPaths',
  'deleteDuplicates',
  'getStatus',
  'cancelDelete',
  'getRecycleBinInfo',
  'emptyRecycleBin'
] as const satisfies readonly (keyof CleanupApi)[]

/** Nome amigável dos programas que precisam estar fechados (chave em minúsculas). */
export const CLEANUP_APP_NAMES: Record<string, string> = {
  'chrome.exe': 'Google Chrome',
  'msedge.exe': 'Microsoft Edge',
  'brave.exe': 'Brave',
  'opera.exe': 'Opera',
  'vivaldi.exe': 'Vivaldi',
  'firefox.exe': 'Firefox',
  'discord.exe': 'Discord',
  'discordptb.exe': 'Discord PTB',
  'discordcanary.exe': 'Discord Canary',
  'spotify.exe': 'Spotify',
  'ms-teams.exe': 'Microsoft Teams',
  'teams.exe': 'Microsoft Teams (clássico)',
  'slack.exe': 'Slack',
  'code.exe': 'VS Code',
  'steam.exe': 'Steam',
  'epicgameslauncher.exe': 'Epic Games Launcher',
  'eadesktop.exe': 'EA app',
  'battle.net.exe': 'Battle.net'
}

/** 'chrome.exe' -> 'Google Chrome' */
export function cleanupAppName(exe: string): string {
  return CLEANUP_APP_NAMES[exe.toLowerCase()] ?? exe.replace(/\.exe$/i, '')
}
