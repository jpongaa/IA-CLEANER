// Domínio: IA (Claude). A IA nunca executa nada sozinha: ela classifica e recomenda itens
// que JÁ existem nos dados coletados; a execução sempre passa pelo guard e pela confirmação do usuário.
import type { Impact, Risk, Verdict } from './common'
import type { FindingActionKind } from './discover'

export type AiModel = 'claude-opus-5-5' | 'claude-sonnet-5-5' | 'claude-haiku-5-5'
export type AiEffort = 'low' | 'medium' | 'high'

/**
 * Provedor da IA. 'anthropic' usa o SDK oficial (busca na web, saída estruturada garantida, preços conhecidos);
 * os outros falam o formato "compatível com OpenAI" (/chat/completions), que quase todas as IAs aceitam.
 */
export type AiProvider = 'anthropic' | 'openai' | 'gemini' | 'xai' | 'deepseek' | 'mistral' | 'openrouter' | 'custom'

export interface AiProviderInfo {
  id: AiProvider
  label: string
  /** Endereço da API compatível com OpenAI (vazio = definido pelo usuário / SDK próprio) */
  baseURL: string
  /** Onde criar a chave */
  keysUrl: string
  /** Variável de ambiente lida quando não há chave salva */
  envVar: string
  /** Exemplo de modelo (só dica; a lista real vem do botão "Carregar modelos") */
  modelHint: string
}

export const AI_PROVIDERS: readonly AiProviderInfo[] = [
  {
    id: 'anthropic',
    label: 'Anthropic (Claude)',
    baseURL: '',
    keysUrl: 'https://console.anthropic.com/settings/keys',
    envVar: 'ANTHROPIC_API_KEY',
    modelHint: ''
  },
  {
    id: 'openai',
    label: 'OpenAI (ChatGPT)',
    baseURL: 'https://api.openai.com/v1',
    keysUrl: 'https://platform.openai.com/api-keys',
    envVar: 'OPENAI_API_KEY',
    modelHint: 'ex.: gpt-5-mini'
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
    keysUrl: 'https://aistudio.google.com/apikey',
    envVar: 'GEMINI_API_KEY',
    modelHint: 'ex.: gemini-2.5-flash'
  },
  {
    id: 'xai',
    label: 'xAI (Grok)',
    baseURL: 'https://api.x.ai/v1',
    keysUrl: 'https://console.x.ai',
    envVar: 'XAI_API_KEY',
    modelHint: 'ex.: grok-4'
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    baseURL: 'https://api.deepseek.com/v1',
    keysUrl: 'https://platform.deepseek.com/api_keys',
    envVar: 'DEEPSEEK_API_KEY',
    modelHint: 'ex.: deepseek-chat'
  },
  {
    id: 'mistral',
    label: 'Mistral',
    baseURL: 'https://api.mistral.ai/v1',
    keysUrl: 'https://console.mistral.ai/api-keys',
    envVar: 'MISTRAL_API_KEY',
    modelHint: 'ex.: mistral-large-latest'
  },
  {
    id: 'openrouter',
    label: 'OpenRouter (centenas de modelos)',
    baseURL: 'https://openrouter.ai/api/v1',
    keysUrl: 'https://openrouter.ai/keys',
    envVar: 'OPENROUTER_API_KEY',
    modelHint: 'ex.: meta-llama/llama-4-maverick'
  },
  {
    id: 'custom',
    label: 'Outra / IA local (Ollama, LM Studio...)',
    baseURL: '',
    keysUrl: '',
    envVar: 'OPENAI_COMPAT_API_KEY',
    modelHint: 'ex.: llama3.1'
  }
]

export function providerInfo(id: string | undefined): AiProviderInfo {
  return AI_PROVIDERS.find((p) => p.id === id) ?? AI_PROVIDERS[0]
}

export interface AiModelInfo {
  id: AiModel
  /** Nome de exibição */
  label: string
  /** PT-BR curto (ex.: 'Recomendado: melhor análise') */
  tagline: string
  /** US$ por milhão de tokens de entrada */
  inputUsdPerMTok: number
  /** US$ por milhão de tokens de saída */
  outputUsdPerMTok: number
  recommended?: boolean
  /** US$ por milhão de tokens LIDOS do cache (padrão: 0,1× a entrada) */
  cacheReadUsdPerMTok?: number
  /** Tabela de preço para prompts longos (ex.: Haiku 5.5 acima de 100 mil tokens de entrada) */
  longContext?: {
    aboveInputTokens: number
    inputUsdPerMTok: number
    outputUsdPerMTok: number
    cacheReadUsdPerMTok?: number
  }
}

/** Modelos suportados (preços de tabela da API da Anthropic; escrita no cache = 1,25× a entrada). */
export const AI_MODELS: readonly AiModelInfo[] = [
  {
    id: 'claude-opus-5-5',
    label: 'Claude Opus 5.5',
    tagline: 'Recomendado: a análise mais cuidadosa',
    inputUsdPerMTok: 4,
    outputUsdPerMTok: 20,
    cacheReadUsdPerMTok: 0.2,
    recommended: true
  },
  {
    id: 'claude-sonnet-5-5',
    label: 'Claude Sonnet 5.5',
    tagline: 'Mais barato, ainda muito bom',
    inputUsdPerMTok: 2,
    outputUsdPerMTok: 10,
    cacheReadUsdPerMTok: 0.2
  },
  {
    id: 'claude-haiku-5-5',
    label: 'Claude Haiku 5.5',
    tagline: 'O mais rápido e econômico',
    inputUsdPerMTok: 0.1,
    outputUsdPerMTok: 0.5,
    cacheReadUsdPerMTok: 0.01,
    longContext: {
      aboveInputTokens: 100_000,
      inputUsdPerMTok: 0.5,
      outputUsdPerMTok: 2.5,
      cacheReadUsdPerMTok: 0.05
    }
  }
]

export interface AiStatus {
  configured: boolean
  /** settings = chave salva no app; env = variável de ambiente do provedor; none = sem credencial */
  source: 'settings' | 'env' | 'none'
  /** Id do modelo em uso (no Claude, um AiModel; nos outros provedores, o nome digitado/escolhido) */
  model: string
  provider: AiProvider
  /** A busca na web só existe no Claude: false nos outros provedores, mesmo com a opção ligada */
  webSearch: boolean
  /**
   * Há uma chave SALVA no app que não pode ser usada neste usuário/PC (motivo em PT-BR, vindo de
   * core/settings getApiKeyProblem). Ausente = sem problema. Pode vir com configured=true quando a IA
   * está usando ANTHROPIC_API_KEY no lugar da chave salva.
   */
  problem?: string
}

export interface AiUsage {
  model: string
  /** Tokens de entrada (inclui os lidos/gravados no cache) */
  inputTokens: number
  outputTokens: number
  /** Estimativa em dólares */
  costUsd: number
  /** Tokens de entrada lidos do cache (mais baratos) */
  cacheReadTokens?: number
  /** Buscas na web feitas pela IA */
  webSearches?: number
  /** Provedor sem tabela de preços no app (o custo real aparece no painel do provedor) */
  costUnknown?: boolean
}

/**
 * Referência a um item conhecido pelo app. Formato '<tipo>:<id>':
 *  - 'cleanup:<CleanupTarget.id>'
 *  - 'game:<GameInfo.id>'            (ex.: 'game:steam:570')
 *  - 'program:<ProgramInfo.id>'
 *  - 'file:<caminho absoluto>'       (arquivo presente em topFiles/oldLargeFiles/duplicados)
 *  - 'dir:<caminho absoluto>'        (pasta presente na árvore da varredura)
 *  - 'action:<OptimizationAction.id>'
 *  - 'startup:<StartupItem.id>'
 *  - 'driver:<DriverInfo.id>'
 *  - 'found:<Finding.id>'            (achado da Busca Profunda, ex.: 'found:leftover:c:\\program files\\foo').
 *                                     A ação sugerida é 'resolve_finding' + `findingAction` (uma das Finding.actions);
 *                                     o veredito/risco do app para o achado é o PISO (a IA nunca deixa o achado mais arriscado).
 *  - 'repair:<RepairIssue.id>'       (problema da ÚLTIMA verificação de Reparar Erros, ex.: 'repair:unexpected-shutdowns',
 *                                     'repair:app-crashes'). A ação sugerida é 'repair_issue': a interface leva à página
 *                                     Reparar Erros, onde o usuário escolhe e confirma a correção (ou segue os passos manuais).
 *                                     O validador só aceita problemas que ainda estão no último relatório; ferramentas
 *                                     (RepairIssue.tool) não são problemas e não viram refs.
 * Otimizações 'action:<id>' incluem ids parametrizados quando existem no snapshot/catálogo
 * (ex.: 'action:widgets-off', 'action:service-manual:AsusUpdateCheck', 'action:dns-set:cloudflare').
 * Refs que não existem nos dados enviados são descartadas pelo validador.
 */
export type ItemRef = string

export type AiActionKind =
  | 'clean_target'
  | 'uninstall_game'
  | 'uninstall_program'
  | 'move_game'
  | 'delete_files'
  | 'review_files'
  | 'apply_optimization'
  | 'disable_startup'
  | 'update_driver'
  /** Achado da Busca Profunda (refs 'found:'): executar UMA das ações do próprio achado (`findingAction`), na página Busca Profunda */
  | 'resolve_finding'
  /** Problema da verificação de erros (refs 'repair:'): abrir Reparar Erros e escolher/confirmar a correção lá */
  | 'repair_issue'
  | 'manual'
  | 'none'

export interface AiRecommendation {
  id: string
  /** PT-BR */
  title: string
  /** PT-BR: por que, e o que acontece se fizer */
  explanation: string
  verdict: Verdict
  risk: Risk
  /** 1 = mais importante */
  priority: 1 | 2 | 3 | 4 | 5
  estimatedBytes?: number
  action: AiActionKind
  targetRefs: ItemRef[]
  /**
   * Só com action 'resolve_finding': qual ação do achado o usuário deve usar (sempre uma das Finding.actions de TODOS
   * os achados citados; escolhida/validada pelo app). Quem executa é a página Busca Profunda, com confirmação.
   */
  findingAction?: FindingActionKind
}

export interface AiCriticalPoint {
  title: string
  detail: string
  bytes?: number
  refs?: ItemRef[]
}

export interface AiCleanupReport {
  /** ISO */
  generatedAt: string
  model: string
  /** PT-BR, 2-5 frases */
  summary: string
  criticalPoints: AiCriticalPoint[]
  recommendations: AiRecommendation[]
  /** Coisas que parecem lixo mas NÃO devem ser apagadas */
  keepWarnings: { title: string; detail: string; refs: ItemRef[] }[]
  totalRecoverableBytes: number
  usage: AiUsage
  /** Dados que estavam faltando quando a análise foi feita (PT-BR) */
  missingData?: string[]
}

export interface AiRootCause {
  title: string
  evidence: string
  impact: Impact
  /** OptimizationAction.id */
  actionIds: string[]
  manualSteps: string[]
}

export interface AiPerformanceReport {
  /** ISO */
  generatedAt: string
  model: string
  /** 0..100 */
  healthScore: number
  /** Frase curta: o principal motivo da lentidão */
  headline: string
  summary: string
  rootCauses: AiRootCause[]
  quickWins: AiRecommendation[]
  /** Sugestão de upgrade de hardware, se fizer sentido */
  upgradeAdvice?: string
  /** Coisas que o usuário achava que ajudavam mas não ajudam */
  myths?: string[]
  usage: AiUsage
  missingData?: string[]
}

export interface AiDriverItem {
  driverId: string
  deviceName: string
  status: 'up_to_date' | 'update_available' | 'unknown' | 'problem'
  installedVersion: string
  latestVersion?: string
  recommendation: string
  /** Apenas domínios oficiais de fabricantes */
  officialUrl?: string
  sources: string[]
}

export interface AiDriverReport {
  /** ISO */
  generatedAt: string
  model: string
  summary: string
  items: AiDriverItem[]
  usedWebSearch: boolean
  usage: AiUsage
  missingData?: string[]
}

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface AiChatDelta {
  streamId: string
  delta: string
}

export interface AiChatDone {
  streamId: string
  usage?: AiUsage
  error?: string
}

/** Um conjunto de dados coletados que a IA pode enxergar. */
export interface AiContextSource {
  /**
   * 'discover' = Busca Profunda; 'uninstalls' = desinstalações acompanhadas (só aparece quando há alguma);
   * 'repair' = verificação de erros (Reparar Erros); 'measurements' = medições antes/depois (Desempenho);
   * 'actions' = o que o app mudou nos últimos dias (Histórico; só aparece quando há alguma ação)
   */
  key:
    | 'scan'
    | 'duplicates'
    | 'cleanupEstimate'
    | 'apps'
    | 'performance'
    | 'hardware'
    | 'drivers'
    | 'discover'
    | 'uninstalls'
    | 'repair'
    | 'measurements'
    | 'actions'
  /** PT-BR (ex.: 'Varredura de discos') */
  label: string
  available: boolean
  /** ISO da coleta */
  collectedAt?: string
  /** PT-BR curto (ex.: '3 unidades · 1,2 TB') */
  detail?: string
  /** Página do app onde o dado é coletado */
  page: 'disk' | 'cleanup' | 'apps' | 'performance' | 'hardware' | 'drivers' | 'discover' | 'repair' | 'history'
}

export interface AiContextInfo {
  sources: AiContextSource[]
  /** Estimativa de tokens do resumo do PC enviado no chat */
  chatContextTokens: number
  anonymizePaths: boolean
}

export interface AiReports {
  cleanup?: AiCleanupReport
  performance?: AiPerformanceReport
  drivers?: AiDriverReport
}

/** Veredito da IA para um item da lista "Tudo que dá para apagar". */
export type ItemVerdict = 'apagar' | 'manter' | 'desconhecido'

/** Um item da lista "Tudo que dá para apagar" enviado para a IA explicar. */
export interface ExplainItemInput {
  /** Id curto da lista (a IA devolve o mesmo) */
  id: string
  title: string
  paths: string[]
  bytes: number
  /** Ex.: 'Limpeza', 'Busca Profunda', 'Arquivo grande' */
  source: string
  /** Classificação das regras do app (a IA nunca pode ser menos cautelosa que 'keep') */
  appVerdict: Verdict
  detail?: string
}

export interface AiItemExplanation {
  id: string
  verdict: ItemVerdict
  /** O que é (PT-BR, curto) */
  whatIsIt: string
  /** Por que apagar ou não (PT-BR, 1 a 2 frases) */
  explanation: string
}

export interface AiItemsReport {
  /** ISO */
  generatedAt: string
  model: string
  items: AiItemExplanation[]
  usedWebSearch: boolean
  usage: AiUsage
}

export interface AiApi {
  /** Explica item a item (pode apagar / melhor não / não sei), pesquisando na web o que não conhecer. Progresso em 'ai:progress'. */
  explainItems(items: ExplainItemInput[]): Promise<AiItemsReport>
  getLastExplanations(): Promise<AiItemsReport | null>
  getStatus(): Promise<AiStatus>
  testConnection(): Promise<{ ok: boolean; message: string }>
  /** Modelos disponíveis no provedor escolhido (não gasta tokens). Vazio no Claude (a lista é fixa). */
  listModels(): Promise<string[]>
  /** Usa os últimos dados de disco/limpeza/apps já coletados. Progresso em 'ai:progress'. */
  analyzeCleanup(): Promise<AiCleanupReport>
  /** Usa o último snapshot de desempenho + hardware. */
  diagnosePerformance(): Promise<AiPerformanceReport>
  /** Usa o último inventário de drivers; pode usar busca na web se habilitado. */
  adviseDrivers(): Promise<AiDriverReport>
  /** Streaming: 'ai:chatDelta' e 'ai:chatDone'. */
  chat(messages: ChatMessage[]): Promise<{ streamId: string }>
  cancelChat(streamId: string): Promise<void>
  getLastReports(): Promise<AiReports>
  /** Soma de custo estimado desde a instalação */
  getUsageTotals(): Promise<{
    inputTokens: number
    outputTokens: number
    costUsd: number
    calls: number
  }>
  /** Quais dados a IA enxerga agora (para a interface explicar ao usuário) */
  getContextInfo(): Promise<AiContextInfo>
}

export const AI_METHODS = [
  'explainItems',
  'getLastExplanations',
  'getStatus',
  'testConnection',
  'listModels',
  'analyzeCleanup',
  'diagnosePerformance',
  'adviseDrivers',
  'chat',
  'cancelChat',
  'getLastReports',
  'getUsageTotals',
  'getContextInfo'
] as const satisfies readonly (keyof AiApi)[]
