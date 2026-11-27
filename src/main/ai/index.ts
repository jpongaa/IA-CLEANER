// Domínio IA (Claude): análise de limpeza, diagnóstico de desempenho, consultor de drivers e chat.
// A IA só recomenda itens que existem nos dados coletados (refs validadas); quem executa é o usuário.
import { randomUUID } from 'node:crypto'
import type {
  BetaContentBlock,
  BetaMessage,
  BetaMessageParam,
  MessageCreateParamsNonStreaming
} from '@anthropic-ai/sdk/resources/beta/messages/messages'
import type * as z from 'zod/v4'
import type {
  AiApi,
  AiCleanupReport,
  AiContextInfo,
  AiDriverReport,
  AiItemExplanation,
  AiItemsReport,
  AiModel,
  AiPerformanceReport,
  AiStatus,
  AiUsage,
  ChatMessage
} from '@shared/types/ai'
import type { Verdict } from '@shared/types/common'
import { formatBytes } from '@shared/format'
import { getApiKey, getApiKeyProblem, getSettings } from '../core/settings'
import { getLatest, setLatest } from '../core/state'
import { emit } from '../core/events'
import {
  AiError,
  MODEL_LABELS,
  NO_KEY_MESSAGE,
  TRUNCATED_MESSAGE,
  fallbackParams,
  friendlyError,
  getAiSetup,
  isOptionalFeatureRejection,
  refusalMessage,
  webSearchTool,
  withoutOptionalFeatures,
  type AiSetup
} from './client'
import {
  buildChatSummary,
  buildCleanupContext,
  buildDriversContext,
  buildPerformanceContext,
  describeSources,
  estimateTokens,
  loadSources,
  type SourceData
} from './context'
import {
  CHAT_SYSTEM,
  CLEANUP_SYSTEM,
  DRIVERS_NO_WEB_NOTE,
  DRIVERS_SYSTEM,
  ITEMS_SYSTEM,
  PERFORMANCE_SYSTEM,
  chatSystemPrompt,
  driversWebSearchInstructions,
  itemsWebSearchInstructions,
  userMessage
} from './prompts'
import { CleanupOut, DriversOut, ItemsIn, ItemsOut, PerformanceOut, extractJsonBlock, outputFormat, parseWith, strictJsonSchema } from './schemas'
import { Anonymizer } from './refs'
import { sumUsage, usageFromApi } from './pricing'
import { getUsageTotals, recordUsage } from './usage'
import { validateCleanup, validateDrivers, validatePerformance } from './validate'

const MAX_TOKENS = 16_000

type Task = 'ai:cleanup' | 'ai:performance' | 'ai:drivers' | 'ai:items'

function progress(task: Task, phase: string, message: string, percent?: number): void {
  emit('ai:progress', { task, phase, message, percent })
}

/** Mantém o usuário informado enquanto a requisição não volta (a interface mostra o cronômetro). */
function ticker(task: Task, label: string): () => void {
  const started = Date.now()
  progress(task, 'model', `${label}...`)
  const id = setInterval(() => {
    const s = (Date.now() - started) / 1000
    const msg = s < 30 ? `${label}...` : s < 100 ? `${label} — pensando com cuidado nos seus dados...` : `${label} — está demorando mais que o normal, mas continua.`
    progress(task, 'model', msg)
  }, 10_000)
  return () => clearInterval(id)
}

function textOf(content: BetaContentBlock[]): string {
  return content
    .filter((b): b is Extract<BetaContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('')
}

/** Verifica stop_reason ANTES de usar o conteúdo. */
function assertStop(msg: BetaMessage): void {
  if (msg.stop_reason === 'refusal') throw new AiError(refusalMessage(msg.stop_details?.category), 'refusal')
  if (msg.stop_reason === 'max_tokens') throw new AiError(TRUNCATED_MESSAGE, 'truncated')
}

/** messages.create (beta); se a API recusar um recurso opcional (fallback/cache), tenta 1× sem ele. */
async function createMessage(setup: AiSetup, params: MessageCreateParamsNonStreaming): Promise<BetaMessage> {
  try {
    return await setup.client.beta.messages.create(params)
  } catch (e) {
    if (isOptionalFeatureRejection(e) && (params.fallbacks || params.betas)) {
      return await setup.client.beta.messages.create(withoutOptionalFeatures(params))
    }
    throw e
  }
}

/** Uma chamada com saída estruturada (JSON Schema) + validação zod. Repete 1× se o JSON vier inválido. */
async function structuredCall<T>(
  setup: AiSetup,
  task: Task,
  system: string,
  user: string,
  schema: z.ZodType<T>,
  usages: AiUsage[]
): Promise<T> {
  const params: MessageCreateParamsNonStreaming = {
    model: setup.model,
    max_tokens: MAX_TOKENS,
    thinking: { type: 'adaptive' },
    output_config: { effort: setup.effort, format: outputFormat(schema) },
    system,
    messages: [{ role: 'user', content: user }],
    ...fallbackParams(setup.model)
  }
  let lastError = ''
  for (let attempt = 1; attempt <= 2; attempt++) {
    const stop = ticker(task, attempt === 1 ? 'A IA está analisando' : 'A IA está refazendo a resposta')
    let msg: BetaMessage
    try {
      msg = await createMessage(setup, params)
    } catch (e) {
      throw friendlyError(e, setup.model)
    } finally {
      stop()
    }
    const usage = usageFromApi(setup.model, msg.usage)
    usages.push(usage)
    void recordUsage(usage)
    assertStop(msg)
    const parsed = parseWith(schema, textOf(msg.content).trim())
    if (parsed.ok) return parsed.data
    lastError = parsed.error
  }
  throw new AiError(`A IA respondeu num formato inesperado (${lastError}). Tente de novo.`, 'format')
}

/** Evita duas análises iguais ao mesmo tempo (devolve a mesma promessa). */
const running = new Map<Task, Promise<unknown>>()
function once<T>(task: Task, fn: () => Promise<T>): Promise<T> {
  const cur = running.get(task) as Promise<T> | undefined
  if (cur) return cur
  const p = fn().finally(() => running.delete(task))
  running.set(task, p)
  return p
}

// ---------------------------------------------------------------- análises

async function analyzeCleanup(): Promise<AiCleanupReport> {
  const task: Task = 'ai:cleanup'
  try {
    progress(task, 'context', 'Juntando os dados de discos, limpeza, programas e Busca Profunda...', 5)
    const setup = await getAiSetup()
    const data = await loadSources()
    if (!data.scan && !data.cleanupEstimate && !data.apps && !data.discover) {
      throw new AiError(
        'Ainda não há dados para analisar. Faça primeiro a varredura em "Análise de Discos" e/ou meça o lixo em "Limpeza Inteligente" (e liste "Jogos & Programas" ou rode a "Busca Profunda").',
        'data'
      )
    }
    const ctx = buildCleanupContext(data, { anonymize: setup.settings.anonymizePaths })
    progress(task, 'model', `A IA está analisando (${MODEL_LABELS[setup.model]})...`, 20)
    const usages: AiUsage[] = []
    const out = await structuredCall(setup, task, CLEANUP_SYSTEM, userMessage('cleanup', ctx.text), CleanupOut, usages)
    progress(task, 'validate', 'Conferindo as recomendações com as regras de segurança...', 90)
    const v = await validateCleanup(out, { index: ctx.index })
    const report: AiCleanupReport = {
      generatedAt: new Date().toISOString(),
      model: setup.model,
      summary: v.summary,
      criticalPoints: v.criticalPoints,
      recommendations: v.recommendations,
      keepWarnings: v.keepWarnings,
      totalRecoverableBytes: v.totalRecoverableBytes,
      usage: sumUsage(setup.model, usages),
      missingData: ctx.missing.length ? ctx.missing : undefined
    }
    await setLatest('aiCleanup', report)
    progress(task, 'done', 'Análise concluída.', 100)
    return report
  } catch (e) {
    const err = friendlyError(e)
    progress(task, 'error', err.message)
    throw err
  }
}

async function diagnosePerformance(): Promise<AiPerformanceReport> {
  const task: Task = 'ai:performance'
  try {
    progress(task, 'context', 'Juntando o diagnóstico de desempenho e o hardware...', 5)
    const setup = await getAiSetup()
    const data = await loadSources()
    if (!data.performance) {
      throw new AiError('Faça primeiro o diagnóstico na página "Desempenho" (botão de coletar); a IA usa esses dados.', 'data')
    }
    const ctx = buildPerformanceContext(data, { anonymize: setup.settings.anonymizePaths })
    progress(task, 'model', `A IA está analisando (${MODEL_LABELS[setup.model]})...`, 20)
    const usages: AiUsage[] = []
    const out = await structuredCall(setup, task, PERFORMANCE_SYSTEM, userMessage('performance', ctx.text), PerformanceOut, usages)
    progress(task, 'validate', 'Conferindo ações e evidências...', 90)
    const v = await validatePerformance(out, { index: ctx.index }, data.performance)
    const report: AiPerformanceReport = {
      generatedAt: new Date().toISOString(),
      model: setup.model,
      healthScore: v.healthScore,
      headline: v.headline,
      summary: v.summary,
      rootCauses: v.rootCauses,
      quickWins: v.quickWins,
      upgradeAdvice: v.upgradeAdvice,
      myths: v.myths,
      usage: sumUsage(setup.model, usages),
      missingData: ctx.missing.length ? ctx.missing : undefined
    }
    await setLatest('aiPerformance', report)
    progress(task, 'done', 'Diagnóstico concluído.', 100)
    return report
  } catch (e) {
    const err = friendlyError(e)
    progress(task, 'error', err.message)
    throw err
  }
}

/** Busca na web com resposta em bloco ```json, tratando pause_turn. officialOnly = só sites de fabricantes. */
async function jsonWithWebSearch<T>(
  setup: AiSetup,
  task: Task,
  system: string,
  user: string,
  schema: z.ZodType<T>,
  officialOnly: boolean,
  usages: AiUsage[],
  seenUrls: Set<string>
): Promise<T> {
  const messages: BetaMessageParam[] = [{ role: 'user', content: user }]
  const base = {
    model: setup.model,
    max_tokens: MAX_TOKENS,
    thinking: { type: 'adaptive' as const },
    output_config: { effort: setup.effort },
    system,
    tools: [webSearchTool(setup.model, officialOnly)],
    ...fallbackParams(setup.model)
  }
  const collect = (content: BetaContentBlock[]): void => {
    for (const b of content) {
      if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) {
        for (const r of b.content) if (r.url) seenUrls.add(r.url)
      }
      if (b.type === 'text' && Array.isArray(b.citations)) {
        for (const c of b.citations) if ('url' in c && typeof c.url === 'string') seenUrls.add(c.url)
      }
    }
  }
  let lastError = ''
  for (let attempt = 1; attempt <= 2; attempt++) {
    let msg: BetaMessage | null = null
    for (let turn = 0; turn < 5; turn++) {
      const first = officialOnly ? 'A IA está pesquisando nos sites oficiais' : 'A IA está pesquisando na internet'
      const stop = ticker(task, turn === 0 && attempt === 1 ? first : 'A IA continua pesquisando')
      try {
        msg = await createMessage(setup, { ...base, messages })
      } catch (e) {
        throw friendlyError(e, setup.model)
      } finally {
        stop()
      }
      const usage = usageFromApi(setup.model, msg.usage)
      usages.push(usage)
      void recordUsage(usage)
      collect(msg.content)
      if (msg.stop_reason === 'pause_turn') {
        // O servidor pausou um turno longo de busca: reenviar a resposta do assistente para continuar.
        messages.push({ role: 'assistant', content: msg.content })
        progress(task, 'model', 'Continuando a pesquisa...')
        continue
      }
      break
    }
    if (!msg) break
    if (msg.stop_reason === 'pause_turn') {
      // 5 pausas seguidas: a resposta pausada JÁ está em messages; reenviá-la duplicaria o bloco server_tool_use
      // (a API recusa com 400, depois de já ter cobrado as buscas). Melhor parar com uma mensagem clara.
      throw new AiError('A pesquisa na web demorou demais. Tente de novo ou desligue a busca na web em Configurações.', 'other')
    }
    assertStop(msg)
    const parsed = parseWith(schema, extractJsonBlock(textOf(msg.content)))
    if (parsed.ok) return parsed.data
    lastError = parsed.error
    // Uma nova tentativa pedindo só o JSON (sem novas buscas). msg nunca foi empurrada antes (não era pause_turn).
    messages.push({ role: 'assistant', content: msg.content })
    messages.push({
      role: 'user',
      content: 'Sua resposta final não veio no formato pedido. Não pesquise mais: responda agora APENAS com o bloco ```json``` válido conforme o JSON Schema.'
    })
  }
  throw new AiError(`A IA respondeu num formato inesperado (${lastError}). Tente de novo.`, 'format')
}

async function adviseDrivers(): Promise<AiDriverReport> {
  const task: Task = 'ai:drivers'
  try {
    progress(task, 'context', 'Juntando o inventário de drivers...', 5)
    const setup = await getAiSetup()
    const data = await loadSources({ withDrives: false })
    if (!data.drivers) throw new AiError('Carregue primeiro o inventário na página "Drivers"; a IA usa esses dados.', 'data')
    const ctx = buildDriversContext(data, { anonymize: setup.settings.anonymizePaths })
    const usages: AiUsage[] = []
    const seenUrls = new Set<string>()
    let out: z.infer<typeof DriversOut>
    const useWeb = setup.settings.webSearch
    if (useWeb) {
      progress(task, 'search', 'A IA está pesquisando as versões mais recentes nos sites oficiais...', 15)
      const system = `${DRIVERS_SYSTEM}\n\n${driversWebSearchInstructions(JSON.stringify(strictJsonSchema(DriversOut)))}`
      out = await jsonWithWebSearch(setup, 'ai:drivers', system, userMessage('drivers', ctx.text), DriversOut, true, usages, seenUrls)
    } else {
      progress(task, 'model', `A IA está analisando (${MODEL_LABELS[setup.model]}, sem busca na web)...`, 20)
      out = await structuredCall(setup, task, `${DRIVERS_SYSTEM}\n\n${DRIVERS_NO_WEB_NOTE}`, userMessage('drivers', ctx.text), DriversOut, usages)
    }
    progress(task, 'validate', 'Conferindo drivers e links oficiais...', 92)
    const v = validateDrivers(out, { index: ctx.index }, data.drivers, seenUrls)
    const report: AiDriverReport = {
      generatedAt: new Date().toISOString(),
      model: setup.model,
      summary: v.summary,
      items: v.items,
      usedWebSearch: useWeb && usages.some((u) => (u.webSearches ?? 0) > 0),
      usage: sumUsage(setup.model, usages),
      missingData: ctx.missing.length ? ctx.missing : undefined
    }
    await setLatest('aiDrivers', report)
    progress(task, 'done', 'Análise de drivers concluída.', 100)
    return report
  } catch (e) {
    const err = friendlyError(e)
    progress(task, 'error', err.message)
    throw err
  }
}

const VERDICT_PT: Record<Verdict, string> = { safe: 'pode apagar', review: 'revisar', keep: 'manter' }
/** Itens por chamada: mantém a resposta bem abaixo de MAX_TOKENS. */
const ITEMS_BATCH = 40

async function explainItems(raw: unknown): Promise<AiItemsReport> {
  const task: Task = 'ai:items'
  try {
    const input = ItemsIn.safeParse(raw)
    if (!input.success) throw new AiError('Lista de itens inválida.', 'data')
    const items = input.data
    if (!items.length) throw new AiError('Nada para analisar: use "Analisar tudo" primeiro.', 'data')
    const setup = await getAiSetup()
    const anon = new Anonymizer(setup.settings.anonymizePaths)
    const useWeb = setup.settings.webSearch
    const usages: AiUsage[] = []
    const out = new Map<string, AiItemExplanation>()
    for (let i = 0; i < items.length; i += ITEMS_BATCH) {
      const chunk = items.slice(i, i + ITEMS_BATCH)
      progress(task, 'model', `A IA está analisando os itens ${i + 1} a ${i + chunk.length} de ${items.length}...`, 10 + Math.round((80 * i) / items.length))
      const lines = chunk.map((it) =>
        anon.hide(
          `[${it.id}] ${it.title} | origem: ${it.source} | ${formatBytes(it.bytes)} | regra do app: ${VERDICT_PT[it.appVerdict]}` +
            (it.paths.length ? ` | ${it.paths.join(' ; ')}` : '') +
            (it.detail ? ` | ${it.detail}` : '')
        )
      )
      const user = userMessage('items', lines.join('\n'))
      const res = useWeb
        ? await jsonWithWebSearch(setup, task, `${ITEMS_SYSTEM}\n\n${itemsWebSearchInstructions(JSON.stringify(strictJsonSchema(ItemsOut)))}`, user, ItemsOut, false, usages, new Set())
        : await structuredCall(setup, task, ITEMS_SYSTEM, user, ItemsOut, usages)
      const byId = new Map(chunk.map((it) => [it.id, it]))
      for (const r of res.items) {
        const src = byId.get(r.id)
        if (!src) continue // id inventado
        out.set(r.id, {
          id: r.id,
          // a IA nunca é menos cautelosa que a regra do app
          verdict: src.appVerdict === 'keep' ? 'manter' : r.verdict,
          whatIsIt: anon.reveal(r.whatIsIt).slice(0, 200),
          explanation: anon.reveal(r.explanation).slice(0, 600)
        })
      }
    }
    const report: AiItemsReport = {
      generatedAt: new Date().toISOString(),
      model: setup.model,
      items: [...out.values()],
      usedWebSearch: useWeb && usages.some((u) => (u.webSearches ?? 0) > 0),
      usage: sumUsage(setup.model, usages)
    }
    await setLatest('aiItems', report)
    progress(task, 'done', 'Análise item a item concluída.', 100)
    return report
  } catch (e) {
    const err = friendlyError(e)
    progress(task, 'error', err.message)
    throw err
  }
}

// ---------------------------------------------------------------- chat

interface ChatStream {
  abort: () => void
  cancelled: boolean
}
const streams = new Map<string, ChatStream>()

/** Normaliza o histórico vindo da interface (papéis alternados, começa com user, termina com user). */
export function sanitizeHistory(messages: ChatMessage[]): BetaMessageParam[] {
  const list = (Array.isArray(messages) ? messages : [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .map((m) => ({ role: m.role, content: m.content.slice(0, 12_000) }))
  const merged: { role: 'user' | 'assistant'; content: string }[] = []
  for (const m of list) {
    const last = merged[merged.length - 1]
    if (last && last.role === m.role) last.content += '\n\n' + m.content
    else merged.push({ ...m })
  }
  while (merged.length && merged[0].role !== 'user') merged.shift()
  // Limita o histórico (últimas ~30 mensagens), mantendo o início em 'user'.
  let recent = merged.slice(-30)
  while (recent.length && recent[0].role !== 'user') recent = recent.slice(1)
  if (!recent.length || recent[recent.length - 1].role !== 'user') throw new AiError('A última mensagem precisa ser do usuário.', 'other')
  return recent
}

/**
 * Resumo do PC do chat, reaproveitado enquanto os dados não mudam: o resumo vai no `system`, e qualquer byte
 * diferente (ex.: espaço livre lido ao vivo variando 100 MB) invalidaria o cache do prefixo a cada pergunta.
 * Refeito quando alguma coleta muda, quando o espaço livre de uma unidade muda 1 GB ou mais, ou a cada 6 h.
 */
let chatSummaryMemo: { key: string; drives: Map<string, number>; text: string; at: number } | null = null
const SUMMARY_FREE_TOLERANCE = 1024 ** 3
const SUMMARY_MAX_AGE_MS = 6 * 3600_000

export function stableChatSummary(data: SourceData, anonymize: boolean, now = Date.now()): { text: string; tokens: number } {
  const d = new Date(now)
  const key = JSON.stringify([
    anonymize,
    `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`,
    data.scan?.finishedAt,
    data.cleanupEstimate?.scannedAt,
    data.apps?.collectedAt,
    data.performance?.collectedAt,
    data.hardware?.collectedAt,
    data.drivers?.collectedAt,
    data.duplicatesAt,
    Array.isArray(data.duplicates) ? data.duplicates.length : null,
    data.aiCleanup?.generatedAt,
    data.aiPerformance?.generatedAt,
    data.aiDrivers?.generatedAt,
    data.discover?.scannedAt,
    // Desinstalações: muda quando uma termina/aparece (não a cada segundo de acompanhamento).
    (Array.isArray(data.uninstallTracks) ? data.uninstallTracks : []).map((t) => `${t.trackId}:${t.status}:${(t.leftovers ?? []).length}`).join(','),
    // Reparar Erros (uma correção tira o problema do relatório sem mudar a data), medições, Histórico e DNS.
    data.repair?.scannedAt,
    Array.isArray(data.repair?.issues) ? data.repair.issues.map((i) => i?.id).join(',') : null,
    Array.isArray(data.measurements) ? data.measurements.map((m) => m?.id).slice(0, 4).join(',') : null,
    Array.isArray(data.actionLog) ? data.actionLog.slice(0, 30).map((e) => `${e?.id}:${e?.undone ? 1 : 0}`).join(',') : null,
    data.dns?.testedAt,
    // Temperatura ao vivo da GPU só refaz o resumo quando muda de faixa (10 °C) ou aparece/some.
    typeof data.gpuLive?.tempC === 'number' ? Math.round(data.gpuLive.tempC / 10) : null
  ])
  const drives = new Map((Array.isArray(data.drives) ? data.drives : []).map((x) => [String(x.letter).toUpperCase(), Number(x.freeBytes) || 0]))
  const memo = chatSummaryMemo
  const sameDrives =
    memo !== null &&
    memo.drives.size === drives.size &&
    [...drives].every(([letter, free]) => memo.drives.has(letter) && Math.abs((memo.drives.get(letter) ?? 0) - free) < SUMMARY_FREE_TOLERANCE)
  if (memo && memo.key === key && sameDrives && now - memo.at < SUMMARY_MAX_AGE_MS) return { text: memo.text, tokens: estimateTokens(memo.text) }
  const s = buildChatSummary(data, { anonymize, now })
  chatSummaryMemo = { key, drives, text: s.text, at: now }
  return s
}

async function chat(messages: ChatMessage[]): Promise<{ streamId: string }> {
  // Rápido (configurações + chave): erros de configuração continuam voltando direto no invoke.
  const setup = await getAiSetup()
  const history = sanitizeHistory(messages)
  // O id é registrado ANTES do trabalho lento (ler unidades em PowerShell), para "Parar" funcionar desde o início.
  const streamId = randomUUID()
  const entry: ChatStream = { abort: () => undefined, cancelled: false }
  streams.set(streamId, entry)

  const run = async (): Promise<void> => {
    let usage: AiUsage | undefined
    let streamed = false
    let streamedText = ''
    let snapshot: BetaMessage | undefined
    try {
      const data = await loadSources({ withReports: true })
      if (entry.cancelled) {
        // Cancelado antes de chamar a API: nada foi cobrado.
        emit('ai:chatDone', { streamId })
        return
      }
      const summary = stableChatSummary(data, setup.settings.anonymizePaths)
      const baseParams = {
        model: setup.model,
        max_tokens: MAX_TOKENS,
        thinking: { type: 'adaptive' as const },
        output_config: { effort: setup.effort },
        // Cache automático do prefixo (sistema + histórico): barateia as próximas perguntas da conversa.
        cache_control: { type: 'ephemeral' as const },
        system: chatSystemPrompt(summary.text),
        messages: history,
        ...fallbackParams(setup.model)
      }
      const attempt = async (params: typeof baseParams): Promise<void> => {
        const stream = setup.client.beta.messages.stream(params)
        entry.abort = () => stream.abort()
        if (entry.cancelled) stream.abort()
        stream.on('streamEvent', (_ev, snap) => {
          snapshot = snap
        })
        stream.on('text', (delta) => {
          if (!delta) return
          streamed = true
          streamedText += delta
          emit('ai:chatDelta', { streamId, delta })
        })
        const final = await stream.finalMessage()
        usage = usageFromApi(setup.model, final.usage)
        void recordUsage(usage)
        if (final.stop_reason === 'refusal') {
          emit('ai:chatDone', { streamId, usage, error: refusalMessage(final.stop_details?.category) })
        } else if (final.stop_reason === 'max_tokens') {
          emit('ai:chatDone', { streamId, usage, error: 'A resposta foi cortada por ficar longa demais. Peça para continuar ou faça uma pergunta mais específica.' })
        } else {
          emit('ai:chatDone', { streamId, usage })
        }
      }
      try {
        await attempt(baseParams)
      } catch (e) {
        // A API recusou um recurso opcional antes de responder: tenta 1× sem ele.
        if (!streamed && !entry.cancelled && isOptionalFeatureRejection(e)) await attempt(withoutOptionalFeatures(baseParams))
        else throw e
      }
    } catch (e) {
      // Interrompida (pelo usuário ou por erro) depois de começar: a entrada e o que já foi gerado SÃO cobrados.
      if (!usage && snapshot?.usage) {
        const raw = { ...snapshot.usage, output_tokens: Math.max(snapshot.usage.output_tokens ?? 0, estimateTokens(streamedText)) }
        usage = usageFromApi(setup.model, raw)
        void recordUsage(usage)
      }
      if (entry.cancelled) emit('ai:chatDone', { streamId, usage })
      else emit('ai:chatDone', { streamId, usage, error: friendlyError(e, setup.model).message })
    } finally {
      streams.delete(streamId)
    }
  }
  void run()
  return { streamId }
}

async function cancelChat(streamId: string): Promise<void> {
  const s = streams.get(streamId)
  if (!s) return
  s.cancelled = true
  try {
    s.abort()
  } catch {
    // já terminou
  }
}

// ---------------------------------------------------------------- status / utilidades

async function getStatus(): Promise<AiStatus> {
  const [settings, cred, problem] = await Promise.all([getSettings(), getApiKey().catch(() => null), getApiKeyProblem().catch(() => null)])
  const status: AiStatus = {
    configured: Boolean(cred),
    source: cred?.source ?? 'none',
    model: settings.model,
    webSearch: settings.webSearch
  }
  // Chave salva que não pode ser lida aqui: a interface explica o motivo no aviso "Configurar IA".
  if (problem) status.problem = problem
  return status
}

async function testConnection(): Promise<{ ok: boolean; message: string }> {
  let setup: AiSetup
  try {
    setup = await getAiSetup()
  } catch (e) {
    return { ok: false, message: e instanceof AiError ? e.message : NO_KEY_MESSAGE }
  }
  try {
    // Não gasta tokens: só confirma chave + acesso ao modelo.
    const info = await setup.client.models.retrieve(setup.model)
    const label = MODEL_LABELS[setup.model as AiModel] ?? info.display_name ?? setup.model
    return {
      ok: true,
      message: `Conexão OK — ${label} disponível (chave ${setup.keySource === 'env' ? 'da variável ANTHROPIC_API_KEY' : 'salva no app'}).`
    }
  } catch (e) {
    return { ok: false, message: friendlyError(e, setup.model).message }
  }
}

async function getContextInfo(): Promise<AiContextInfo> {
  const settings = await getSettings()
  const data = await loadSources({ withDrives: false, withReports: true })
  const summary = buildChatSummary(data, { anonymize: settings.anonymizePaths })
  return {
    sources: describeSources(data),
    chatContextTokens: summary.tokens + Math.ceil(CHAT_SYSTEM.length / 3.3),
    anonymizePaths: settings.anonymizePaths
  }
}

export function createAiApi(): AiApi {
  return {
    explainItems: (items) => once('ai:items', () => explainItems(items)),
    getLastExplanations: () => getLatest('aiItems'),
    getStatus,
    testConnection,
    analyzeCleanup: () => once('ai:cleanup', analyzeCleanup),
    diagnosePerformance: () => once('ai:performance', diagnosePerformance),
    adviseDrivers: () => once('ai:drivers', adviseDrivers),
    chat,
    cancelChat,
    async getLastReports() {
      const [cleanup, performance, drivers] = await Promise.all([getLatest('aiCleanup'), getLatest('aiPerformance'), getLatest('aiDrivers')])
      return { cleanup: cleanup ?? undefined, performance: performance ?? undefined, drivers: drivers ?? undefined }
    },
    async getUsageTotals() {
      const t = await getUsageTotals()
      return { inputTokens: t.inputTokens, outputTokens: t.outputTokens, costUsd: t.costUsd, calls: t.calls }
    },
    getContextInfo
  }
}
