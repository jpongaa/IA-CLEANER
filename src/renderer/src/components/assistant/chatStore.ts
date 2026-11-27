// Estado do chat fora do React: a resposta continua chegando mesmo se o usuário trocar de página,
// e a conversa fica salva no localStorage.
import { useSyncExternalStore } from 'react'
import type { AiUsage, ChatMessage } from '@shared/types/ai'
import { api, errMsg } from '../../lib/api'

export interface UiMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: number
  /** Resposta ainda chegando */
  streaming?: boolean
  error?: string
  cancelled?: boolean
  usage?: AiUsage
}

export interface ChatState {
  messages: UiMessage[]
  /** Stream em andamento */
  streamId: string | null
  sending: boolean
}

const STORAGE_KEY = 'iacleaner.assistant.chat.v1'
const MAX_SAVED = 80

let state: ChatState = { messages: [], streamId: null, sending: false }
let initialized = false
const listeners = new Set<() => void>()
/** Stream (id do main) -> bolha de resposta que ele preenche. Só streams desta interface entram aqui. */
const streamToReply = new Map<string, string>()
/** Deltas/fins que chegaram antes de o invoke devolver o streamId (corrida possível). Limitados. */
const pendingDeltas = new Map<string, string>()
const pendingDone = new Map<string, { usage?: AiUsage; error?: string }>()
const MAX_PENDING = 8
/** Pedidos api.ai.chat ainda sem resposta (enquanto houver, um id desconhecido pode ser de um deles). */
let inflight = 0
/** Cada envio ganha um número; uma resposta de um envio antigo (cancelado/substituído) é descartada. */
let sendSeq = 0
/** Bolha de resposta do envio atual. */
let currentReplyId: string | null = null
/** Streams descartados (cancelados antes de o id chegar): seus eventos são ignorados até o fim. */
const ignored = new Set<string>()

function uid(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function set(next: Partial<ChatState>): void {
  state = { ...state, ...next }
  for (const l of listeners) l()
}

function save(): void {
  try {
    const msgs = state.messages.slice(-MAX_SAVED).map((m) => ({ ...m, streaming: undefined }))
    localStorage.setItem(STORAGE_KEY, JSON.stringify(msgs))
  } catch {
    // armazenamento indisponível/cheio: segue sem salvar
  }
}

function load(): UiMessage[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const list = JSON.parse(raw) as UiMessage[]
    if (!Array.isArray(list)) return []
    return list
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .map((m) => (m.role === 'assistant' && !m.content && !m.error ? { ...m, error: 'Resposta interrompida (o app foi fechado).' } : m))
  } catch {
    return []
  }
}

function updateMessage(id: string, patch: Partial<UiMessage> | ((m: UiMessage) => Partial<UiMessage>)): void {
  set({
    messages: state.messages.map((m) => (m.id === id ? { ...m, ...(typeof patch === 'function' ? patch(m) : patch) } : m))
  })
}

/** Guarda um evento de stream ainda sem dono, só enquanto algum envio espera o seu streamId. */
function canBuffer(streamId: string, map: Map<string, unknown>): boolean {
  if (inflight <= 0) return false // ninguém esperando: stream órfão (ex.: de um envio cancelado) — descarta
  return map.has(streamId) || map.size < MAX_PENDING
}

function applyDelta(streamId: string, delta: string): void {
  if (ignored.has(streamId)) return
  const replyId = streamToReply.get(streamId)
  if (!replyId) {
    if (canBuffer(streamId, pendingDeltas)) pendingDeltas.set(streamId, (pendingDeltas.get(streamId) ?? '') + delta)
    return
  }
  updateMessage(replyId, (x) => ({ content: x.content + delta }))
}

function applyDone(streamId: string, payload: { usage?: AiUsage; error?: string }): void {
  if (ignored.delete(streamId)) return
  const replyId = streamToReply.get(streamId)
  if (!replyId) {
    if (canBuffer(streamId, pendingDone)) pendingDone.set(streamId, payload)
    else pendingDeltas.delete(streamId)
    return
  }
  streamToReply.delete(streamId)
  updateMessage(replyId, (x) => ({ streaming: false, usage: payload.usage, error: payload.error, cancelled: x.cancelled }))
  if (state.streamId === streamId) set({ streamId: null, sending: false })
  if (currentReplyId === replyId) currentReplyId = null
  save()
}

function init(): void {
  if (initialized) return
  initialized = true
  state = { ...state, messages: load() }
  try {
    api.on('ai:chatDelta', (p) => applyDelta(p.streamId, p.delta))
    api.on('ai:chatDone', (p) => applyDone(p.streamId, { usage: p.usage, error: p.error }))
  } catch {
    // fora do Electron (testes): sem eventos
  }
}

function history(): ChatMessage[] {
  return state.messages
    .filter((m) => m.content.trim() && !(m.role === 'assistant' && m.error && !m.content.trim()))
    .map((m) => ({ role: m.role, content: m.content }))
}

export const chatStore = {
  getState(): ChatState {
    init()
    return state
  },

  subscribe(fn: () => void): () => void {
    init()
    listeners.add(fn)
    return () => listeners.delete(fn)
  },

  async send(text: string): Promise<void> {
    init()
    const content = text.trim()
    if (!content || state.sending) return
    const user: UiMessage = { id: uid(), role: 'user', content, createdAt: Date.now() }
    const reply: UiMessage = { id: uid(), role: 'assistant', content: '', createdAt: Date.now(), streaming: true }
    const myToken = ++sendSeq
    currentReplyId = reply.id
    set({ messages: [...state.messages, user, reply], sending: true, streamId: null })
    save()
    inflight++
    let streamId: string
    try {
      streamId = (await api.ai.chat(history())).streamId
    } catch (e) {
      inflight--
      if (myToken === sendSeq) {
        updateMessage(reply.id, { streaming: false, error: errMsg(e) })
        set({ sending: false, streamId: null })
        if (currentReplyId === reply.id) currentReplyId = null
        save()
      }
      return
    }
    inflight--
    const mine = state.messages.find((m) => m.id === reply.id)
    if (myToken !== sendSeq || !mine || mine.cancelled || !mine.streaming) {
      // "Parar" (ou "Limpar"/nova pergunta) antes de o id chegar: cancela no main para não seguir cobrando,
      // e nada desse stream entra em outra bolha.
      void api.ai.cancelChat(streamId).catch(() => undefined)
      if (!pendingDone.delete(streamId)) {
        if (ignored.size > 50) ignored.clear()
        ignored.add(streamId) // o 'ai:chatDone' dele ainda vai chegar
      }
      pendingDeltas.delete(streamId)
      return
    }
    streamToReply.set(streamId, reply.id)
    set({ streamId })
    const buffered = pendingDeltas.get(streamId)
    if (buffered) {
      pendingDeltas.delete(streamId)
      applyDelta(streamId, buffered)
    }
    const done = pendingDone.get(streamId)
    if (done) {
      pendingDone.delete(streamId)
      applyDone(streamId, done)
    }
  },

  /** Reenvia a última pergunta (depois de um erro). */
  async retry(): Promise<void> {
    init()
    if (state.sending) return
    const msgs = [...state.messages]
    while (msgs.length && msgs[msgs.length - 1].role === 'assistant') msgs.pop()
    const lastUser = msgs.pop()
    if (!lastUser) return
    set({ messages: msgs })
    await chatStore.send(lastUser.content)
  },

  async cancel(): Promise<void> {
    const id = state.streamId
    const replyId = currentReplyId
    if (!replyId) return
    updateMessage(replyId, { cancelled: true })
    if (id) {
      await api.ai.cancelChat(id).catch(() => undefined)
      // O main responde com 'ai:chatDone'; se não responder (stream já encerrado), fecha a bolha mesmo assim.
      setTimeout(() => {
        if (streamToReply.get(id) === replyId) applyDone(id, {})
      }, 5000)
    } else {
      // O id ainda não chegou: fecha a bolha agora; send() cancela o stream no main assim que o id chegar.
      updateMessage(replyId, { streaming: false })
      set({ sending: false })
      currentReplyId = null
      save()
    }
  },

  clear(): void {
    for (const id of streamToReply.keys()) void api.ai.cancelChat(id).catch(() => undefined)
    streamToReply.clear()
    pendingDeltas.clear()
    pendingDone.clear()
    sendSeq++ // um envio ainda sem id será cancelado quando o id chegar
    currentReplyId = null
    set({ messages: [], streamId: null, sending: false })
    save()
  },

  /** Custo estimado somado da conversa atual. */
  conversationCost(): number {
    return state.messages.reduce((s, m) => s + (m.usage?.costUsd ?? 0), 0)
  }
}

export function useChat(): ChatState {
  return useSyncExternalStore(chatStore.subscribe, chatStore.getState)
}
