// Acesso tipado ao backend (window.api) + hooks utilitários.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ExposedApi } from '@shared/api'
import type { EventMap, EventName } from '@shared/events'

export const api: ExposedApi = window.api

/** Prefixo "<Nome>Error: " que o Electron acrescenta ao serializar a rejeição (Error, TypeError, PowerShellError, AiError...). */
const ERROR_NAME_PREFIX = /^\s*(?:[A-Za-z_$][\w$]*)?Error:\s*/

/** Mensagem de erro limpa (remove "Error invoking remote method..." e qualquer prefixo "XxxError:"). */
export function errMsg(e: unknown): string {
  let msg = (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+':\s*/, '')
  // Pode vir encadeado ("Error: TypeError: ..."); para quando não há mais prefixo.
  for (let i = 0; i < 5 && ERROR_NAME_PREFIX.test(msg); i++) msg = msg.replace(ERROR_NAME_PREFIX, '')
  return msg.trim() || 'Erro desconhecido.'
}

/** Assina um evento do backend enquanto o componente estiver montado. */
export function useEvent<E extends EventName>(event: E, handler: (payload: EventMap[E]) => void): void {
  const ref = useRef(handler)
  ref.current = handler
  useEffect(() => api.on(event, (p) => ref.current(p)), [event])
}

export interface AsyncState<T> {
  data: T | null
  error: string | null
  loading: boolean
  /** Executa de novo; devolve o resultado (ou null se falhar). */
  run: () => Promise<T | null>
  setData: (v: T | null) => void
}

/** Executa uma chamada assíncrona com estados de carregamento/erro. immediate=true roda ao montar. */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[] = [], immediate = true): AsyncState<T> {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(immediate)
  const fnRef = useRef(fn)
  fnRef.current = fn
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const run = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const v = await fnRef.current()
      if (mounted.current) setData(v)
      return v
    } catch (e) {
      if (mounted.current) setError(errMsg(e))
      return null
    } finally {
      if (mounted.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (immediate) void run()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  return { data, error, loading, run, setData }
}
