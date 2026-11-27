// Provedores "compatíveis com OpenAI" (POST /chat/completions): OpenAI, Gemini, Grok, DeepSeek, Mistral, OpenRouter e
// IA local (Ollama, LM Studio). Sem SDK extra: fetch puro, pelo mesmo transporte da IA (proxy do Windows).
// O que só o Claude tem (busca na web pelo servidor, preços conhecidos) fica desligado aqui.
import type { AiUsage } from '@shared/types/ai'
import { AiError, TRUNCATED_MESSAGE, aiFetch, type AiSetup } from './client'

export interface CompatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

type Format = 'json_schema' | 'json_object' | 'none'
const FORMATS: Format[] = ['json_schema', 'json_object', 'none']
/** Formato de JSON que cada provedor+modelo aceitou (evita repetir o erro 400 a cada chamada). */
const formatMemo = new Map<string, Format>()

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

function compatOf(setup: AiSetup): NonNullable<AiSetup['compat']> {
  if (!setup.compat) throw new AiError('Provedor de IA não configurado.', 'other')
  return setup.compat
}

function headers(setup: AiSetup): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' }
  const key = compatOf(setup).key
  if (key) h.Authorization = `Bearer ${key}`
  // O OpenRouter pede o nome do app (opcional): só o nome, nenhum dado do usuário.
  if (setup.provider === 'openrouter') h['X-Title'] = 'IA Cleaner'
  return h
}

export function usageOf(setup: AiSetup, raw: { prompt_tokens?: unknown; completion_tokens?: unknown } | null | undefined): AiUsage {
  return {
    model: setup.model,
    inputTokens: num(raw?.prompt_tokens),
    outputTokens: num(raw?.completion_tokens),
    costUsd: 0,
    costUnknown: true
  }
}

async function httpError(setup: AiSetup, res: Response): Promise<AiError> {
  const { label } = compatOf(setup)
  let detail = ''
  try {
    const j = (await res.json()) as {
      error?: { message?: unknown } | string
      message?: unknown
    }
    const e = typeof j?.error === 'string' ? j.error : j?.error?.message
    detail = String(e ?? j?.message ?? '').slice(0, 300)
  } catch {
    // corpo sem JSON
  }
  const tail = detail ? ` Detalhe: ${detail}` : ''
  if (res.status === 401 || res.status === 403) {
    return new AiError(`A ${label} recusou a chave (${res.status}). Confira se ela foi copiada inteira e se a conta tem créditos/acesso.${tail}`, 'auth')
  }
  if (res.status === 404)
    return new AiError(`O modelo "${setup.model}" não foi encontrado na ${label}. Escolha outro em Configurações (botão "Carregar modelos").${tail}`, 'model')
  if (res.status === 429)
    return new AiError(`Limite de uso da ${label} atingido (muitas requisições ou sem créditos). Aguarde um pouco e tente de novo.${tail}`, 'rate')
  if (res.status >= 500) return new AiError(`Os servidores da ${label} estão instáveis agora (${res.status}). Tente de novo em alguns minutos.`, 'server')
  return new AiError(`A ${label} recusou a requisição (${res.status}).${tail}`, 'other')
}

async function request(setup: AiSetup, path: string, init: { method: 'GET' | 'POST'; body?: unknown; signal?: AbortSignal }): Promise<Response> {
  const c = compatOf(setup)
  try {
    return await aiFetch()(`${c.baseURL}${path}`, {
      method: init.method,
      headers: headers(setup),
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: init.signal
    })
  } catch (e) {
    if (init.signal?.aborted || (e as Error)?.name === 'AbortError') throw new AiError('Operação cancelada.', 'cancelled')
    const local = setup.provider === 'custom' ? ' ou se a IA local (Ollama, LM Studio...) está aberta' : ''
    throw new AiError(`Sem conexão com a ${c.label} (${c.baseURL}). Verifique a internet${local}.`, 'network')
  }
}

function checkFinish(setup: AiSetup, finish: unknown): void {
  if (finish === 'length') throw new AiError(TRUNCATED_MESSAGE, 'truncated')
  if (finish === 'content_filter')
    throw new AiError(`A ${compatOf(setup).label} recusou responder (filtro de conteúdo). Tente de novo ou use outro modelo.`, 'refusal')
}

/** Raciocínio que alguns modelos devolvem no texto (<think>...</think>): fora do JSON. */
export function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
}

/**
 * Uma resposta completa pedindo JSON. Tenta o JSON Schema estrito; se o provedor recusar (400/422),
 * cai para "json_object" e depois para texto livre (o prompt já pede só o JSON e o app valida tudo).
 */
export async function compatJson(setup: AiSetup, system: string, user: string, jsonSchema: object): Promise<{ text: string; usage: AiUsage }> {
  const memoKey = `${compatOf(setup).baseURL}|${setup.model}`
  const start = FORMATS.indexOf(formatMemo.get(memoKey) ?? 'json_schema')
  for (let i = start; i < FORMATS.length; i++) {
    const format = FORMATS[i]
    const responseFormat =
      format === 'json_schema'
        ? {
            response_format: {
              type: 'json_schema',
              json_schema: {
                name: 'resposta',
                strict: true,
                schema: jsonSchema
              }
            }
          }
        : format === 'json_object'
          ? { response_format: { type: 'json_object' } }
          : {}
    const messages: CompatMessage[] = [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ]
    const res = await request(setup, '/chat/completions', {
      method: 'POST',
      body: { model: setup.model, messages, ...responseFormat }
    })
    if (!res.ok) {
      if ((res.status === 400 || res.status === 422) && format !== 'none') continue
      throw await httpError(setup, res)
    }
    formatMemo.set(memoKey, format)
    const j = (await res.json()) as {
      choices?: { message?: { content?: unknown }; finish_reason?: unknown }[]
      usage?: Parameters<typeof usageOf>[1]
    }
    const choice = j?.choices?.[0]
    checkFinish(setup, choice?.finish_reason)
    return {
      text: stripThinking(String(choice?.message?.content ?? '')),
      usage: usageOf(setup, j?.usage)
    }
  }
  throw new AiError(`A ${compatOf(setup).label} recusou a requisição.`, 'other')
}

/** Chat em streaming (SSE). onDelta recebe cada pedaço de texto. */
export async function compatStream(
  setup: AiSetup,
  messages: CompatMessage[],
  onDelta: (text: string) => void,
  signal: AbortSignal
): Promise<{ finish: string | null; usage: AiUsage | null }> {
  const res = await request(setup, '/chat/completions', {
    method: 'POST',
    body: { model: setup.model, messages, stream: true },
    signal
  })
  if (!res.ok) throw await httpError(setup, res)
  if (!res.body) throw new AiError(`A ${compatOf(setup).label} não devolveu a resposta.`, 'server')
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let finish: string | null = null
  let usage: AiUsage | null = null
  for (;;) {
    let chunk: Awaited<ReturnType<typeof reader.read>>
    try {
      chunk = await reader.read()
    } catch {
      if (signal.aborted) throw new AiError('Operação cancelada.', 'cancelled')
      throw new AiError(`A conexão com a ${compatOf(setup).label} caiu no meio da resposta.`, 'network')
    }
    if (chunk.done) break
    buf += decoder.decode(chunk.value, { stream: true })
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (!data || data === '[DONE]') continue
      let j: {
        choices?: { delta?: { content?: unknown }; finish_reason?: unknown }[]
        usage?: Parameters<typeof usageOf>[1]
      }
      try {
        j = JSON.parse(data)
      } catch {
        continue
      }
      const c = j?.choices?.[0]
      if (typeof c?.delta?.content === 'string' && c.delta.content) onDelta(c.delta.content)
      if (typeof c?.finish_reason === 'string') finish = c.finish_reason
      if (j?.usage) usage = usageOf(setup, j.usage)
    }
  }
  return { finish, usage }
}

/** Ids que não são modelos de conversa (embeddings, áudio, imagem, moderação...). */
const NOT_CHAT = /embed|whisper|tts|dall-e|moderation|imagen|image|audio|transcri|realtime|veo|aqa|rerank/i

/** Modelos de conversa do provedor (GET /models; não gasta tokens). */
export async function compatListModels(setup: AiSetup): Promise<string[]> {
  const res = await request(setup, '/models', { method: 'GET' })
  if (!res.ok) throw await httpError(setup, res)
  const j = (await res.json()) as { data?: unknown; models?: unknown }
  const list = Array.isArray(j?.data) ? j.data : Array.isArray(j?.models) ? j.models : []
  const ids = list
    .map((m) => String((m as { id?: unknown; name?: unknown })?.id ?? (m as { name?: unknown })?.name ?? ''))
    .map((id) => id.replace(/^models\//, ''))
    .filter((id) => id && !NOT_CHAT.test(id))
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b))
}
