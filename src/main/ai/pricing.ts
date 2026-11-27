// Preços (US$ por milhão de tokens) e cálculo de custo estimado de cada chamada.
import { AI_MODELS, type AiUsage } from '@shared/types/ai'

export interface Price {
  input: number
  output: number
  /** Leitura do cache (varia por modelo: 0,05× no Opus 5.5, 0,1× nos demais) */
  cacheRead: number
  /** Escrita no cache de 5 minutos (1,25× a entrada) */
  cacheWrite: number
}

export interface PriceCard {
  base: Price
  /** Tabela para prompts longos (ex.: Haiku 5.5 acima de 100 mil tokens de entrada) */
  long?: { aboveInputTokens: number; price: Price }
}

/** Escrita no cache (TTL de 5 minutos) custa 1,25× a entrada; leitura, 0,1× (exceto onde a tabela diz outra coisa). */
const CACHE_WRITE_FACTOR = 1.25
const CACHE_READ_FACTOR = 0.1
/** Busca na web: US$ 10 por 1.000 buscas. */
const WEB_SEARCH_USD = 10 / 1000

function price(input: number, output: number, cacheRead?: number): Price {
  return { input, output, cacheRead: cacheRead ?? input * CACHE_READ_FACTOR, cacheWrite: input * CACHE_WRITE_FACTOR }
}

/**
 * Tabela de preços (US$ / 1M tokens): os modelos do app (lista compartilhada AI_MODELS) e os que o fallback do
 * servidor pode usar depois de uma recusa (ex.: Claude Opus 5 / 4.8, que custam mais que o Opus 5.5).
 */
export const MODEL_PRICES: Readonly<Record<string, PriceCard>> = {
  ...Object.fromEntries(
    AI_MODELS.map((m) => [
      m.id,
      {
        base: price(m.inputUsdPerMTok, m.outputUsdPerMTok, m.cacheReadUsdPerMTok),
        long: m.longContext
          ? { aboveInputTokens: m.longContext.aboveInputTokens, price: price(m.longContext.inputUsdPerMTok, m.longContext.outputUsdPerMTok, m.longContext.cacheReadUsdPerMTok) }
          : undefined
      } satisfies PriceCard
    ])
  ),
  'claude-fable-5-1': { base: price(10, 50, 0.25) },
  'claude-fable-5': { base: price(10, 50, 1) },
  'claude-opus-5': { base: price(5, 25, 0.5) },
  'claude-opus-4-8': { base: price(5, 25, 0.5) },
  'claude-opus-4-7': { base: price(5, 25, 0.5) },
  'claude-opus-4-6': { base: price(5, 25, 0.5) },
  'claude-sonnet-5': { base: price(2, 10, 0.2) },
  'claude-sonnet-4-6': { base: price(3, 15, 0.3) },
  'claude-haiku-4-5': { base: price(1, 5, 0.1) }
}

/** Tabela de preço de um modelo. Desconhecido: o preço mais alto da família (melhor superestimar que subestimar). */
export function priceCardOf(model: string): PriceCard {
  const id = String(model || '')
    .trim()
    .toLowerCase()
    .replace(/^anthropic\./, '')
    .replace(/[-@]\d{8}$/, '')
  if (MODEL_PRICES[id]) return MODEL_PRICES[id]
  if (/fable|mythos/.test(id)) return MODEL_PRICES['claude-fable-5']
  if (/haiku/.test(id)) return MODEL_PRICES['claude-haiku-4-5']
  if (/sonnet/.test(id)) return MODEL_PRICES['claude-sonnet-4-6']
  return MODEL_PRICES['claude-opus-5']
}

/** Preço base (prompt curto) de um modelo. */
export function priceOf(model: string): Price {
  return priceCardOf(model).base
}

/** Uso bruto de UMA iteração (formato da API). */
export interface RawUsage {
  input_tokens?: number | null
  output_tokens?: number | null
  cache_creation_input_tokens?: number | null
  cache_read_input_tokens?: number | null
  server_tool_use?: { web_search_requests?: number | null } | null
  iterations?: Array<{ type: string; model?: string | null; input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number }> | null
}

const n = (v: number | null | undefined): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/** Custo de UMA amostragem: a tabela "longa" vale quando o prompt (entrada + cache) passa do limite do modelo. */
export function tokenCost(model: string, input: number, output: number, cacheWrite: number, cacheRead: number): number {
  const card = priceCardOf(model)
  const prompt = input + cacheWrite + cacheRead
  const p = card.long && prompt > card.long.aboveInputTokens ? card.long.price : card.base
  return (input * p.input + cacheWrite * p.cacheWrite + cacheRead * p.cacheRead + output * p.output) / 1_000_000
}

/**
 * Converte o uso da API em AiUsage. Quando há iterações por modelo (ex.: fallback do servidor para outro modelo
 * após recusa, ou várias amostragens num modelo com tabela de prompt longo), cada iteração é cobrada pelo preço
 * do seu próprio modelo e do seu próprio tamanho de prompt.
 */
export function usageFromApi(requestedModel: string, raw: RawUsage | null | undefined): AiUsage {
  const input = n(raw?.input_tokens)
  const output = n(raw?.output_tokens)
  const cacheWrite = n(raw?.cache_creation_input_tokens)
  const cacheRead = n(raw?.cache_read_input_tokens)
  const searches = n(raw?.server_tool_use?.web_search_requests)

  let cost = tokenCost(requestedModel, input, output, cacheWrite, cacheRead)
  const iters = (raw?.iterations ?? []).filter((it) => it && (it.type === 'message' || it.type === 'fallback_message'))
  const perIteration = iters.some((it) => it.type === 'fallback_message') || (iters.length > 1 && iters.some((it) => priceCardOf(it.model || requestedModel).long))
  if (perIteration) {
    cost = iters.reduce(
      (sum, it) =>
        sum +
        tokenCost(it.model || requestedModel, n(it.input_tokens), n(it.output_tokens), n(it.cache_creation_input_tokens), n(it.cache_read_input_tokens)),
      0
    )
  }
  cost += searches * WEB_SEARCH_USD

  return {
    model: requestedModel,
    inputTokens: input + cacheWrite + cacheRead,
    outputTokens: output,
    costUsd: Math.round(cost * 1e6) / 1e6,
    cacheReadTokens: cacheRead || undefined,
    webSearches: searches || undefined
  }
}

/** Soma vários AiUsage (ex.: continuação após pause_turn, nova tentativa). */
export function sumUsage(model: string, list: AiUsage[]): AiUsage {
  const total: AiUsage = { model, inputTokens: 0, outputTokens: 0, costUsd: 0 }
  let cacheRead = 0
  let searches = 0
  for (const u of list) {
    total.inputTokens += u.inputTokens
    total.outputTokens += u.outputTokens
    total.costUsd += u.costUsd
    cacheRead += u.cacheReadTokens ?? 0
    searches += u.webSearches ?? 0
  }
  total.costUsd = Math.round(total.costUsd * 1e6) / 1e6
  if (cacheRead) total.cacheReadTokens = cacheRead
  if (searches) total.webSearches = searches
  return total
}
