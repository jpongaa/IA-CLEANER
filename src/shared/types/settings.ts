// Configurações do app + funções gerais do sistema (admin, abrir links, histórico).
import type { ActionLogEntry } from './common'
import type { AiEffort, AiModel, AiProvider } from './ai'

export interface AppSettings {
  /** Há chave da API salva E utilizável neste usuário/PC (a chave nunca volta para a interface) */
  apiKeySet: boolean
  /**
   * Há uma chave salva, mas ela não pode ser usada aqui (criptografia do Windows indisponível, ou a chave foi
   * salva por outro usuário/PC). A interface deve pedir para colar a chave de novo. Ausente = sem problema.
   */
  apiKeyUnreadable?: boolean
  /** Motivo (PT-BR) quando apiKeyUnreadable. */
  apiKeyProblem?: string
  /** Qual IA usar. Cada provedor tem a sua chave salva (trocar de provedor não apaga as outras). */
  provider: AiProvider
  /** Modelo do Claude (provedor 'anthropic') */
  model: AiModel
  /** Modelo nos outros provedores (nome exato da API, ex.: 'gpt-5-mini') */
  providerModel: string
  /** Endereço da API do provedor 'custom' (https, ou http só em localhost: Ollama, LM Studio) */
  customBaseUrl: string
  effort: AiEffort
  /** Permite a IA pesquisar na web (versões de drivers etc.) */
  webSearch: boolean
  /** Troca C:\Users\<nome> por %USERPROFILE% antes de enviar à IA */
  anonymizePaths: boolean
  /** Modo padrão para arquivos escolhidos pelo usuário */
  deleteMode: 'recycle' | 'permanent'
  /** Pastas que a varredura deve ignorar */
  scanExclusions: string[]
}

export const DEFAULT_SETTINGS: AppSettings = {
  apiKeySet: false,
  provider: 'anthropic',
  model: 'claude-opus-5-5',
  providerModel: '',
  customBaseUrl: 'http://localhost:11434/v1',
  effort: 'medium',
  webSearch: true,
  anonymizePaths: true,
  deleteMode: 'recycle',
  scanExclusions: []
}

/** Campos que settings.update aceita (o resto é calculado pelo app). */
export type SettingsPatch = Partial<Omit<AppSettings, 'apiKeySet' | 'apiKeyUnreadable' | 'apiKeyProblem'>>

export interface SettingsApi {
  get(): Promise<AppSettings>
  /** Valida o patch: campo desconhecido ou valor inválido = erro (nada é gravado). */
  update(patch: SettingsPatch): Promise<AppSettings>
  /** null remove a chave */
  setApiKey(key: string | null): Promise<AppSettings>
}

export const SETTINGS_METHODS = ['get', 'update', 'setApiKey'] as const satisfies readonly (keyof SettingsApi)[]

export interface AppInfo {
  version: string
  isAdmin: boolean
  /** Helper nativo de varredura (.NET) disponível */
  scannerAvailable: boolean
  userDataPath: string
  osRelease: string
}

/** Telas do Windows que o app pode abrir (nenhuma altera nada sozinha). */
export type SpecialTarget =
  | 'recycleBin'
  | 'systemProtection'
  | 'storageSettings'
  | 'startupApps'
  | 'appsSettings'
  | 'taskManager'
  | 'diskCleanup'

export interface SystemApi {
  getAppInfo(): Promise<AppInfo>
  /** Reabre o app como Administrador (UAC). */
  relaunchAsAdmin(): Promise<{ ok: boolean; message: string }>
  /** Só http/https e ms-settings: */
  openExternal(url: string): Promise<void>
  /** Abre no Explorer selecionando o item */
  showInExplorer(path: string): Promise<void>
  getActionLog(limit?: number): Promise<ActionLogEntry[]>
  /** Diálogo "Escolher pasta". null = cancelado. */
  pickFolder(title?: string): Promise<string | null>
  /** Abre uma tela do Windows (Lixeira, Proteção do Sistema, Armazenamento...). */
  openSpecial(target: SpecialTarget): Promise<void>
}

export const SYSTEM_METHODS = [
  'getAppInfo',
  'relaunchAsAdmin',
  'openExternal',
  'showInExplorer',
  'getActionLog',
  'pickFolder',
  'openSpecial'
] as const satisfies readonly (keyof SystemApi)[]
