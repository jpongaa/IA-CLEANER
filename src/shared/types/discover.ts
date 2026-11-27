// Domínio: Busca Profunda ("Achados") — o que ficou perdido no PC: instaladores e repacks baixados, zips já extraídos,
// jogos fora dos launchers (Hydra, repacks, portáteis), sobras de programas desinstalados, desinstaladores quebrados,
// programas sem desinstalador e programas indesejados conhecidos. Somente leitura na busca; toda ação é confirmada.
import type { ActionResult, Risk, Verdict } from './common'
import type { DeleteFilesReport } from './cleanup'

export type FindingKind =
  /** Instalador baixado (setup .exe/.msi/.msix/.appx) em Downloads/Área de Trabalho/pastas de download */
  | 'downloadedInstaller'
  /** Repack/instalador de jogo (setup.exe + .bin, FitGirl/DODI/ElAmigos...) ou download do Hydra */
  | 'gameRepack'
  /** Arquivo compactado (.zip/.rar/.7z) cuja pasta extraída já está ao lado (cópia dupla) */
  | 'archiveExtracted'
  /** Imagem de disco (.iso/.img) */
  | 'diskImage'
  /** Jogo instalado fora dos launchers conhecidos (portátil/repack), com ou sem desinstalador */
  | 'orphanGame'
  /** Launcher alternativo (Hydra, Playnite, itch.io, Heroic...) e o que ele baixou/instalou */
  | 'altLauncher'
  /** Pasta que sobrou de programa/jogo já desinstalado (Program Files, ProgramData, AppData...) */
  | 'leftoverFolder'
  /** Programa listado no Windows cujo desinstalador não existe mais */
  | 'brokenUninstall'
  /** Programa rodando/abrindo com o Windows sem desinstalador registrado */
  | 'noUninstaller'
  /** Programa indesejado conhecido (adware, "otimizadores", barras, navegadores intrusivos) */
  | 'unwanted'

export type FindingActionKind =
  /** Mover os caminhos para a Lixeira (arquivos/pastas do usuário) */
  | 'recycle'
  /** Apagar sobras de programa desinstalado (revalida que ninguém usa; pode pedir admin) */
  | 'deleteLeftovers'
  /** Abrir o desinstalador oficial (registro, unins000.exe do repack, launcher) */
  | 'runUninstaller'
  /** Remover à força um programa sem desinstalador que funcione (avançado; pede admin; Lixeira + backup do registro) */
  | 'forceRemove'
  /** Apagar só a entrada quebrada da lista de programas do Windows (com backup .reg) */
  | 'removeBrokenEntry'
  /** Tirar da inicialização do Windows */
  | 'disableStartup'
  | 'openFolder'
  /** Abrir Configurações do Windows / Segurança do Windows */
  | 'openSettings'
  | 'openLauncher'
  /** Abrir página oficial com instruções */
  | 'learnMore'

export interface FindingAction {
  kind: FindingActionKind
  /** PT-BR */
  label: string
  requiresAdmin?: boolean
  /** Ação perigosa: a interface exige digitar uma palavra para confirmar */
  dangerous?: boolean
  /** Texto exato do que será feito, mostrado na confirmação (PT-BR) */
  confirmText?: string
  /** Palavra que o usuário precisa digitar (ações perigosas). Hoje sempre 'REMOVER'. */
  confirmWord?: string
  /** Endereço/arquivo que será aberto (learnMore/openSettings/runUninstaller), só para mostrar */
  target?: string
}

/** Sub-item de um achado (ex.: jogos baixados pelo Hydra, partes de um zip dividido, arquivos de um repack). */
export interface FindingItem {
  /** PT-BR */
  label: string
  path?: string
  bytes?: number
  /** O item ainda existe no disco */
  exists?: boolean
  /** PT-BR curto (ex.: 'jogado há 3 meses', 'baixado, não instalado') */
  note?: string
  /** epoch ms */
  lastUsed?: number
}

/**
 * Dados internos que o backend usa para revalidar/executar ações (a interface pode ignorar).
 * act() só confia nestes dados porque eles vêm do último relatório salvo pelo próprio backend, e mesmo assim
 * revalida tudo no disco/registro antes de agir.
 */
export interface FindingMeta {
  /** Entrada de desinstalação relacionada */
  reg?: { hive: 'HKLM' | 'HKLM32' | 'HKCU' | 'HKCU32'; key: string }
  /** Desinstalador próprio (unins000.exe do repack, Uninstall X.exe do launcher) */
  uninstallerExe?: string
  /** Executável do launcher (openLauncher) */
  launcherExe?: string
  /** Itens de inicialização (ids no formato de performance/startup) que apontam para a pasta */
  startupIds?: string[]
  /** Tarefas agendadas que apontam para a pasta */
  tasks?: { path: string; name: string }[]
  /** URL de learnMore (https) */
  url?: string
  /** URI de openSettings (ms-settings: / windowsdefender:) */
  settingsUri?: string
  /** Pasta principal do achado (forceRemove/deleteLeftovers/openFolder) */
  folder?: string
  /** O Hydra ainda está compartilhando (seeding) este download */
  seeding?: boolean
}

export interface Finding {
  /** Estável entre buscas (ex.: 'leftover:c:\\program files\\foo') */
  id: string
  kind: FindingKind
  /** PT-BR curto (ex.: 'The Sims 4 [FitGirl Repack] — instalador baixado') */
  title: string
  /** PT-BR: o que é, por que achamos que pode sair e o que acontece se apagar */
  detail: string
  paths: string[]
  bytes: number
  /** epoch ms */
  lastModified?: number
  /** epoch ms */
  lastUsed?: number
  verdict: Verdict
  risk: Risk
  /**
   * Relação com o que está instalado: instalador de algo 'installed' (pode apagar o instalador),
   * 'notInstalled' (nunca instalado ou já desinstalado), 'unknown'.
   */
  installState?: 'installed' | 'notInstalled' | 'unknown'
  /** GameInfo.id / ProgramInfo.id relacionado, se houver */
  relatedId?: string
  /** Origem (ex.: 'Downloads', 'Hydra Launcher', 'Program Files') */
  source?: string
  /** Evidências em PT-BR (por que classificamos assim) */
  evidence: string[]
  actions: FindingAction[]
  /** Aviso forte em PT-BR (ex.: 'pode conter seus saves') */
  warning?: string
  /** Sub-itens (jogos do Hydra, partes de um zip dividido...) */
  items?: FindingItem[]
  /** Editora/fabricante, quando conhecida */
  publisher?: string
  /** Tamanho medido parcialmente (pasta grande demais ou sem permissão): o real pode ser maior */
  approximate?: boolean
  /** Só aparece na busca completa (deep) */
  deepOnly?: boolean
  /** Uso interno do backend (revalidação/execução das ações) */
  meta?: FindingMeta
}

export interface DiscoverTotals {
  count: number
  bytes: number
}

export interface DiscoverReport {
  /** ISO */
  scannedAt: string
  durationMs: number
  findings: Finding[]
  totals: Partial<Record<FindingKind, DiscoverTotals>>
  /** Pastas varridas (para a interface mostrar o alcance) */
  locationsScanned: string[]
  /** Avisos PT-BR (sem permissão, fontes não lidas...) */
  warnings: string[]
  cancelled?: boolean
  /** Foi a busca completa (deep) */
  deep?: boolean
  /** O app estava como Administrador (algumas pastas só são lidas assim) */
  isAdmin?: boolean
}

/** Resultado da pré-verificação de sobras (checkLeftovers). */
export interface LeftoverCheck {
  path: string
  allowed: boolean
  /** PT-BR */
  reason: string
  /** Precisa de administrador (Arquivos de Programas / ProgramData) */
  requiresAdmin?: boolean
  bytes?: number
}

export interface DiscoverActRequest {
  findingId: string
  action: FindingActionKind
  /** Para ações perigosas: a palavra digitada pelo usuário na confirmação */
  confirmWord?: string
  /** Só alguns caminhos do achado (ex.: escolher quais arquivos de Downloads apagar) */
  paths?: string[]
  /** Tentar de novo como Administrador (ex.: depois de "acesso negado") */
  elevated?: boolean
}

export interface DiscoverApi {
  /** Busca completa (somente leitura). Progresso em 'discover:progress'. */
  scan(opts?: { deep?: boolean }): Promise<DiscoverReport>
  getLastReport(): Promise<DiscoverReport | null>
  cancel(): Promise<void>
  /** Executa uma ação de um achado (sempre revalida no disco antes). Registra no Histórico. */
  act(req: DiscoverActRequest): Promise<ActionResult>
  /**
   * Apaga pastas que sobraram de programas desinstalados (ex.: as sobras mostradas depois de uma desinstalação).
   * Revalida que nenhuma é usada por programa instalado/serviço/processo; vai para a Lixeira; pode pedir admin.
   */
  deleteLeftovers(paths: string[]): Promise<DeleteFilesReport>
  /** Confere (sem apagar nada) se cada pasta pode ser apagada como sobra e quanto ocupa. */
  checkLeftovers(paths: string[]): Promise<LeftoverCheck[]>
  /**
   * Desfaz uma ação da Busca Profunda registrada no Histórico, quando possível (hoje: devolve ao registro do
   * Windows a entrada de desinstalação apagada, a partir do backup .reg — undo.kind 'reg.import').
   */
  undo(logId: string): Promise<ActionResult>
}

export const DISCOVER_METHODS = ['scan', 'getLastReport', 'cancel', 'act', 'deleteLeftovers', 'checkLeftovers', 'undo'] as const satisfies readonly (keyof DiscoverApi)[]
