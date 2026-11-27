// Assina o monitor ao vivo enquanto o componente estiver montado:
// startLive ao montar, stopLive ao desmontar (o backend conta referências).
import { useEffect, useState } from 'react'
import type { LiveStats } from '@shared/types/hardware'
import { api, errMsg, useEvent } from '../../lib/api'

export interface LiveState {
  latest: LiveStats | null
  /** Últimas N amostras (mais antiga primeiro) */
  history: LiveStats[]
  error: string | null
}

export function useLiveStats(maxPoints = 60): LiveState {
  const [history, setHistory] = useState<LiveStats[]>([])
  const [error, setError] = useState<string | null>(null)

  useEvent('hardware:live', (s) => {
    setHistory((h) => {
      const next = h.length >= maxPoints ? h.slice(h.length - maxPoints + 1) : h.slice()
      next.push(s)
      return next
    })
  })

  useEffect(() => {
    api.hardware.startLive().catch((e) => setError(errMsg(e)))
    return () => {
      api.hardware.stopLive().catch(() => undefined)
    }
  }, [])

  return { latest: history.length ? history[history.length - 1] : null, history, error }
}
