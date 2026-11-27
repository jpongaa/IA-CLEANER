// Domínio: Jogos & Programas instalados (tamanho, último uso, desinstalação oficial).
import type { DriveInfo } from './common'

export type Launcher =
  | 'steam'
  | 'epic'
  | 'ea'
  | 'ubisoft'
  | 'battlenet'
  | 'gog'
  | 'xbox'
  | 'riot'
  | 'rockstar'
  | 'other'

export interface UninstallMethod {
  /**
   * uri: abre URI do launcher (ex.: steam://uninstall/123)
   * command: executa o desinstalador oficial do programa (UninstallString)
   * settings: abre Configurações do Windows (Apps)
   * launcher: abre o launcher para o usuário desinstalar lá
   */
  kind: 'uri' | 'command' | 'settings' | 'launcher'
  value: string
  /** Rótulo PT-BR (ex.: 'Desinstalar pela Steam') */
  label: string
  requiresAdmin?: boolean
  /** Passo a passo PT-BR para o usuário (ex.: onde clicar dentro do launcher). */
  instructions?: string
}

/**
 * De onde veio o tamanho:
 *  launcher = informado pelo launcher (Steam SizeOnDisk, Epic InstallSize)
 *  registry = estimativa do desinstalador (EstimatedSize; pode estar desatualizada)
 *  scan     = árvore da última Análise de Discos
 *  measured = medido pelo app somando os arquivos da pasta
 *  unknown  = não foi possível saber (bytes = 0)
 */
export type SizeSource = 'launcher' | 'registry' | 'scan' | 'measured' | 'unknown'

export interface GameInfo {
  /** Ex.: 'steam:570', 'epic:Fortnite' */
  id: string
  launcher: Launcher
  name: string
  installPath: string
  /** 'C:' */
  drive: string
  /** Bytes ocupados hoje no disco (0 se a pasta não existe ou se o tamanho é desconhecido). */
  bytes: number
  /** epoch ms */
  lastPlayed?: number
  /** De onde veio o lastPlayed (ex.: 'Steam localconfig', 'arquivo .exe') */
  lastPlayedSource?: string
  /** lastPlayed é só uma aproximação (último acesso ao .exe / última modificação na pasta). */
  lastPlayedApprox?: boolean
  playtimeMinutes?: number
  /** O launcher registra partidas (Steam) e não tem nenhuma deste jogo neste PC. */
  neverPlayed?: boolean
  uninstall: UninstallMethod
  /** Pasta ainda existe no disco */
  exists: boolean
  bytesSource?: SizeSource
  /** Parte de `bytes` que é conteúdo da Oficina Steam (mods), removido junto na desinstalação. */
  workshopBytes?: number
  /** Tamanho que o launcher informa quando a pasta não existe mais (só informativo, NÃO ocupa espaço). */
  reportedBytes?: number
  /** epoch ms da última atualização feita pelo launcher (Steam LastUpdated). */
  lastUpdated?: number
  /** Executável principal (quando conhecido). */
  mainExe?: string
  /** Id do programa correspondente na lista de programas (quando existe entrada de desinstalação). */
  programId?: string
}

export interface ProgramInfo {
  /** Ex.: 'reg:HKLM:{GUID}' ou 'store:PackageFamilyName' */
  id: string
  name: string
  publisher?: string
  version?: string
  /** ISO date (YYYY-MM-DD) */
  installDate?: string
  installPath?: string
  bytes?: number
  /** epoch ms */
  lastUsed?: number
  lastUsedSource?: string
  /** lastUsed é só uma aproximação (último acesso ao .exe). */
  lastUsedApprox?: boolean
  /** Detectado como jogo (já listado em games) */
  isGame?: boolean
  /** Id do jogo correspondente (quando isGame). */
  gameId?: string
  uninstall?: UninstallMethod
  source: 'registry' | 'store'
  scope: 'machine' | 'user'
  bytesSource?: SizeSource
  /** Executável principal (DisplayIcon), quando conhecido. */
  mainExe?: string
}

export interface LauncherInfo {
  launcher: Launcher
  installed: boolean
  path?: string
  libraries?: string[]
}

/** Pasta que sobrou de um jogo já desinstalado (ex.: steamapps\common\X sem manifesto). */
export interface LeftoverFolder {
  /** 'leftover:steam:<caminho>' */
  id: string
  launcher: Launcher
  /** Nome da pasta */
  name: string
  path: string
  /** 'C:' */
  drive: string
  bytes?: number
  bytesSource?: SizeSource
  /** epoch ms da modificação mais recente encontrada */
  lastWrite?: number
  /** Explicação PT-BR de por que parece sobra */
  reason: string
}

/** Quais fontes de "último uso" puderam ser lidas neste PC (transparência para o usuário). */
export interface UsageSourcesStatus {
  /** UserAssist (HKCU): programas abertos pelo Explorer/Menu Iniciar */
  userAssist: boolean
  /** BAM (HKLM): exige Administrador */
  bam: boolean
  /** Prefetch (C:\Windows\Prefetch): exige Administrador */
  prefetch: boolean
  /** O NTFS está atualizando a data de último acesso dos arquivos */
  lastAccess: boolean | null
}

export interface AppsInventory {
  /** ISO */
  collectedAt: string
  games: GameInfo[]
  programs: ProgramInfo[]
  launchers: LauncherInfo[]
  /** Pastas que sobraram de jogos desinstalados (não estão em games). */
  leftovers?: LeftoverFolder[]
  /** Unidades no momento da coleta (tipo SSD/HDD, espaço livre). */
  drives?: DriveInfo[]
  usageSources?: UsageSourcesStatus
  /** Avisos PT-BR (fontes que não puderam ser lidas etc.) */
  warnings?: string[]
  /** Duração da coleta em ms */
  durationMs?: number
  /** Pastas de programas que ainda não foram medidas (rode getInventory com computeSizes: true). */
  pendingProgramSizes?: number
}

/**
 * Acompanhamento de uma desinstalação: o app abre o desinstalador oficial e fica conferindo se o item saiu de
 * verdade (registro/manifesto/pasta). Quando sai, o item some do inventário. Atualizações em 'apps:uninstall'.
 */
export type UninstallTrackStatus =
  /** Esperando o usuário confirmar no launcher/desinstalador */
  | 'waiting'
  /** Desinstalador rodando */
  | 'running'
  /** Saiu de verdade (sumiu do registro/launcher) */
  | 'removed'
  /** O desinstalador terminou, mas o item continua instalado (falhou, foi cancelado ou precisa de admin) */
  | 'stillInstalled'
  /** Não foi possível abrir o desinstalador */
  | 'failed'
  /** O usuário cancelou o UAC / dispensou o acompanhamento */
  | 'cancelled'
  /** Passou do tempo máximo de acompanhamento sem conclusão */
  | 'timeout'

export interface UninstallTrack {
  trackId: string
  /** GameInfo.id ou ProgramInfo.id */
  itemId: string
  name: string
  kind: 'game' | 'program'
  launcher?: Launcher
  status: UninstallTrackStatus
  /** epoch ms */
  startedAt: number
  /** epoch ms */
  finishedAt?: number
  /** PT-BR: o que está acontecendo / o que fazer */
  message: string
  /** O desinstalador foi aberto como Administrador */
  elevated?: boolean
  /** Espaço liberado (tamanho conhecido do item antes) */
  bytesFreed?: number
  /** Pastas que ficaram no disco depois de desinstalar (com tamanho), para oferecer limpeza das sobras */
  leftovers?: { path: string; bytes: number }[]
  /** Dá para tentar de novo como Administrador */
  canRetryElevated?: boolean
}

export interface AppsApi {
  /**
   * Progresso em 'apps:progress'.
   * computeSizes: true mede também pastas de programas sem tamanho; false não mede nada;
   * omitido mede só jogos e sobras sem tamanho informado (usa cache de medições recentes).
   * refresh: false devolve o inventário em memória se tiver menos de 2 minutos.
   */
  getInventory(opts?: { refresh?: boolean; computeSizes?: boolean }): Promise<AppsInventory>
  getLastInventory(): Promise<AppsInventory | null>
  /**
   * Inicia a desinstalação oficial (jogo ou programa) e começa o acompanhamento (trackId). Nunca apaga pastas.
   * elevated: força abrir o desinstalador como Administrador (usado em "Tentar de novo como administrador").
   */
  uninstall(id: string, opts?: { elevated?: boolean }): Promise<{ started: boolean; message: string; trackId?: string }>
  /** Abre a pasta de um jogo, programa ou sobra (id de GameInfo, ProgramInfo ou LeftoverFolder). */
  openLocation(id: string): Promise<void>
  /** Desinstalações acompanhadas (em andamento e recentes, das últimas 24 h). */
  getUninstallTracks(): Promise<UninstallTrack[]>
  /** Confere agora se o item saiu (ex.: depois que o usuário fechou o desinstalador). */
  recheckUninstall(trackId: string): Promise<UninstallTrack | null>
  /** Remove o acompanhamento da lista. */
  dismissUninstallTrack(trackId: string): Promise<void>
}

export const APPS_METHODS = [
  'getInventory',
  'getLastInventory',
  'uninstall',
  'openLocation',
  'getUninstallTracks',
  'recheckUninstall',
  'dismissUninstallTrack'
] as const satisfies readonly (keyof AppsApi)[]
