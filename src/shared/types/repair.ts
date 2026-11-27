// Domínio: Reparar Erros — erros REAIS do sistema (não "limpeza de registro", que não acelera e pode quebrar coisas).
// Verificação somente leitura; cada correção é confirmada, registrada no Histórico e, quando altera registro/
// configurações, guarda backup para Desfazer.
import type { ActionResult, Risk, Severity } from './common'

export type RepairCategory =
  /** Arquivos do Windows corrompidos (SFC/DISM) */
  | 'systemFiles'
  /** Erros no sistema de arquivos/disco, saúde do disco */
  | 'disk'
  /** Windows Update com falhas/travado */
  | 'windowsUpdate'
  /** Inicialização/tarefas/serviços/App Paths/fontes/atalhos apontando para coisas que não existem */
  | 'brokenEntries'
  /** Extensões do Explorer/menu de contexto quebradas (lentidão/travamentos no Explorer) */
  | 'shell'
  /** Telas azuis, desligamentos inesperados, travamentos de programas, erros de hardware (WHEA) */
  | 'crashes'
  /** DNS/Winsock/TCP-IP */
  | 'network'
  /** Antivírus do Windows (proteção, última verificação, ameaças) */
  | 'security'
  /** Relógio do sistema fora de sincronia */
  | 'time'
  /** Cache de ícones/miniaturas, Microsoft Store */
  | 'appearance'

/** Nomes PT-BR das categorias (para a interface e a IA). */
export const REPAIR_CATEGORY_LABELS: Record<RepairCategory, string> = {
  systemFiles: 'Arquivos do Windows',
  disk: 'Disco',
  windowsUpdate: 'Windows Update',
  brokenEntries: 'Entradas quebradas',
  shell: 'Explorer e menu de contexto',
  crashes: 'Travamentos e desligamentos',
  network: 'Internet e rede',
  security: 'Segurança',
  time: 'Relógio',
  appearance: 'Ícones e Microsoft Store'
}

export interface RepairFix {
  /** Estável (ex.: 'sfc-scannow', 'remove-broken-startup') */
  id: string
  /** PT-BR, verbo no infinitivo (ex.: 'Reparar arquivos do Windows') */
  label: string
  /** PT-BR: o que faz exatamente */
  description: string
  requiresAdmin: boolean
  requiresRestart?: boolean
  /** Demora (minutos) */
  longRunning?: boolean
  /** Dá para desfazer pelo Histórico */
  reversible: boolean
  risk: Risk
  /** Texto mostrado na confirmação (PT-BR) */
  confirmText: string
  /**
   * Só abre uma tela/ferramenta do Windows (Monitor de Confiabilidade, Segurança do Windows...): não altera nada,
   * não vai para o Histórico e não precisa de confirmação.
   */
  opensOnly?: boolean
  /** A correção aceita só alguns itens do problema (RepairFixRequest.itemIds). */
  perItem?: boolean
  /** Estimativa de duração em PT-BR (ex.: '10 a 30 minutos') */
  duration?: string
}

export interface RepairItem {
  /** Estável dentro do problema (ex.: caminho da chave de registro) */
  id: string
  /** PT-BR */
  label: string
  path?: string
  /** Detalhe (ex.: arquivo que não existe mais) */
  value?: string
  /** Observação curta PT-BR (ex.: 'precisa de administrador', 'Inicializar (todos os usuários)') */
  note?: string
  /** Mexer neste item exige administrador (UAC). */
  requiresAdmin?: boolean
  /**
   * Grupo para listas grandes (ex.: linhas do hosts agrupadas pelo site: 'adobe.com'). A interface agrupa/recolhe
   * por este texto; os suspeitos vêm num grupo próprio.
   */
  group?: string
}

export interface RepairIssue {
  /** Estável entre verificações (ex.: 'broken-startup') */
  id: string
  category: RepairCategory
  severity: Severity
  /** PT-BR */
  title: string
  /** PT-BR simples: o que é, que efeito tem, por que corrigir */
  detail: string
  evidence: string[]
  /** Itens afetados (ex.: cada entrada quebrada) — a correção pode receber só alguns */
  items?: RepairItem[]
  fixes: RepairFix[]
  /**
   * Não é um problema detectado: é uma ferramenta de reparo disponível (ex.: reconstruir o cache de ícones,
   * reparar arquivos do Windows sem evidência de defeito). A interface deve mostrá-la separada dos problemas.
   */
  tool?: boolean
  /** Passos manuais claros (PT-BR) quando não há correção automática honesta (ex.: desligamentos inesperados). */
  manualSteps?: string[]
  /** Id do RepairCheck que encontrou o problema. */
  checkId?: string
}

export interface RepairCheck {
  id: string
  category: RepairCategory
  /** PT-BR (ex.: 'Arquivos do Windows') */
  title: string
  status: 'ok' | 'issue' | 'skipped' | 'error'
  /** PT-BR (ex.: 'Precisa de administrador para verificar') */
  note?: string
  /** Só roda na verificação completa (com administrador). */
  deepOnly?: boolean
  /**
   * ISO: o app aplicou uma correção para o que esta verificação (só da completa) encontrou; o resultado novo só
   * aparece na próxima verificação completa.
   */
  fixedAt?: string
}

export interface RepairReport {
  /** ISO */
  scannedAt: string
  durationMs: number
  /** Verificação completa (inclui SFC/DISM somente leitura, que exigem admin e demoram) */
  deep: boolean
  issues: RepairIssue[]
  /** Tudo o que foi verificado (inclusive o que está OK), para a interface mostrar o alcance */
  checks: RepairCheck[]
  warnings: string[]
  /** O app estava como Administrador durante a verificação. */
  admin?: boolean
  /**
   * Verificação rápida feita depois de uma completa: os resultados que só a completa enxerga (SFC, DISM, discos)
   * foram mantidos da verificação completa desta data (ISO). Ausente = nada foi herdado.
   */
  deepCarriedAt?: string
  /** Verificações (RepairCheck.id) cujo resultado veio da verificação completa de `deepCarriedAt`. */
  carriedCheckIds?: string[]
  /** Contagens prontas para a interface/IA (problemas reais, sem as ferramentas). */
  summary?: {
    problems: number
    critical: number
    high: number
    medium: number
    low: number
    tools: number
    checksOk: number
    checksTotal: number
  }
}

export interface RepairFixRequest {
  issueId: string
  fixId: string
  /** Só alguns itens do problema (RepairItem.id); omitido = todos */
  itemIds?: string[]
}

export interface RepairApi {
  /** Verificação (somente leitura). Progresso em 'repair:progress'. */
  scan(opts?: { deep?: boolean }): Promise<RepairReport>
  getLastReport(): Promise<RepairReport | null>
  cancel(): Promise<void>
  /** Aplica uma correção (revalida antes; backup para desfazer quando altera registro/configuração). */
  fix(req: RepairFixRequest): Promise<ActionResult>
  /** Desfaz uma correção pelo id do Histórico. */
  undo(logId: string): Promise<ActionResult>
  /**
   * Aplica várias correções de uma vez (usado pelo "Otimizar tudo"): revalida cada uma e usa UM único pedido de
   * administrador para todas as que exigem admin. Cada correção vai para o Histórico com seu Desfazer.
   * Progresso em 'repair:progress' (task 'repair:fix').
   */
  fixBatch(reqs: RepairFixRequest[]): Promise<RepairBatchResult>
}

export interface RepairBatchResult {
  results: {
    issueId: string
    fixId: string
    title: string
    ok: boolean
    message: string
    logId?: string
    requiresRestart?: boolean
    /** Título do problema (PT-BR) */
    issueTitle?: string
    /** Tem Desfazer no Histórico (logId) */
    reversible?: boolean
    /** Não foi aplicada porque a permissão de administrador foi negada/expirou */
    cancelled?: boolean
    /** Itens do problema que a correção resolveu (RepairItem.id) */
    resolved?: string[]
  }[]
  /** Tudo que precisava de admin rodou com UM pedido de UAC */
  elevatedOnce?: boolean
  /** UAC negado/expirado: nada foi aplicado */
  cancelled?: boolean
}

export const REPAIR_METHODS = ['scan', 'getLastReport', 'cancel', 'fix', 'undo', 'fixBatch'] as const satisfies readonly (keyof RepairApi)[]
