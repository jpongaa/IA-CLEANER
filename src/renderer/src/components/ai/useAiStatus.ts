// Estado da IA (chave configurada? modelo?) compartilhado entre componentes, com cache em memória.
import { useEffect, useSyncExternalStore } from 'react'
import type { AiStatus } from '@shared/types/ai'
import { api } from '../../lib/api'

let current: AiStatus | null = null
let loaded = false
let inflight: Promise<void> | null = null
const listeners = new Set<() => void>()

function notify(): void {
  for (const l of listeners) l()
}

/** Recarrega o status (chame depois de salvar/remover a chave ou trocar o modelo). */
export function refreshAiStatus(): Promise<void> {
  if (inflight) return inflight
  inflight = api.ai
    .getStatus()
    .then((s) => {
      current = s
    })
    .catch(() => undefined)
    .finally(() => {
      loaded = true
      inflight = null
      notify()
    })
  return inflight
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** status = null enquanto carrega (ou se falhar). */
export function useAiStatus(): { status: AiStatus | null; loaded: boolean; refresh: () => Promise<void> } {
  const status = useSyncExternalStore(subscribe, () => current)
  const isLoaded = useSyncExternalStore(subscribe, () => loaded)
  useEffect(() => {
    void refreshAiStatus()
  }, [])
  return { status, loaded: isLoaded, refresh: refreshAiStatus }
}
