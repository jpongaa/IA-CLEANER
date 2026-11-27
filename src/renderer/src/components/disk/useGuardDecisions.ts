// Decisões do guard de segurança do backend (api.cleanup.checkPaths) para os arquivos mostrados na Análise
// de Discos, em lote e memorizadas por caminho (cache curto: o inventário de jogos/programas pode mudar).
import { useCallback, useEffect, useState } from 'react'
import type { GuardDecision } from '@shared/types/cleanup'
import { api, errMsg } from '../../lib/api'
import { chunk, dirSafety, pathKey, pathSafety, type PathSafety } from './safety'

/** O backend aceita até 5000 caminhos por chamada. */
const BATCH = 2000
const TTL_MS = 2 * 60_000

const cache = new Map<string, { d: GuardDecision; at: number }>()

function cached(k: string, now = Date.now()): GuardDecision | undefined {
  const c = cache.get(k)
  return c && now - c.at < TTL_MS ? c.d : undefined
}

/** Esquece decisões memorizadas (ex.: depois de apagar arquivos). Sem argumento, esquece tudo. */
export function invalidateGuardDecisions(paths?: string[]): void {
  if (!paths) cache.clear()
  else for (const p of paths) cache.delete(pathKey(p))
}

/**
 * Busca as decisões do guard (chave = caminho em minúsculas). fresh = ignora o cache (usado na confirmação,
 * que precisa da decisão de agora). Lança erro se o backend falhar: quem chama trata como "não verificado".
 */
export async function fetchGuardDecisions(paths: string[], opts: { fresh?: boolean } = {}): Promise<Map<string, GuardDecision>> {
  const out = new Map<string, GuardDecision>()
  const missing: string[] = []
  const seen = new Set<string>()
  for (const p of paths) {
    if (typeof p !== 'string' || !p) continue
    const k = pathKey(p)
    if (seen.has(k)) continue
    seen.add(k)
    const c = opts.fresh ? undefined : cached(k)
    if (c) out.set(k, c)
    else missing.push(p)
  }
  for (const part of chunk(missing, BATCH)) {
    const res = await api.cleanup.checkPaths(part)
    if (!Array.isArray(res)) throw new Error('Resposta inválida do verificador de segurança.')
    const at = Date.now()
    part.forEach((p, i) => {
      const d = res[i]
      if (!d || (d.level !== 'blocked' && d.level !== 'warn' && d.level !== 'ok')) return
      const k = pathKey(p)
      cache.set(k, { d, at })
      out.set(k, d)
    })
  }
  return out
}

export interface GuardState {
  /** Proteção efetiva (guard + dica local). pending = guard ainda não respondeu para este caminho. */
  safetyOf: (path: string) => PathSafety
  /** O mesmo para PASTAS (dica local de pasta) */
  dirSafetyOf: (path: string) => PathSafety
  /** Verificando no backend */
  loading: boolean
  /** Falha do backend: tudo fica "não verificado" (nada é marcado automaticamente) */
  error: string | null
  retry: () => void
  /** Garante a decisão de uma lista (ex.: todos os grupos de duplicados antes de "marcar cópias extras"). */
  ensure: (paths: string[]) => Promise<(path: string) => PathSafety>
}

export function useGuardDecisions(paths: string[]): GuardState {
  const [decisions, setDecisions] = useState<Map<string, GuardDecision>>(() => new Map())
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)
  const key = paths.join('\n')

  const merge = useCallback((m: Map<string, GuardDecision>) => {
    if (!m.size) return
    setDecisions((prev) => {
      const n = new Map(prev)
      for (const [k, v] of m) n.set(k, v)
      return n
    })
  }, [])

  useEffect(() => {
    if (!paths.length) return
    let alive = true
    setLoading(true)
    setError(null)
    fetchGuardDecisions(paths)
      .then((m) => alive && merge(m))
      .catch((e) => alive && setError(errMsg(e)))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [key, nonce]) // eslint-disable-line react-hooks/exhaustive-deps

  const safetyOf = useCallback(
    (p: string): PathSafety => {
      const k = pathKey(p)
      return pathSafety(p, decisions.get(k) ?? cached(k))
    },
    [decisions]
  )

  const dirSafetyOf = useCallback(
    (p: string): PathSafety => {
      const k = pathKey(p)
      return dirSafety(p, decisions.get(k) ?? cached(k))
    },
    [decisions]
  )

  const ensure = useCallback(
    async (list: string[]) => {
      const m = await fetchGuardDecisions(list)
      merge(m)
      return (p: string): PathSafety => {
        const k = pathKey(p)
        return pathSafety(p, m.get(k) ?? decisions.get(k) ?? cached(k))
      }
    },
    [decisions, merge]
  )

  return { safetyOf, dirSafetyOf, loading, error, retry: () => setNonce((n) => n + 1), ensure }
}
