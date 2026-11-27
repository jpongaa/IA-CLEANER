// Cliente da API da Anthropic: credenciais, opções por modelo e mensagens de erro em PT-BR.
import Anthropic from '@anthropic-ai/sdk'
import type { BetaWebSearchTool20250305, BetaWebSearchTool20260209 } from '@anthropic-ai/sdk/resources/beta/messages/messages'
import { AI_MODELS, type AiEffort, type AiModel } from '@shared/types/ai'
import type { AppSettings } from '@shared/types/settings'
import { OFFICIAL_DRIVER_DOMAINS as SHARED_OFFICIAL_DOMAINS, isOfficialDriverUrl } from '@shared/types/drivers'
import { getApiKey, getApiKeyProblem, getSettings } from '../core/settings'

/**
 * Erro "amigável": a mensagem já está pronta para o usuário (PT-BR).
 * O `name` fica o padrão ('Error'): o Electron serializa a rejeição do IPC como "Error: <mensagem>" e a interface
 * já remove esse prefixo (com name='AiError' o usuário via "AiError: ..."). Identifique pelo `instanceof`/`code`.
 */
export class AiError extends Error {
  constructor(
    message: string,
    public readonly code: 'no_key' | 'auth' | 'permission' | 'model' | 'rate' | 'network' | 'server' | 'refusal' | 'truncated' | 'format' | 'data' | 'cancelled' | 'other' = 'other'
  ) {
    super(message)
  }
}

type ClientOptions = NonNullable<ConstructorParameters<typeof Anthropic>[0]>
export type AiFetch = NonNullable<ClientOptions['fetch']>

const API_BASE_URL = 'https://api.anthropic.com'
/** Variáveis que o SDK leria do ambiente e que poderiam mandar a chave do app a outro host ou com outro token. */
const IGNORED_ENV = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_CUSTOM_HEADERS'] as const

let transport: { baseURL: string; fetch?: AiFetch } = { baseURL: API_BASE_URL }

/**
 * Transporte de rede da IA, definido pelo código (NUNCA por variáveis de ambiente):
 *  - no app, o main do Electron injeta `net.fetch` (usa o proxy e os certificados do Windows);
 *  - nos testes, um servidor falso em 127.0.0.1.
 * Só aceita a API oficial (https://api.anthropic.com) ou um endereço local (loopback).
 */
export function setAiTransport(t: { fetch?: AiFetch | null; baseURL?: string | null }): void {
  let baseURL = API_BASE_URL
  if (t.baseURL) {
    const u = new URL(t.baseURL)
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname.toLowerCase())
    const official = u.protocol === 'https:' && u.hostname.toLowerCase() === 'api.anthropic.com'
    if (!official && !(loopback && (u.protocol === 'http:' || u.protocol === 'https:'))) throw new Error(`Endereço da API não permitido: ${t.baseURL}`)
    baseURL = t.baseURL.replace(/\/+$/, '')
  }
  transport = { baseURL, fetch: t.fetch ?? undefined }
}

/** Cria o cliente sem herdar ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_CUSTOM_HEADERS do ambiente. */
export function createAnthropicClient(apiKey: string): Anthropic {
  // O SDK lê essas variáveis SÓ no construtor (síncrono): escondê-las durante a criação basta e não afeta o resto do app.
  const saved = new Map<string, string>()
  for (const k of IGNORED_ENV) {
    const v = process.env[k]
    if (v !== undefined) {
      saved.set(k, v)
      delete process.env[k]
    }
  }
  try {
    return new Anthropic({
      apiKey,
      authToken: null,
      baseURL: transport.baseURL,
      ...(transport.fetch ? { fetch: transport.fetch } : {}),
      maxRetries: 2,
      timeout: 10 * 60_000
    })
  } finally {
    for (const [k, v] of saved) process.env[k] = v
  }
}

export const NO_KEY_MESSAGE = 'Configure sua chave da API em Configurações para usar a IA.'

/**
 * Mensagem "sem chave" com o motivo quando há uma chave salva que não pode ser lida neste PC.
 * Sempre começa com NO_KEY_MESSAGE (a interface reconhece o erro por esse início).
 */
export function noKeyMessage(problem?: string | null): string {
  return problem ? `${NO_KEY_MESSAGE} ${problem}` : NO_KEY_MESSAGE
}

export const MODEL_LABELS = Object.fromEntries(AI_MODELS.map((m) => [m.id, m.label])) as Record<AiModel, string>

const VALID_MODELS = new Set<string>(Object.keys(MODEL_LABELS))
const VALID_EFFORTS = new Set<string>(['low', 'medium', 'high'])

export interface AiSetup {
  client: Anthropic
  model: AiModel
  effort: AiEffort
  settings: AppSettings
  keySource: 'settings' | 'env'
}

/** Lê configurações + chave. Lança AiError('no_key') se não houver credencial. */
export async function getAiSetup(): Promise<AiSetup> {
  const settings = await getSettings()
  const cred = await getApiKey()
  if (!cred) throw new AiError(noKeyMessage(await getApiKeyProblem().catch(() => null)), 'no_key')
  const model = (VALID_MODELS.has(settings.model) ? settings.model : 'claude-opus-5-5') as AiModel
  const effort = (VALID_EFFORTS.has(settings.effort) ? settings.effort : 'medium') as AiEffort
  const client = createAnthropicClient(cred.key)
  return { client, model, effort, settings, keySource: cred.source }
}

/**
 * Fallback do servidor em caso de recusa (beta 'server-side-fallback-2026-07-01' + fallbacks: 'default').
 * Só para Opus/Sonnet; o Haiku não tem fallback do servidor.
 */
export function fallbackParams(model: AiModel): { betas?: string[]; fallbacks?: 'default' } {
  if (model === 'claude-haiku-5-5') return {}
  return { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }
}

/**
 * A API recusou (400) um recurso opcional (fallback beta, cache automático)? Nesse caso vale tentar
 * de novo sem os extras, em vez de falhar a análise inteira.
 */
export function isOptionalFeatureRejection(e: unknown): boolean {
  return e instanceof Anthropic.BadRequestError && /fallback|beta|cache_control/i.test(String(e.message ?? ''))
}

/** Remove os parâmetros opcionais (fallbacks/betas/cache_control) de uma requisição. */
export function withoutOptionalFeatures<T extends object>(params: T): T {
  const { betas: _b, fallbacks: _f, cache_control: _c, ...rest } = params as T & { betas?: unknown; fallbacks?: unknown; cache_control?: unknown }
  return rest as T
}

/** Domínios oficiais permitidos na busca de drivers (mesma lista da página Drivers). */
export const OFFICIAL_DRIVER_DOMAINS: readonly string[] = SHARED_OFFICIAL_DOMAINS

/** https de um domínio oficial (ex.: www.amd.com, drivers.amd.com) — mesma regra da página Drivers. */
export function isOfficialUrl(url: string): boolean {
  return /^https:/i.test(url) && isOfficialDriverUrl(url)
}

/** Ferramenta de busca na web conforme o modelo (a versão 20260209 não existe no Haiku). */
/** officialOnly: só sites de fabricantes (drivers); false = web aberta (descobrir o que é uma pasta/programa). */
export function webSearchTool(model: AiModel, officialOnly = true): BetaWebSearchTool20260209 | BetaWebSearchTool20250305 {
  // allowed_domains já cobre subdomínios: envia só os domínios "raiz" (ex.: catalog.update.microsoft.com ⊂ microsoft.com).
  const domains = OFFICIAL_DRIVER_DOMAINS.filter((d) => !OFFICIAL_DRIVER_DOMAINS.some((o) => o !== d && d.endsWith('.' + o)))
  const limits = officialOnly ? { max_uses: 8, allowed_domains: domains } : { max_uses: 12 }
  if (model === 'claude-haiku-5-5') return { type: 'web_search_20250305', name: 'web_search', ...limits }
  return { type: 'web_search_20260209', name: 'web_search', ...limits }
}

/** Converte qualquer erro da API/rede numa mensagem clara em PT-BR. */
export function friendlyError(e: unknown, model?: string): AiError {
  if (e instanceof AiError) return e
  if (e instanceof Anthropic.APIUserAbortError) return new AiError('Operação cancelada.', 'cancelled')
  if (e instanceof Anthropic.AuthenticationError) {
    return new AiError('Chave da API inválida: a Anthropic recusou a chave. Confira se ela foi copiada inteira (começa com "sk-ant-") e se não foi revogada no Console.', 'auth')
  }
  if (e instanceof Anthropic.PermissionDeniedError) {
    return new AiError('A chave não tem permissão para usar este recurso/modelo. Verifique a conta e o workspace no Console da Anthropic.', 'permission')
  }
  if (e instanceof Anthropic.NotFoundError) {
    const label = model && model in MODEL_LABELS ? MODEL_LABELS[model as AiModel] : (model ?? 'escolhido')
    return new AiError(`O modelo ${label} não está disponível para esta chave. Escolha outro modelo em Configurações.`, 'model')
  }
  if (e instanceof Anthropic.RateLimitError) {
    return new AiError('Limite de uso da API atingido (muitas requisições ou créditos insuficientes). Aguarde um pouco e tente de novo.', 'rate')
  }
  if (e instanceof Anthropic.APIConnectionTimeoutError) {
    return new AiError('A IA demorou demais para responder. Tente de novo (ou use um esforço menor em Configurações).', 'network')
  }
  if (e instanceof Anthropic.APIConnectionError) {
    return new AiError('Sem conexão com a API da Anthropic. Verifique sua internet, proxy ou firewall.', 'network')
  }
  if (e instanceof Anthropic.BadRequestError) {
    const msg = String(e.message || '')
    if (/credit|billing|balance/i.test(msg)) {
      return new AiError('Sua conta da Anthropic está sem créditos. Adicione créditos no Console (Plans & Billing).', 'rate')
    }
    return new AiError(`A API recusou a requisição (400). Detalhe: ${msg.slice(0, 300)}`, 'other')
  }
  if (e instanceof Anthropic.InternalServerError) {
    return new AiError('Os servidores da Anthropic estão instáveis ou sobrecarregados no momento. Tente de novo em alguns minutos.', 'server')
  }
  if (e instanceof Anthropic.APIError) {
    const status = typeof e.status === 'number' ? ` (${e.status})` : ''
    if (e.status === 529) return new AiError('A API da Anthropic está sobrecarregada agora. Tente de novo em alguns minutos.', 'server')
    return new AiError(`Erro da API da Anthropic${status}: ${String(e.message || '').slice(0, 300)}`, 'server')
  }
  const msg = e instanceof Error ? e.message : String(e)
  return new AiError(`Erro inesperado ao falar com a IA: ${msg.slice(0, 300)}`, 'other')
}

/** Mensagem para stop_reason 'refusal'. */
export function refusalMessage(category?: string | null): string {
  const base = 'A IA recusou esta solicitação por política de segurança'
  return `${base}${category ? ` (categoria: ${category})` : ''}. Isso às vezes acontece por engano com nomes de arquivos/programas; tente de novo ou use outro modelo em Configurações.`
}

export const TRUNCATED_MESSAGE =
  'A resposta da IA ficou longa demais e foi cortada antes do fim. Tente de novo; se persistir, escolha o esforço "Baixo" em Configurações.'
